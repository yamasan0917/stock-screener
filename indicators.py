# -*- coding: utf-8 -*-
"""
テクニカル指標計算モジュール（純pandas実装）

pandas_ta を使わない理由:
  - pandas_ta はメンテナンスが停止しており、numpy 2.x で `numpy.NaN` の
    import エラーが発生する（この環境は pandas 3.0 / numpy 2.x のため動作不能）
  - SMA/RSI/MACD/CCI/ストキャスティクスは標準的な定義で自前実装可能であり、
    依存を減らした方が長期的に壊れにくい

各指標は TradingView / 証券会社ツールと同じ標準的な定義:
  - RSI: Wilder 平滑化（単純平均ではない点に注意）
  - MACD: EMA(12) - EMA(26)、シグナル = MACDのEMA(9)
  - CCI: (TP - SMA(TP,20)) / (0.015 * 平均偏差)
  - ストキャスティクス: スロー(14,3,3) — %K=SMA3(Fast%K), %D=SMA3(%K)
"""

import pandas as pd


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(window=period, min_periods=period).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """RSI（Wilder方式）。pandas_ta / TradingView の RSI と一致する。"""
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    # Wilder の平滑移動平均 = ewm(alpha=1/period)
    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss
    out = 100.0 - (100.0 / (1.0 + rs))
    # 下落が一切ない期間は avg_loss=0 で inf になるため 100 に丸める
    out = out.where(avg_loss != 0, 100.0)
    return out


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    """MACD。(macd_line, signal_line, histogram) を返す。"""
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def cci(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 20) -> pd.Series:
    tp = (high + low + close) / 3.0
    tp_sma = tp.rolling(window=period, min_periods=period).mean()
    # 平均偏差（mean absolute deviation）
    mad = tp.rolling(window=period, min_periods=period).apply(
        lambda x: (abs(x - x.mean())).mean(), raw=True
    )
    return (tp - tp_sma) / (0.015 * mad)


def stochastic_slow(high: pd.Series, low: pd.Series, close: pd.Series,
                    k_period: int = 14, smooth_k: int = 3, d_period: int = 3):
    """スローストキャスティクス。(%K, %D) を返す。"""
    lowest = low.rolling(window=k_period, min_periods=k_period).min()
    highest = high.rolling(window=k_period, min_periods=k_period).max()
    fast_k = 100.0 * (close - lowest) / (highest - lowest)
    slow_k = fast_k.rolling(window=smooth_k, min_periods=smooth_k).mean()
    slow_d = slow_k.rolling(window=d_period, min_periods=d_period).mean()
    return slow_k, slow_d


def atr_pct(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    """ATR（Wilder平滑化）を株価比%で返す。「1日にだいたい何%動くか」の体感指標。"""
    prev_close = close.shift(1)
    tr = pd.concat([high - low,
                    (high - prev_close).abs(),
                    (low - prev_close).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    return atr / close * 100.0


def crossed_above_recently(fast: pd.Series, slow: pd.Series, lookback: int = 5) -> bool:
    """直近 lookback 営業日以内に fast が slow を下から上に抜けたか。"""
    above = fast > slow
    cross_up = above & (~above.shift(1).fillna(False))
    tail = cross_up.tail(lookback)
    return bool(tail.any())


def compute_snapshot(df: pd.DataFrame) -> dict | None:
    """
    1銘柄分のOHLCV DataFrameから最新営業日のテクニカル指標スナップショットを作る。
    データ不足・欠損の場合は None を返す（仕様の「当該銘柄をスキップ」に対応）。
    """
    df = df.dropna(subset=["Close"])
    if len(df) < 120:  # SMA50 + 安定計算に必要な最低本数（新規上場などは除外）
        return None

    close, high, low, vol = df["Close"], df["High"], df["Low"], df["Volume"]

    sma25 = sma(close, 25)
    sma50 = sma(close, 50)
    sma200 = sma(close, 200)  # ディフェンシブ戦略の長期トレンド判定用（データ不足時はNaN）
    rsi14 = rsi(close, 14)
    macd_line, signal_line, hist = macd(close)
    cci20 = cci(high, low, close, 20)
    stoch_k, stoch_d = stochastic_slow(high, low, close)
    # 流動性は出来高「株数」ではなく売買代金（終値×出来高）の20日平均で判定する
    value_traded20 = (close * vol).rolling(20, min_periods=20).mean()
    atr14 = atr_pct(high, low, close, 14)
    # 52週高値からの距離（終値ベース）。上場1年未満は取得できた期間の高値で代用
    high_52w = close.rolling(252, min_periods=120).max()

    last = -1
    snap = {
        "date": df.index[last],
        "close": float(close.iloc[last]),
        "sma25": float(sma25.iloc[last]),
        "sma50": float(sma50.iloc[last]),
        # 上場1年未満などで200日分ない場合は None（ディフェンシブ判定側で扱う）
        "sma200": None if pd.isna(sma200.iloc[last]) else float(sma200.iloc[last]),
        "rsi": float(rsi14.iloc[last]),
        "macd": float(macd_line.iloc[last]),
        "macd_signal": float(signal_line.iloc[last]),
        "macd_hist": float(hist.iloc[last]),
        "cci": float(cci20.iloc[last]),
        "stoch_k": float(stoch_k.iloc[last]),
        "stoch_d": float(stoch_d.iloc[last]),
        "value_traded20": float(value_traded20.iloc[last]),
        "cross_up_50_recent": crossed_above_recently(close, sma50, lookback=5),
        # 参考表示用（欠損しても銘柄をスキップしない）
        "atr_pct": None if pd.isna(atr14.iloc[last]) else float(atr14.iloc[last]),
        "high_52w_dist": (None if pd.isna(high_52w.iloc[last]) or high_52w.iloc[last] <= 0
                          else float(close.iloc[last] / high_52w.iloc[last] - 1.0)),
    }
    # 主要値に NaN が混じる銘柄はスキップ
    for key in ("close", "sma25", "sma50", "rsi", "macd", "cci", "stoch_k", "stoch_d", "value_traded20"):
        if pd.isna(snap[key]):
            return None
    return snap
