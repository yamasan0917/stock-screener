# -*- coding: utf-8 -*-
"""
ROIC（投下資本利益率）の年次履歴計算

ROIC = NOPAT ÷ 投下資本
  NOPAT     = 営業利益 × (1 − 実効税率)
  投下資本   = 有利子負債 + 株主資本（yfinance の "Invested Capital" 行）
              当年と前年の平均を使う（期中平均の近似）

設計判断:
  - 分子は EBIT ではなく Operating Income を優先する。
    yfinance の EBIT は「税引前利益 + 支払利息」で計算されており、
    Alphabet の持分証券評価益のような営業外損益が混入する（2025年実測で
    EBIT 159.6B vs 営業利益 129.0B）。事業の資本効率を測る指標としては
    営業利益が適切。Operating Income が無い銘柄のみ EBIT で代用する。
  - 実効税率 = 法人税 ÷ 税引前利益。赤字や一時的な税還付で異常値になる
    ため 0〜45% にクランプし、計算不能時は 25%（主要国の標準的な実効税率）。
  - 金融株（銀行・保険）は営業利益・投下資本の概念が合わないため
    データが取れず None になる。これは仕様（ハードフィルタにしない理由）。
  - yfinance の年次財務諸表は直近4年分。「過去5年平均」が業界標準だが
    データソースの制約上、最大4年平均となる（表示には年数を必ず併記）。
  - .income_stmt / .balance_sheet は銘柄ごとに2リクエスト走るため、
    テクニカル通過銘柄に限定したうえで7日間ディスクキャッシュする
    （財務諸表は四半期更新なので7日で十分鮮度が保てる）。
"""

import json
import time
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

CACHE_FILE = Path(__file__).parent / "cache" / "roic_cache.json"
CACHE_TTL_DAYS = 7

# ROIC計算で許容する実効税率の範囲（外れたら異常値としてデフォルトに置換）
_TAX_MIN, _TAX_MAX, _TAX_DEFAULT = 0.0, 0.45, 0.25
# 1年あたり±この幅（パーセントポイント）を超える回帰直線の傾きで増加/減少と判定
_TREND_SLOPE_PP = 1.5

_EMPTY = {"roic_latest": None, "roic_avg": None, "roic_years": 0,
          "roic_trend": None, "roic_std": None}


def _load_cache() -> dict:
    if not CACHE_FILE.exists():
        return {}
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_cache(cache: dict):
    CACHE_FILE.parent.mkdir(exist_ok=True)
    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")


def _row(df: pd.DataFrame, *names):
    """財務諸表から最初に見つかった行を Series で返す（無ければ None）。"""
    for n in names:
        if n in df.index:
            return df.loc[n]
    return None


def _yearly_roic(tk: yf.Ticker) -> list[float]:
    """年次ROIC（%）を古い年→新しい年の順で返す。計算不能な年はスキップ。"""
    inc = tk.income_stmt
    bs = tk.balance_sheet
    if inc is None or bs is None or inc.empty or bs.empty:
        return []

    op = _row(inc, "Operating Income", "EBIT")
    pretax = _row(inc, "Pretax Income")
    tax = _row(inc, "Tax Provision")
    ic = _row(bs, "Invested Capital")
    if ic is None:
        debt = _row(bs, "Total Debt")
        eq = _row(bs, "Total Equity Gross Minority Interest", "Stockholders Equity")
        if debt is not None and eq is not None:
            ic = debt.add(eq, fill_value=0)
    if op is None or ic is None:
        return []

    # 列（決算期）は新しい順に並んでいる。古い順に処理する
    cols = sorted([c for c in inc.columns if c in ic.index or c in bs.columns])
    out = []
    prev_ic = None
    for c in cols:
        ebit = op.get(c)
        cap = ic.get(c) if hasattr(ic, "get") else None
        if ebit is None or pd.isna(ebit) or cap is None or pd.isna(cap) or cap <= 0:
            prev_ic = cap if (cap is not None and not pd.isna(cap)) else prev_ic
            continue
        # 実効税率
        rate = _TAX_DEFAULT
        if pretax is not None and tax is not None:
            p, x = pretax.get(c), tax.get(c)
            if p is not None and x is not None and not pd.isna(p) and not pd.isna(x) and p > 0:
                rate = min(_TAX_MAX, max(_TAX_MIN, float(x) / float(p)))
        nopat = float(ebit) * (1.0 - rate)
        avg_cap = (float(cap) + float(prev_ic)) / 2.0 if (prev_ic is not None and prev_ic > 0) else float(cap)
        roic = nopat / avg_cap * 100.0
        if -100.0 <= roic <= 300.0:  # 異常値（極小資本など）は捨てる
            out.append(round(roic, 2))
        prev_ic = float(cap)
    return out


def _summarize(series: list[float]) -> dict:
    """年次ROIC系列から表示用サマリーを作る。"""
    if not series:
        return dict(_EMPTY)
    n = len(series)
    avg = sum(series) / n
    latest = series[-1]
    std = (sum((v - avg) ** 2 for v in series) / n) ** 0.5 if n >= 2 else None
    trend = None
    if n >= 3:
        # 最小二乗法の傾き（pp/年）。3〜4点なので単純実装で十分
        xs = list(range(n))
        xm, ym = sum(xs) / n, avg
        denom = sum((x - xm) ** 2 for x in xs)
        slope = sum((x - xm) * (y - ym) for x, y in zip(xs, series)) / denom
        trend = "up" if slope >= _TREND_SLOPE_PP else ("down" if slope <= -_TREND_SLOPE_PP else "flat")
    return {
        "roic_latest": round(latest, 1),
        "roic_avg": round(avg, 1),
        "roic_years": n,
        "roic_trend": trend,
        "roic_std": round(std, 1) if std is not None else None,
    }


def fetch_roic(tickers: list[str], sleep_sec: float = 0.3,
               use_cache: bool = True) -> dict[str, dict]:
    """
    複数銘柄のROICサマリーを取得する。
    戻り値: {ticker: {roic_latest, roic_avg, roic_years, roic_trend, roic_std}}
      - roic_latest/avg/std: %単位。計算不能（金融株など）は None
      - roic_years: 平均の対象年数（0〜4）。3未満は信頼度低（IPO直後など）
      - roic_trend: "up"/"flat"/"down"。3年分未満は None
    """
    cache = _load_cache() if use_cache else {}
    limit = (datetime.now() - timedelta(days=CACHE_TTL_DAYS)).strftime("%Y-%m-%d")
    results: dict[str, dict] = {}
    fetched = 0
    total = len(tickers)

    for i, t in enumerate(tickers, 1):
        hit = cache.get(t)
        if hit and hit.get("fetched", "") >= limit:
            results[t] = {k: hit.get(k) for k in _EMPTY}
            continue
        summary = dict(_EMPTY)
        for attempt in range(2):
            try:
                summary = _summarize(_yearly_roic(yf.Ticker(t)))
                break
            except Exception as e:
                if attempt == 0:
                    time.sleep(2.0)
                else:
                    print(f"  [警告] {t}: ROIC計算失敗 → 欠損扱い ({type(e).__name__})")
        results[t] = summary
        cache[t] = {"fetched": datetime.now().strftime("%Y-%m-%d"), **summary}
        fetched += 1
        if i % 10 == 0 or i == total:
            print(f"  ROIC取得: {i}/{total}（新規 {fetched}件）")
        time.sleep(sleep_sec)

    if use_cache and fetched:
        _save_cache(cache)
    return results


if __name__ == "__main__":
    # 動作確認: python roic.py AAPL GOOGL 7203.T
    import sys
    args = sys.argv[1:] or ["AAPL", "GOOGL", "MSFT", "7203.T"]
    for t, r in fetch_roic(args, use_cache=False).items():
        print(t, r)
