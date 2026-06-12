# -*- coding: utf-8 -*-
"""
ファンダメンタルズデータの取得と正規化（yfinance .info）

重要な設計判断:
  - .info の取得は1銘柄ずつHTTPリクエストが走るため非常に遅く、429エラーの主因。
    そのため「テクニカル条件を通過した銘柄だけ」に絞って取得する（2段階方式）。
    元仕様のように全ユニバースへ .info を取りに行くと 700銘柄 × 0.4秒 ≒ 5分弱
    かかる上にブロックのリスクが高い。
  - dividendYield の単位問題:
      yfinance 0.2.5x 以降（この環境の 1.4.1 を含む）はパーセント表記（2.54 = 2.54%）。
      古い版は小数表記（0.0254）。バージョン依存を避けるため、
      「年間配当額 ÷ 現在株価」での再計算を第一とし、それが不可能な場合のみ
      dividendYield をパーセントとして解釈する。
"""

import time

import yfinance as yf

# .info から取得するフィールド
_FIELDS = [
    "shortName", "sector", "currentPrice",
    "trailingPE", "forwardPE", "priceToBook",
    "dividendYield", "trailingAnnualDividendRate",
    "returnOnEquity", "revenueGrowth", "earningsGrowth",
    "marketCap", "beta",
]


def _normalized_div_yield_pct(info: dict, fallback_price: float | None) -> float | None:
    """配当利回りを「%単位」で返す。配当なし→0.0、判定不能→None。"""
    price = info.get("currentPrice") or fallback_price
    rate = info.get("trailingAnnualDividendRate")
    if rate is not None and price:
        return float(rate) / float(price) * 100.0
    dy = info.get("dividendYield")
    if dy is None:
        return 0.0  # 無配
    dy = float(dy)
    # 現行 yfinance はパーセント表記。仮に古い版の小数表記(<0.25想定)が来ても
    # 「利回り25%超」はあり得ないため、1.0 未満かつ×100しても妥当なら小数とみなす
    if dy < 1.0 and 0.0 < dy * 100.0 < 25.0:
        # 0.0254(=2.54%) と 0.37(=0.37%) が区別不能なケース。
        # 現行版実測でパーセント表記を確認済みのため、パーセントとして扱う。
        return dy
    return dy if dy < 25.0 else dy / 100.0


def fetch_fundamentals(tickers: list[str], sleep_sec: float = 0.4,
                       fallback_prices: dict | None = None) -> dict[str, dict]:
    """
    テクニカル通過銘柄のファンダメンタルズを1件ずつ取得する。
    失敗した銘柄は1回だけリトライし、それでも駄目ならスキップ。
    戻り値: {ticker: 正規化済みdict}
    """
    fallback_prices = fallback_prices or {}
    results: dict[str, dict] = {}
    total = len(tickers)

    for i, t in enumerate(tickers, 1):
        info = None
        for attempt in range(2):
            try:
                info = yf.Ticker(t).info
                break
            except Exception as e:
                if attempt == 0:
                    time.sleep(2.0)  # 429等は少し長めに待ってリトライ
                else:
                    print(f"  [警告] {t}: .info 取得失敗 → スキップ ({type(e).__name__})")
        if not info:
            continue

        raw = {k: info.get(k) for k in _FIELDS}
        results[t] = {
            "name": raw["shortName"] or t,
            "sector": raw["sector"] or "-",
            "per": _positive_or_none(raw["trailingPE"]),
            "per_forward": _positive_or_none(raw["forwardPE"]),
            "pbr": _positive_or_none(raw["priceToBook"]),
            "div_yield_pct": _normalized_div_yield_pct(raw, fallback_prices.get(t)),
            "roe": _to_float(raw["returnOnEquity"]),          # 小数 (0.119 = 11.9%)
            "revenue_growth": _to_float(raw["revenueGrowth"]),    # 小数・直近四半期YoY
            "earnings_growth": _to_float(raw["earningsGrowth"]),  # 小数・直近四半期YoY
            "market_cap": _to_float(raw["marketCap"]),
            "beta": _to_float(raw["beta"]),  # 市場全体に対する値動きの大きさ（1未満=穏やか）
        }
        if i % 10 == 0 or i == total:
            print(f"  ファンダメンタルズ取得: {i}/{total}")
        time.sleep(sleep_sec)  # HTTP 429 対策

    return results


def _to_float(v) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _positive_or_none(v) -> float | None:
    f = _to_float(v)
    return f if (f is not None and f > 0) else None
