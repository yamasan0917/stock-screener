# -*- coding: utf-8 -*-
"""
スクリーニング閾値の設定

元仕様（Gemini Deep Research版）からの主な修正点:
  1. 配当利回り: yfinance 最新版の dividendYield は「パーセント表記」(2.54 = 2.54%)。
     元仕様の `>= 0.02` 判定は配当0.1%の銘柄まで通過させる致命的バグだったため、
     正規化処理を fundamentals.py 側で実装（閾値はパーセント単位で持つ）。
  2. 流動性: 出来高「株数」基準（US50万株/JP10万株）は株価水準で意味が変わるため
     売買代金（終値×出来高の20日平均）基準に変更。
  3. バリュー株に ROE 下限を追加（万年割安の「バリュートラップ」排除。
     JPX の資本コスト改革の文脈でも PBR と ROE はセットで見るのが標準）。
  4. グロース条件（RSI65-85 + CCI100 + ストキャ80×80 同時成立）は極めて厳しく
     該当ゼロの日が多いため、--loose プリセットを用意。

すべての閾値はこのファイルだけで変更できる。
"""

from dataclasses import dataclass


@dataclass
class ValueCriteria:
    """タブ1: バリュー株 × 上昇トレンド"""
    per_max: float            # 0 < trailingPE <= per_max
    pbr_max: float            # 0 < priceToBook <= pbr_max
    div_yield_min_pct: float  # 配当利回り（%）下限
    roe_min: float            # ROE 下限（小数: 0.08 = 8%）。0 にすれば実質無効
    min_value_traded: float   # 売買代金20日平均の下限（現地通貨）
    rsi_min: float = 40.0
    rsi_max: float = 65.0


@dataclass
class GrowthCriteria:
    """タブ2: 高成長グロース株 × モメンタム

    スタイル誤分類対策（コカ・コーラ問題）:
      成熟ディフェンシブ企業でも好決算の四半期は成長率の数字だけなら通過してしまう。
      成長企業は利益を再投資するため高配当はほぼ無い、という性質を使い
      「配当利回りが高い銘柄はグロースとみなさない」ルールを追加。
    """
    revenue_growth_min: float   # 小数 (0.15 = 15%) ※直近四半期の前年同期比
    earnings_growth_min: float  # 小数 (0.20 = 20%) ※直近四半期の前年同期比
    min_value_traded: float
    max_div_yield_pct: float = 2.0  # 配当利回りがこれを超える銘柄は除外（%）
    rsi_min: float = 65.0
    rsi_max: float = 85.0
    cci_min: float = 100.0
    stoch_k_min: float = 80.0
    stoch_d_min: float = 80.0
    max_dev_from_sma25: float = 0.20  # 25日SMAからの上方乖離率上限


# ディフェンシブとみなすセクター（yfinance の sector 表記）
DEFENSIVE_SECTORS = ("Consumer Defensive", "Utilities", "Healthcare")

# グロース戦略から除外するセクター。
# 生活必需品・公益は事業構造上「高成長企業」ではなく、好決算の四半期に
# 数字だけで通過する誤分類（コカ・コーラ問題）の温床になるため一律除外する。
# Healthcare は本物の高成長企業（創薬・医療機器）が多いので除外しない。
GROWTH_EXCLUDE_SECTORS = ("Consumer Defensive", "Utilities")


@dataclass
class DefensiveCriteria:
    """タブ3: ディフェンシブ株（安定配当 × 守り）

    景気や相場の変動に強い業種（生活必需品・公益・ヘルスケア）の中から、
    値動きが穏やかで（低ベータ）、配当が厚く、長期上昇トレンドにある銘柄を抽出。
    """
    div_yield_min_pct: float   # 配当利回り（%）下限
    per_max: float             # 0 < PER <= per_max（割高なディフェンシブは除外）
    roe_min: float             # 稼ぐ力の下限（小数）
    beta_max: float            # ベータ上限（市場より値動きが穏やか）
    min_value_traded: float
    rsi_min: float = 35.0
    rsi_max: float = 70.0
    require_above_sma200: bool = True  # 200日線の上（長期上昇トレンド）を必須にするか


# ------------------------------------------------------------
# 標準プリセット（元仕様の閾値をベースに、上記修正を反映）
# ------------------------------------------------------------

def standard_config() -> dict:
    return {
        "value": {
            "US": ValueCriteria(
                per_max=18.0, pbr_max=2.5, div_yield_min_pct=2.0,
                roe_min=0.08,
                min_value_traded=10_000_000,      # 1,000万ドル/日
            ),
            "JP": ValueCriteria(
                per_max=14.0, pbr_max=1.2, div_yield_min_pct=3.0,
                roe_min=0.08,
                min_value_traded=300_000_000,     # 3億円/日
            ),
        },
        "growth": {
            "US": GrowthCriteria(
                revenue_growth_min=0.15, earnings_growth_min=0.20,
                min_value_traded=10_000_000,
            ),
            "JP": GrowthCriteria(
                revenue_growth_min=0.15, earnings_growth_min=0.20,
                min_value_traded=300_000_000,
            ),
        },
        "defensive": {
            "US": DefensiveCriteria(
                div_yield_min_pct=2.0, per_max=22.0, roe_min=0.08,
                beta_max=1.0, min_value_traded=10_000_000,
            ),
            "JP": DefensiveCriteria(
                div_yield_min_pct=2.5, per_max=18.0, roe_min=0.08,
                beta_max=1.0, min_value_traded=300_000_000,
            ),
        },
    }


# ------------------------------------------------------------
# 緩和プリセット（--loose）: 候補が出ない日でも「惜しい銘柄」を観察できる
#
# 重要: 緩めるのは主に「テクニカル条件」。スタイルの定義
# （グロース=高成長・低配当、バリュー=割安、ディフェンシブ=守りの業種）
# まで緩めると、コカ・コーラがグロースに混ざるような誤分類が起きるため、
# 成長率の下限はわずかしか下げず、配当上限ルールはそのまま適用する。
# ------------------------------------------------------------

def loose_config() -> dict:
    return {
        "value": {
            "US": ValueCriteria(
                per_max=22.0, pbr_max=3.5, div_yield_min_pct=1.5,
                roe_min=0.05, min_value_traded=10_000_000,
                rsi_min=35.0, rsi_max=70.0,
            ),
            "JP": ValueCriteria(
                per_max=18.0, pbr_max=1.6, div_yield_min_pct=2.5,
                roe_min=0.05, min_value_traded=300_000_000,
                rsi_min=35.0, rsi_max=70.0,
            ),
        },
        "growth": {
            "US": GrowthCriteria(
                revenue_growth_min=0.12, earnings_growth_min=0.15,
                min_value_traded=10_000_000,
                rsi_min=60.0, rsi_max=90.0, cci_min=80.0,
                stoch_k_min=70.0, stoch_d_min=70.0,
                max_dev_from_sma25=0.25,
            ),
            "JP": GrowthCriteria(
                revenue_growth_min=0.12, earnings_growth_min=0.15,
                min_value_traded=300_000_000,
                rsi_min=60.0, rsi_max=90.0, cci_min=80.0,
                stoch_k_min=70.0, stoch_d_min=70.0,
                max_dev_from_sma25=0.25,
            ),
        },
        "defensive": {
            "US": DefensiveCriteria(
                div_yield_min_pct=1.5, per_max=26.0, roe_min=0.05,
                beta_max=1.15, min_value_traded=10_000_000,
                rsi_min=30.0, rsi_max=75.0, require_above_sma200=False,
            ),
            "JP": DefensiveCriteria(
                div_yield_min_pct=2.0, per_max=22.0, roe_min=0.05,
                beta_max=1.15, min_value_traded=300_000_000,
                rsi_min=30.0, rsi_max=75.0, require_above_sma200=False,
            ),
        },
    }


# .info 連続取得時のスリープ秒（HTTP 429 対策）
INFO_FETCH_SLEEP = 0.4
# yf.download のチャンクサイズとチャンク間スリープ
DOWNLOAD_CHUNK_SIZE = 80
DOWNLOAD_CHUNK_SLEEP = 1.0
# 価格データの取得期間（SMA50 + 余裕）
PRICE_PERIOD = "1y"
# 最終データがこの日数より古い銘柄は除外（上場廃止・取引停止など）
MAX_STALE_DAYS = 7
