/* MTG Meta Tracker — frontend statico. Tutte le statistiche sono calcolate nel browser
   a partire da data/formats/<formato>.json, così i filtri sono istantanei. */
"use strict";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x) => (100 * x).toFixed(1) + "%";
const enc = encodeURIComponent;

const state = { meta: null, fmt: null, data: null, cache: {}, days: 30, type: "all", place: "all" };
try {
  const saved = JSON.parse(localStorage.getItem("mtgmeta-filters") || "{}");
  Object.assign(state, { days: saved.days ?? 30, type: saved.type ?? "all", place: saved.place ?? "all" });
} catch (_) { /* storage non disponibile */ }

/* ---------- caricamento dati ---------- */
async function loadMeta() {
  state.meta = await (await fetch("data/meta.json", { cache: "no-cache" })).json();
  const g = new Date(state.meta.generated);
  $("#updated").textContent = `Ultimo aggiornamento: ${g.toLocaleString("it-IT")} · ${state.meta.totals.decks.toLocaleString("it-IT")} liste da ${state.meta.totals.tournaments.toLocaleString("it-IT")} tornei`;
}

async function loadFormat(slug) {
  if (!state.cache[slug]) {
    const raw = await (await fetch(`data/formats/${slug}.json`, { cache: "no-cache" })).json();
    raw.deckById = new Map();
    raw.decks = raw.decks.map((d) => {
      const o = { id: d[0], ev: raw.events[d[1]], evIdx: d[1], player: d[2], result: d[3], rank: d[4], wins: d[5],
        losses: d[6], arch: raw.archetypes[d[7]], method: d[8], colors: d[9], url: d[10], main: d[11], side: d[12] };
      raw.deckById.set(o.id, o);
      return o;
    });
    raw.cardIdx = new Map(raw.cards.map((c, i) => [c.toLowerCase(), i]));
    raw.maxDate = raw.events.reduce((m, e) => (e[2] > m ? e[2] : m), "");
    state.cache[slug] = raw;
  }
  state.data = state.cache[slug];
  $("#card-list").innerHTML = state.data.cards.map((c) => `<option value="${esc(c)}">`).join("");
}

/* ---------- filtri ---------- */
function filtered() {
  const d = state.data;
  const from = new Date(d.maxDate);
  from.setDate(from.getDate() - state.days + 1);
  const since = from.toISOString().slice(0, 10);
  return d.decks.filter((x) => {
    if (x.ev[2] < since) return false;
    if (state.type !== "all" && x.ev[3] !== state.type) return false;
    if (state.place === "top8" && !(x.rank && x.rank <= 8) && !(x.wins >= 5 && x.losses === 0)) return false;
    if (state.place === "win" && x.rank !== 1) return false;
    return true;
  });
}

function filterLabel() {
  const t = { all: "online + cartacei", online: "solo online", paper: "solo cartacei" }[state.type];
  const p = { all: "", top8: " · top 8 / 5-0", win: " · solo vincitori" }[state.place];
  return `ultimi ${state.days} giorni (fino al ${fmtDate(state.data.maxDate)}) · ${t}${p}`;
}
const fmtDate = (s) => (s ? s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4) : "");

/* ---------- statistiche ---------- */
function composition(decks, board) {
  const key = board === "main" ? "main" : "side";
  const m = new Map();
  for (const d of decks) {
    const l = d[key];
    for (let i = 0; i < l.length; i += 2) {
      let s = m.get(l[i]);
      if (!s) m.set(l[i], (s = { card: l[i], n: 0, qty: 0, dist: [0, 0, 0, 0] }));
      s.n++; s.qty += l[i + 1]; s.dist[Math.min(l[i + 1], 4) - 1]++;
    }
  }
  const N = decks.length || 1;
  return [...m.values()].map((s) => ({ ...s, incl: s.n / N, avg: s.qty / s.n, exp: s.qty / N }))
    .sort((a, b) => b.incl - a.incl || b.avg - a.avg);
}

/* Lista "aggregata": copie attese per lista (totale copie / liste). Parte intera a tutti,
   poi le copie mancanti per arrivare alla dimensione media delle liste vanno alle carte
   con la parte decimale più alta (metodo dei resti maggiori). */
function aggregate(comp, target) {
  const items = comp.map((s) => ({ card: s.card, exp: s.exp, q: Math.floor(s.exp) }));
  let tot = items.reduce((a, b) => a + b.q, 0);
  items.sort((a, b) => (b.exp - b.q) - (a.exp - a.q));
  for (const it of items) { if (tot >= target) break; if (it.exp > it.q) { it.q++; tot++; } }
  const cards = items.filter((i) => i.q > 0).sort((a, b) => b.q - a.q || b.exp - a.exp).map((i) => [i.card, i.q]);
  return { cards, total: tot };
}
const avgSize = (decks, key) => {
  let t = 0;
  for (const d of decks) for (let i = 1; i < d[key].length; i += 2) t += d[key][i];
  return Math.round(t / (decks.length || 1));
};

const role = (incl) => (incl >= 0.9 ? ["core", "Core"] : incl >= 0.3 ? ["flex", "Flex"] : ["tech", "Tech"]);

function pips(colors) {
  const c = colors || "C";
  return `<span class="pips" title="${esc(colors || "Incolore")}">${[...c].map((x) => `<i class="pip" style="background:var(--mana-${x})"></i>`).join("")}</span>`;
}
function topColors(decks) {
  const c = new Map(); decks.forEach((d) => c.set(d.colors, (c.get(d.colors) || 0) + 1));
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/* ---------- viste ---------- */
const view = (html) => { $("#app").innerHTML = html; enableSorting(); window.scrollTo(0, 0); };
const fmtLink = (rest = "") => `#/${state.fmt}${rest}`;
const archLink = (a) => fmtLink(`/a/${enc(a)}`);
const deckLink = (id) => fmtLink(`/d/${id}`);
const cardLink = (c) => fmtLink(`/c/${enc(c)}`);

function renderMeta() {
  const decks = filtered();
  const by = new Map();
  for (const d of decks) {
    let a = by.get(d.arch);
    if (!a) by.set(d.arch, (a = { arch: d.arch, decks: [], wins: 0, top8: 0 }));
    a.decks.push(d);
    if (d.rank === 1) a.wins++;
    if ((d.rank && d.rank <= 8) || (d.wins >= 5 && d.losses === 0)) a.top8++;
  }
  const rows = [...by.values()].sort((a, b) => b.decks.length - a.decks.length);
  const N = decks.length;
  const events = new Set(decks.map((d) => d.evIdx)).size;
  const maxShare = rows.length ? rows[0].decks.length / N : 1;
  view(`
    <h1>${esc(state.data.format)} — metagame</h1>
    <div class="note">${filterLabel()}</div>
    <div class="kpis">
      <div class="kpi"><b>${N.toLocaleString("it-IT")}</b><span>liste</span></div>
      <div class="kpi"><b>${events}</b><span>tornei</span></div>
      <div class="kpi"><b>${rows.length}</b><span>archetipi</span></div>
      <div class="kpi"><b><a href="${fmtLink("/e")}">Tornei →</a></b><span>elenco eventi</span></div>
    </div>
    ${N ? `<div class="card scroll"><table>
      <thead><tr><th class="num">#</th><th>Archetipo</th><th class="num">Liste</th><th class="num">% meta</th><th></th>
        <th class="num">Vittorie</th><th class="num">Top 8 / 5-0</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td class="num" data-v="${i}">${i + 1}</td>
        <td class="name" data-v="${esc(r.arch)}">${pips(topColors(r.decks))}<a href="${archLink(r.arch)}">${esc(r.arch)}</a></td>
        <td class="num" data-v="${r.decks.length}">${r.decks.length}</td>
        <td class="num" data-v="${r.decks.length}">${pct(r.decks.length / N)}</td>
        <td><div class="bar"><i style="width:${(100 * r.decks.length / N / maxShare).toFixed(1)}%"></i></div></td>
        <td class="num" data-v="${r.wins}">${r.wins}</td>
        <td class="num" data-v="${r.top8}">${r.top8}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="card empty">Nessuna lista con questi filtri. Prova ad allargare il periodo.</div>`}
  `);
}

function compTable(comp, N, cards) {
  if (!comp.length) return `<div class="card empty">Nessuna carta.</div>`;
  return `<div class="card scroll"><table>
    <thead><tr><th>Carta</th><th class="num">% liste</th><th></th><th class="num">Copie medie</th>
      <th>Copie: 1·2·3·4</th><th>Ruolo</th></tr></thead>
    <tbody>${comp.map((s) => {
      const [rc, rl] = role(s.incl);
      const mx = Math.max(...s.dist, 1);
      return `<tr>
        <td class="name" data-v="${esc(cards[s.card])}"><a href="${cardLink(cards[s.card])}">${esc(cards[s.card])}</a></td>
        <td class="num" data-v="${s.incl}">${pct(s.incl)}</td>
        <td><div class="bar"><i style="width:${(100 * s.incl).toFixed(1)}%"></i></div></td>
        <td class="num" data-v="${s.avg}">${s.avg.toFixed(2)}</td>
        <td data-v="${s.dist.join(",")}" title="${s.dist.map((n, i) => `${i + 1}${i === 3 ? "+" : ""} copie: ${n} liste`).join("\n")}">
          <span class="dist">${s.dist.map((n) => `<i style="height:${n ? Math.max(2, 18 * n / mx) : 0}px"></i>`).join("")}</span>
          <span class="dist-legend">${s.dist.join("·")}</span></td>
        <td data-v="${s.incl}"><span class="role ${rc}">${rl}</span></td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function renderArch(arch) {
  const all = filtered();
  const decks = all.filter((d) => d.arch === arch);
  const cards = state.data.cards;
  const N = decks.length;
  if (!N) return view(`<div class="crumbs"><a href="${fmtLink()}">${esc(state.data.format)}</a> ›</div>
    <h1>${esc(arch)}</h1><div class="card empty">Nessuna lista di questo archetipo con i filtri attuali.</div>`);
  const main = composition(decks, "main"), side = composition(decks, "side");
  const aggM = aggregate(main, avgSize(decks, "main")), aggS = aggregate(side, avgSize(decks, "side"));
  const wins = decks.filter((d) => d.rank === 1).length;
  const methods = new Set(decks.map((d) => d.method));
  const list = [...decks].sort((a, b) => (b.ev[2] > a.ev[2] ? 1 : b.ev[2] < a.ev[2] ? -1 : (a.rank ?? 99) - (b.rank ?? 99)));
  const tab = sessionStorage.getItem("mtgmeta-tab") || "main";
  view(`
    <div class="crumbs"><a href="${fmtLink()}">${esc(state.data.format)}</a> › archetipo</div>
    <h1>${pips(topColors(decks))}${esc(arch)}</h1>
    <div class="note">${filterLabel()}${methods.has("colors") ? " · <span class='tag'>gruppo per colori: archetipo non riconosciuto dalle regole</span>" : ""}</div>
    <div class="kpis">
      <div class="kpi"><b>${N}</b><span>liste</span></div>
      <div class="kpi"><b>${pct(N / all.length)}</b><span>del metagame</span></div>
      <div class="kpi"><b>${wins}</b><span>tornei vinti</span></div>
      <div class="kpi"><b>${main.filter((s) => s.incl >= 0.9).length}</b><span>carte core (≥90%)</span></div>
    </div>
    <div class="tabs" id="tabs">
      ${[["main", "Composizione main"], ["side", "Sideboard"], ["avg", "Lista media"], ["decks", `Liste (${N})`]]
        .map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("")}
    </div>
    <section data-pane="main"><div class="note">Per ogni carta: % di liste che la giocano nel main, copie medie quando è giocata, e quante liste ne giocano 1/2/3/4 copie. Core ≥ 90%, Flex 30–90%, Tech &lt; 30%.</div>${compTable(main, N, cards)}</section>
    <section data-pane="side"><div class="note">Sideboard: stessa analisi.</div>${compTable(side, N, cards)}</section>
    <section data-pane="avg"><div class="note">Lista aggregata: copie medie per lista (totale copie ÷ liste), arrotondate per arrivare alla dimensione media delle liste. Il numero a destra è la % di liste che giocano la carta.</div>
      <div class="card"><div class="decklist">
        <h4>Main (${aggM.total})</h4>${aggM.cards.map(([c, q]) => line(q, cards[c], main.find((s) => s.card === c).incl)).join("")}
        <h4>Sideboard (${aggS.total})</h4>${aggS.cards.map(([c, q]) => line(q, cards[c], side.find((s) => s.card === c).incl)).join("")}
      </div></div></section>
    <section data-pane="decks">${decksTable(list)}</section>
  `);
  const show = (k) => {
    document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== k));
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === k));
    try { sessionStorage.setItem("mtgmeta-tab", k); } catch (_) { /* */ }
  };
  $("#tabs").addEventListener("click", (e) => e.target.dataset.tab && show(e.target.dataset.tab));
  show(tab);
}

function line(q, name, incl, cls = "") {
  return `<div class="${cls}"><span class="q">${q}</span><a href="${cardLink(name)}">${esc(name)}</a>${incl != null ? `<span class="pct">${pct(incl)}</span>` : ""}</div>`;
}

function decksTable(list, showArch = false) {
  return `<div class="card scroll"><table>
    <thead><tr><th>Data</th><th>Torneo</th><th>Tipo</th>${showArch ? "<th>Archetipo</th>" : ""}<th>Giocatore</th><th>Risultato</th><th></th></tr></thead>
    <tbody>${list.map((d) => `<tr>
      <td data-v="${d.ev[2]}">${fmtDate(d.ev[2])}</td>
      <td class="name" data-v="${esc(d.ev[1])}"><a href="${fmtLink(`/e/${d.evIdx}`)}">${esc(d.ev[1])}</a></td>
      <td><span class="tag">${d.ev[3] === "paper" ? "cartaceo" : "online"}</span></td>
      ${showArch ? `<td class="name" data-v="${esc(d.arch)}">${pips(d.colors)}<a href="${archLink(d.arch)}">${esc(d.arch)}</a></td>` : ""}
      <td data-v="${esc(d.player)}">${esc(d.player)}</td>
      <td data-v="${d.rank ?? (d.wins != null ? 100 - d.wins : 999)}">${esc(d.result)}</td>
      <td><a href="${deckLink(d.id)}">lista →</a></td></tr>`).join("")}</tbody></table></div>`;
}

function renderDeck(id) {
  const d = state.data.deckById.get(id);
  if (!d) return view(`<div class="card empty">Lista non trovata.</div>`);
  const cards = state.data.cards;
  // confronto con l'archetipo, stessi filtri di data/tipo ma tutte le posizioni
  const peers = state.data.decks.filter((x) => x.arch === d.arch);
  const incl = (board) => new Map(composition(peers, board).map((s) => [s.card, s.incl]));
  const im = incl("main"), is = incl("side");
  const block = (l, m) => {
    const rows = []; for (let i = 0; i < l.length; i += 2) rows.push([l[i], l[i + 1]]);
    return rows.sort((a, b) => b[1] - a[1] || cards[a[0]].localeCompare(cards[b[0]]))
      .map(([c, q]) => line(q, cards[c], m.get(c), (m.get(c) ?? 0) < 0.15 ? "rare" : "")).join("");
  };
  const sum = (l) => { let t = 0; for (let i = 1; i < l.length; i += 2) t += l[i]; return t; };
  view(`
    <div class="crumbs"><a href="${fmtLink()}">${esc(state.data.format)}</a> › <a href="${archLink(d.arch)}">${esc(d.arch)}</a> › lista</div>
    <h1>${pips(d.colors)}${esc(d.arch)} — ${esc(d.player)}</h1>
    <div class="note">${esc(d.result)} · <a href="${fmtLink(`/e/${d.evIdx}`)}">${esc(d.ev[1])}</a> · ${fmtDate(d.ev[2])} ·
      ${d.ev[3] === "paper" ? "cartaceo" : "online"} · fonte ${esc(d.ev[4])}${d.url ? ` · <a href="${esc(d.url)}" target="_blank" rel="noopener">originale ↗</a>` : ""}</div>
    <div class="note">A destra: % di liste ${esc(d.arch)} (${peers.length}, tutto il periodo caricato) che giocano la carta. <span class="rare" style="color:var(--tech)">In viola</span> le scelte insolite (&lt; 15%).</div>
    <div class="card"><div class="decklist">
      <h4>Main (${sum(d.main)})</h4>${block(d.main, im)}
      <h4>Sideboard (${sum(d.side)})</h4>${block(d.side, is)}
    </div></div>
    <p><button onclick="copyDeck(${d.id})" class="tabs-btn">Copia lista (formato MTGO/Arena)</button> <span id="copied" class="muted"></span></p>
  `);
}

window.copyDeck = (id) => {
  const d = state.data.deckById.get(id), c = state.data.cards;
  const txt = (l) => { const o = []; for (let i = 0; i < l.length; i += 2) o.push(`${l[i + 1]} ${c[l[i]]}`); return o.join("\n"); };
  navigator.clipboard?.writeText(`${txt(d.main)}\n\nSideboard\n${txt(d.side)}`).then(() => ($("#copied").textContent = "Copiata!"));
};

function renderCard(name) {
  const ci = state.data.cardIdx.get(name.toLowerCase());
  if (ci == null) return view(`<h1>${esc(name)}</h1><div class="card empty">Carta non presente nelle liste di ${esc(state.data.format)}.</div>`);
  const cards = state.data.cards;
  const decks = filtered();
  const by = new Map();
  let withCard = 0;
  for (const d of decks) {
    let a = by.get(d.arch);
    if (!a) by.set(d.arch, (a = { arch: d.arch, n: 0, main: 0, side: 0, qty: 0, colors: d.colors }));
    a.n++;
    let has = false;
    for (const [k, board] of [["main", "main"], ["side", "side"]]) {
      const l = d[k];
      for (let i = 0; i < l.length; i += 2) if (l[i] === ci) { a[board]++; if (board === "main") a.qty += l[i + 1]; has = true; }
    }
    if (has) withCard++;
  }
  const rows = [...by.values()].filter((a) => a.main || a.side).sort((a, b) => (b.main + b.side) - (a.main + a.side));
  view(`
    <div class="crumbs"><a href="${fmtLink()}">${esc(state.data.format)}</a> › carta</div>
    <h1>${esc(cards[ci])}</h1>
    <div class="note">${filterLabel()}</div>
    <div class="kpis">
      <div class="kpi"><b>${pct(withCard / (decks.length || 1))}</b><span>delle liste la giocano (main o side)</span></div>
      <div class="kpi"><b>${rows.length}</b><span>archetipi</span></div>
    </div>
    ${rows.length ? `<div class="card scroll"><table>
      <thead><tr><th>Archetipo</th><th class="num">Liste arch.</th><th class="num">% main</th><th class="num">Copie medie main</th><th class="num">% side</th></tr></thead>
      <tbody>${rows.map((a) => `<tr>
        <td class="name" data-v="${esc(a.arch)}">${pips(a.colors)}<a href="${archLink(a.arch)}">${esc(a.arch)}</a></td>
        <td class="num" data-v="${a.n}">${a.n}</td>
        <td class="num" data-v="${a.main / a.n}">${pct(a.main / a.n)}</td>
        <td class="num" data-v="${a.main ? a.qty / a.main : 0}">${a.main ? (a.qty / a.main).toFixed(2) : "–"}</td>
        <td class="num" data-v="${a.side / a.n}">${pct(a.side / a.n)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="card empty">Nessuna lista con questa carta nei filtri attuali.</div>`}
  `);
}

function renderEvents() {
  const decks = filtered();
  const evs = new Map();
  for (const d of decks) { const e = evs.get(d.evIdx) || { idx: d.evIdx, ev: d.ev, n: 0 }; e.n++; evs.set(d.evIdx, e); }
  const rows = [...evs.values()].sort((a, b) => (a.ev[2] < b.ev[2] ? 1 : -1));
  view(`
    <div class="crumbs"><a href="${fmtLink()}">${esc(state.data.format)}</a> › tornei</div>
    <h1>Tornei ${esc(state.data.format)}</h1><div class="note">${filterLabel()}</div>
    <div class="card scroll"><table><thead><tr><th>Data</th><th>Torneo</th><th>Tipo</th><th>Fonte</th><th class="num">Giocatori</th><th class="num">Liste</th></tr></thead>
    <tbody>${rows.map((e) => `<tr><td data-v="${e.ev[2]}">${fmtDate(e.ev[2])}</td>
      <td class="name" data-v="${esc(e.ev[1])}"><a href="${fmtLink(`/e/${e.idx}`)}">${esc(e.ev[1])}</a></td>
      <td><span class="tag">${e.ev[3] === "paper" ? "cartaceo" : "online"}</span></td><td>${esc(e.ev[4])}</td>
      <td class="num" data-v="${e.ev[6] ?? 0}">${e.ev[6] ?? "–"}</td><td class="num" data-v="${e.n}">${e.n}</td></tr>`).join("")}</tbody></table></div>`);
}

function renderEvent(idx) {
  const ev = state.data.events[idx];
  if (!ev) return view(`<div class="card empty">Torneo non trovato.</div>`);
  const list = state.data.decks.filter((d) => d.evIdx === idx).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (b.wins ?? 0) - (a.wins ?? 0));
  view(`
    <div class="crumbs"><a href="${fmtLink()}">${esc(state.data.format)}</a> › <a href="${fmtLink("/e")}">tornei</a> ›</div>
    <h1>${esc(ev[1])}</h1>
    <div class="note">${fmtDate(ev[2])} · ${ev[3] === "paper" ? "cartaceo" : "online"} · fonte ${esc(ev[4])}${ev[6] ? ` · ${ev[6]} giocatori` : ""}${ev[5] ? ` · <a href="${esc(ev[5])}" target="_blank" rel="noopener">originale ↗</a>` : ""}</div>
    ${decksTable(list, true)}`);
}

/* ---------- ordinamento tabelle ---------- */
function enableSorting() {
  document.querySelectorAll("#app table").forEach((t) => {
    t.querySelectorAll("th").forEach((th, col) => th.addEventListener("click", () => {
      const body = t.tBodies[0];
      const dir = th.dataset.dir === "desc" ? 1 : -1;
      th.dataset.dir = dir === 1 ? "asc" : "desc";
      const val = (r) => { const c = r.cells[col]; const v = c?.dataset.v ?? c?.textContent ?? ""; const n = parseFloat(v); return isNaN(n) || /[a-z]/i.test(v) ? v.toLowerCase() : n; };
      [...body.rows].sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; }).forEach((r) => body.appendChild(r));
    }));
  });
}

/* ---------- router ---------- */
async function route() {
  if (!state.meta) await loadMeta();
  const fmts = state.meta.formats;
  if (!fmts.length) return view(`<div class="card empty">Nessun dato ancora. Esegui <code>python -m mtgmeta all</code>.</div>`);
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const slug = fmts.some((f) => f.slug === parts[0]) ? parts[0] : fmts[0].slug;
  if (parts[0] !== slug) { location.replace(`#/${slug}`); return; }
  state.fmt = slug;
  $("#formats").innerHTML = fmts.map((f) => `<a href="#/${f.slug}" class="${f.slug === slug ? "on" : ""}">${esc(f.format)} <small>${f.decks}</small></a>`).join("");
  await loadFormat(slug);
  const [, kind, arg] = parts;
  if (kind === "a") renderArch(arg);
  else if (kind === "d") renderDeck(Number(arg));
  else if (kind === "c") renderCard(arg);
  else if (kind === "e" && arg != null) renderEvent(Number(arg));
  else if (kind === "e") renderEvents();
  else renderMeta();
  document.title = `${state.data.format} · MTG Meta Tracker`;
}

function bindFilters() {
  $("#f-days").value = state.days; $("#f-type").value = state.type; $("#f-place").value = state.place;
  const upd = () => {
    state.days = Number($("#f-days").value); state.type = $("#f-type").value; state.place = $("#f-place").value;
    try { localStorage.setItem("mtgmeta-filters", JSON.stringify({ days: state.days, type: state.type, place: state.place })); } catch (_) { /* */ }
    route();
  };
  ["#f-days", "#f-type", "#f-place"].forEach((s) => $(s).addEventListener("change", upd));
  $("#f-card").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v && state.data?.cardIdx.has(v.toLowerCase())) { location.hash = cardLink(v); e.target.value = ""; }
  });
}

window.addEventListener("hashchange", route);
bindFilters();
route().catch((e) => view(`<div class="card empty">Errore nel caricamento dei dati: ${esc(e.message)}</div>`));
