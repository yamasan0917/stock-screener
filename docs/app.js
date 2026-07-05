/* 本日のおすすめ銘柄 — フロントエンドロジック（ビルド不要のVanilla JS） */
"use strict";

const state = {
  data: null,
  market: "JP",
  strategy: "value",
  scoreStrategy: "value",  // スコア計算に使う戦略（シナリオ選択中は直前の戦略を保持）
  preset: "standard",
  sortKey: "score",
  sortDesc: true,
  watchlist: new Set(JSON.parse(
    localStorage.getItem("watchlist") || localStorage.getItem("favorites") || "[]"
  )),
  scenarioGroup: null,   // 選択中のシナリオ（中東情勢など）
  scenarioOpt: {},       // シナリオごとの選択肢 {groupId: optionId}
};

// 統一列定義 — どの戦略を選んでも全指標を同じ並びで表示する。
// スコア列は選択中の戦略に応じて score_value / score_growth / score_defensive を切り替える。
const UNIFIED_COLUMNS = [
  { key: "score",    label: "スコア",     type: "score",      tip: "選択中の戦略基準で算出したスコア（0〜100）。戦略タブを切り替えると、その戦略向けに再計算した値に変わります。「—」はその戦略の判定に必要な指標が取得できない銘柄（例: 金融株はグロース系の成長率が無いためグロースのスコアが付きません）" },
  { key: "close",    label: "終値",       type: "num",        tip: "最新の終値" },
  { key: "per",      label: "PER",       type: "num",        tip: "株価収益率。低いほど利益に対して割安（バリュー・ディフェンシブの判定に使用）" },
  { key: "fpe",      label: "予想PER",    type: "num",        tip: "来期の予想利益ベースのPER。実績PERより低ければ増益予想（アナリスト予想ベースの参考値）" },
  { key: "pbr",      label: "PBR",       type: "num",        tip: "株価純資産倍率。低いほど資産に対して割安（バリューの判定に使用）" },
  { key: "div",      label: "配当",       type: "pct",        tip: "配当利回り（年率・税引前。バリュー・ディフェンシブの判定に使用）" },
  { key: "roe",      label: "ROE",       type: "pct",        tip: "自己資本利益率。会社の稼ぐ力（日本株8%・米国株10%以上が抽出条件）" },
  { key: "de",       label: "D/E",       type: "de_ratio",   tip: "負債÷自己資本の比率。借金の多さの目安。2倍超は赤、1倍超は琥珀。銀行・保険・公益は業種特性上、高くなりやすい" },
  { key: "payout",   label: "配当性向",   type: "payout",     tip: "配当額÷純利益。85%超は減配リスク（琥珀）、100%超はタコ足配当（赤）。ディフェンシブのスコアに反映" },
  { key: "fcf",      label: "FCF利回り",  type: "fcf",        tip: "フリーキャッシュフロー÷時価総額。会社が実際に生み出す現金の利回り。マイナス（赤）は現金流出中＝配当の持続性に注意" },
  { key: "revg",     label: "売上成長",   type: "pctSigned",  tip: "直近四半期の売上・前年同期比（グロースの判定に使用。15%以上が条件）" },
  { key: "epsg",     label: "EPS成長",    type: "pctSigned",  tip: "1株利益の前年同期比（グロースの判定に使用。20%以上が条件）" },
  { key: "gpath",    label: "型",         type: "gpath",      tip: "グロースの通過経路。🚀ブレイク=強い上昇の真っ最中（順張り） / 🎯押し目=上昇トレンド中の過熱が冷めた局面（高値掴みしにくい）" },
  { key: "roic_avg", label: "ROIC平均",   type: "roic_val",   tip: "投下資本利益率の過去平均（括弧内はデータ年数）。10%以上が優良の目安。銀行・保険は業種特性上、計算対象外（—）。全戦略のスコアにボーナス加点" },
  { key: "roic_avg", label: "ROIC傾向",   type: "roic_trend", tip: "ROICの直近トレンド。↗=改善傾向（競争優位が強まるシグナル）、↘=悪化傾向、—=データ不足またはほぼ横ばい" },
  { key: "beta",     label: "ベータ",     type: "num",        tip: "市場全体に対する値動きの大きさ。1未満=市場より穏やか（ディフェンシブは1.0以下が条件）" },
  { key: "atr",      label: "1日変動",    type: "atr",        tip: "ATR(14日)÷株価。1日にだいたい何%動くかの目安。±5%超（琥珀）は値動きが荒く、±8%超（赤）はかなり荒い" },
  { key: "rsi",      label: "RSI",       type: "num",        tip: "買われすぎ・売られすぎの体温計（0〜100）。70以上は過熱、30以下は売られすぎ" },
  { key: "cci",      label: "CCI",       type: "num",        tip: "勢い（モメンタム）を測る指標。100以上はブレイクアウト状態（グロースの判定に使用）" },
  { key: "dev",      label: "乖離",       type: "pctSigned",  tip: "25日移動平均線からの上方乖離率。大きすぎる（急騰しすぎ）銘柄はグロースで除外" },
  { key: "h52",      label: "52週高値比", type: "h52",        tip: "52週高値からの下落率。0%に近いほど高値圏でトレンド健在。-30%超（琥珀）は長期トレンドが崩れている可能性" },
  { key: "gc",       label: "短期トレンド", type: "gc",        tip: "○=25日線が50日線の上（ゴールデンクロス状態）" },
  { key: "sma200",   label: "長期トレンド", type: "sma200",    tip: "○=終値が200日移動平均線の上（長期上昇トレンド。ディフェンシブの必須条件）" },
];

// スコア計算に使う戦略（シナリオ選択中は直前に選んだ戦略を使う）
function scoreStrategy() {
  return state.strategy === "scenario" ? state.scoreStrategy : state.strategy;
}

// 行の「現在の戦略における」スコアを取り出す
function effScore(r) {
  return r["score_" + scoreStrategy()];
}

function rows() {
  const p = state.data?.presets?.[state.preset];
  return (p?.[state.strategy]?.[state.market]) || [];
}

function fmtClose(v) {
  return state.market === "JP"
    ? Math.round(v).toLocaleString() + "円"
    : "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtCell(col, r) {
  // スコア列は選択中の戦略に応じた値を引く（r.score ではなく r.score_<戦略>）
  if (col.type === "score") {
    const v = effScore(r);
    if (v === null || v === undefined) return '<span class="score-na" title="この戦略の判定に必要な指標が取得できないため、スコアを算出できません">—</span>';
    const lvl = v >= 80 ? "hi" : v >= 60 ? "" : "low";
    return `<span class="score-bar-bg"><span class="score-bar ${lvl}" style="width:${Math.min(100, v)}%"></span></span><span class="score-num ${lvl}">${v.toFixed(0)}</span>`;
  }
  const v = r[col.key];
  if (v === null || v === undefined) return "—";
  switch (col.type) {
    case "num":
      return col.key === "close" ? fmtClose(v) : v.toLocaleString();
    case "pct":
      return v.toFixed(1) + "%";
    case "pctSigned": {
      const cls = v >= 0 ? "pos" : "neg";
      return `<span class="${cls}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</span>`;
    }
    case "roic_val": {
      // ROIC平均値 + データ年数のみ（傾向矢印は別列「ROIC傾向」に表示）
      const yrs = r.roic_yrs ? ` <span class="roic-yrs">(${r.roic_yrs}年)</span>` : "";
      const lowConf = (r.roic_yrs || 0) < 3 ? ' title="データ3年未満のため参考値。値動きに注意"' : "";
      return `<span${lowConf}>${v.toFixed(1)}%${yrs}</span>`;
    }
    case "roic_trend": {
      // ROIC傾向矢印のみ（roic_avgがnull/undefinedの場合は事前の null チェックで "—" になる）
      if (r.roic_tr === "up") {
        return '<span class="pos roic-arrow" title="改善傾向: 直近の年次データでROICが上昇しています。競争優位が強まるポジティブシグナル">↗</span>';
      }
      if (r.roic_tr === "down") {
        return '<span class="neg roic-arrow" title="悪化傾向: 直近の年次データでROICが低下しています。収益性の変化に注意">↘</span>';
      }
      return '<span class="roic-arrow-flat" title="横ばいまたは判定不可: データが少ない、もしくはROICがほぼ変化していません">—</span>';
    }
    case "de_ratio": {
      // D/E比率: 2倍超は赤、1倍超は琥珀色で警告
      const cls = v >= 2.0 ? "neg" : v >= 1.0 ? "warn" : "";
      return `<span class="${cls}">${v.toFixed(1)}x</span>`;
    }
    case "payout": {
      // 配当性向: 100%超は赤（タコ足）、85%超は琥珀（要注意）
      const cls = v > 100 ? "neg" : v > 85 ? "warn" : "";
      return `<span class="${cls}">${v.toFixed(0)}%</span>`;
    }
    case "gc":
      return v ? '<span class="badge-gc">○ 上昇</span>' : "△ 転換中";
    case "sma200":
      return v ? '<span class="badge-gc">○ 上昇</span>' : "× 線の下";
    case "gpath":
      return v === "breakout"
        ? '<span class="badge-gc" title="RSI・CCI・ストキャスが揃った強い上昇の真っ最中（順張り）">🚀 ブレイク</span>'
        : '<span class="badge-dip" title="上昇トレンドを保ったまま過熱が冷めた押し目局面（高値掴みしにくい）">🎯 押し目</span>';
    case "atr": {
      const cls = v >= 8 ? "neg" : v >= 5 ? "warn" : "";
      return `<span class="${cls}">±${v.toFixed(1)}%</span>`;
    }
    case "h52": {
      const cls = v <= -30 ? "warn" : "";
      return `<span class="${cls}">${v.toFixed(1)}%</span>`;
    }
    case "fcf": {
      const cls = v < 0 ? "neg" : "";
      return `<span class="${cls}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</span>`;
    }
    default:
      return String(v);
  }
}

function sparkSvg(points) {
  if (!points || points.length < 2) return "";
  const w = 110, h = 32, pad = 2;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const coords = points.map((v, i) =>
    `${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`);
  const up = points[points.length - 1] >= points[0];
  const color = up ? "var(--green)" : "var(--red)";
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${coords.join(" ")}" fill="none" stroke="${color}" stroke-width="1.6"/>
  </svg>`;
}

function linksHtml(r) {
  if (state.market === "JP") {
    const code = r.ticker.replace(".T", "");
    return `<a href="https://finance.yahoo.co.jp/quote/${r.ticker}" target="_blank" rel="noopener">Yahoo</a>` +
           `<a href="https://kabutan.jp/stock/?code=${code}" target="_blank" rel="noopener">かぶたん</a>`;
  }
  return `<a href="https://finance.yahoo.com/quote/${r.ticker}" target="_blank" rel="noopener">Yahoo</a>` +
         `<a href="https://www.tradingview.com/symbols/${r.ticker}/" target="_blank" rel="noopener">Chart</a>`;
}

function primaryLink(r) {
  return state.market === "JP"
    ? `https://finance.yahoo.co.jp/quote/${r.ticker}`
    : `https://finance.yahoo.com/quote/${r.ticker}`;
}

// 市場タブの件数バッジ（B: 切替前にヒット数がわかる）
function updateMarketCounts() {
  for (const mk of ["JP", "US"]) {
    const el = document.getElementById("count" + mk);
    if (!el) continue;
    let n;
    if (state.strategy === "scenario") {
      const groups = state.data?.scenarios?.groups || [];
      const group = groups.find(g => g.id === state.scenarioGroup);
      const opt = group?.options?.find(o => o.id === state.scenarioOpt[group.id]);
      n = opt?.stocks?.[mk]?.length;
    } else {
      n = state.data?.presets?.[state.preset]?.[state.strategy]?.[mk]?.length;
    }
    if (n === undefined || n === null) { el.hidden = true; continue; }
    el.hidden = false;
    el.textContent = n;
  }
}

function render() {
  // 戦略を選ぶたびに、スコア計算用の戦略を覚えておく（シナリオ時はこれを維持）
  if (state.strategy !== "scenario") state.scoreStrategy = state.strategy;
  // シナリオ別モードはテーブルUIを隠して専用UIに切り替える
  const isScenario = state.strategy === "scenario";
  document.getElementById("scenarioArea").hidden = !isScenario;
  document.querySelector(".toolbar").style.display = isScenario ? "none" : "";
  document.getElementById("countLine").style.display = isScenario ? "none" : "";
  document.querySelector(".table-scroll").style.display = isScenario ? "none" : "";
  renderStrategyInfo();
  if (isScenario) {
    document.getElementById("emptyState").hidden = true;
    renderScenario();
    return;
  }

  const cols = UNIFIED_COLUMNS;

  // ヘッダー
  const head = document.getElementById("tableHead");
  let th = '<tr><th class="no-sort">★</th><th class="no-sort">銘柄</th><th class="no-sort">3ヶ月チャート</th>';
  for (const c of cols) {
    const arrow = state.sortKey === c.key ? `<span class="arrow">${state.sortDesc ? "▼" : "▲"}</span>` : "";
    th += `<th data-key="${c.key}" title="${c.tip}">${c.label}${arrow}</th>`;
  }
  th += '<th class="no-sort">詳細</th></tr>';
  head.innerHTML = th;
  head.querySelectorAll("th[data-key]").forEach(el => {
    el.addEventListener("click", () => {
      const k = el.dataset.key;
      if (state.sortKey === k) state.sortDesc = !state.sortDesc;
      else { state.sortKey = k; state.sortDesc = true; }
      render();
    });
  });

  // 行のソート（スコア列は選択中の戦略のスコアで並べ替える）
  const sortVal = r => state.sortKey === "score" ? effScore(r) : r[state.sortKey];
  let list = rows().slice();
  list.sort((a, b) => {
    const av = sortVal(a), bv = sortVal(b);
    const an = (av === null || av === undefined) ? -Infinity : +av;
    const bn = (bv === null || bv === undefined) ? -Infinity : +bv;
    return state.sortDesc ? bn - an : an - bn;
  });

  // 本体
  const body = document.getElementById("tableBody");
  body.innerHTML = list.map(r => {
    const fav = state.watchlist.has(r.ticker);
    let tds = `<td class="fav-cell"><button class="fav-btn ${fav ? "on" : ""}" data-t="${r.ticker}" title="ウォッチリストに追加/削除" aria-label="ウォッチリストに追加/削除">★</button></td>`;
    tds += `<td class="name-cell"><div class="stock-name"><a href="${primaryLink(r)}" target="_blank" rel="noopener">${r.name}</a></div>` +
           `<div class="stock-sub">${r.ticker}　${r.sector || ""}</div></td>`;
    tds += `<td class="spark-cell">${sparkSvg(r.spark)}</td>`;
    for (const c of cols) tds += `<td class="${c.type === "score" ? "score-cell" : ""}">${fmtCell(c, r)}</td>`;
    tds += `<td class="links-cell">${linksHtml(r)}</td>`;
    return `<tr>${tds}</tr>`;
  }).join("");

  body.querySelectorAll(".fav-btn").forEach(el => {
    el.addEventListener("click", () => {
      const t = el.dataset.t;
      state.watchlist.has(t) ? state.watchlist.delete(t) : state.watchlist.add(t);
      localStorage.setItem("watchlist", JSON.stringify([...state.watchlist]));
      el.classList.toggle("on", state.watchlist.has(t));
      renderWatchlist();
    });
  });

  // 件数・空状態
  const total = rows().length;
  const mkt = state.market === "JP" ? "日本株" : "米国株";
  const strat = { value: "割安×上昇開始", growth: "高成長×勢い", defensive: "守り×安定配当" }[state.strategy];
  const presetName = state.preset === "standard" ? "標準" : "ゆるめ";
  document.getElementById("presetHint").textContent = state.preset === "standard"
    ? "本来の厳しい基準で厳選"
    : "基準をゆるめて惜しい銘柄も表示";
  updateMarketCounts();
  document.getElementById("countLine").textContent =
    `${mkt} / ${strat} / ${presetName}基準 — ${total}銘柄ヒット`;

  const empty = document.getElementById("emptyState");
  const tableWrap = document.querySelector(".table-scroll");
  if (list.length === 0) {
    empty.hidden = false;
    tableWrap.style.display = "none";
    document.getElementById("emptyMsg").textContent =
      state.preset === "standard"
        ? "本日は標準基準を満たす銘柄がありません（厳しい基準なので珍しくありません）。「ゆるめ」に切り替えると惜しい銘柄を確認できます。"
        : "本日はゆるめ基準でも該当がありません。";
  } else {
    empty.hidden = true;
    tableWrap.style.display = "";
  }
}

/* ---- 選定基準バナー ---- */

function renderStrategyInfo() {
  const el = document.getElementById("strategyInfo");
  if (!el) return;
  if (state.strategy === "scenario") { el.hidden = true; return; }
  el.hidden = false;

  const jp = state.market === "JP";

  const criteria = {
    value: {
      label: "💎 割安×上昇開始（バリュー株）の選定基準",
      items: jp ? [
        "PER ≤ 14倍（利益に対して割安）",
        "PBR ≤ 1.2倍（資産に対して割安）",
        "配当利回り ≥ 3%",
        "ROE ≥ 8%（バリュートラップ除外）",
        "RSI 40〜65（過熱・売られすぎを除外）",
        "MACD好転 ＋ ゴールデンクロス（25日線 > 50日線）",
        "200日移動平均線の上（長期下降トレンド＝落ちるナイフを除外）",
        "除外: 配当性向100%超（タコ足配当）・D/E比率2倍超（金融セクターを除く）",
      ] : [
        "PER ≤ 18倍（利益に対して割安）",
        "PBR ≤ 2.5倍（資産に対して割安）",
        "配当利回り ≥ 2%",
        "ROE ≥ 10%（バリュートラップ除外）",
        "RSI 40〜65（過熱・売られすぎを除外）",
        "MACD好転 ＋ ゴールデンクロス（25日線 > 50日線）",
        "200日移動平均線の上（長期下降トレンド＝落ちるナイフを除外）",
        "除外: 配当性向100%超（タコ足配当）・D/E比率2倍超（金融セクターを除く）",
      ],
      score: "スコア内訳（最大100点）: PERの割安度 最大25点 ＋ PBRの割安度 最大25点 ＋ 配当の厚み 最大25点 ＋ トレンドシグナル 最大20点 ＋ ROICボーナス 最大10点",
    },
    growth: {
      label: "🚀 高成長×勢い（グロース株）の選定基準",
      items: [
        "売上成長率 ≥ 15%（四半期の前年同期比）",
        "EPS成長率 ≥ 20%（四半期の前年同期比）",
        "🚀 ブレイク型: RSI 65〜85 ＋ CCI ≥ 100 ＋ ストキャスティクス ≥ 80 ＋ 乖離20%以内（強い上昇の真っ最中に順張り）",
        "🎯 押し目型: 終値 > 25日線 > 50日線 ＋ MACD好転 ＋ RSI 45〜65 ＋ 乖離10%以内（上昇トレンド中の過熱が冷めた局面＝高値掴みしにくい）",
        "上の2経路のどちらかを満たせば通過（「型」列にバッジ表示）",
        "除外: 生活必需品・公益セクター、配当利回り2%超",
        "※ 直近1四半期の数値のため特別利益による一時的なEPS急増が混ざる可能性あり",
      ],
      score: "スコア内訳（最大100点）: 売上成長の強さ 最大30点 ＋ EPS成長の強さ 最大30点 ＋ モメンタムの強さ 最大20点（RSI45→85で線形） ＋ 押し目度（急騰しすぎでない） 最大20点 ＋ ROICボーナス 最大10点",
    },
    defensive: {
      label: "🛡️ 守り×安定配当（ディフェンシブ株）の選定基準",
      items: jp ? [
        "業種: 生活必需品・公益・ヘルスケアのみ対象",
        "配当利回り ≥ 2.5%（安定した収入）",
        "PER ≤ 18倍（過度に割高な銘柄を除外）",
        "ROE ≥ 8%（稼ぐ力がある）",
        "ベータ ≤ 1.0（市場より値動きが穏やか）",
        "200日移動平均線の上（長期上昇トレンド）",
        "除外: 配当性向100%超（タコ足配当）・D/E比率3倍超",
        "配当性向 85%超はスコア－5点（減配リスクゾーン）",
      ] : [
        "業種: 生活必需品・公益・ヘルスケアのみ対象",
        "配当利回り ≥ 2.0%（安定した収入）",
        "PER ≤ 22倍（過度に割高な銘柄を除外）",
        "ROE ≥ 10%（稼ぐ力がある）",
        "ベータ ≤ 1.0（市場より値動きが穏やか）",
        "200日移動平均線の上（長期上昇トレンド）",
        "除外: 配当性向100%超（タコ足配当）・D/E比率3倍超",
        "配当性向 85%超はスコア－5点（減配リスクゾーン）",
      ],
      score: "スコア内訳（最大100点）: 配当の厚み 最大35点 ＋ 値動きの穏やかさ（ベータ） 最大25点 ＋ 割高でない（PER） 最大20点 ＋ トレンドシグナル 最大20点 ＋ ROICボーナス 最大10点。配当性向85%超で－5点",
    },
  };

  const c = criteria[state.strategy];
  if (!c) { el.hidden = true; return; }
  // 除外ルール・参考情報・注意書きはチェックマークなしで表示
  const isNote = i => i.startsWith("参考") || i.startsWith("除外") || i.startsWith("※");
  el.innerHTML = `<div class="criteria-box">
    <span class="criteria-title">${c.label}</span>
    <ul class="criteria-list">${c.items.map(i =>
      `<li${isNote(i) ? ' class="criteria-note"' : ""}>${i}</li>`).join("")}</ul>
    <p class="score-breakdown">📊 ${c.score}</p>
  </div>`;
}

/* ---- 成績トラッキング（過去のおすすめのその後） ---- */

function renderPerformance() {
  const sec = document.getElementById("perfSection");
  if (!sec) return;
  const perf = state.data?.performance;
  if (!perf || !perf.rows?.length) { sec.hidden = true; return; }
  sec.hidden = false;

  const stLabel = { value: "💎 割安×上昇開始", growth: "🚀 高成長×勢い", defensive: "🛡️ 守り×安定配当" };
  const mkLabel = { JP: "🇯🇵 日本株", US: "🇺🇸 米国株" };
  const fmt = v => (v === null || v === undefined) ? "—"
    : `<span class="${v >= 0 ? "pos" : "neg"}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</span>`;

  const body = perf.rows.map(r => {
    const bench = r.market === "JP" ? "日経平均" : "S&P500";
    // おすすめが市場平均に勝っていたか（同期間比較）
    const win = (r.bench === null || r.bench === undefined) ? ""
      : r.avg >= r.bench ? ' <span class="perf-win" title="同期間の市場平均を上回りました">◎</span>' : "";
    return `<tr>
      <td>${r.date}</td>
      <td>${mkLabel[r.market]}</td>
      <td>${stLabel[r.strategy]}</td>
      <td>${fmt(r.avg)}${win}</td>
      <td>${fmt(r.bench)} <span class="perf-bench-name">(${bench})</span></td>
      <td>${r.n}銘柄</td>
    </tr>`;
  }).join("");

  document.getElementById("perfBody").innerHTML = `<div class="table-scroll"><table>
    <thead><tr>
      <th>選定日</th><th>市場</th><th>戦略</th>
      <th title="その日の標準基準・スコア上位${perf.top_n}銘柄を同額ずつ買ったと仮定した平均リターン">上位${perf.top_n}銘柄平均</th>
      <th title="同じ期間に市場平均（日経平均/S&P500）がどれだけ動いたか">市場平均（同期間）</th>
      <th>集計対象</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/* ---- シナリオ別おすすめ ---- */

function renderScenario() {
  const sc = state.data?.scenarios;
  const groups = sc?.groups || [];
  if (!groups.length) {
    document.getElementById("scenarioQuestion").textContent = "シナリオデータがまだ生成されていません。";
    return;
  }
  if (!groups.some(g => g.id === state.scenarioGroup)) state.scenarioGroup = groups[0].id;
  const group = groups.find(g => g.id === state.scenarioGroup);
  if (!group.options.some(o => o.id === state.scenarioOpt[group.id])) {
    state.scenarioOpt[group.id] = group.options[0].id;
  }
  const opt = group.options.find(o => o.id === state.scenarioOpt[group.id]);

  // テーマタブ
  const tabs = document.getElementById("scenarioTabs");
  tabs.innerHTML = groups.map(g =>
    `<button class="tab ${g.id === group.id ? "active" : ""}" data-g="${g.id}">${g.icon} ${g.label}</button>`).join("");
  tabs.querySelectorAll("[data-g]").forEach(el => el.addEventListener("click", () => {
    state.scenarioGroup = el.dataset.g;
    renderScenario();
  }));

  // 質問と選択肢（ユーザーの予想）
  document.getElementById("scenarioQuestion").textContent = group.question;
  const optsEl = document.getElementById("scenarioOptions");
  optsEl.innerHTML = group.options.map(o =>
    `<button class="scenario-opt ${o.id === opt.id ? "active" : ""}" data-o="${o.id}">${o.label}</button>`).join("");
  optsEl.querySelectorAll("[data-o]").forEach(el => el.addEventListener("click", () => {
    state.scenarioOpt[group.id] = el.dataset.o;
    renderScenario();
  }));

  document.getElementById("scenarioSummary").textContent = `📌 ${opt.summary}`;
  // シナリオは時事性が強いため、編集日から30日を超えたら古さを明示する
  const asOfEl = document.getElementById("scenarioAsOf");
  const ageDays = sc.as_of ? Math.floor((Date.now() - new Date(sc.as_of)) / 86400000) : null;
  asOfEl.textContent = sc.as_of || "—";
  asOfEl.classList.toggle("stale", ageDays !== null && ageDays > 30);
  if (ageDays !== null && ageDays > 30) {
    asOfEl.textContent = `${sc.as_of}（⚠ 編集から${ageDays}日経過 — 情勢が変わっている可能性があります）`;
  }
  updateMarketCounts();

  // 銘柄カード
  const list = opt.stocks?.[state.market] || [];
  document.getElementById("scenarioCards").innerHTML = list.length === 0
    ? `<p class="scenario-empty">このシナリオで${state.market === "JP" ? "日本株" : "米国株"}の登録銘柄はありません。</p>`
    : list.map(r => {
      const chg = (r.chg === null || r.chg === undefined) ? ""
        : `<span class="${r.chg >= 0 ? "pos" : "neg"}">${r.chg >= 0 ? "+" : ""}${r.chg.toFixed(2)}%</span>`;
      const price = (r.close === null || r.close === undefined) ? "" :
        `<div class="sc-price">${fmtClose(r.close)} ${chg}</div>`;
      // 財務注意フラグ（赤字・高D/E・タコ足配当・FCFマイナス）。
      // テーマ株は財務リスクがあっても優良株と同じ顔で並ぶため明示する
      const warn = (r.warn && r.warn.length)
        ? `<div class="warn-badge" title="テーマ性とは別に財務面の注意点がある銘柄です。投資前に決算資料を確認してください">⚠ ${r.warn.join("・")}</div>`
        : "";
      return `<div class="scenario-card">
        <div class="sc-head">
          <div>
            <div class="stock-name"><a href="${primaryLink(r)}" target="_blank" rel="noopener">${r.name}</a></div>
            <div class="stock-sub">${r.ticker}　<span class="sc-tag">${r.tag}</span></div>
          </div>
          <div class="sc-quote">${price}${sparkSvg(r.spark)}</div>
        </div>
        <p class="sc-reason">${r.reason}</p>${warn}
        <div class="links-cell">${linksHtml(r)}</div>
      </div>`;
    }).join("");
}

// ウォッチリストテーブルの列定義（スクリーニング表と同じ全指標を表示）。
// スコアは選択中の戦略に連動。ファンダ系はスクリーニング通過銘柄のみ値が入る（他は—）。
const WL_COLUMNS = [
  { key: "score",    label: "スコア",     type: "score",      tip: "選択中の戦略基準でのスコア（0〜100）。上部のスクリーニング戦略タブを切り替えると連動して変わります。スクリーニング対象外の銘柄は—" },
  { key: "close",    label: "終値",       type: "wl_close",   tip: "最新の終値" },
  { key: "chg",      label: "前日比",     type: "wl_chg",     tip: "前日比（当日の値動き）" },
  { key: "per",      label: "PER",       type: "num",        tip: "株価収益率（スクリーニング通過銘柄のみ）" },
  { key: "fpe",      label: "予想PER",    type: "num",        tip: "来期予想利益ベースのPER。実績PERより低ければ増益予想" },
  { key: "pbr",      label: "PBR",       type: "num",        tip: "株価純資産倍率（スクリーニング通過銘柄のみ）" },
  { key: "div",      label: "配当",       type: "pct",        tip: "配当利回り（年率。スクリーニング通過銘柄のみ）" },
  { key: "roe",      label: "ROE",       type: "pct",        tip: "自己資本利益率（スクリーニング通過銘柄のみ）" },
  { key: "de",       label: "D/E",       type: "de_ratio",   tip: "負債÷自己資本。2倍超は赤、1倍超は琥珀" },
  { key: "payout",   label: "配当性向",   type: "payout",     tip: "配当÷純利益。85%超は琥珀、100%超は赤（タコ足配当）" },
  { key: "fcf",      label: "FCF利回り",  type: "fcf",        tip: "フリーキャッシュフロー÷時価総額。マイナス（赤）は現金流出中" },
  { key: "revg",     label: "売上成長",   type: "pctSigned",  tip: "直近四半期の売上・前年同期比" },
  { key: "epsg",     label: "EPS成長",    type: "pctSigned",  tip: "1株利益の前年同期比" },
  { key: "roic_avg", label: "ROIC平均",   type: "roic_val",   tip: "投下資本利益率の過去平均。10%以上が優良の目安" },
  { key: "roic_avg", label: "ROIC傾向",   type: "roic_trend", tip: "ROICの直近トレンド。↗=改善傾向、↘=悪化傾向" },
  { key: "beta",     label: "ベータ",     type: "num",        tip: "1未満=市場より値動きが穏やか" },
  { key: "atr",      label: "1日変動",    type: "atr",        tip: "1日にだいたい何%動くかの目安。±5%超は値動きが荒い" },
  { key: "rsi",      label: "RSI",       type: "num",        tip: "買われすぎ・売られすぎの目安（0〜100）" },
  { key: "cci",      label: "CCI",       type: "num",        tip: "勢い（モメンタム）。100以上はブレイクアウト" },
  { key: "dev",      label: "乖離",       type: "pctSigned",  tip: "25日移動平均線からの上方乖離率" },
  { key: "h52",      label: "52週高値比", type: "h52",        tip: "52週高値からの下落率。0%に近いほど高値圏" },
  { key: "gc",       label: "短期トレンド", type: "gc",        tip: "○=25日線が50日線の上（ゴールデンクロス状態）" },
  { key: "sma200",   label: "長期トレンド", type: "sma200",    tip: "○=終値が200日移動平均線の上（長期上昇トレンド）" },
];

// 全プリセット・全戦略・全市場からティッカーを検索してファンダ等を返す。
// スコアはプリセットで変わるため、現在選択中のプリセットを優先して探す。
function findScreeningData(ticker) {
  if (!state.data?.presets) return null;
  const presetNames = Object.keys(state.data.presets);
  const ordered = [state.preset, ...presetNames.filter(p => p !== state.preset)];
  for (const pname of ordered) {
    const preset = state.data.presets[pname];
    if (!preset) continue;
    for (const strategy of Object.values(preset)) {
      for (const marketRows of Object.values(strategy)) {
        if (!Array.isArray(marketRows)) continue;
        const hit = marketRows.find(r => r.ticker === ticker);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// ウォッチリスト行オブジェクトを構築（ticker_data + screening data をマージ）
// スクリーニング通過銘柄(sc)は全指標＋3戦略スコアを丸ごと取り込む。
// 当日値（終値・前日比・RSI・GC）は ticker_data 側を優先して最新に保つ。
function buildWatchlistRow(ticker) {
  const td = state.data?.ticker_data?.[ticker] || null;
  // スクリーニング通過銘柄はその行を、非通過でも watchlist_data の常時表示データを使う
  const sc = findScreeningData(ticker) || state.data?.watchlist_data?.[ticker] || null;
  return {
    ...(sc || {}),          // score_value/growth/defensive, per, pbr, div, roe, de, payout, revg, epsg, beta, cci, dev, sma200 等
    ticker,
    name: sc?.name || td?.n || ticker,
    sector: sc?.sector || "",
    spark: td?.sp || sc?.spark || null,
    close: td?.c ?? sc?.close ?? null,
    chg: td?.g ?? null,
    rsi: td?.r ?? sc?.rsi ?? null,
    gc: td?.gc ?? sc?.gc ?? null,
  };
}

// ウォッチリスト専用セル整形（市場依存の終値・前日比を個別処理、他は共通fmtCellに委譲）
function fmtWlCell(col, r) {
  if (col.type === "wl_close") {
    const v = r[col.key];
    if (v === null || v === undefined) return "—";
    return r.ticker.endsWith(".T")
      ? Math.round(v).toLocaleString() + "円"
      : "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (col.type === "wl_chg") {
    const v = r[col.key];
    if (v === null || v === undefined) return "—";
    return `<span class="${v >= 0 ? "pos" : "neg"}">${v >= 0 ? "+" : ""}${v.toFixed(2)}%</span>`;
  }
  return fmtCell(col, r);
}

/* ---- ウォッチリスト ---- */

function fmtPrice(c, ticker) {
  return ticker.endsWith(".T")
    ? Math.round(c).toLocaleString() + "円"
    : "$" + c.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function renderWatchlist() {
  const container = document.getElementById("watchlistCards");
  if (!container) return;

  // スクリーニング表の★ボタンと同期
  document.querySelectorAll(".fav-btn[data-t]").forEach(el => {
    el.classList.toggle("on", state.watchlist.has(el.dataset.t));
  });

  if (state.watchlist.size === 0) {
    container.innerHTML = '<p class="wl-empty">スクリーニング表の ★ か「＋ 銘柄を追加」から登録すると、ここに常時表示されます。</p>';
    return;
  }

  const wlRows = [...state.watchlist].map(buildWatchlistRow);

  // ヘッダー
  let th = '<tr><th class="no-sort">★</th><th class="no-sort">銘柄</th><th class="no-sort">3ヶ月チャート</th>';
  for (const c of WL_COLUMNS) {
    th += `<th title="${c.tip}">${c.label}</th>`;
  }
  th += '</tr>';

  // 行
  const tbody = wlRows.map(r => {
    const flag = r.ticker.endsWith(".T") ? "🇯🇵" : "🇺🇸";
    const link = r.ticker.endsWith(".T")
      ? `https://finance.yahoo.co.jp/quote/${r.ticker}`
      : `https://finance.yahoo.com/quote/${r.ticker}`;
    let tds = `<td class="fav-cell"><button class="fav-btn on" data-t="${r.ticker}" title="ウォッチリストから削除（★クリック）">★</button></td>`;
    const wlWarn = (r.warn && r.warn.length)
      ? `<div class="warn-badge" title="財務面の注意点。投資前に決算資料を確認してください">⚠ ${r.warn.join("・")}</div>`
      : "";
    tds += `<td class="name-cell">
      <div class="stock-name"><a href="${link}" target="_blank" rel="noopener">${flag} ${r.name}</a></div>
      <div class="stock-sub">${r.ticker}${r.sector ? "　" + r.sector : ""}</div>${wlWarn}
    </td>`;
    tds += `<td class="spark-cell">${r.spark ? sparkSvg(r.spark) : "—"}</td>`;
    for (const c of WL_COLUMNS) {
      tds += `<td class="${c.type === "score" ? "score-cell" : ""}">${fmtWlCell(c, r)}</td>`;
    }
    return `<tr>${tds}</tr>`;
  }).join("");

  container.innerHTML = `<div class="table-scroll">
    <table>
      <thead>${th}</thead>
      <tbody>${tbody}</tbody>
    </table>
  </div>`;

  // ★クリックでウォッチリストから削除
  container.querySelectorAll(".fav-btn").forEach(el => {
    el.addEventListener("click", () => {
      state.watchlist.delete(el.dataset.t);
      localStorage.setItem("watchlist", JSON.stringify([...state.watchlist]));
      document.querySelectorAll(`.fav-btn[data-t="${el.dataset.t}"]`).forEach(b => b.classList.remove("on"));
      renderWatchlist();
    });
  });
}

// 検索候補の状態（キーボード操作で使う）
let wlMatches = [];    // [[ticker, data], ...]
let wlActiveIdx = -1;  // ハイライト中の候補インデックス

function watchlistSearch(query) {
  const q = query.trim().toLowerCase();
  const dropdown = document.getElementById("watchlistDropdown");
  if (!dropdown) return;
  if (q.length < 1) { closeWatchlistDropdown(); return; }

  const td = state.data?.ticker_data || {};
  wlMatches = Object.entries(td)
    .filter(([t, d]) =>
      t.toLowerCase().includes(q) ||
      (d.n || "").toLowerCase().includes(q) ||
      (d.en || "").toLowerCase().includes(q)
    )
    .slice(0, 30);  // 多めに出し、はみ出す分は内部スクロールでたどれる
  wlActiveIdx = wlMatches.length ? 0 : -1;
  renderWatchlistDropdown();
}

function renderWatchlistDropdown() {
  const dropdown = document.getElementById("watchlistDropdown");
  if (!dropdown) return;
  dropdown.hidden = false;
  if (wlMatches.length === 0) {
    dropdown.innerHTML = '<li class="wl-no-result">該当なし</li>';
    positionWatchlistDropdown();
    return;
  }
  dropdown.innerHTML = wlMatches.map(([ticker, d], i) => {
    const flag = ticker.endsWith(".T") ? "🇯🇵" : "🇺🇸";
    const price = d.c ? ` — ${fmtPrice(d.c, ticker)}` : "";
    const added = state.watchlist.has(ticker);
    return `<li class="wl-result-item${added ? " wl-added" : ""}${i === wlActiveIdx ? " wl-active" : ""}" data-t="${ticker}" data-idx="${i}">
      <span class="wl-result-name">${flag} ${d.n}</span>
      <span class="wl-result-meta">${ticker}${price}${added ? " ✓" : ""}</span>
    </li>`;
  }).join("");
  dropdown.querySelectorAll("li[data-t]").forEach(el => {
    el.addEventListener("mouseenter", () => { wlActiveIdx = +el.dataset.idx; highlightWatchlistActive(); });
    el.addEventListener("click", () => selectWatchlistItem(el.dataset.t));
  });
  positionWatchlistDropdown();
}

// キーボードのハイライト位置だけ更新（再描画はしない）
function highlightWatchlistActive() {
  const dropdown = document.getElementById("watchlistDropdown");
  if (!dropdown) return;
  dropdown.querySelectorAll("li[data-idx]").forEach(el => {
    const on = +el.dataset.idx === wlActiveIdx;
    el.classList.toggle("wl-active", on);
    if (on) el.scrollIntoView({ block: "nearest" });
  });
}

function selectWatchlistItem(ticker) {
  if (!ticker) return;
  state.watchlist.add(ticker);
  localStorage.setItem("watchlist", JSON.stringify([...state.watchlist]));
  renderWatchlist();
  document.getElementById("watchlistInput").value = "";
  closeWatchlistDropdown();
  document.getElementById("watchlistSearchWrap").hidden = true;
}

function closeWatchlistDropdown() {
  const dd = document.getElementById("watchlistDropdown");
  if (dd) dd.hidden = true;
  wlMatches = [];
  wlActiveIdx = -1;
}

// position:fixed のドロップダウンを入力欄の真下に合わせる
function positionWatchlistDropdown() {
  const input = document.getElementById("watchlistInput");
  const dd = document.getElementById("watchlistDropdown");
  if (!input || !dd || dd.hidden) return;
  const r = input.getBoundingClientRect();
  dd.style.left = r.left + "px";
  dd.style.top = (r.bottom + 4) + "px";
  dd.style.width = r.width + "px";
}

// 入力欄でのキーボード操作（↓↑で選択移動、Enterで確定、Escで閉じる）
function watchlistKeydown(e) {
  const dd = document.getElementById("watchlistDropdown");
  if (!dd || dd.hidden || wlMatches.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    wlActiveIdx = (wlActiveIdx + 1) % wlMatches.length;
    highlightWatchlistActive();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    wlActiveIdx = (wlActiveIdx - 1 + wlMatches.length) % wlMatches.length;
    highlightWatchlistActive();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (wlActiveIdx >= 0) selectWatchlistItem(wlMatches[wlActiveIdx][0]);
  } else if (e.key === "Escape") {
    closeWatchlistDropdown();
  }
}

function bindTabs(containerId, attr, stateKey) {
  document.querySelectorAll(`#${containerId} [data-${attr}]`).forEach(el => {
    el.addEventListener("click", () => {
      document.querySelectorAll(`#${containerId} [data-${attr}]`).forEach(b => b.classList.remove("active"));
      el.classList.add("active");
      state[stateKey] = el.dataset[attr];
      state.sortKey = "score";
      state.sortDesc = true;
      render();
      renderWatchlist();  // 戦略・プリセット・市場の切替でウォッチリストのスコアも追従
    });
  });
}

async function init() {
  bindTabs("marketTabs", "market", "market");
  bindTabs("strategyTabs", "strategy", "strategy");
  bindTabs("presetToggle", "preset", "preset");

  // ウォッチリスト操作
  document.getElementById("watchlistAddBtn").addEventListener("click", () => {
    const area = document.getElementById("watchlistSearchWrap");
    area.hidden = !area.hidden;
    if (!area.hidden) document.getElementById("watchlistInput").focus();
  });
  const wlInput = document.getElementById("watchlistInput");
  wlInput.addEventListener("input", e => watchlistSearch(e.target.value));
  wlInput.addEventListener("keydown", watchlistKeydown);
  document.addEventListener("click", e => {
    if (!e.target.closest("#watchlistSection")) closeWatchlistDropdown();
  });
  // 入力欄がスクロール等で動いたら、固定表示のドロップダウン位置を追従させる
  window.addEventListener("scroll", positionWatchlistDropdown, true);
  window.addEventListener("resize", positionWatchlistDropdown);

  // ウォッチリストは localStorage のデータだけでも描画できる（データロード前）
  renderWatchlist();

  try {
    const res = await fetch(`data/latest.json?v=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    const m = state.data.markets || {};
    const dates = ["JP", "US"]
      .filter(k => m[k]?.data_date)
      .map(k => `${k === "JP" ? "日本株" : "米国株"}: ${m[k].data_date}終値`)
      .join(" / ");
    const ver = state.data.version ? ` / v${state.data.version}` : "";
    document.getElementById("updated").textContent =
      `更新: ${state.data.generated_at}（${dates}${ver}）`;
    if (state.data.version) {
      const vb = document.getElementById("verBadge");
      if (vb) vb.textContent = `v${state.data.version}`;
    }
    render();
    renderWatchlist();
    renderPerformance();
  } catch (e) {
    document.getElementById("updated").textContent = "データの読み込みに失敗しました。時間をおいて再読み込みしてください。";
    console.error(e);
  }
}

init();
