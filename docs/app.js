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

// ROIC列の共通ツールチップ
const ROIC_TIP = "投下資本利益率の過去平均（年数を併記）。10%以上で優良、" +
  "↗=増加傾向。データが3年未満（上場間もない等）は参考程度に。銀行・保険は計算対象外（—）";

// 列定義（key: 行データのキー / fmt: 表示整形）
const COLUMNS = {
  value: [
    { key: "score", label: "スコア", type: "score", tip: "条件をどれだけ余裕を持って満たしたかの目安" },
    { key: "close", label: "終値", type: "num", tip: "最新の終値" },
    { key: "per", label: "PER", type: "num", tip: "低いほど利益に対して割安" },
    { key: "pbr", label: "PBR", type: "num", tip: "低いほど資産に対して割安" },
    { key: "div", label: "配当", type: "pct", tip: "配当利回り（年率・税引前）" },
    { key: "roe", label: "ROE", type: "pct", tip: "会社の稼ぐ力。8%以上で抽出" },
    { key: "roic_avg", label: "ROIC平均", type: "roic", tip: ROIC_TIP },
    { key: "rsi", label: "RSI", type: "num", tip: "買われすぎ・売られすぎの度合い" },
    { key: "gc", label: "トレンド", type: "gc", tip: "○=25日線が50日線の上（ゴールデンクロス状態）" },
  ],
  growth: [
    { key: "score", label: "スコア", type: "score", tip: "条件をどれだけ余裕を持って満たしたかの目安" },
    { key: "close", label: "終値", type: "num", tip: "最新の終値" },
    { key: "revg", label: "売上成長", type: "pctSigned", tip: "直近四半期の前年同期比" },
    { key: "epsg", label: "EPS成長", type: "pctSigned", tip: "1株利益の前年同期比" },
    { key: "roic_avg", label: "ROIC平均", type: "roic", tip: ROIC_TIP },
    { key: "rsi", label: "RSI", type: "num", tip: "65〜85=強い勢い" },
    { key: "cci", label: "CCI", type: "num", tip: "100以上=ブレイクアウト状態" },
    { key: "dev", label: "乖離", type: "pctSigned", tip: "25日移動平均線からの上方乖離" },
  ],
  defensive: [
    { key: "score", label: "スコア", type: "score", tip: "条件をどれだけ余裕を持って満たしたかの目安" },
    { key: "close", label: "終値", type: "num", tip: "最新の終値" },
    { key: "div", label: "配当", type: "pct", tip: "配当利回り（年率・税引前）" },
    { key: "per", label: "PER", type: "num", tip: "低いほど利益に対して割安" },
    { key: "roe", label: "ROE", type: "pct", tip: "会社の稼ぐ力。8%以上で抽出" },
    { key: "roic_avg", label: "ROIC平均", type: "roic", tip: ROIC_TIP },
    { key: "beta", label: "ベータ", type: "num", tip: "1未満=市場より値動きが穏やか" },
    { key: "rsi", label: "RSI", type: "num", tip: "買われすぎ・売られすぎの度合い" },
    { key: "sma200", label: "長期トレンド", type: "sma200", tip: "○=終値が200日移動平均線の上（長期上昇トレンド）" },
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
    case "roic": {
      // 平均値 + データ年数 + 傾向矢印（例: 28.5% (4年) ↗）。ソートは平均値で行う
      const arrow = r.roic_tr === "up" ? ' <span class="pos">↗</span>'
        : r.roic_tr === "down" ? ' <span class="neg">↘</span>' : "";
      const yrs = r.roic_yrs ? `<span class="roic-yrs">(${r.roic_yrs}年)</span>` : "";
      const lowConf = (r.roic_yrs || 0) < 3 ? ' title="データ3年未満のため参考値"' : "";
      return `<span${lowConf}>${v.toFixed(1)}% ${yrs}${arrow}</span>`;
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
