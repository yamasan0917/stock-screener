# -*- coding: utf-8 -*-
"""
対象ユニバース（銘柄リスト）の取得

- 米国株: S&P 500 構成銘柄を Wikipedia から取得
  ※ BRK.B / BF.B など「.」入りシンボルは yfinance 形式の「-」に変換する
    （元仕様はこの変換に言及しておらず、そのままだと取得失敗する）
- 日本株: 日経225 構成銘柄を Wikipedia(英語版) から正規表現で抽出し「.T」を付与
- どちらも取得結果を cache/ に JSON 保存（7日間有効）。
  取得失敗時は同梱のフォールバックリスト（主要大型株）を使用する。
- --universe-file で自前のティッカーリスト（1行1銘柄のテキスト）も指定可能。
"""

import io
import json
import re
import time
from datetime import datetime
from pathlib import Path

import requests

CACHE_DIR = Path(__file__).parent / "cache"
CACHE_TTL_DAYS = 7
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) stock-screener/1.0"}

# ------------------------------------------------------------
# フォールバックリスト（取得失敗時のみ使用 / 2026年6月時点の主要大型株）
# ------------------------------------------------------------

FALLBACK_US = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "BRK-B",
    "JPM", "V", "MA", "UNH", "XOM", "JNJ", "WMT", "PG", "LLY", "HD", "COST",
    "ORCL", "MRK", "ABBV", "CVX", "KO", "PEP", "BAC", "CRM", "TMO", "CSCO",
    "MCD", "ACN", "ADBE", "AMD", "LIN", "NFLX", "INTC", "IBM", "TXN", "GE",
    "CAT", "VZ", "T", "QCOM", "PM", "DHR", "NEE", "UNP", "SPGI", "RTX",
    "HON", "LOW", "AMGN", "INTU", "BA", "UPS", "GS", "MS", "SBUX", "BLK",
    "PFE", "CMCSA", "AXP", "DE", "BKNG", "MDT", "ADI", "GILD", "LMT", "TJX",
    "MMC", "SYK", "VRTX", "ETN", "ZTS", "CB", "PLD", "SO", "REGN", "NOW",
    "ISRG", "MU", "PANW", "SCHW", "CI", "ELV",
]

FALLBACK_JP_CODES = [
    # 食品・小売
    "2502", "2503", "2802", "2914", "3382", "8267", "9843",
    # 化学・素材・繊維
    "3402", "3407", "4063", "4188", "4452", "4911", "5108",
    # 医薬品・ヘルスケア
    "4502", "4503", "4519", "4523", "4543", "4568", "4578", "2413",
    # エネルギー・鉄鋼・非鉄
    "1605", "5020", "5401", "5411", "5713", "5801",
    # 機械・電機・精密
    "6098", "6146", "6273", "6301", "6326", "6367", "6501", "6503", "6504",
    "6594", "6645", "6701", "6702", "6723", "6752", "6758", "6857", "6861",
    "6902", "6920", "6954", "6971", "6981", "7011", "7012", "7013",
    "7733", "7741", "7751",
    # 自動車
    "7201", "7203", "7267", "7269", "7270",
    # 商社
    "8001", "8002", "8031", "8053", "8058",
    # 金融
    "8306", "8316", "8411", "8591", "8604", "8630", "8725", "8750", "8766",
    "6178",
    # 不動産・建設
    "8801", "8802", "8830", "1925", "1928",
    # 運輸
    "9020", "9021", "9022", "9101", "9104", "9107", "9201", "9202",
    # 通信・IT・サービス
    "9432", "9433", "9434", "9984", "4689", "4755", "4661", "4901", "3092",
    # ゲーム・エンタメ
    "7974", "7832", "9697", "9766",
    # 電力
    "9501", "9503",
]


def _cache_path(name: str) -> Path:
    return CACHE_DIR / f"universe_{name}.json"


def _load_cache(name: str) -> list[str] | None:
    p = _cache_path(name)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        age_days = (time.time() - data["fetched_at"]) / 86400
        if age_days <= CACHE_TTL_DAYS:
            return data["tickers"]
    except Exception:
        pass
    return None


def _save_cache(name: str, tickers: list[str]) -> None:
    CACHE_DIR.mkdir(exist_ok=True)
    _cache_path(name).write_text(
        json.dumps({"fetched_at": time.time(),
                    "fetched_date": datetime.now().strftime("%Y-%m-%d"),
                    "tickers": tickers}, ensure_ascii=False),
        encoding="utf-8",
    )


def get_sp500(use_cache: bool = True) -> tuple[list[str], str]:
    """S&P 500 構成銘柄。(tickers, source) を返す。"""
    if use_cache:
        cached = _load_cache("us")
        if cached:
            return cached, "キャッシュ"
    try:
        import pandas as pd
        url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
        r = requests.get(url, headers=UA, timeout=30)
        r.raise_for_status()
        table = pd.read_html(io.StringIO(r.text))[0]
        symbols = table["Symbol"].astype(str).str.strip().tolist()
        # yfinance 形式へ変換（BRK.B -> BRK-B）
        tickers = sorted({s.replace(".", "-") for s in symbols if s and s != "nan"})
        if len(tickers) < 400:
            raise ValueError(f"取得件数が異常: {len(tickers)}")
        _save_cache("us", tickers)
        return tickers, "Wikipedia (S&P 500)"
    except Exception as e:
        print(f"  [警告] S&P500リスト取得失敗 ({e}) → フォールバックリスト({len(FALLBACK_US)}銘柄)を使用")
        return FALLBACK_US, "フォールバック(主要大型株)"


def get_nikkei225(use_cache: bool = True) -> tuple[list[str], str]:
    """日経225 構成銘柄（.T 付与済み）。(tickers, source) を返す。"""
    if use_cache:
        cached = _load_cache("jp")
        if cached:
            return cached, "キャッシュ"
    try:
        url = "https://en.wikipedia.org/wiki/Nikkei_225"
        r = requests.get(url, headers=UA, timeout=30)
        r.raise_for_status()
        # 構成銘柄はJPXの銘柄検索URL (topSearchStr=7203 等) で埋め込まれている。
        # 285A のような新形式（英字入り）コードにも対応する。
        codes = sorted(set(re.findall(r"topSearchStr=([0-9]{3}[0-9A-Z])", r.text)))
        if len(codes) < 180:  # 225銘柄のはず。大きく欠けていたら異常とみなす
            raise ValueError(f"取得件数が異常: {len(codes)}")
        tickers = [f"{c}.T" for c in codes]
        _save_cache("jp", tickers)
        return tickers, "Wikipedia (Nikkei 225)"
    except Exception as e:
        print(f"  [警告] 日経225リスト取得失敗 ({e}) → フォールバックリスト({len(FALLBACK_JP_CODES)}銘柄)を使用")
        return [f"{c}.T" for c in FALLBACK_JP_CODES], "フォールバック(主要大型株)"


def get_nasdaq100(use_cache: bool = True) -> tuple[list[str], str]:
    """NASDAQ-100 構成銘柄。"""
    if use_cache:
        cached = _load_cache("ndx")
        if cached:
            return cached, "キャッシュ"
    try:
        import pandas as pd
        r = requests.get("https://en.wikipedia.org/wiki/Nasdaq-100", headers=UA, timeout=30)
        r.raise_for_status()
        for table in pd.read_html(io.StringIO(r.text)):
            cols = [str(c) for c in table.columns]
            if "Ticker" in cols and len(table) >= 90:
                tickers = sorted({str(s).strip().replace(".", "-")
                                  for s in table["Ticker"] if str(s).strip() != "nan"})
                _save_cache("ndx", tickers)
                return tickers, "Wikipedia (NASDAQ-100)"
        raise ValueError("構成銘柄テーブルが見つからない")
    except Exception as e:
        print(f"  [警告] NASDAQ-100リスト取得失敗 ({e}) → スキップ")
        return [], "取得失敗"


def get_sp400(use_cache: bool = True) -> tuple[list[str], str]:
    """S&P 400（中型株）構成銘柄。"""
    if use_cache:
        cached = _load_cache("sp400")
        if cached:
            return cached, "キャッシュ"
    try:
        import pandas as pd
        url = "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies"
        r = requests.get(url, headers=UA, timeout=30)
        r.raise_for_status()
        table = pd.read_html(io.StringIO(r.text))[0]
        tickers = sorted({str(s).strip().replace(".", "-")
                          for s in table["Symbol"] if str(s).strip() != "nan"})
        if len(tickers) < 300:
            raise ValueError(f"取得件数が異常: {len(tickers)}")
        _save_cache("sp400", tickers)
        return tickers, "Wikipedia (S&P 400)"
    except Exception as e:
        print(f"  [警告] S&P400リスト取得失敗 ({e}) → スキップ")
        return [], "取得失敗"


# JPX公式 上場銘柄一覧（東証全銘柄の日本語社名・市場区分・TOPIX規模区分）
JPX_DATA_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"


def get_jpx_listed(use_cache: bool = True):
    """
    JPX公式の上場銘柄一覧を DataFrame で返す（コード/銘柄名/市場区分/規模区分）。
    日本語社名のマッピングと、TOPIX500・グロース市場ユニバースの構築に使う。
    失敗時は None。
    """
    import pandas as pd
    cache_file = CACHE_DIR / "jpx_listed.json"
    if use_cache and cache_file.exists():
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            if (time.time() - data["fetched_at"]) / 86400 <= CACHE_TTL_DAYS:
                return pd.DataFrame(data["records"])
        except Exception:
            pass
    try:
        r = requests.get(JPX_DATA_URL, headers=UA, timeout=60)
        r.raise_for_status()
        df = pd.read_excel(io.BytesIO(r.content))
        df = df.rename(columns={"コード": "code", "銘柄名": "name",
                                "市場・商品区分": "market", "規模区分": "size"})
        df["code"] = df["code"].astype(str).str.strip()
        df = df[["code", "name", "market", "size"]]
        CACHE_DIR.mkdir(exist_ok=True)
        cache_file.write_text(
            json.dumps({"fetched_at": time.time(),
                        "records": df.to_dict("records")}, ensure_ascii=False),
            encoding="utf-8")
        return df
    except Exception as e:
        print(f"  [警告] JPX上場銘柄一覧の取得失敗 ({e})")
        return None


def get_jp_names(use_cache: bool = True) -> dict[str, str]:
    """{ティッカー(.T付き): 日本語社名} の辞書。取得失敗時は空dict。"""
    df = get_jpx_listed(use_cache)
    if df is None:
        return {}
    return {f"{row.code}.T": str(row.name) for row in df.itertuples()}


def get_us_extended(use_cache: bool = True, watchlist: list[str] | None = None) -> tuple[list[str], str]:
    """拡張USユニバース: S&P500 + S&P400 + NASDAQ-100 + ウォッチリスト"""
    sp500, src500 = get_sp500(use_cache)
    sp400, _ = get_sp400(use_cache)
    ndx, _ = get_nasdaq100(use_cache)
    tickers = sorted(set(sp500) | set(sp400) | set(ndx) | set(watchlist or []))
    parts = [f"S&P500:{len(sp500)}", f"S&P400:{len(sp400)}", f"NASDAQ100:{len(ndx)}"]
    if watchlist:
        parts.append(f"ウォッチリスト:{len(watchlist)}")
    return tickers, " + ".join(parts)


def get_jp_extended(use_cache: bool = True, watchlist: list[str] | None = None) -> tuple[list[str], str]:
    """
    拡張JPユニバース: TOPIX500（Core30+Large70+Mid400） + 東証グロース市場全銘柄
    + 日経225 + ウォッチリスト。JPX一覧の取得に失敗したら日経225にフォールバック。
    """
    n225, _ = get_nikkei225(use_cache)
    df = get_jpx_listed(use_cache)
    if df is None:
        tickers = sorted(set(n225) | set(watchlist or []))
        return tickers, "日経225（JPX一覧の取得失敗のためTOPIX500/グロースは未追加）"
    topix500 = df[df["size"].isin(["TOPIX Core30", "TOPIX Large70", "TOPIX Mid400"])]
    growth = df[df["market"].astype(str).str.startswith("グロース")]
    codes = set(topix500["code"]) | set(growth["code"])
    tickers = sorted({f"{c}.T" for c in codes} | set(n225) | set(watchlist or []))
    return tickers, (f"TOPIX500:{len(topix500)} + 東証グロース市場:{len(growth)}"
                     f" + 日経225 (重複除外後 {len(tickers)}銘柄)")


def load_universe_file(path: str, market: str) -> list[str]:
    """ユーザー指定のティッカーリストファイル（1行1銘柄、#コメント可）を読む。"""
    tickers = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        t = line.split("#")[0].strip()
        if not t:
            continue
        if market == "JP" and re.fullmatch(r"\d{4}[A-Z]?", t):
            t += ".T"  # 4桁コードだけ書かれていたら .T を補完
        tickers.append(t)
    return tickers
