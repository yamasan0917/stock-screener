# -*- coding: utf-8 -*-
"""
ウェブサイト用データ生成バッチ（「本日のおすすめ銘柄」）

CLI版 screener.py と同じロジックで、標準・ゆるめ両プリセットの結果を
docs/data/latest.json に書き出す。GitHub Actions / タスクスケジューラから
1日2回（日本市場の大引け後・米国市場の引け後）実行する想定。

実行: python generate_data.py            # 拡張ユニバース（約2,000銘柄・10分前後）
      python generate_data.py --limit 30 # 動作確認用
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

import config
import scenarios
from config import standard_config, loose_config
from fundamentals import fetch_fundamentals
from indicators import compute_snapshot
from names_ja import us_display_name
from screener import (download_prices, tech_pass_value, tech_pass_growth,
                      tech_pass_defensive, fund_pass_value, fund_pass_growth,
                      fund_pass_defensive, score_value, score_growth, score_defensive)
from universe import get_us_extended, get_jp_extended, get_jp_names, load_universe_file

BASE_DIR = Path(__file__).parent
DOCS_DATA_DIR = BASE_DIR / "docs" / "data"
JST = timezone(timedelta(hours=9))

SPARK_DAYS = 63   # 約3ヶ月分の終値
SPARK_POINTS = 30  # フロントに埋め込む点数（軽量化のため間引く）


def sparkline(df: pd.DataFrame) -> list[float]:
    closes = df["Close"].dropna().tail(SPARK_DAYS)
    if len(closes) > SPARK_POINTS:
        idx = [round(i * (len(closes) - 1) / (SPARK_POINTS - 1)) for i in range(SPARK_POINTS)]
        closes = closes.iloc[idx]
    return [round(float(v), 2) for v in closes]


def display_name(ticker: str, market: str, fund: dict, jp_names: dict) -> str:
    if market == "JP":
        return jp_names.get(ticker, fund["name"])
    return us_display_name(ticker, fund["name"])


def value_row(t, s, f, c, market, jp_names, spark):
    return {
        "ticker": t,
        "name": display_name(t, market, f, jp_names),
        "name_en": f["name"],
        "sector": f["sector"],
        "close": round(s["close"], 2),
        "score": score_value(s, f, c),
        "spark": spark,
        "per": round(f["per"], 1),
        "pbr": round(f["pbr"], 2),
        "div": round(f["div_yield_pct"], 2),
        "roe": round(f["roe"] * 100, 1) if f["roe"] is not None else None,
        "roic_avg": f.get("roic_avg"),
        "roic_yrs": f.get("roic_years"),
        "roic_tr": f.get("roic_trend"),
        "rsi": round(s["rsi"], 1),
        "gc": bool(s["sma25"] > s["sma50"]),
        "vt": s["value_traded20"],
    }


def growth_row(t, s, f, c, market, jp_names, spark):
    return {
        "ticker": t,
        "name": display_name(t, market, f, jp_names),
        "name_en": f["name"],
        "sector": f["sector"],
        "close": round(s["close"], 2),
        "score": score_growth(s, f, c),
        "spark": spark,
        "revg": round(f["revenue_growth"] * 100, 1),
        "epsg": round(f["earnings_growth"] * 100, 1),
        "roic_avg": f.get("roic_avg"),
        "roic_yrs": f.get("roic_years"),
        "roic_tr": f.get("roic_trend"),
        "rsi": round(s["rsi"], 1),
        "cci": round(s["cci"], 0),
        "k": round(s["stoch_k"], 1),
        "d": round(s["stoch_d"], 1),
        "dev": round((s["close"] / s["sma25"] - 1.0) * 100, 1),
        "vt": s["value_traded20"],
    }


def defensive_row(t, s, f, c, market, jp_names, spark):
    return {
        "ticker": t,
        "name": display_name(t, market, f, jp_names),
        "name_en": f["name"],
        "sector": f["sector"],
        "close": round(s["close"], 2),
        "score": score_defensive(s, f, c),
        "spark": spark,
        "div": round(f["div_yield_pct"], 2),
        "per": round(f["per"], 1),
        "roe": round(f["roe"] * 100, 1) if f["roe"] is not None else None,
        "roic_avg": f.get("roic_avg"),
        "roic_yrs": f.get("roic_years"),
        "roic_tr": f.get("roic_trend"),
        "beta": round(f["beta"], 2) if f["beta"] is not None else None,
        "rsi": round(s["rsi"], 1),
        "sma200": bool(s["sma200"] is not None and s["close"] > s["sma200"]),
        "vt": s["value_traded20"],
    }


def scenario_quotes(market: str, frames: dict) -> dict[str, dict]:
    """シナリオ別おすすめ銘柄の日次データ（終値・前日比・スパークライン）を作る。"""
    quotes = {}
    for t in scenarios.all_tickers(market):
        df = frames.get(t)
        if df is None:
            continue
        closes = df["Close"].dropna()
        if closes.empty:
            continue
        chg = (float(closes.iloc[-1]) / float(closes.iloc[-2]) - 1.0) * 100.0 if len(closes) >= 2 else None
        quotes[t] = {
            "close": round(float(closes.iloc[-1]), 2),
            "chg": round(chg, 2) if chg is not None else None,
            "spark": sparkline(df),
        }
    return quotes


def run_market(market: str, presets: dict, args, jp_names: dict) -> tuple[dict, dict, dict]:
    """市場ごとに 全プリセット×全戦略 の結果を作る。(results, stats, scenario_quotes) を返す。"""
    wl_file = BASE_DIR / ("watchlist_us.txt" if market == "US" else "watchlist_jp.txt")
    watchlist = load_universe_file(str(wl_file), market) if wl_file.exists() else []
    if market == "US":
        tickers, source = get_us_extended(use_cache=not args.no_cache, watchlist=watchlist)
    else:
        tickers, source = get_jp_extended(use_cache=not args.no_cache, watchlist=watchlist)
    if args.limit:
        tickers = tickers[:args.limit]
    # シナリオ別おすすめ銘柄は（--limit時も含め）必ず価格データを取得する
    tickers = list(dict.fromkeys(tickers + scenarios.all_tickers(market)))
    print(f"[{market}] ユニバース: {len(tickers)}銘柄（{source}）")

    frames = download_prices(tickers, f"{market}_web", use_cache=not args.no_cache)
    print(f"[{market}] 価格データ取得: {len(frames)}/{len(tickers)}")

    stale_limit = datetime.now() - timedelta(days=config.MAX_STALE_DAYS)
    snaps = {}
    for t, df in frames.items():
        snap = compute_snapshot(df)
        if snap is None:
            continue
        if pd.Timestamp(snap["date"]).tz_localize(None) < stale_limit:
            continue
        snaps[t] = snap
    print(f"[{market}] 指標計算完了: {len(snaps)}銘柄")

    # 全プリセット×全戦略のテクニカル通過銘柄
    tech: dict[tuple[str, str], list[str]] = {}
    for pname, cfg in presets.items():
        tech[(pname, "value")] = [t for t, s in snaps.items()
                                  if tech_pass_value(s, cfg["value"][market])]
        tech[(pname, "growth")] = [t for t, s in snaps.items()
                                   if tech_pass_growth(s, cfg["growth"][market])]
        tech[(pname, "defensive")] = [t for t, s in snaps.items()
                                      if tech_pass_defensive(s, cfg["defensive"][market])]

    survivors = sorted(set().union(*tech.values()))
    print(f"[{market}] テクニカル通過（全プリセット合算）: {len(survivors)}銘柄")
    funds = fetch_fundamentals(
        survivors, sleep_sec=config.INFO_FETCH_SLEEP,
        fallback_prices={t: snaps[t]["close"] for t in survivors}) if survivors else {}

    results = {}
    for pname, cfg in presets.items():
        out = {}
        c = cfg["value"][market]
        rows = [value_row(t, snaps[t], funds[t], c, market, jp_names, sparkline(frames[t]))
                for t in tech[(pname, "value")]
                if t in funds and fund_pass_value(funds[t], c)]
        out["value"] = sorted(rows, key=lambda r: -r["score"])
        c = cfg["growth"][market]
        rows = [growth_row(t, snaps[t], funds[t], c, market, jp_names, sparkline(frames[t]))
                for t in tech[(pname, "growth")]
                if t in funds and fund_pass_growth(funds[t], c)]
        out["growth"] = sorted(rows, key=lambda r: -r["score"])
        c = cfg["defensive"][market]
        rows = [defensive_row(t, snaps[t], funds[t], c, market, jp_names, sparkline(frames[t]))
                for t in tech[(pname, "defensive")]
                if t in funds and fund_pass_defensive(funds[t], c)]
        out["defensive"] = sorted(rows, key=lambda r: -r["score"])
        results[pname] = out
        print(f"[{market}] {pname}: バリュー{len(out['value'])} / グロース{len(out['growth'])}"
              f" / ディフェンシブ{len(out['defensive'])}")

    last_dates = [pd.Timestamp(s["date"]).strftime("%Y-%m-%d") for s in snaps.values()]
    stats = {
        "universe": len(tickers),
        "with_data": len(snaps),
        "source": source,
        "data_date": max(last_dates) if last_dates else None,
    }
    quotes = scenario_quotes(market, frames)
    print(f"[{market}] シナリオ銘柄の価格データ: {len(quotes)}/{len(scenarios.all_tickers(market))}")
    return results, stats, quotes


def main():
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--market", choices=["us", "jp", "all"], default="all")
    args = ap.parse_args()

    t0 = time.time()
    presets = {"standard": standard_config(), "loose": loose_config()}
    markets = ["JP", "US"] if args.market == "all" else [args.market.upper()]

    jp_names = get_jp_names(use_cache=not args.no_cache) if "JP" in markets else {}
    print(f"日本語社名マッピング: {len(jp_names)}件")

    payload = {
        "title": "銘柄選定補助ツール",
        "generated_at": datetime.now(JST).strftime("%Y-%m-%d %H:%M"),
        "markets": {},
        "presets": {p: {"value": {}, "growth": {}, "defensive": {}} for p in presets},
    }
    all_quotes: dict[str, dict] = {}
    for m in markets:
        results, stats, quotes = run_market(m, presets, args, jp_names)
        payload["markets"][m] = stats
        all_quotes.update(quotes)
        for pname, out in results.items():
            payload["presets"][pname]["value"][m] = out["value"]
            payload["presets"][pname]["growth"][m] = out["growth"]
            payload["presets"][pname]["defensive"][m] = out["defensive"]
    payload["scenarios"] = scenarios.build_payload(all_quotes)

    DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    latest = DOCS_DATA_DIR / "latest.json"
    latest.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                      encoding="utf-8")
    # 履歴も保存（将来「過去の結果」機能を作る時用）
    hist_dir = DOCS_DATA_DIR / "history"
    hist_dir.mkdir(exist_ok=True)
    (hist_dir / f"{datetime.now(JST):%Y-%m-%d}.json").write_text(
        latest.read_text(encoding="utf-8"), encoding="utf-8")

    size_kb = latest.stat().st_size / 1024
    print(f"\n出力: {latest} ({size_kb:.0f}KB)  所要 {time.time() - t0:.0f}秒")


if __name__ == "__main__":
    main()
