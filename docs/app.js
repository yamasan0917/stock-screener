/* 本日のおすすめ銘柄 — フロントエンドロジック（ビルド不要のVanilla JS） */
"use strict";

const state = {
  data: null,
  market: "JP",
  strategy: "value",
  preset: "standard",
  search: "",
  favOnly: false,
  sortKey: "score",
  sortDesc: true,
  favorites: new Set(JSON.parse(localStorage.getItem("favorites") || "[]")),
  scenarioGroup: null,   // 選択中のシナリオ（中東情勢など）
  scenarioOpt: {},       // シナリオごとの選択肢 {groupId: optionId}
};

// 列定義（key: 行データのキー / type: 表示整形方法）
// ROIC平均とROIC傾向は別列に分離（矢印が何を示すか一目で分かるように）
const COLUMNS = {
  value: [
    { key: "score", label: "スコア", type: "score", tip: "条件をどれだけ余裕を持って満たしたかの目安（0〜100）" },
    { key: "close", label: "終値", type: "num", tip: "最新の終値" },
    { key: "per", label: "PER", type: "num", tip: "株価収益率。低いほど利益に対して割安。日本株14倍以下・米国株18倍以下で抽出" },
    { key: "pbr", label: "PBR", type: "num", tip: "株価純資産倍率。低いほど資産に対して割安。日本株1.2倍以下・米国株2.5倍以下で抽出" },
    { key: "div", label: "配当", type: "pct", tip: "配当利回り（年率・税引前）。日本株3%以上・米国株2%以上で抽出" },
    { key: "roe", label: "ROE", type: "pct", tip: "自己資本利益率。会社の稼ぐ力。8%以上で抽出（バリュートラップ除外）" },
    { key: "roic_avg", label: "ROIC平均", type: "roic_val", tip: "投下資本利益率の過去平均（括弧内はデータ年数）。10%以上が優良の目安。銀行・保険は業種特性上、計算対象外（—）" },
    { key: "roic_avg", label: "ROIC傾向", type: "roic_trend", tip: "ROICの直近トレンド。↗=改善傾向（競争優位が強まるシグナル）、↘=悪化傾向、—=データ不足またはほぼ横ばい。スコアのボーナス点にも使用" },
    { key: "rsi", label: "RSI", type: "num", tip: "相対力指数。40〜65の範囲で抽出（過熱も売られすぎも除外）" },
    { key: "gc", label: "トレンド", type: "gc", tip: "○=25日線が50日線の上（ゴールデンクロス状態）。MACD好転も条件に含む" },
  ],
  growth: [
    { key: "score", label: "スコア", type: "score", tip: "条件をどれだけ余裕を持って満たしたかの目安（0〜100）" },
    { key: "close", label: "終値", type: "num", tip: "最新の終値" },
    { key: "revg", label: "売上成長", type: "pctSigned", tip: "直近四半期の前年同期比。15%以上で抽出" },
    { key: "epsg", label: "EPS成長", type: "pctSigned", tip: "1株利益の前年同期比。20%以上で抽出" },
    { key: "roic_avg", label: "ROIC平均", type: "roic_val", tip: "投下資本利益率の過去平均（括弧内はデータ年数）。10%以上が優良の目安。銀行・保険は業種特性上、計算対象外（—）" },
    { key: "roic_avg", label: "ROIC傾向", type: "roic_trend", tip: "ROICの直近トレンド。↗=改善傾向（競争優位が強まるシグナル）、↘=悪化傾向、—=データ不足またはほぼ横ばい。スコアのボーナス点にも使用" },
    { key: "rsi", label: "RSI", type: "num", tip: "相対力指数。65〜85の範囲で抽出（強い上昇モメンタムがある状態）" },
    { key: "cci", label: "CCI", type: "num", tip: "商品チャンネル指数。100以上=ブレイクアウト状態で抽出" },
    { key: "dev", label: "乖離", type: "pctSigned", tip: "25日移動平均線からの上方乖離率。20%超の急騰銘柄は除外済み" },
  ],
  defensive: [
    { key: "score", label: "スコア", type: "score", tip: "条件をどれだけ余裕を持って満たしたかの目安（0〜100）" },
    { key: "close", label: "終値", type: "num", tip: "最新の終値" },
    { key: "div", label: "配当", type: "pct", tip: "配当利回り（年率・税引前）。日本株2.5%以上・米国株2%以上で抽出" },
    { key: "per", label: "PER", type: "num", tip: "株価収益率。過度に割高な銘柄を除外（日本株18倍以下・米国株22倍以下）" },
    { key: "roe", label: "ROE", type: "pct", tip: "自己資本利益率。8%以上で抽出（稼げない高配当銘柄を除外）" },
    { key: "roic_avg", label: "ROIC平均", type: "roic_val", tip: "投下資本利益率の過去平均（括弧内はデータ年数）。10%以上が優良の目安。銀行・保険は業種特性上、計算対象外（—）" },
    { key: "roic_avg", label: "ROIC傾向", type: "roic_trend", tip: "ROICの直近トレンド。↗=改善傾向（競争優位が強まるシグナル）、↘=悪化傾向、—=データ不足またはほぼ横ばい。スコアのボーナス点にも使用" },
    { key: "beta", label: "ベータ", type: "num", tip: "1未満=市場より値動きが穏やか。1.0以下で抽出（守りの銘柄のみ）" },
    { key: "rsi", label: "RSI", type: "num", tip: "相対力指数。35〜70の範囲で抽出" },
    { key: "sma200", label: "長期トレンド", type: "sma200", tip: "○=終値が200日移動平均線の上（長期上昇トレンド）。これを必須条件にしている" },
  ],
};

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
  const v = r[col.key];
  if (v === null || v === undefined) return "—";
  switch (col.type) {
    case "score": {
      const lvl = v >= 80 ? "hi" : v >= 60 ? "" : "low";
      return `<span class="score-bar-bg"><span class="score-bar ${lvl}" style="width:${Math.min(100, v)}%"></span></span><span class="score-num ${lvl}">${v.toFixed(0)}</span>`;
    }
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
    case "gc":
      return v ? '<span class="badge-gc">○ 上昇</span>' : "△ 転換中";
    case "sma200":
      return v ? '<span class="badge-gc">○ 上昇</span>' : "× 線の下";
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

  const cols = COLUMNS[state.strategy];

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

  // 行のフィルタ・ソート
  let list = rows().slice();
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter(r =>
      r.ticker.toLowerCase().includes(q) ||
      (r.name || "").toLowerCase().includes(q) ||
      (r.name_en || "").toLowerCase().includes(q));
  }
  if (state.favOnly) list = list.filter(r => state.favorites.has(r.ticker));
  list.sort((a, b) => {
    const av = a[state.sortKey], bv = b[state.sortKey];
    const an = (av === null || av === undefined) ? -Infinity : +av;
    const bn = (bv === null || bv === undefined) ? -Infinity : +bv;
    return state.sortDesc ? bn - an : an - bn;
  });

  // 本体
  const body = document.getElementById("tableBody");
  body.innerHTML = list.map(r => {
    const fav = state.favorites.has(r.ticker);
    let tds = `<td class="fav-cell"><button class="fav-btn ${fav ? "on" : ""}" data-t="${r.ticker}" aria-label="お気に入り">★</button></td>`;
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
      state.favorites.has(t) ? state.favorites.delete(t) : state.favorites.add(t);
      localStorage.setItem("favorites", JSON.stringify([...state.favorites]));
      render();
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
    `${mkt} / ${strat} / ${presetName}基準 — ${total}銘柄ヒット` +
    (list.length !== total ? `（絞り込み表示: ${list.length}件）` : "");

  const empty = document.getElementById("emptyState");
  const tableWrap = document.querySelector(".table-scroll");
  if (list.length === 0) {
    empty.hidden = false;
    tableWrap.style.display = "none";
    document.getElementById("emptyMsg").textContent =
      state.favOnly ? "★を付けた銘柄がこの条件にはありません。"
      : (state.preset === "standard"
        ? "本日は標準基準を満たす銘柄がありません（厳しい基準なので珍しくありません）。「ゆるめ」に切り替えると惜しい銘柄を確認できます。"
        : "本日はゆるめ基準でも該当がありません。");
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
      ] : [
        "PER ≤ 18倍（利益に対して割安）",
        "PBR ≤ 2.5倍（資産に対して割安）",
        "配当利回り ≥ 2%",
        "ROE ≥ 8%（バリュートラップ除外）",
        "RSI 40〜65（過熱・売られすぎを除外）",
        "MACD好転 ＋ ゴールデンクロス（25日線 > 50日線）",
      ],
    },
    growth: {
      label: "🚀 高成長×勢い（グロース株）の選定基準",
      items: [
        "売上成長率 ≥ 15%（四半期の前年同期比）",
        "EPS成長率 ≥ 20%（四半期の前年同期比）",
        "RSI 65〜85（強い上昇モメンタム）",
        "CCI ≥ 100（ブレイクアウト状態）",
        "ストキャスティクス ≥ 80（トレンド継続）",
        "25日線乖離率 ≤ 20%（急騰しすぎは除外）",
        "除外: 生活必需品・公益セクター、配当利回り2%超",
      ],
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
      ] : [
        "業種: 生活必需品・公益・ヘルスケアのみ対象",
        "配当利回り ≥ 2.0%（安定した収入）",
        "PER ≤ 22倍（過度に割高な銘柄を除外）",
        "ROE ≥ 8%（稼ぐ力がある）",
        "ベータ ≤ 1.0（市場より値動きが穏やか）",
        "200日移動平均線の上（長期上昇トレンド）",
      ],
    },
  };

  const c = criteria[state.strategy];
  if (!c) { el.hidden = true; return; }
  el.innerHTML = `<div class="criteria-box">
    <span class="criteria-title">${c.label}</span>
    <ul class="criteria-list">${c.items.map(i => `<li>${i}</li>`).join("")}</ul>
  </div>`;
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
  document.getElementById("scenarioAsOf").textContent = sc.as_of || "—";
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
      return `<div class="scenario-card">
        <div class="sc-head">
          <div>
            <div class="stock-name"><a href="${primaryLink(r)}" target="_blank" rel="noopener">${r.name}</a></div>
            <div class="stock-sub">${r.ticker}　<span class="sc-tag">${r.tag}</span></div>
          </div>
          <div class="sc-quote">${price}${sparkSvg(r.spark)}</div>
        </div>
        <p class="sc-reason">${r.reason}</p>
        <div class="links-cell">${linksHtml(r)}</div>
      </div>`;
    }).join("");
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
    });
  });
}

async function init() {
  bindTabs("marketTabs", "market", "market");
  bindTabs("strategyTabs", "strategy", "strategy");
  bindTabs("presetToggle", "preset", "preset");
  document.getElementById("searchBox").addEventListener("input", e => {
    state.search = e.target.value;
    render();
  });
  document.getElementById("favOnly").addEventListener("change", e => {
    state.favOnly = e.target.checked;
    render();
  });

  try {
    const res = await fetch(`data/latest.json?v=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    const m = state.data.markets || {};
    const dates = ["JP", "US"]
      .filter(k => m[k]?.data_date)
      .map(k => `${k === "JP" ? "日本株" : "米国株"}: ${m[k].data_date}終値`)
      .join(" / ");
    document.getElementById("updated").textContent =
      `更新: ${state.data.generated_at}（${dates}）`;
    render();
  } catch (e) {
    document.getElementById("updated").textContent = "データの読み込みに失敗しました。時間をおいて再読み込みしてください。";
    console.error(e);
  }
}

init();
