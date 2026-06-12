# -*- coding: utf-8 -*-
"""
日米株 日次スクリーニングツール

戦略1（バリュー）: 割安 × 上昇トレンド初動
戦略2（グロース）: 高成長 × 強モメンタム（ブレイクアウト）

使い方:
    python screener.py                     # 日米両方・両戦略
    python screener.py --market jp         # 日本株のみ
    python screener.py --strategy value    # バリュー戦略のみ
    python screener.py --loose             # 緩和プリセット（候補が出ない日の観察用）
    python screener.py --limit 50          # ユニバースを先頭50銘柄に制限（動作確認用）
    python screener.py --universe-file my_list.txt --market jp   # 自前リストを使用
    python screener.py --no-cache          # 銘柄リスト/価格キャッシュを使わない

出力: コンソール表 + results/ フォルダにCSV（Excelで開ける utf-8-sig）
"""

import argparse
import pickle
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

import config
from config import standard_config, loose_config
from fundamentals import fetch_fundamentals
from indicators import compute_snapshot
from universe import get_sp500, get_nikkei225, load_universe_file

BASE_DIR = Path(__file__).parent
RESULTS_DIR = BASE_DIR / "results"
CACHE_DIR = BASE_DIR / "cache"


# ------------------------------------------------------------
# 価格データ取得
# ------------------------------------------------------------

def download_prices(tickers: list[str], market: str, use_cache: bool) -> dict[str, pd.DataFrame]:
    """yf.download で一括取得（チャンク分割）。同日中はキャッシュを再利用する。"""
    cache_file = CACHE_DIR / f"prices_{market}_{datetime.now():%Y%m%d}.pkl"
    if use_cache and cache_file.exists():
        try:
            with open(cache_file, "rb") as f:
                data = pickle.load(f)
            if set(tickers) <= set(data.keys()):
                print(f"  価格データ: 本日分キャッシュを使用 ({len(tickers)}銘柄)")
                return {t: data[t] for t in tickers}
        except Exception:
            pass

    frames: dict[str, pd.DataFrame] = {}
    chunks = [tickers[i:i + config.DOWNLOAD_CHUNK_SIZE]
              for i in range(0, len(tickers), config.DOWNLOAD_CHUNK_SIZE)]
    for ci, chunk in enumerate(chunks, 1):
        print(f"  価格データ取得: チャンク {ci}/{len(chunks)} ({len(chunk)}銘柄)")
        try:
            raw = yf.download(
                chunk, period=config.PRICE_PERIOD, interval="1d",
                auto_adjust=True,  # 調整後株価で統一（配当・分割の影響を排除）
                group_by="ticker", progress=False, threads=True,
            )
        except Exception as e:
            print(f"  [警告] チャンク{ci} 取得失敗 → スキップ ({type(e).__name__}: {e})")
            continue
        if raw is None or raw.empty:
            continue
        for t in chunk:
            try:
                df = raw[t] if isinstance(raw.columns, pd.MultiIndex) else raw
                df = df.dropna(subset=["Close"])
                if not df.empty:
                    frames[t] = df
            except (KeyError, TypeError):
                continue  # 取得失敗銘柄（上場廃止等）はスキップ
        if ci < len(chunks):
            time.sleep(config.DOWNLOAD_CHUNK_SLEEP)

    if use_cache and frames:
        CACHE_DIR.mkdir(exist_ok=True)
        with open(cache_file, "wb") as f:
            pickle.dump(frames, f)
    return frames


# ------------------------------------------------------------
# テクニカル判定
# ------------------------------------------------------------

def tech_pass_value(s: dict, c) -> bool:
    """バリュー戦略のテクニカル条件"""
    return (
        s["value_traded20"] >= c.min_value_traded
        and s["close"] > s["sma50"]                                   # トレンド水準
        and (s["sma25"] > s["sma50"] or s["cross_up_50_recent"])      # トレンド好転
        and s["macd"] > s["macd_signal"]                              # MACD好転
        and c.rsi_min <= s["rsi"] <= c.rsi_max                        # 過熱感の排除
    )


def tech_pass_growth(s: dict, c) -> bool:
    """グロース戦略のテクニカル条件"""
    dev = s["close"] / s["sma25"] - 1.0
    return (
        s["value_traded20"] >= c.min_value_traded
        and c.rsi_min <= s["rsi"] <= c.rsi_max                        # モメンタム
        and s["cci"] >= c.cci_min                                     # ブレイクアウト
        and s["stoch_k"] >= c.stoch_k_min and s["stoch_d"] >= c.stoch_d_min  # エンベデッド
        and s["close"] > s["sma25"]                                   # 上昇トレンド
        and dev <= c.max_dev_from_sma25                               # 過度な急騰の排除
    )


# ------------------------------------------------------------
# ファンダメンタルズ判定
# ------------------------------------------------------------

def fund_pass_value(f: dict, c) -> bool:
    if f["per"] is None or f["per"] > c.per_max:
        return False
    if f["pbr"] is None or f["pbr"] > c.pbr_max:
        return False
    if f["div_yield_pct"] is None or f["div_yield_pct"] < c.div_yield_min_pct:
        return False
    if c.roe_min > 0 and (f["roe"] is None or f["roe"] < c.roe_min):
        return False
    return True


def fund_pass_growth(f: dict, c) -> bool:
    # --- スタイル誤分類対策（コカ・コーラ問題） ---
    # 成熟ディフェンシブ企業でも好決算の四半期は成長率だけなら通過してしまうため、
    # (1) 生活必需品・公益セクターはグロースとみなさない
    # (2) 高配当（利益を成長投資に回していない）銘柄はグロースとみなさない
    if f["sector"] in config.GROWTH_EXCLUDE_SECTORS:
        return False
    if f["div_yield_pct"] is not None and f["div_yield_pct"] > c.max_div_yield_pct:
        return False
    # 成長率が取得できない銘柄（金融など）は判定不能としてスキップ
    if f["revenue_growth"] is None or f["revenue_growth"] < c.revenue_growth_min:
        return False
    if f["earnings_growth"] is None or f["earnings_growth"] < c.earnings_growth_min:
        return False
    return True


def tech_pass_defensive(s: dict, c) -> bool:
    """ディフェンシブ戦略のテクニカル条件（緩め。主役はファンダ側の業種・配当・ベータ）"""
    if s["value_traded20"] < c.min_value_traded:
        return False
    if not (c.rsi_min <= s["rsi"] <= c.rsi_max):
        return False
    if c.require_above_sma200:
        # 200日分のデータがない銘柄は長期トレンドを判定できないので除外
        if s["sma200"] is None or s["close"] <= s["sma200"]:
            return False
    return True


def fund_pass_defensive(f: dict, c) -> bool:
    if f["sector"] not in config.DEFENSIVE_SECTORS:
        return False
    if f["div_yield_pct"] is None or f["div_yield_pct"] < c.div_yield_min_pct:
        return False
    if f["per"] is None or f["per"] > c.per_max:
        return False
    if c.roe_min > 0 and (f["roe"] is None or f["roe"] < c.roe_min):
        return False
    # ベータ未取得（None）は欠損として許容。取得できていて市場より荒い銘柄は除外
    if f["beta"] is not None and f["beta"] > c.beta_max:
        return False
    return True


# ------------------------------------------------------------
# スコアリング（0〜100点 / 初心者向けの並び順の目安。売買判断そのものではない）
# ------------------------------------------------------------

def score_value(s: dict, f: dict, c) -> float:
    pts = 0.0
    pts += 25.0 * max(0.0, (c.per_max - f["per"]) / c.per_max)            # PERの余裕
    pts += 25.0 * max(0.0, (c.pbr_max - f["pbr"]) / c.pbr_max)            # PBRの余裕
    pts += 25.0 * min(1.0, f["div_yield_pct"] / (c.div_yield_min_pct * 2))  # 配当の厚み
    trend = 0.0
    if s["sma25"] > s["sma50"]:
        trend += 10.0
    if s["cross_up_50_recent"]:
        trend += 5.0   # 初動シグナルはボーナス
    if s["macd_hist"] > 0:
        trend += 5.0
    if 45.0 <= s["rsi"] <= 60.0:
        trend += 5.0   # 過熱でも弱すぎでもない帯
    pts += trend
    return round(min(pts, 100.0), 1)


def score_growth(s: dict, f: dict, c) -> float:
    pts = 0.0
    pts += 30.0 * min(1.0, f["revenue_growth"] / (c.revenue_growth_min * 3))
    pts += 30.0 * min(1.0, f["earnings_growth"] / (c.earnings_growth_min * 3))
    rsi_span = max(1e-9, c.rsi_max - c.rsi_min)
    pts += 20.0 * min(1.0, (s["rsi"] - c.rsi_min) / rsi_span)             # モメンタムの強さ
    dev = s["close"] / s["sma25"] - 1.0
    pts += 20.0 * max(0.0, 1.0 - dev / c.max_dev_from_sma25)              # 乖離の余地（押し目度）
    return round(min(pts, 100.0), 1)


def score_defensive(s: dict, f: dict, c) -> float:
    pts = 0.0
    pts += 35.0 * min(1.0, f["div_yield_pct"] / (c.div_yield_min_pct * 2))  # 配当の厚み
    beta = f["beta"] if f["beta"] is not None else c.beta_max
    pts += 25.0 * max(0.0, min(1.0, (c.beta_max - beta) / c.beta_max))      # 値動きの穏やかさ
    pts += 20.0 * max(0.0, (c.per_max - f["per"]) / c.per_max)              # 割高でない
    trend = 0.0
    if s["sma200"] is not None and s["close"] > s["sma200"]:
        trend += 10.0  # 長期上昇トレンド
    if s["sma25"] > s["sma50"]:
        trend += 5.0
    if 40.0 <= s["rsi"] <= 60.0:
        trend += 5.0   # 過熱でも売られすぎでもない帯
    pts += trend
    return round(min(pts, 100.0), 1)


# ------------------------------------------------------------
# 結果整形
# ------------------------------------------------------------

def _fmt_value_traded(v: float, market: str) -> str:
    if market == "JP":
        return f"{v / 1e8:.1f}億円"
    return f"${v / 1e6:.0f}M"


def build_value_rows(passed: list[str], snaps: dict, funds: dict, c, market: str) -> pd.DataFrame:
    rows = []
    for t in passed:
        s, f = snaps[t], funds[t]
        rows.append({
            "ティッカー": t,
            "銘柄名": str(f["name"])[:18],
            "終値": round(s["close"], 2),
            "PER": round(f["per"], 1),
            "PBR": round(f["pbr"], 2),
            "配当%": round(f["div_yield_pct"], 2),
            "ROE%": round(f["roe"] * 100, 1) if f["roe"] is not None else None,
            "RSI": round(s["rsi"], 1),
            "MACD-Sig": round(s["macd_hist"], 2),
            "GC": "○" if s["sma25"] > s["sma50"] else "△",
            "売買代金": _fmt_value_traded(s["value_traded20"], market),
            "セクター": f["sector"],
            "スコア": score_value(s, f, c),
        })
    df = pd.DataFrame(rows)
    return df.sort_values("スコア", ascending=False).reset_index(drop=True) if not df.empty else df


def build_growth_rows(passed: list[str], snaps: dict, funds: dict, c, market: str) -> pd.DataFrame:
    rows = []
    for t in passed:
        s, f = snaps[t], funds[t]
        rows.append({
            "ティッカー": t,
            "銘柄名": str(f["name"])[:18],
            "終値": round(s["close"], 2),
            "売上成長%": round(f["revenue_growth"] * 100, 1),
            "EPS成長%": round(f["earnings_growth"] * 100, 1),
            "RSI": round(s["rsi"], 1),
            "CCI": round(s["cci"], 0),
            "%K": round(s["stoch_k"], 1),
            "%D": round(s["stoch_d"], 1),
            "乖離%": round((s["close"] / s["sma25"] - 1.0) * 100, 1),
            "売買代金": _fmt_value_traded(s["value_traded20"], market),
            "セクター": f["sector"],
            "スコア": score_growth(s, f, c),
        })
    df = pd.DataFrame(rows)
    return df.sort_values("スコア", ascending=False).reset_index(drop=True) if not df.empty else df


def build_defensive_rows(passed: list[str], snaps: dict, funds: dict, c, market: str) -> pd.DataFrame:
    rows = []
    for t in passed:
        s, f = snaps[t], funds[t]
        above200 = s["sma200"] is not None and s["close"] > s["sma200"]
        rows.append({
            "ティッカー": t,
            "銘柄名": str(f["name"])[:18],
            "終値": round(s["close"], 2),
            "配当%": round(f["div_yield_pct"], 2),
            "PER": round(f["per"], 1),
            "ROE%": round(f["roe"] * 100, 1) if f["roe"] is not None else None,
            "ベータ": round(f["beta"], 2) if f["beta"] is not None else None,
            "RSI": round(s["rsi"], 1),
            "200日線": "○" if above200 else "×",
            "売買代金": _fmt_value_traded(s["value_traded20"], market),
            "セクター": f["sector"],
            "スコア": score_defensive(s, f, c),
        })
    df = pd.DataFrame(rows)
    return df.sort_values("スコア", ascending=False).reset_index(drop=True) if not df.empty else df


def print_section(title: str, df: pd.DataFrame):
    bar = "=" * 78
    print(f"\n{bar}\n  {title}\n{bar}")
    if df.empty:
        print("  該当銘柄なし（条件が厳しめです。--loose で緩和条件も確認できます）")
    else:
        print(df.to_string(index=False))


# ------------------------------------------------------------
# メイン
# ------------------------------------------------------------

def run_market(market: str, strategies: list[str], cfg: dict, args) -> dict[str, pd.DataFrame]:
    label = "米国株 (S&P 500)" if market == "US" else "日本株 (日経225)"
    print(f"\n──── {label} ────")

    # 1) ユニバース
    if args.universe_file:
        tickers = load_universe_file(args.universe_file, market)
        source = f"指定ファイル ({args.universe_file})"
    elif market == "US":
        tickers, source = get_sp500(use_cache=not args.no_cache)
    else:
        tickers, source = get_nikkei225(use_cache=not args.no_cache)
    if args.limit:
        tickers = tickers[:args.limit]
    print(f"  ユニバース: {len(tickers)}銘柄（出所: {source}）")

    # 2) 価格データ一括取得 → テクニカル指標
    frames = download_prices(tickers, market, use_cache=not args.no_cache)
    print(f"  価格データ取得成功: {len(frames)}/{len(tickers)}銘柄")

    stale_limit = datetime.now() - timedelta(days=config.MAX_STALE_DAYS)
    snaps: dict[str, dict] = {}
    for t, df in frames.items():
        snap = compute_snapshot(df)
        if snap is None:
            continue
        last_date = pd.Timestamp(snap["date"]).tz_localize(None)
        if last_date < stale_limit:
            continue  # 古いデータ（取引停止・上場廃止など）は除外
        snaps[t] = snap
    print(f"  指標計算完了: {len(snaps)}銘柄")

    # 3) テクニカル1次スクリーニング（ここで絞ってから .info を取りに行く）
    tech_value = [t for t, s in snaps.items()
                  if "value" in strategies and tech_pass_value(s, cfg["value"][market])]
    tech_growth = [t for t, s in snaps.items()
                   if "growth" in strategies and tech_pass_growth(s, cfg["growth"][market])]
    tech_defensive = [t for t, s in snaps.items()
                      if "defensive" in strategies and tech_pass_defensive(s, cfg["defensive"][market])]
    survivors = sorted(set(tech_value) | set(tech_growth) | set(tech_defensive))
    print(f"  テクニカル通過: バリュー {len(tech_value)}銘柄 / グロース {len(tech_growth)}銘柄"
          f" / ディフェンシブ {len(tech_defensive)}銘柄")

    # 4) 通過銘柄のみファンダメンタルズ取得
    funds = {}
    if survivors:
        prices = {t: snaps[t]["close"] for t in survivors}
        funds = fetch_fundamentals(survivors, sleep_sec=config.INFO_FETCH_SLEEP,
                                   fallback_prices=prices)

    # 5) 最終判定
    out: dict[str, pd.DataFrame] = {}
    if "value" in strategies:
        c = cfg["value"][market]
        final = [t for t in tech_value if t in funds and fund_pass_value(funds[t], c)]
        out["value"] = build_value_rows(final, snaps, funds, c, market)
    if "growth" in strategies:
        c = cfg["growth"][market]
        final = [t for t in tech_growth if t in funds and fund_pass_growth(funds[t], c)]
        out["growth"] = build_growth_rows(final, snaps, funds, c, market)
    if "defensive" in strategies:
        c = cfg["defensive"][market]
        final = [t for t in tech_defensive if t in funds and fund_pass_defensive(funds[t], c)]
        out["defensive"] = build_defensive_rows(final, snaps, funds, c, market)
    return out


def main():
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    pd.set_option("display.unicode.east_asian_width", True)  # 日本語の列幅ずれ対策
    pd.set_option("display.width", 200)

    ap = argparse.ArgumentParser(description="日米株 日次スクリーニングツール")
    ap.add_argument("--market", choices=["us", "jp", "all"], default="all")
    ap.add_argument("--strategy", choices=["value", "growth", "defensive", "all"], default="all")
    ap.add_argument("--loose", action="store_true", help="緩和プリセットを使用")
    ap.add_argument("--limit", type=int, default=None, help="ユニバース先頭N銘柄に制限（動作確認用）")
    ap.add_argument("--no-cache", action="store_true", help="銘柄リスト・価格キャッシュを使わない")
    ap.add_argument("--no-csv", action="store_true", help="CSV出力を行わない")
    ap.add_argument("--universe-file", default=None, help="自前ティッカーリスト（1行1銘柄）")
    args = ap.parse_args()

    markets = ["US", "JP"] if args.market == "all" else [args.market.upper()]
    strategies = ["value", "growth", "defensive"] if args.strategy == "all" else [args.strategy]
    cfg = loose_config() if args.loose else standard_config()
    preset = "緩和(--loose)" if args.loose else "標準"

    t0 = time.time()
    print(f"日米株スクリーニング  実行日時: {datetime.now():%Y-%m-%d %H:%M}  プリセット: {preset}")

    all_results: dict[tuple[str, str], pd.DataFrame] = {}
    for m in markets:
        res = run_market(m, strategies, cfg, args)
        for strat, df in res.items():
            all_results[(strat, m)] = df

    # ---- 出力 ----
    strat_label = {"value": "タブ1【バリュー株 × 上昇トレンド】",
                   "growth": "タブ2【高成長グロース株 × モメンタム】",
                   "defensive": "タブ3【ディフェンシブ株 × 安定配当】"}
    mkt_label = {"US": "米国株", "JP": "日本株"}
    for strat in ["value", "growth", "defensive"]:
        for m in markets:
            if (strat, m) in all_results:
                print_section(f"{strat_label[strat]} — {mkt_label[m]}", all_results[(strat, m)])

    if not args.no_csv:
        RESULTS_DIR.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d")
        for (strat, m), df in all_results.items():
            if df.empty:
                continue
            path = RESULTS_DIR / f"screen_{stamp}_{strat}_{m.lower()}.csv"
            df.to_csv(path, index=False, encoding="utf-8-sig")
            print(f"\nCSV保存: {path}")

    print(f"\n完了（所要 {time.time() - t0:.0f}秒）")
    print("※ 本ツールは情報提供のみを目的とし、投資勧誘・売買推奨ではありません。")


if __name__ == "__main__":
    main()
