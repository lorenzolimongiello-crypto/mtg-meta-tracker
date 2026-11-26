/* ==========================================================================
   Metagame — frontend statico.
   Tutte le statistiche vengono calcolate nel browser a partire da
   data/formats/<formato>.json: i filtri sono istantanei e sempre coerenti.
   ========================================================================== */
"use strict";

/* ---------- utilità ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;
const NF1 = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat("it-IT");
const pct = (x) => NF1.format(100 * x) + "%";
const pct0 = (x) => Math.round(100 * x) + "%";
const n0 = (x) => NF0.format(x);
const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const MONTHS_L = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const dShort = (s) => `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]}`;
const dLong = (s) => `${+s.slice(8, 10)} ${MONTHS_L[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
const IMG = (path, size = "normal") => (path ? `https://cards.scryfall.io/${size}/${path}` : null);
const SYM = (s) => `https://svgs.scryfall.io/card-symbols/${s.replace(/\//g, "")}.svg`;
const plural = (n, one, many) => `${n0(n)} ${n === 1 ? one : many}`;

const TIERS = ["large", "medium", "small", "league"];
const TIER_L = { large: "Grandi", medium: "Medi", small: "Piccoli", league: "Leghe 5-0" };
const TIER_S = { large: "grande", medium: "medio", small: "piccolo", league: "lega MTGO" };
const TIER_P = { large: "grandi", medium: "medi", small: "piccoli", league: "leghe MTGO" };
const TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Kindred", "Other", "Land"];
const TYPE_L = { Creature: "Creature", Planeswalker: "Planeswalker", Battle: "Battaglie", Instant: "Istantanei", Sorcery: "Stregonerie", Artifact: "Artefatti", Enchantment: "Incantesimi", Kindred: "Tribali", Other: "Altro", Land: "Terre" };

/* ---------- stato ---------- */
const state = {
  meta: null, data: null, slug: null, cache: {},
  f: { days: 30, type: "all", tiers: new Set(TIERS), place: "all" },
  sort: "share", showAll: false,
};
try {
  const s = JSON.parse(localStorage.getItem("mm-filters") || "{}");
  if (s.days) state.f.days = s.days;
  if (s.type) state.f.type = s.type;
  if (Array.isArray(s.tiers) && s.tiers.length) state.f.tiers = new Set(s.tiers);
  if (s.place) state.f.place = s.place;
} catch (_) { /* storage non disponibile */ }
const saveFilters = () => {
  try { localStorage.setItem("mm-filters", JSON.stringify({ ...state.f, tiers: [...state.f.tiers] })); } catch (_) { /* */ }
};

/* ---------- caricamento ---------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} su ${url}`);
  return r.json();
}

async function loadMeta() {
  if (state.meta) return;
  state.meta = await getJSON("data/meta.json");
  const g = new Date(state.meta.generated);
  $("#updated").innerHTML = `Aggiornato il ${g.toLocaleDateString("it-IT", { day: "numeric", month: "long" })} alle ${g.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.<br>${n0(state.meta.totals.decks)} liste da ${n0(state.meta.totals.tournaments)} tornei.`;
}

async function loadFormat(slug) {
  if (!state.cache[slug]) {
    const raw = await getJSON(`data/formats/${slug}.json`);
    const ev = raw.events.map((e, i) => ({ i, id: e[0], name: e[1], date: e[2], type: e[3], source: e[4], url: e[5], players: e[6], kind: e[7], tier: e[8] }));
    const D = {
      format: raw.format, slug,
      cards: raw.cards,
      info: raw.cardInfo.map((c) => ({ type: c[0], cmc: c[1], mana: c[2], img: c[3], art: c[4], artist: c[5], colors: c[6] })),
      archetypes: raw.archetypes, signature: raw.signature, events: ev,
    };
    D.decks = raw.decks.map((d) => ({
      id: d[0], ev: ev[d[1]], player: d[2], result: d[3], rank: d[4], wins: d[5], losses: d[6],
      arch: raw.archetypes[d[7]], method: d[8], colors: d[9], url: d[10], pts: d[11], main: d[12], side: d[13],
    }));
    D.byId = new Map(D.decks.map((d) => [d.id, d]));
    D.cardIdx = new Map(D.cards.map((c, i) => [c.toLowerCase(), i]));
    D.maxDate = ev.reduce((m, e) => (e.date > m ? e.date : m), "");
    D.minDate = ev.reduce((m, e) => (e.date < m ? e.date : m), "9999");
    state.cache[slug] = D;
  }
  state.data = state.cache[slug];
  state.slug = slug;
}

/* ---------- filtri ---------- */
function shiftDate(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const isTop8 = (d) => (d.rank != null && d.rank <= 8) || (d.ev.tier === "league" && d.wins >= 5 && !d.losses);
function passes(d, from, to) {
  const f = state.f;
  if (d.ev.date < from || d.ev.date > to) return false;
  if (f.type !== "all" && d.ev.type !== f.type) return false;
  if (!f.tiers.has(d.ev.tier)) return false;
  if (f.place === "top8" && !isTop8(d)) return false;
  if (f.place === "win" && d.rank !== 1) return false;
  return true;
}
function windowDates(offset = 0) {
  const to = shiftDate(state.data.maxDate, -offset * state.f.days);
  const from = shiftDate(to, -state.f.days + 1);
  return [from, to];
}
function filtered(offset = 0) {
  const [from, to] = windowDates(offset);
  return state.data.decks.filter((d) => passes(d, from, to));
}
const hasPrev = () => windowDates(1)[0] >= state.data.minDate;
function filterSentence() {
  const f = state.f;
  const parts = [`ultimi ${f.days} giorni`];
  if (f.type !== "all") parts.push(f.type === "online" ? "solo online" : "solo cartacei");
  if (f.tiers.size < 4) parts.push("tornei " + [...f.tiers].map((t) => TIER_L[t].toLowerCase()).join(", "));
  if (f.place === "top8") parts.push("solo Top 8");
  if (f.place === "win") parts.push("solo vincitori");
  return parts.join(" · ");
}

/* ---------- statistiche ---------- */
function metagame(decks) {
  const m = new Map();
  for (const d of decks) {
    let a = m.get(d.arch);
    if (!a) m.set(d.arch, (a = { arch: d.arch, n: 0, wins: 0, top8: 0, pts: 0, tiers: {}, colors: new Map() }));
    a.n++; a.pts += d.pts;
    if (d.rank === 1) a.wins++;
    if (isTop8(d)) a.top8++;
    const t = (a.tiers[d.ev.tier] ||= { n: 0, wins: 0, top8: 0 });
    t.n++; if (d.rank === 1) t.wins++; if (isTop8(d)) t.top8++;
    a.colors.set(d.colors, (a.colors.get(d.colors) || 0) + 1);
  }
  const N = decks.length || 1;
  const list = [...m.values()];
  for (const a of list) { a.share = a.n / N; a.color = [...a.colors.entries()].sort((x, y) => y[1] - x[1])[0][0]; }
  return list;
}

function composition(decks, key = "main") {
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
  return [...m.values()].map((s) => {
    const mode = s.dist.indexOf(Math.max(...s.dist)) + 1;
    return { ...s, incl: s.n / N, avg: s.qty / s.n, exp: s.qty / N, mode };
  }).sort((a, b) => b.incl - a.incl || b.avg - a.avg);
}

/* Lista aggregata: copie medie per lista (totale copie / liste); parte intera a tutte,
   le copie mancanti per arrivare alla dimensione media vanno ai resti più alti. */
function aggregate(comp, target) {
  const it = comp.map((s) => ({ card: s.card, exp: s.exp, incl: s.incl, q: Math.floor(s.exp) }));
  let tot = it.reduce((a, b) => a + b.q, 0);
  [...it].sort((a, b) => (b.exp - b.q) - (a.exp - a.q)).forEach((x) => { if (tot < target && x.exp > x.q) { x.q++; tot++; } });
  return { cards: it.filter((x) => x.q > 0).map((x) => [x.card, x.q, x.incl]), total: tot };
}
const deckSize = (decks, key) => {
  let t = 0;
  for (const d of decks) for (let i = 1; i < d[key].length; i += 2) t += d[key][i];
  return Math.round(t / (decks.length || 1));
};
const cardsOf = (flat) => { const o = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; };
const total = (flat) => { let t = 0; for (let i = 1; i < flat.length; i += 2) t += flat[i]; return t; };

/* ---------- varianti: k-medoids su Jaccard pesato delle carte "flessibili" ---------- */
function findVariants(decks, comp) {
  const N = decks.length;
  if (N < 14) return { reason: "few" };
  // solo carte non-terra: le varianti devono riflettere scelte di gioco, non quale fetchland usare
  const feats = comp.filter((s) => s.incl >= 0.1 && s.incl <= 0.9 && state.data.info[s.card].type !== "Land").map((s) => s.card);
  if (feats.length < 3) return { reason: "stable" };
  const fi = new Map(feats.map((c, i) => [c, i]));
  const F = feats.length;
  // campione deterministico per archetipi molto numerosi
  const step = Math.max(1, Math.ceil(N / 500));
  const sample = decks.filter((_, i) => i % step === 0);
  const vec = (d) => {
    const v = new Float32Array(F);
    for (let i = 0; i < d.main.length; i += 2) { const j = fi.get(d.main[i]); if (j != null) v[j] = Math.min(d.main[i + 1], 4) / 4; }
    return v;
  };
  const V = sample.map(vec);
  const S = V.length;
  const dist = (a, b) => { let mn = 0, mx = 0; for (let j = 0; j < F; j++) { const x = a[j], y = b[j]; if (x < y) { mn += x; mx += y; } else { mn += y; mx += x; } } return mx ? 1 - mn / mx : 0; };
  const M = new Float32Array(S * S);
  for (let i = 0; i < S; i++) for (let j = i + 1; j < S; j++) { const v = dist(V[i], V[j]); M[i * S + j] = v; M[j * S + i] = v; }
  const D = (i, j) => M[i * S + j];

  function kmedoids(k) {
    // inizializzazione: il punto più centrale, poi i più lontani
    let best = 0, bs = Infinity;
    for (let i = 0; i < S; i++) { let s = 0; for (let j = 0; j < S; j++) s += D(i, j); if (s < bs) { bs = s; best = i; } }
    const med = [best];
    while (med.length < k) {
      let far = -1, fd = -1;
      for (let i = 0; i < S; i++) { const md = Math.min(...med.map((m) => D(i, m))); if (md > fd) { fd = md; far = i; } }
      med.push(far);
    }
    let asg = new Int32Array(S);
    for (let it = 0; it < 12; it++) {
      for (let i = 0; i < S; i++) { let b = 0, bd = Infinity; med.forEach((m, c) => { const v = D(i, m); if (v < bd) { bd = v; b = c; } }); asg[i] = b; }
      let changed = false;
      for (let c = 0; c < k; c++) {
        const mem = []; for (let i = 0; i < S; i++) if (asg[i] === c) mem.push(i);
        if (!mem.length) continue;
        let bm = med[c], bsum = Infinity;
        for (const i of mem) { let s = 0; for (const j of mem) s += D(i, j); if (s < bsum) { bsum = s; bm = i; } }
        if (bm !== med[c]) { med[c] = bm; changed = true; }
      }
      if (!changed) break;
    }
    // silhouette media
    let sil = 0;
    for (let i = 0; i < S; i++) {
      const sums = new Float64Array(k), cnt = new Int32Array(k);
      for (let j = 0; j < S; j++) if (j !== i) { sums[asg[j]] += D(i, j); cnt[asg[j]]++; }
      const a = cnt[asg[i]] ? sums[asg[i]] / cnt[asg[i]] : 0;
      let b = Infinity; for (let c = 0; c < k; c++) if (c !== asg[i] && cnt[c]) b = Math.min(b, sums[c] / cnt[c]);
      sil += b === Infinity || Math.max(a, b) === 0 ? 0 : (b - a) / Math.max(a, b);
    }
    return { k, med, asg, sil: sil / S };
  }

  let pick = null;
  for (let k = 2; k <= 4 && k < S / 5; k++) {
    const r = kmedoids(k);
    const sizes = Array.from({ length: k }, (_, c) => r.asg.filter((x) => x === c).length);
    if (Math.min(...sizes) < Math.max(4, 0.08 * S)) continue;
    if (r.sil > 0.12 && (!pick || r.sil > pick.sil + 0.02)) pick = r;
  }
  if (!pick) return { reason: "stable" };

  // assegna TUTTE le liste al medoid più vicino
  const medV = pick.med.map((m) => V[m]);
  const groups = Array.from({ length: pick.k }, () => []);
  for (const d of decks) {
    const v = vec(d); let b = 0, bd = Infinity;
    medV.forEach((mv, c) => { const x = dist(v, mv); if (x < bd) { bd = x; b = c; } });
    groups[b].push(d);
  }
  const used = new Set();
  const out = groups.map((g, c) => {
    const rest = decks.filter((d) => !g.includes(d));
    const inG = new Map(composition(g).map((s) => [s.card, s]));
    const inR = new Map(composition(rest).map((s) => [s.card, s.incl]));
    const diffs = [];
    for (const s of comp) {
      const a = inG.get(s.card)?.incl || 0, b = inR.get(s.card) || 0;
      if (Math.abs(a - b) >= 0.25) diffs.push({ card: s.card, a, b, d: a - b, q: inG.get(s.card)?.mode || 0 });
    }
    const plus = diffs.filter((x) => x.d > 0).sort((x, y) => y.d - x.d);
    const minus = diffs.filter((x) => x.d < 0).sort((x, y) => x.d - y.d);
    const D_ = state.data;
    const key = plus.find((x) => !used.has(x.card) && D_.info[x.card].type !== "Land") || plus.find((x) => !used.has(x.card));
    let name;
    if (key) { used.add(key.card); name = `Con ${D_.cards[key.card]}`; }
    else if (minus[0]) name = `Senza ${D_.cards[minus[0].card]}`;
    else name = `Variante ${c + 1}`;
    // lista "tipo": il medoid assegnato al gruppo
    const medDeck = sample[pick.med[c]];
    return {
      name, decks: g, share: g.length / N, plus: plus.slice(0, 4), minus: minus.slice(0, 3),
      wins: g.filter((d) => d.rank === 1).length, top8: g.filter(isTop8).length,
      pts: g.reduce((s, d) => s + d.pts, 0) / (g.length || 1), medoid: medDeck,
    };
  }).sort((a, b) => b.decks.length - a.decks.length);
  return { list: out, sil: pick.sil };
}

/* Varianti STABILI: identificate una volta su tutte le liste caricate dell'archetipo,
   così nome e composizione non cambiano al variare dei filtri (che cambiano solo i numeri). */
function archVariants(arch) {
  const D = state.data;
  D.varCache ||= new Map();
  if (!D.varCache.has(arch)) {
    const all = D.decks.filter((d) => d.arch === arch);
    const v = findVariants(all, composition(all, "main"));
    if (v.list) v.of = new Map(v.list.flatMap((x) => x.decks.map((d) => [d, x])));
    D.varCache.set(arch, v);
  }
  return D.varCache.get(arch);
}

/* ---------- frammenti di interfaccia ---------- */
function manaCost(cost, cls = "") {
  if (!cost) return "";
  const parts = cost.split(" // ")[0].match(/\{[^}]+\}/g) || [];
  return `<span class="mana ${cls}">${parts.map((p) => { const s = p.slice(1, -1); return `<img src="${SYM(s)}" alt="{${esc(s)}}" loading="lazy">`; }).join("")}</span>`;
}
function pips(colors, cls = "") {
  const c = colors || "C";
  return `<span class="mana ${cls}" title="${esc(colors || "Incolore")}">${[..."WUBRG"].filter((x) => c.includes(x)).concat(c === "C" ? ["C"] : []).map((x) => `<img src="${SYM(x)}" alt="${x}" loading="lazy">`).join("")}</span>`;
}
function formatInclusion() {
  const D = state.data;
  if (!D.fmtIncl) {
    const m = new Map();
    for (const d of D.decks) for (let i = 0; i < d.main.length; i += 2) m.set(d.main[i], (m.get(d.main[i]) || 0) + 1);
    D.fmtIncl = m;
  }
  return D.fmtIncl;
}
const archArt = (arch) => { const s = state.data.signature[arch]; return s != null ? state.data.info[s] : null; };
const fmtLink = (p = "") => `#/${state.slug}${p}`;
const archLink = (a) => fmtLink(`/mazzo/${enc(a)}`);
const deckLink = (id) => fmtLink(`/lista/${id}`);
const cardLink = (c) => fmtLink(`/carta/${enc(c)}`);
const evLink = (i) => fmtLink(`/torneo/${i}`);
const tierDot = (t) => `<i class="tier-dot ${t}" aria-hidden="true"></i>`;
function tierBadge(ev) {
  const p = ev.players ? `${n0(ev.players)} giocatori` : ev.tier === "league" ? "lega" : ev.kind === "challenge" ? "Challenge MTGO" : "iscritti n.d.";
  return `<span class="tier" title="Torneo ${TIER_S[ev.tier]}">${tierDot(ev.tier)}${p}</span>`;
}
function delta(cur, prev) {
  if (prev == null) return "";
  const d = (cur - prev) * 100;
  if (Math.abs(d) < 0.3) return `<span class="delta flat" title="Stabile rispetto al periodo precedente">=</span>`;
  return `<span class="delta ${d > 0 ? "up" : "down"}" title="Rispetto ai ${state.f.days} giorni precedenti">${d > 0 ? "▲" : "▼"} ${NF1.format(Math.abs(d))}</span>`;
}
function cardImg(ci, name, size = "normal", eager = false) {
  const src = IMG(ci.img, size);
  return `<div class="card-img">${src ? `<img src="${src}" alt="${esc(name)}" ${eager ? "" : 'loading="lazy"'} decoding="async">` : `<div class="fallback">${esc(name)}</div>`}</div>`;
}
const credit = (ci) => (ci?.artist ? `<span class="credit">${esc(ci.artist)}</span>` : "");
const empty = (title, text) => `<div class="empty"><b>${title}</b>${text}</div>`;
function resultsLine(tiers, compact = false) {
  const out = [];
  for (const t of ["large", "medium", "small"]) {
    const r = tiers[t]; if (!r || !r.top8) continue;
    out.push(`<span class="tier">${tierDot(t)}${r.wins ? `<b>${r.wins}</b>&nbsp;${r.wins === 1 ? "vittoria" : "vittorie"} · ` : ""}<b>${r.top8}</b>&nbsp;top 8${compact ? "" : ` in tornei ${TIER_P[t]}`}</span>`);
  }
  if (tiers.league?.top8) out.push(`<span class="tier">${tierDot("league")}<b>${tiers.league.top8}</b>&nbsp;5-0</span>`);
  return out.join("") || `<span class="muted">nessun top 8</span>`;
}

/* Vittorie e top 8 + barra impilata dei top 8 per fascia (stessi colori dei filtri) */
function resultsStack(a, maxTop8) {
  const parts = TIERS.map((t) => [t, a.tiers[t]?.top8 || 0]).filter(([, n]) => n);
  const tip = TIERS.filter((t) => a.tiers[t]).map((t) => `${TIER_L[t]}: ${a.tiers[t].wins || 0} vittorie, ${a.tiers[t].top8 || 0} ${t === "league" ? "5-0" : "top 8"}`).join("\n");
  return `<span class="rs" title="${esc(tip)}">
    <span class="rs-n"><b>${a.wins}</b> ${a.wins === 1 ? "vittoria" : "vittorie"} <span class="dot-sep">·</span> <b>${a.top8}</b> top 8</span>
    <span class="rs-bar" style="width:${Math.max(4, 100 * a.top8 / maxTop8)}%">${parts.map(([t, n]) => `<i class="t-${t}" style="flex:${n}"></i>`).join("")}</span>
  </span>`;
}

/* ---------- viste ---------- */
function view(html, { keepScroll = false } = {}) {
  const app = $("#app");
  app.innerHTML = `<div class="fade-in">${html}</div>`;
  if (!keepScroll) window.scrollTo(0, 0);
  enableSorting();
}

/* Home */
function renderHome() {
  const M = state.meta;
  const cards = M.formats.filter((f) => f.top?.length).map((f) => {
    const top = f.top[0];
    return `<a class="fcard" href="#/${f.slug}">
      <div class="art">${top?.art ? `<img src="${IMG(top.art, "art_crop")}" alt="" loading="lazy">` : ""}<h3>${esc(f.format)}</h3>${top?.artist ? `<span class="credit">${esc(top.artist)}</span>` : ""}</div>
      <div class="body">
        <div class="meta"><span>${n0(f.decks)} liste</span><span>${n0(f.events)} tornei</span><span>aggiornato al ${dShort(f.last)}</span></div>
        <ol>${f.top.map((a) => `<li><span class="nm">${pips(a.colors)} ${esc(a.name)}</span><div class="bar"><i style="width:${Math.min(100, a.share / f.top[0].share * 100)}%"></i></div><span class="pc">${pct(a.share)}</span></li>`).join("")}</ol>
      </div></a>`;
  }).join("");
  view(`
    <section class="home-hero">
      <div class="eyebrow">Aggiornato ogni 12 ore</div>
      <h1 class="display">Il metagame di Magic, <em>raccontato</em>.</h1>
      <p class="lede">Raccogliamo i risultati dei tornei <b>online e cartacei</b> di tutto il mondo e ti mostriamo, in modo chiaro, <b>quali mazzi vincono</b>, <b>con quali carte</b> e <b>in quali tornei</b>: dal negozio sotto casa al Pro Tour.</p>
      <div class="home-stats">
        <div><b>${n0(M.totals.decks)}</b><span>liste analizzate</span></div>
        <div><b>${n0(M.totals.tournaments)}</b><span>tornei</span></div>
        <div><b>${M.formats.length}</b><span>formati</span></div>
        <div><b>${n0(M.tiers?.large || 0)}</b><span>tornei grandi</span></div>
      </div>
    </section>
    <section class="sec">
      <div class="sec-head"><div><h2>Scegli un formato</h2><p>I mazzi più giocati negli ultimi 30 giorni.</p></div></div>
      <div class="format-grid">${cards}</div>
    </section>`);
  document.title = "Metagame — il metagame di Magic, raccontato";
}

/* Formato */
function renderFormat(opts) {
  const D = state.data;
  const decks = filtered();
  const prevOk = hasPrev();
  const prev = prevOk ? new Map(metagame(filtered(1)).map((a) => [a.arch, a.share])) : null;
  const meta = metagame(decks);
  const N = decks.length;
  const evSet = new Map(); decks.forEach((d) => evSet.set(d.ev.i, d.ev));
  const evs = [...evSet.values()];
  const tierCount = Object.fromEntries(TIERS.map((t) => [t, evs.filter((e) => e.tier === t).length]));
  const byShare = [...meta].sort((a, b) => b.n - a.n);
  const byPts = [...meta].sort((a, b) => b.pts - a.pts);
  const ptsRank = new Map(byPts.map((a, i) => [a.arch, i + 1]));
  const list = state.sort === "pts" ? byPts : byShare;
  const shown = state.showAll ? list : list.slice(0, 15);
  const maxShare = list.length ? Math.max(...list.map((a) => a.share)) : 1;
  const maxPts = byPts.length ? byPts[0].pts : 1;
  const maxTop8 = Math.max(1, ...meta.map((a) => a.top8));

  if (!N) {
    return view(`<header class="page-head"><div class="eyebrow">Metagame</div><h1 class="display">${esc(D.format)}</h1></header>
      ${empty("Nessuna lista con questi filtri", "Prova ad allargare il periodo o a includere più tipi di torneo.")}`, opts);
  }

  const lead = byShare[0], best = byPts[0];
  const podium = byShare.slice(0, 3).map((a, i) => {
    const ci = archArt(a.arch);
    return `<a class="pcard" href="${archLink(a.arch)}">
      ${ci?.art ? `<img src="${IMG(ci.art, "art_crop")}" alt="" ${i ? 'loading="lazy"' : ""}>` : ""}
      <span class="rank">N. ${i + 1}</span>${credit(ci)}
      <div>${pips(a.color, "lg")}</div>
      <h3>${esc(a.arch)}</h3>
      <div class="stats">
        <div><b>${pct(a.share)}</b><span>del metagame ${prev ? delta(a.share, prev.get(a.arch) || 0) : ""}</span></div>
        <div><b>${a.wins}</b><span>${a.wins === 1 ? "torneo vinto" : "tornei vinti"}</span></div>
        <div><b>${a.top8}</b><span>top 8</span></div>
      </div></a>`;
  }).join("");

  const rows = shown.map((a) => {
    const ci = archArt(a.arch);
    const pos = (state.sort === "pts" ? byPts : byShare).indexOf(a) + 1;
    return `<a class="meta-row" href="${archLink(a.arch)}">
      <span class="pos">${pos}</span>
      <span class="who">${ci?.art ? `<img class="thumb" src="${IMG(ci.art, "art_crop")}" alt="" loading="lazy">` : `<span class="thumb"></span>`}
        <span style="min-width:0"><span class="name">${esc(a.arch)}</span><span class="sub">${pips(a.color)} ${plural(a.n, "lista", "liste")}</span></span></span>
      <span class="share"><span class="bar"><i style="width:${(100 * a.share / maxShare).toFixed(1)}%"></i></span><span class="v">${pct(a.share)}</span></span>
      <span class="trend">${prev ? delta(a.share, prev.get(a.arch) || 0) : ""}</span>
      <span class="results">${resultsStack(a, maxTop8)}</span>
      <span class="score" title="Punteggio risultati: ${NF1.format(a.pts)} (n. ${ptsRank.get(a.arch)} nel formato)">${Math.round(100 * a.pts / maxPts)}</span>
    </a>`;
  }).join("");

  // tornei più importanti del periodo
  const tierRank = { large: 0, medium: 1, small: 2, league: 3 };
  const winners = new Map(); decks.forEach((d) => { if (d.rank === 1) winners.set(d.ev.i, d); });
  const bigEvents = evs.filter((e) => e.tier !== "league")
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || (b.players || 0) - (a.players || 0) || (a.date < b.date ? 1 : -1)).slice(0, 6);

  // carte più giocate (non terre)
  const comp = composition(decks).filter((s) => D.info[s.card].type !== "Land").slice(0, 10);

  view(`
    <header class="page-head">
      <div class="eyebrow">Metagame · ${filterSentence()}</div>
      <h1 class="display">${esc(D.format)}</h1>
      <p class="lede"><b>${n0(N)} liste</b> da <b>${plural(evs.length, "torneo", "tornei")}</b>. Il mazzo più presente è <a href="${archLink(lead.arch)}"><b>${esc(lead.arch)}</b></a> (${pct(lead.share)})${best.arch !== lead.arch ? `; quello con i <b>risultati migliori</b>, pesati per la dimensione dei tornei, è <a href="${archLink(best.arch)}"><b>${esc(best.arch)}</b></a>` : ", ed è anche quello con i risultati migliori"}.</p>
      <div class="tier-summary">${TIERS.filter((t) => tierCount[t]).map((t) => `<span class="tier">${tierDot(t)}<b>${tierCount[t]}</b>&nbsp;${t === "league" ? (tierCount[t] === 1 ? "lega MTGO" : "leghe MTGO") : `${tierCount[t] === 1 ? `torneo ${TIER_S[t]}` : `tornei ${TIER_P[t]}`}`}</span>`).join("")}</div>
    </header>

    <section class="sec" style="margin-top:36px">
      <div class="podium">${podium}</div>
    </section>

    <section class="sec">
      <div class="sec-head">
        <div><h2>Tutti i mazzi</h2><p>Presenza nel metagame e risultati. La barra dei risultati divide i top 8 per torneo:
          <span class="tier">${tierDot("large")}grandi</span> <span class="tier">${tierDot("medium")}medi</span> <span class="tier">${tierDot("small")}piccoli</span> <span class="tier">${tierDot("league")}leghe 5-0</span>.
          L'<b>indice</b> (0–100) pesa ogni piazzamento in base al torneo in cui è arrivato.</p></div>
        <div class="seg" role="group" aria-label="Ordina per">
          <button data-sort="share" class="${state.sort === "share" ? "on" : ""}">Più giocati</button>
          <button data-sort="pts" class="${state.sort === "pts" ? "on" : ""}">Migliori risultati</button>
        </div>
      </div>
      <div class="meta-list">
        <div class="meta-head"><span>#</span><span>Mazzo</span><span>Presenza</span><span>${prev ? "Trend" : ""}</span><span>Risultati</span><span style="text-align:right">Indice</span></div>
        ${rows}
        ${list.length > 15 ? `<div class="meta-foot"><button class="btn" data-showall>${state.showAll ? "Mostra solo i primi 15" : `Mostra tutti i ${list.length} mazzi`}</button></div>` : ""}
      </div>
    </section>

    <section class="sec two-col">
      <div>
        <div class="sec-head"><div><h2>I tornei del periodo</h2><p>I più importanti per dimensione, con il mazzo vincitore.</p></div><a class="link-more" href="${fmtLink("/tornei")}">Tutti i tornei →</a></div>
        <div class="events">${bigEvents.map((e) => evRow(e, winners.get(e.i))).join("") || empty("Nessun torneo", "")}</div>
      </div>
      <div>
        <div class="sec-head"><div><h2>Le carte del formato</h2><p>Le più giocate, terre escluse.</p></div></div>
        <div class="flex-list">${comp.map((s) => `
          <a class="flex-row compact" href="${cardLink(D.cards[s.card])}" data-card="${s.card}">
            <span class="mini">${D.info[s.card].img ? `<img src="${IMG(D.info[s.card].img, "small")}" alt="" loading="lazy">` : ""}</span>
            <span class="nm"><b>${esc(D.cards[s.card])}</b><span>${s.avg.toFixed(1).replace(".", ",")} copie in media</span></span>
            <span class="incl"><span class="bar"><i style="width:${100 * s.incl}%"></i></span><span class="v">${pct0(s.incl)}</span></span>
          </a>`).join("")}</div>
      </div>
    </section>`, opts);

  $$("[data-sort]").forEach((b) => b.addEventListener("click", () => { state.sort = b.dataset.sort; renderFormat({ keepScroll: true }); }));
  $("[data-showall]")?.addEventListener("click", () => { state.showAll = !state.showAll; renderFormat({ keepScroll: true }); });
  document.title = `${D.format} · Metagame`;
}

function evRow(e, w) {
  return `<a class="ev" href="${evLink(e.i)}">
    <span class="date"><b>${+e.date.slice(8, 10)}</b><span>${MONTHS[+e.date.slice(5, 7) - 1]}</span></span>
    <span><span class="t">${esc(e.name)}</span><span class="s">${tierBadge(e)}<span>${e.type === "paper" ? "cartaceo" : "online"}</span><span>${esc(e.source)}</span></span></span>
    ${w ? `<span class="win"><span>Vincitore</span><b>${esc(w.arch)}</b><span>${esc(w.player)}</span></span>` : `<span></span>`}
  </a>`;
}

/* Archetipo */
function renderArch(arch, opts) {
  const D = state.data;
  const all = filtered();
  const decks = all.filter((d) => d.arch === arch);
  const ci = archArt(arch);
  const N = decks.length;
  const heroImg = ci?.art ? `<img class="bg" src="${IMG(ci.art, "art_crop")}" alt="">` : "";
  if (!N) {
    return view(`<section class="hero">${heroImg}<div class="hero-inner"><nav class="crumbs"><a href="${fmtLink()}">${esc(D.format)}</a></nav><h1>${esc(arch)}</h1></div></section>
      <div style="margin-top:30px">${empty("Nessuna lista con questi filtri", "Questo mazzo non compare nel periodo o nei tornei selezionati. Prova ad allargare i filtri.")}</div>`, opts);
  }
  const meta = metagame(all);
  const me = meta.find((a) => a.arch === arch);
  const byPts = [...meta].sort((a, b) => b.pts - a.pts);
  const ptsPos = byPts.findIndex((a) => a.arch === arch) + 1;
  const prevMeta = hasPrev() ? metagame(filtered(1)).find((a) => a.arch === arch) : undefined;
  const prevShare = hasPrev() ? (prevMeta?.share || 0) : null;

  // variante selezionata: se il mazzo si divide in varianti, la composizione si legge per variante
  const vars = archVariants(arch);
  const varRows = vars.list ? vars.list.map((x) => ({ x, n: decks.filter((d) => vars.of.get(d) === x).length }))
    .filter((r) => r.n).sort((a, b) => b.n - a.n) : [];
  state.varSel ||= {};
  let sel = state.varSel[arch];
  if (sel === undefined) sel = varRows.length >= 2 ? varRows[0].x.name : "all";
  if (sel !== "all" && !varRows.some((r) => r.x.name === sel)) sel = "all";
  const scope = sel === "all" ? decks : decks.filter((d) => vars.of.get(d)?.name === sel);
  const S = scope.length;
  const scopeTxt = sel === "all" ? "" : ` della variante <b>«${esc(sel)}»</b>`;

  const main = composition(scope, "main"), side = composition(scope, "side");
  const core = main.filter((s) => s.incl >= 0.9).sort((a, b) => b.mode - a.mode || b.incl - a.incl);
  const flex = main.filter((s) => s.incl >= 0.25 && s.incl < 0.9);
  const spice = main.filter((s) => s.incl >= 0.06 && s.incl < 0.25).slice(0, 30);
  const sideMain = side.filter((s) => s.incl >= 0.2);
  const sideSpice = side.filter((s) => s.incl >= 0.06 && s.incl < 0.2).slice(0, 30);
  const size = deckSize(scope, "main");
  const coreSlots = core.reduce((s, c) => s + c.exp, 0);
  const stability = coreSlots / (size || 60);
  const divisive = [...flex].sort((a, b) => Math.abs(a.incl - 0.5) - Math.abs(b.incl - 0.5))[0];
  const mS = sel === "all" ? me : metagame(scope)[0]; // risultati della variante scelta
  const bestTier = ["large", "medium", "small"].find((t) => mS.tiers[t]?.top8);
  const aggM = aggregate(main, size), aggS = aggregate(side, deckSize(scope, "side"));
  const results = [...scope].sort((a, b) => b.pts - a.pts || (a.ev.date < b.ev.date ? 1 : -1));
  const varBar = varRows.length >= 2 ? `<div class="varbar">
      <span>Questo mazzo si gioca in <b>${varRows.length} varianti</b> molto diverse tra loro. Stai guardando:</span>
      <div class="seg" role="group" aria-label="Variante" data-var>
        <button data-v="all" class="${sel === "all" ? "on" : ""}">Tutte le liste</button>
        ${varRows.map((r) => `<button data-v="${esc(r.x.name)}" class="${sel === r.x.name ? "on" : ""}">${esc(r.x.name)} <span class="muted">${pct0(r.n / N)}</span></button>`).join("")}
      </div></div>` : "";

  const stabTxt = stability >= 0.75 ? "un mazzo <b>molto stabile</b>: le liste si somigliano quasi tutte"
    : stability >= 0.5 ? "un mazzo <b>abbastanza stabile</b>, con spazio per scelte personali"
      : "un mazzo <b>molto personalizzabile</b>: le liste cambiano parecchio";

  view(`
    <section class="hero">
      ${heroImg}
      <div class="hero-inner">
        <nav class="crumbs"><a href="${fmtLink()}">${esc(D.format)}</a><span aria-hidden="true">/</span><span>Mazzo</span></nav>
        <div>${pips(me.color, "xl")}</div>
        <h1>${esc(arch)}</h1>
        <div class="hero-stats">
          <div><b>${pct(me.share)}</b><span>del metagame ${prevShare != null ? delta(me.share, prevShare) : ""}</span></div>
          <div><b>${n0(N)}</b><span>${N === 1 ? "lista" : "liste"}</span></div>
          <div><b>${me.wins}</b><span>${me.wins === 1 ? "torneo vinto" : "tornei vinti"}</span></div>
          <div><b>n. ${ptsPos}</b><span>per risultati</span></div>
        </div>
        <div class="results" style="margin-top:4px">${resultsLine(me.tiers)}</div>
      </div>
      ${credit(ci)}
    </section>

    <div class="subnav"><nav>
      <a href="#s-panoramica">Panoramica</a><a href="#s-cuore">Il cuore</a><a href="#s-scelte">Le scelte</a>
      <a href="#s-varianti">Varianti</a><a href="#s-side">Sideboard</a><a href="#s-media">Lista media</a><a href="#s-risultati">Risultati</a>
    </nav></div>
    ${varBar}

    <section id="s-panoramica" class="insight">
      <div><h4>${sel === "all" ? "Il mazzo in breve" : "La variante in breve"}</h4><p>${core.length === 1 ? "<b>1 carta</b> è" : `<b>${core.length} carte</b> sono`} in quasi tutte le liste: è ${stabTxt}.</p></div>
      <div><h4>La scelta che divide</h4><p>${divisive ? `<a href="${cardLink(D.cards[divisive.card])}" data-card="${divisive.card}"><b>${esc(D.cards[divisive.card])}</b></a> è nel <b>${pct0(divisive.incl)}</b> delle liste, di solito in ${divisive.mode} ${divisive.mode === 1 ? "copia" : "copie"}.` : "Nessuna: le liste sono quasi identiche."}</p></div>
      <div><h4>Dove ha fatto bene</h4><p>${S < 10 ? `Campione ancora piccolo (<b>${plural(S, "lista", "liste")}</b>): leggi i numeri con prudenza.` : bestTier ? `<b>${mS.tiers[bestTier].top8} top 8</b>${mS.tiers[bestTier].wins ? ` e <b>${mS.tiers[bestTier].wins} ${mS.tiers[bestTier].wins === 1 ? "vittoria" : "vittorie"}</b>` : ""} in tornei <b>${TIER_P[bestTier]}</b>.` : mS.tiers.league ? `<b>${mS.tiers.league.n} liste 5-0</b> nelle leghe MTGO.` : "Ancora nessun top 8 nel periodo."}</p></div>
    </section>

    <section id="s-cuore" class="sec">
      <div class="sec-head"><div><h2>Il cuore del mazzo</h2><p>Le carte presenti in almeno il 90% delle liste${scopeTxt}: <b>non si toccano</b>. Il numero indica le copie più comuni.</p></div><span class="side">${plural(core.length, "carta", "carte")} · ${NF1.format(coreSlots)} slot su ${size}</span></div>
      ${core.length ? `<div class="card-grid">${core.map((s) => tile(s.card, s.mode, `in ${pct0(s.incl)} delle liste`)).join("")}</div>` : `<div class="note-box">Nessuna carta raggiunge il 90%: questo gruppo di liste è molto vario.</div>`}
    </section>

    <section id="s-scelte" class="sec">
      <div class="sec-head"><div><h2>Le scelte</h2><p>Carte giocate da una parte delle liste${scopeTxt} (25–90%). Qui si vede come ognuno <b>personalizza</b> il mazzo. A destra, quante liste ne giocano 1, 2, 3 o 4 copie.</p></div></div>
      ${flex.length ? `<div class="flex-list">${flex.map(flexRow).join("")}</div>` : `<div class="note-box">Nessuna scelta flessibile: chi gioca questo mazzo usa la stessa lista.</div>`}
      ${spice.length ? `<h3 style="font:500 20px/1.2 var(--serif);margin:34px 0 12px">Scelte occasionali</h3><div class="chiplist">${spice.map((s) => `<a href="${cardLink(D.cards[s.card])}" data-card="${s.card}">${esc(D.cards[s.card])}<span>${pct0(s.incl)}</span></a>`).join("")}</div>` : ""}
    </section>

    <section id="s-varianti" class="sec">
      <div class="sec-head"><div><h2>Le varianti</h2><p>Raggruppiamo automaticamente le liste che fanno scelte simili. Per ogni variante, le carte che la distinguono dalle altre: «95% vs 10%» vuol dire che la gioca il 95% delle liste di quella variante e il 10% delle altre.</p></div></div>
      ${variantsHTML(vars, decks)}
    </section>

    <section id="s-side" class="sec">
      <div class="sec-head"><div><h2>Sideboard</h2><p>Le carte da sideboard più usate (in almeno il 20% delle liste${scopeTxt}).</p></div></div>
      ${sideMain.length ? `<div class="flex-list">${sideMain.map(flexRow).join("")}</div>` : `<div class="note-box">Dati di sideboard insufficienti.</div>`}
      ${sideSpice.length ? `<h3 style="font:500 20px/1.2 var(--serif);margin:34px 0 12px">Altre carte da sideboard</h3><div class="chiplist">${sideSpice.map((s) => `<a href="${cardLink(D.cards[s.card])}" data-card="${s.card}">${esc(D.cards[s.card])}<span>${pct0(s.incl)}</span></a>`).join("")}</div>` : ""}
    </section>

    <section id="s-media" class="sec">
      <div class="sec-head"><div><h2>La lista media</h2><p>Il mazzo "tipico"${scopeTxt}: copie medie di ogni carta su ${plural(S, "lista", "liste")}, arrotondate fino a ${size} + ${aggS.total}. A destra, la % di liste che gioca la carta.${sel === "all" && varRows.length >= 2 ? " <b>Attenzione:</b> qui sono mescolate varianti diverse; scegline una qui sopra per una lista giocabile." : ""}</p></div>
        <button class="btn" data-copy="avg">Copia la lista</button></div>
      <div class="avg-layout">
        <div class="panel">${groupedList(aggM.cards, aggS.cards)}</div>
        <div class="side-stack">
          <div class="panel curve">${curveHTML(aggM.cards)}</div>
          <div class="panel types">${typesHTML(aggM.cards)}</div>
        </div>
      </div>
    </section>

    <section id="s-risultati" class="sec">
      <div class="sec-head"><div><h2>Risultati</h2><p>Le liste del periodo${scopeTxt}, dal risultato più raro: arrivare in alto in un torneo grande vale più che vincere un torneo piccolo.</p></div></div>
      ${decksTable(results, { limit: 40 })}
    </section>`, opts);

  $("[data-copy=avg]")?.addEventListener("click", (e) => copyList(aggM.cards, aggS.cards, e.currentTarget));
  const pick = (v, jump) => {
    state.varSel[arch] = v;
    renderArch(arch, { keepScroll: true });
    if (jump) document.getElementById("s-cuore")?.scrollIntoView({ behavior: "smooth" });
  };
  $$("[data-var] button").forEach((b) => b.addEventListener("click", () => pick(b.dataset.v)));
  $$("[data-pickvar]").forEach((b) => b.addEventListener("click", () => pick(b.dataset.pickvar, true)));
  bindMore();
  observeSubnav();
  document.title = `${arch} · ${D.format} · Metagame`;
}

function tile(card, qty, caption, cls = "") {
  const D = state.data;
  const ci = D.info[card];
  return `<a class="tile ${cls}" href="${cardLink(D.cards[card])}" data-card="${card}">
    <div style="position:relative">${cardImg(ci, D.cards[card])}${qty ? `<span class="qty">${qty}</span>` : ""}</div>
    <div class="cap"><b>${esc(D.cards[card])}</b>${caption ? `<span>${caption}</span>` : ""}</div></a>`;
}

function flexRow(s) {
  const D = state.data;
  const ci = D.info[s.card];
  const mx = Math.max(...s.dist, 1);
  return `<a class="flex-row" href="${cardLink(D.cards[s.card])}" data-card="${s.card}">
    <span class="mini">${ci.img ? `<img src="${IMG(ci.img, "small")}" alt="" loading="lazy">` : ""}</span>
    <span class="nm"><b>${esc(D.cards[s.card])}</b><span>di solito ${s.mode} ${s.mode === 1 ? "copia" : "copie"} · media ${s.avg.toFixed(1).replace(".", ",")}</span></span>
    <span class="incl"><span class="bar"><i style="width:${(100 * s.incl).toFixed(1)}%"></i></span><span class="v">${pct0(s.incl)}</span></span>
    <span class="copies" title="${s.dist.map((n, i) => `${i + 1}${i === 3 ? "+" : ""} ${i ? "copie" : "copia"}: ${n} liste`).join("\n")}">
      ${s.dist.map((n, i) => `<div><i class="${n ? "" : "zero"}" style="height:${n ? Math.max(3, 22 * n / mx) : 2}px"></i><span>${i + 1}${i === 3 ? "+" : ""}</span></div>`).join("")}
    </span></a>`;
}

function variantsHTML(v, decks) {
  const D = state.data;
  const N = decks.length;
  if (v.reason === "few") return `<div class="note-box">Servono almeno 14 liste per riconoscere le varianti in modo affidabile. Questo mazzo ne ha troppo poche nel periodo caricato.</div>`;
  if (v.reason === "stable") return `<div class="note-box"><b>Nessuna variante netta.</b> Le liste di questo mazzo differiscono per singole carte, ma non si dividono in gruppi distinti: vedi "Le scelte" qui sopra.</div>`;
  // numeri calcolati sulle liste filtrate; identità della variante stabile
  const rows = v.list.map((x) => {
    const g = decks.filter((d) => v.of.get(d) === x);
    return { x, g, share: g.length / (N || 1), wins: g.filter((d) => d.rank === 1).length, top8: g.filter(isTop8).length };
  }).filter((r) => r.g.length).sort((a, b) => b.g.length - a.g.length);
  if (rows.length < 2) return `<div class="note-box">Con i filtri attuali compare una sola variante di questo mazzo${rows[0] ? `: <b>${esc(rows[0].x.name)}</b>` : ""}. Allarga i filtri per confrontarle.</div>`;
  return `<div class="variants">${rows.map(({ x, g, share, wins, top8 }) => {
    const fanCards = (x.plus.length ? x.plus : x.minus).slice(0, 3).map((p) => p.card);
    return `<article class="variant">
      <div class="v-top">
        <div class="fan">${fanCards.map((c) => cardImg(D.info[c], D.cards[c], "small")).join("")}</div>
        <div><h3>${esc(x.name)}</h3><p>${plural(g.length, "lista", "liste")} · ${wins} ${wins === 1 ? "vittoria" : "vittorie"} · ${top8} top 8</p></div>
      </div>
      <div class="v-share"><span class="bar"><i style="width:${(100 * share).toFixed(1)}%"></i></span><b>${pct0(share)}</b></div>
      <ul>
        ${x.plus.map((p) => `<li><span class="sg plus">+</span><a href="${cardLink(D.cards[p.card])}" data-card="${p.card}">${p.q ? p.q + " " : ""}${esc(D.cards[p.card])}</a><span class="n">${pct0(p.a)} vs ${pct0(p.b)}</span></li>`).join("")}
        ${x.minus.map((p) => `<li><span class="sg minus">−</span><a href="${cardLink(D.cards[p.card])}" data-card="${p.card}">${esc(D.cards[p.card])}</a><span class="n">${pct0(p.a)} vs ${pct0(p.b)}</span></li>`).join("")}
        ${!x.plus.length && !x.minus.length ? `<li><span></span><span class="muted">Differenze lievi e distribuite</span><span></span></li>` : ""}
      </ul>
      <div class="v-foot"><button class="linklike" data-pickvar="${esc(x.name)}">Analizza questa variante</button><a href="${deckLink(x.medoid.id)}">Lista tipo →</a></div>
    </article>`;
  }).join("")}</div>`;
}

function groupedList(mainCards, sideCards, opts = {}) {
  const D = state.data;
  const groups = new Map();
  for (const [c, q, incl] of mainCards) {
    const t = TYPE_ORDER.includes(D.info[c].type) ? D.info[c].type : "Other";
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push([c, q, incl]);
  }
  const line = ([c, q, incl]) => `<div class="dl-line ${opts.odd?.(c) ? "odd" : ""}"><span class="q">${q}</span><a class="n" href="${cardLink(D.cards[c])}" data-card="${c}">${esc(D.cards[c])}</a><span class="x">${manaCost(D.info[c].mana)}${incl != null ? `<span class="p">${pct0(incl)}</span>` : ""}</span></div>`;
  const sortL = (l) => l.sort((a, b) => b[1] - a[1] || D.info[a[0]].cmc - D.info[b[0]].cmc || D.cards[a[0]].localeCompare(D.cards[b[0]]));
  const blocks = TYPE_ORDER.filter((t) => groups.has(t)).map((t) => {
    const l = sortL(groups.get(t));
    return `<div class="dl-group"><h4><span>${TYPE_L[t]}</span><span>${l.reduce((s, x) => s + x[1], 0)}</span></h4>${l.map(line).join("")}</div>`;
  });
  if (sideCards?.length) {
    const l = sortL([...sideCards]);
    blocks.push(`<div class="dl-group"><h4><span>Sideboard</span><span>${l.reduce((s, x) => s + x[1], 0)}</span></h4>${l.map(line).join("")}</div>`);
  }
  return `<div class="decklist">${blocks.join("")}</div>`;
}

function curveHTML(mainCards) {
  const D = state.data;
  const b = new Array(8).fill(0);
  for (const [c, q] of mainCards) { const ci = D.info[c]; if (ci.type === "Land") continue; b[Math.min(7, Math.floor(ci.cmc || 0))] += q; }
  const mx = Math.max(...b, 1);
  const tot = b.reduce((s, x) => s + x, 0);
  const avg = tot ? b.reduce((s, x, i) => s + x * i, 0) / tot : 0;
  return `<h4>Curva di mana <span style="text-transform:none;letter-spacing:0;font-weight:500">· media ${avg.toFixed(2).replace(".", ",")}</span></h4>
    <div class="curve-bars">${b.map((x) => `<div><b>${x || ""}</b><i style="height:${(100 * x / mx).toFixed(1)}%"></i></div>`).join("")}</div>
    <div class="curve-x">${b.map((_, i) => `<span>${i === 7 ? "7+" : i}</span>`).join("")}</div>`;
}
function typesHTML(mainCards) {
  const D = state.data;
  const t = new Map();
  for (const [c, q] of mainCards) { const k = D.info[c].type; t.set(k, (t.get(k) || 0) + q); }
  const tot = [...t.values()].reduce((s, x) => s + x, 0) || 1;
  const rows = TYPE_ORDER.filter((k) => t.has(k)).map((k) => `<li><span>${TYPE_L[k]}</span><b>${t.get(k)}</b><span class="bar"><i style="width:${(100 * t.get(k) / tot).toFixed(1)}%"></i></span></li>`);
  return `<h4>Composizione per tipo</h4><ul>${rows.join("")}</ul>`;
}

let moreState = null;
function decksTable(list, { limit = 40, showArch = false, showEvent = true } = {}) {
  if (!list.length) return empty("Nessuna lista", "");
  const row = (d) => `<tr>
    <td class="num" data-v="${d.ev.date}">${dShort(d.ev.date)}</td>
    ${showEvent ? `<td class="w" data-v="${esc(d.ev.name)}"><a class="strong" href="${evLink(d.ev.i)}">${esc(d.ev.name)}</a><span class="sub">${tierBadge(d.ev)}</span></td>` : ""}
    ${showArch ? `<td class="w" data-v="${esc(d.arch)}">${pips(d.colors)} <a class="strong" href="${archLink(d.arch)}">${esc(d.arch)}</a></td>` : ""}
    <td data-v="${esc(d.player)}">${esc(d.player || "—")}</td>
    <td class="num" data-v="${d.rank ?? (d.wins != null ? 100 - d.wins : 999)}">${esc(d.result || "—")}</td>
    <td class="r num" data-v="${d.pts}">${NF1.format(d.pts)}</td>
    <td class="r"><a class="link-more" href="${deckLink(d.id)}">Lista →</a></td></tr>`;
  moreState = { list, row }; // per "Mostra altre" (una sola tabella di liste per pagina)
  return `<div class="table-wrap"><table class="t">
    <thead><tr><th>Data</th>${showEvent ? "<th>Torneo</th>" : ""}${showArch ? "<th>Mazzo</th>" : ""}<th>Giocatore</th><th>Risultato</th><th class="r" title="log₂(giocatori ÷ piazzamento): quanto è raro il risultato">Punti</th><th></th></tr></thead>
    <tbody>${list.slice(0, limit).map(row).join("")}</tbody></table>
    ${list.length > limit ? `<div class="meta-foot"><button class="btn" data-more>Mostra altre ${Math.min(list.length - limit, 100)} liste</button></div>` : ""}</div>`;
}
function bindMore() {
  $$("[data-more]").forEach((b) => b.addEventListener("click", () => {
    const tbody = $("tbody", b.closest(".table-wrap"));
    const shown = tbody.rows.length;
    const { list, row } = moreState;
    tbody.insertAdjacentHTML("beforeend", list.slice(shown, shown + 100).map(row).join(""));
    const left = list.length - tbody.rows.length;
    if (left <= 0) b.parentElement.remove();
    else b.textContent = `Mostra altre ${Math.min(left, 100)} liste`;
  }));
}

/* Lista */
function renderDeck(id, opts) {
  const D = state.data;
  const d = D.byId.get(id);
  if (!d) return view(empty("Lista non trovata", "Potrebbe essere fuori dal periodo caricato."), opts);
  // confronto con la VARIANTE a cui appartiene la lista (se l'archetipo si divide in varianti)
  let peers = D.decks.filter((x) => x.arch === d.arch);
  const myVar = archVariants(d.arch).of?.get(d);
  if (myVar) peers = myVar.decks;
  const refLabel = myVar ? `${esc(d.arch)} · ${esc(myVar.name.charAt(0).toLowerCase() + myVar.name.slice(1))}` : esc(d.arch);
  const pm = new Map(composition(peers, "main").map((s) => [s.card, s]));
  const ps = new Map(composition(peers, "side").map((s) => [s.card, s]));
  const agg = aggregate(composition(peers, "main"), deckSize(peers, "main"));
  // illustrazione: la carta più caratteristica della lista (tante copie, rara nel formato)
  const fi = formatInclusion();
  const sigCard = cardsOf(d.main).filter(([c, q]) => q >= 2 && D.info[c].type !== "Land" && D.info[c].art)
    .sort((a, b) => (fi.get(a[0]) || 0) - (fi.get(b[0]) || 0) || b[1] - a[1])[0];
  const ci = sigCard ? D.info[sigCard[0]] : archArt(d.arch);
  const odd = (c, m) => (m.get(c)?.incl ?? 0) < 0.15;
  const groups = new Map();
  for (const [c, q] of cardsOf(d.main)) { const t = TYPE_ORDER.includes(D.info[c].type) ? D.info[c].type : "Other"; if (!groups.has(t)) groups.set(t, []); groups.get(t).push([c, q]); }
  const sortL = (l) => l.sort((a, b) => b[1] - a[1] || D.info[a[0]].cmc - D.info[b[0]].cmc);
  const vis = TYPE_ORDER.filter((t) => groups.has(t)).map((t) => {
    const l = sortL(groups.get(t));
    return `<div class="vd-group"><h4>${TYPE_L[t]} · ${l.reduce((s, x) => s + x[1], 0)}</h4><div class="vd-grid">${l.map(([c, q]) => tile(c, q, `${pct0(pm.get(c)?.incl ?? 0)} delle liste`, odd(c, pm) ? "odd" : "")).join("")}</div></div>`;
  });
  if (d.side.length) {
    const l = sortL(cardsOf(d.side));
    vis.push(`<div class="vd-group"><h4>Sideboard · ${total(d.side)}</h4><div class="vd-grid">${l.map(([c, q]) => tile(c, q, `${pct0(ps.get(c)?.incl ?? 0)} delle liste`, odd(c, ps) ? "odd" : "")).join("")}</div></div>`);
  }
  // differenze rispetto alla lista media
  const mine = new Map(cardsOf(d.main));
  const avgM = new Map(agg.cards.map(([c, q]) => [c, q]));
  const diffs = [];
  new Set([...mine.keys(), ...avgM.keys()]).forEach((c) => { const x = (mine.get(c) || 0) - (avgM.get(c) || 0); if (x) diffs.push([c, x]); });
  diffs.sort((a, b) => b[1] - a[1]);
  const ev = d.ev;
  view(`
    <section class="hero" style="min-height:300px">
      ${ci?.art ? `<img class="bg" src="${IMG(ci.art, "art_crop")}" alt="">` : ""}
      <div class="hero-inner">
        <nav class="crumbs"><a href="${fmtLink()}">${esc(D.format)}</a><span aria-hidden="true">/</span><a href="${archLink(d.arch)}">${esc(d.arch)}</a><span aria-hidden="true">/</span><span>Lista</span></nav>
        <div>${pips(d.colors, "lg")}</div>
        <h1 style="font-size:clamp(34px,5vw,56px)">${esc(d.arch)}</h1>
        ${myVar ? `<p style="margin:-4px 0 0;font:italic 400 19px/1.3 var(--serif);color:rgba(255,255,255,.82)">variante «${esc(myVar.name)}»</p>` : ""}
        <div class="hero-stats">
          <div><b>${esc(d.result || "—")}</b><span>risultato</span></div>
          <div><b style="font-size:24px">${esc(d.player || "—")}</b><span>giocatore</span></div>
          <div><b>${NF1.format(d.pts)}</b><span>punti</span></div>
        </div>
      </div>${credit(ci)}
    </section>
    <div class="deck-layout">
      <div class="visual-deck">${vis.join("")}
        <p class="muted" style="font-size:13px;margin:0">Sotto ogni carta: la % di liste ${refLabel} che la gioca (${plural(peers.length, "lista", "liste")}). Bordo colorato = scelta insolita (meno del 15%).</p></div>
      <aside class="side-stack">
        <div class="panel"><div class="facts">
          <div><span>Torneo</span><b><a href="${evLink(ev.i)}">${esc(ev.name)}</a></b></div>
          <div><span>Data</span><b>${dLong(ev.date)}</b></div>
          <div><span>Dimensione</span><b>${tierBadge(ev)}</b></div>
          <div><span>Tipo</span><b>${ev.type === "paper" ? "Cartaceo" : "Online"}</b></div>
          <div><span>Fonte</span><b>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(ev.source)} ↗</a>` : esc(ev.source)}</b></div>
        </div></div>
        <div class="panel"><h4 style="margin:0 0 4px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Rispetto alla lista media</h4><p class="muted" style="font-size:12.5px;margin:0 0 12px">di ${refLabel}</p>
          ${diffs.length ? `<div class="diff-list">${diffs.map(([c, x]) => `<div><span class="q ${x > 0 ? "plus" : "minus"}">${x > 0 ? "+" : "−"}${Math.abs(x)}</span><a href="${cardLink(D.cards[c])}" data-card="${c}">${esc(D.cards[c])}</a><span>${pct0(pm.get(c)?.incl ?? 0)}</span></div>`).join("")}</div>` : `<p class="muted" style="margin:0">Identica alla lista media.</p>`}
        </div>
        <div class="panel curve">${curveHTML(cardsOf(d.main))}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn primary" data-copy="deck">Copia la lista</button><a class="btn" href="${archLink(d.arch)}">Analisi del mazzo</a></div>
      </aside>
    </div>`, opts);
  $("[data-copy=deck]").addEventListener("click", (e) => copyList(cardsOf(d.main), cardsOf(d.side), e.currentTarget));
  document.title = `${d.arch} di ${d.player} · Metagame`;
}

/* Carta */
function renderCard(name, opts) {
  const D = state.data;
  const c = D.cardIdx.get(name.toLowerCase());
  if (c == null) return view(empty(esc(name), `Questa carta non compare nelle liste di ${esc(D.format)} del periodo caricato.`), opts);
  const ci = D.info[c];
  const decks = filtered();
  const by = new Map();
  let withIt = 0;
  for (const d of decks) {
    let a = by.get(d.arch);
    if (!a) by.set(d.arch, (a = { arch: d.arch, n: 0, main: 0, side: 0, q: 0, color: d.colors }));
    a.n++;
    let has = false;
    for (let i = 0; i < d.main.length; i += 2) if (d.main[i] === c) { a.main++; a.q += d.main[i + 1]; has = true; }
    for (let i = 0; i < d.side.length; i += 2) if (d.side[i] === c) { a.side++; has = true; }
    if (has) withIt++;
  }
  const rows = [...by.values()].filter((a) => a.main || a.side).sort((a, b) => (b.main + b.side) - (a.main + a.side));
  view(`
    <section class="card-hero">
      ${cardImg(ci, D.cards[c], "large", true)}
      <div>
        <div class="eyebrow">${esc(D.format)} · ${filterSentence()}</div>
        <h1 class="display" style="font-size:clamp(36px,5vw,58px)">${esc(D.cards[c])}</h1>
        <p style="margin:0 0 18px">${manaCost(ci.mana, "lg")} <span class="muted" style="margin-left:8px">${TYPE_L[ci.type] || ""}</span></p>
        <p class="lede">È giocata nel <b>${pct(withIt / (decks.length || 1))}</b> delle liste, in <b>${plural(rows.length, "mazzo", "mazzi")}</b>.</p>
        <p style="margin-top:18px"><a class="link-more" href="https://scryfall.com/search?q=${enc('!"' + D.cards[c] + '"')}" target="_blank" rel="noopener">Vedi su Scryfall ↗</a>${ci.artist ? ` <span class="muted" style="font-size:13px;margin-left:12px">Illustrazione di ${esc(ci.artist)}</span>` : ""}</p>
      </div>
    </section>
    <section class="sec">
      <div class="sec-head"><div><h2>Dove si gioca</h2><p>Per ogni mazzo: quante liste la giocano in main e in sideboard, e con quante copie.</p></div></div>
      ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Mazzo</th><th class="r">Liste</th><th style="min-width:180px">In main</th><th class="r">Copie medie</th><th class="r">In sideboard</th></tr></thead><tbody>
        ${rows.map((a) => `<tr><td class="w" data-v="${esc(a.arch)}">${pips(a.color)} <a class="strong" href="${archLink(a.arch)}">${esc(a.arch)}</a></td>
          <td class="r num" data-v="${a.n}">${a.n}</td>
          <td data-v="${a.main / a.n}"><div class="share" style="grid-template-columns:1fr 44px"><span class="bar"><i style="width:${(100 * a.main / a.n).toFixed(1)}%"></i></span><span class="v">${pct0(a.main / a.n)}</span></div></td>
          <td class="r num" data-v="${a.main ? a.q / a.main : 0}">${a.main ? (a.q / a.main).toFixed(1).replace(".", ",") : "—"}</td>
          <td class="r num" data-v="${a.side / a.n}">${a.side ? pct0(a.side / a.n) : "—"}</td></tr>`).join("")}
      </tbody></table></div>` : empty("Nessuna lista", "Nessuna lista la gioca con i filtri attuali.")}
    </section>`, opts);
  document.title = `${D.cards[c]} · ${D.format} · Metagame`;
}

/* Tornei */
function renderEvents(opts) {
  const D = state.data;
  const decks = filtered();
  const evs = new Map(); const winners = new Map();
  decks.forEach((d) => { evs.set(d.ev.i, d.ev); if (d.rank === 1) winners.set(d.ev.i, d); });
  const list = [...evs.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)));
  view(`
    <nav class="crumbs"><a href="${fmtLink()}">${esc(D.format)}</a><span aria-hidden="true">/</span><span>Tornei</span></nav>
    <header class="page-head" style="padding-top:12px"><div class="eyebrow">${filterSentence()}</div><h1 class="display">Tornei di ${esc(D.format)}</h1>
      <p class="lede">${plural(list.length, "torneo", "tornei")}. Il pallino indica la dimensione: <span class="tier">${tierDot("large")}grande (100+ giocatori o evento premier)</span>, <span class="tier">${tierDot("medium")}medio (32–99, Challenge MTGO, RCQ)</span>, <span class="tier">${tierDot("small")}piccolo</span>.</p></header>
    <div class="events" style="margin-top:20px">${list.slice(0, 300).map((e) => evRow(e, winners.get(e.i))).join("") || empty("Nessun torneo", "Allarga i filtri.")}</div>`, opts);
  document.title = `Tornei · ${D.format} · Metagame`;
}

function renderEvent(idx, opts) {
  const D = state.data;
  const ev = D.events[idx];
  if (!ev) return view(empty("Torneo non trovato", ""), opts);
  const list = D.decks.filter((d) => d.ev === ev).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (b.wins ?? 0) - (a.wins ?? 0));
  const meta = metagame(list).sort((a, b) => b.n - a.n);
  view(`
    <nav class="crumbs"><a href="${fmtLink()}">${esc(D.format)}</a><span aria-hidden="true">/</span><a href="${fmtLink("/tornei")}">Tornei</a><span aria-hidden="true">/</span><span>${dShort(ev.date)}</span></nav>
    <header class="page-head" style="padding-top:12px">
      <div class="eyebrow">${dLong(ev.date)} · ${ev.type === "paper" ? "cartaceo" : "online"} · torneo ${TIER_S[ev.tier]}</div>
      <h1 class="display" style="font-size:clamp(32px,4.5vw,54px)">${esc(ev.name)}</h1>
      <p class="lede">${tierBadge(ev)} · ${plural(list.length, "lista pubblicata", "liste pubblicate")}${ev.url ? ` · <a class="link-more" href="${esc(ev.url)}" target="_blank" rel="noopener">pagina originale ↗</a>` : ""}</p>
      ${ev.kind === "challenge" ? `<p class="muted" style="font-size:13px;margin:6px 0 0">MTGO pubblica solo i primi 32 classificati delle Challenge: il numero reale di partecipanti non è noto.</p>` : ""}
      ${ev.tier === "league" ? `<p class="muted" style="font-size:13px;margin:6px 0 0">Le leghe MTGO non hanno classifica: vengono pubblicate solo alcune liste che hanno chiuso 5-0.</p>` : ""}
    </header>
    ${meta.length > 1 ? `<div class="chiplist" style="margin:8px 0 26px">${meta.map((a) => `<a href="${archLink(a.arch)}">${pips(a.color)} ${esc(a.arch)}<span>${a.n}</span></a>`).join("")}</div>` : ""}
    ${decksTable(list, { limit: 200, showArch: true, showEvent: false })}`, opts);
  bindMore();
  document.title = `${ev.name} · Metagame`;
}

/* Metodo */
function renderMethod() {
  const M = state.meta;
  view(`
    <header class="page-head"><div class="eyebrow">Metodo e fonti</div><h1 class="display">Come leggere i dati</h1>
      <p class="lede">Un buon dato vale più di tanti dati. Qui spieghiamo da dove arriva ogni numero e quanto pesa.</p></header>
    <article class="prose">
      <h2>Da dove arrivano le liste</h2>
      <p>Ogni 12 ore raccogliamo i tornei pubblicati da <b>MTGO</b> (Challenge, Leghe, Showcase), <b>Melee.gg</b>, <b>Topdeck.gg</b>, <b>CardsRealm</b>, <b>GetPaird</b> (tramite l'archivio pubblico MTGODecklistCache) e <b>MTGTop8</b> (tornei locali di tutto il mondo). Le liste identiche pubblicate da due fonti vengono contate una volta sola. Oggi l'archivio contiene <b>${n0(M.totals.decks)} liste</b> da <b>${n0(M.totals.tournaments)} tornei</b>.</p>
      <h2>La dimensione del torneo</h2>
      <p>Vincere un torneo da 8 giocatori non è come vincere un Regional da 400. Per questo ogni torneo ha una fascia:</p>
      <table><tr><th>Fascia</th><th>Quando</th></tr>
        <tr><td><span class="tier">${tierDot("large")}<b>Grande</b></span></td><td>100+ giocatori, oppure eventi premier (Pro Tour, Regional Championship, Showcase MTGO, Open…)</td></tr>
        <tr><td><span class="tier">${tierDot("medium")}<b>Medio</b></span></td><td>32–99 giocatori, oppure Challenge MTGO e qualificazioni (RCQ, PTQ) di cui non conosciamo i numeri</td></tr>
        <tr><td><span class="tier">${tierDot("small")}<b>Piccolo</b></span></td><td>meno di 32 giocatori</td></tr>
        <tr><td><span class="tier">${tierDot("league")}<b>Lega 5-0</b></span></td><td>Leghe MTGO: solo alcune liste 5-0, senza classifica</td></tr></table>
      <p><b>Attenzione alle Challenge MTGO:</b> il sito ufficiale pubblica solo i primi 32, quindi non conosciamo il numero reale di partecipanti. Le consideriamo tornei medi.</p>
      <h2>Punti e indice Risultati</h2>
      <p>Ogni lista riceve dei punti che misurano <b>quanto è raro il suo risultato</b>: <code>punti = log₂(giocatori ÷ piazzamento)</code>. In pratica, ogni punto è un raddoppio di difficoltà:</p>
      <table><tr><th>Risultato</th><th>Punti</th></tr>
        <tr><td>Vincere un torneo da 8 giocatori</td><td>3</td></tr>
        <tr><td>Vincere un torneo da 64 giocatori</td><td>6</td></tr>
        <tr><td>Arrivare 6° su 407 giocatori (Regional Championship)</td><td>≈ 6</td></tr>
        <tr><td>Arrivare 8° su 32 giocatori</td><td>2</td></tr>
        <tr><td>Chiudere 5-0 una lega MTGO</td><td>3</td></tr></table>
      <p>Quando non conosciamo il numero di giocatori usiamo stime prudenti: 64 per una Challenge MTGO, 48 per una qualificazione, 256 per un evento premier, 16 per un torneo locale.</p>
      <p>L'<b>indice Risultati</b> di un mazzo è la somma dei punti delle sue liste, riportata da 0 a 100 rispetto al mazzo migliore del periodo. Così un mazzo molto giocato ma che vince poco non sembra più forte di quanto sia, e un buon piazzamento in un torneo enorme conta più di una vittoria al negozio sotto casa.</p>
      <h2>Presenza nel metagame</h2>
      <p>È la quota di liste pubblicate. Ricorda che molte fonti pubblicano solo le liste dei primi classificati (top 8, top 32 o i 5-0): la presenza misura quindi quanto un mazzo <b>arriva in alto</b>, non quanto viene giocato in assoluto.</p>
      <h2>Il cuore, le scelte, le varianti</h2>
      <p><b>Il cuore</b>: carte presenti in almeno il 90% delle liste. <b>Le scelte</b>: dal 25% al 90%. <b>Scelte occasionali</b>: dal 6% al 25%.</p>
      <p><b>Le varianti</b> vengono trovate automaticamente: confrontiamo le liste solo sulle carte "flessibili" (né sempre presenti né rarissime), le raggruppiamo con un algoritmo di clustering (k-medoids) e teniamo i gruppi solo se sono davvero distinti e abbastanza grandi. Ogni variante prende il nome dalla carta che più la distingue dalle altre.</p>
      <p><b>La lista media</b>: per ogni carta calcoliamo le copie medie su tutte le liste, poi arrotondiamo in modo che il totale sia la dimensione tipica del mazzo.</p>
      <h2>Archetipi</h2>
      <p>Riconosciamo il mazzo con le regole pubbliche della community (MTGOFormatData) per Standard, Pioneer, Modern, Legacy, Vintage e Pauper. Nei formati Commander il mazzo è il comandante. Le liste che nessuna regola riconosce vengono raggruppate per colori, es. "Izzet (Other)".</p>
      <h2>Dati aperti</h2>
      <p>Tutto il database è scaricabile in fondo alla pagina: SQLite e CSV, pronti per Excel, Python o R.</p>
    </article>`);
  document.title = "Come leggere i dati · Metagame";
}

/* ---------- interazioni ---------- */
async function copyList(main, side, btn) {
  const D = state.data;
  const txt = (l) => l.map(([c, q]) => `${q} ${D.cards[c]}`).join("\n");
  try {
    await navigator.clipboard.writeText(`${txt(main)}\n\nSideboard\n${txt(side)}`);
    const t = btn.textContent; btn.textContent = "Copiata ✓"; setTimeout(() => (btn.textContent = t), 1600);
  } catch (_) { btn.textContent = "Copia non disponibile"; }
}

function enableSorting() {
  $$("#app table.t").forEach((t) => {
    $$("th", t).forEach((th, col) => th.addEventListener("click", () => {
      const body = t.tBodies[0];
      const dir = th.dataset.dir === "desc" ? 1 : -1;
      th.dataset.dir = dir === 1 ? "asc" : "desc";
      const val = (r) => { const c = r.cells[col]; const v = c?.dataset.v ?? c?.textContent ?? ""; const n = parseFloat(v); return isNaN(n) || /[a-z]/i.test(v) ? v.toLowerCase() : n; };
      [...body.rows].sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; }).forEach((r) => body.appendChild(r));
    }));
  });
}

function observeSubnav() {
  const links = $$(".subnav a");
  if (!links.length || !("IntersectionObserver" in window)) return;
  const map = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { links.forEach((l) => l.classList.remove("on")); map.get(e.target.id)?.classList.add("on"); } });
  }, { rootMargin: "-40% 0px -55% 0px" });
  map.forEach((_, id) => { const el = document.getElementById(id); if (el) io.observe(el); });
  links.forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); document.getElementById(a.getAttribute("href").slice(1))?.scrollIntoView({ behavior: "smooth" }); }));
}

/* anteprima della carta al passaggio del mouse */
(function preview() {
  const box = $("#preview"), img = $("img", box);
  let cur = null;
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-card]");
    if (!el || !state.data || el.querySelector(".card-img img")) { if (cur && !el) { box.classList.remove("on"); cur = null; } return; }
    const ci = state.data.info[+el.dataset.card];
    if (!ci?.img) return;
    cur = el;
    img.src = IMG(ci.img, "normal");
    box.classList.add("on");
  });
  document.addEventListener("mousemove", (e) => {
    if (!cur) return;
    const w = 250, h = 349, pad = 18;
    let x = e.clientX + pad, y = e.clientY - h / 2;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    y = Math.max(8, Math.min(innerHeight - h - 8, y));
    box.style.left = x + "px"; box.style.top = y + "px";
  });
  document.addEventListener("mouseout", (e) => {
    if (cur && !cur.contains(e.relatedTarget)) { box.classList.remove("on"); cur = null; }
  });
  window.addEventListener("hashchange", () => { box.classList.remove("on"); cur = null; });
})();

/* ricerca */
(function search() {
  const input = $("#q"), out = $("#q-results");
  let sel = -1, items = [];
  const close = () => { out.hidden = true; input.setAttribute("aria-expanded", "false"); sel = -1; };
  async function ensureData() {
    if (!state.data) { await loadMeta(); await loadFormat(state.meta.formats[0].slug); }
  }
  input.addEventListener("input", async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) return close();
    await ensureData();
    const D = state.data;
    const decks = D.decks;
    const counts = new Map(); decks.forEach((d) => counts.set(d.arch, (counts.get(d.arch) || 0) + 1));
    const archs = D.archetypes.filter((a) => a.toLowerCase().includes(q)).sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0)).slice(0, 5);
    const cards = D.cards.map((c, i) => [c, i]).filter(([c]) => c.toLowerCase().includes(q))
      .sort((a, b) => (a[0].toLowerCase().startsWith(q) ? 0 : 1) - (b[0].toLowerCase().startsWith(q) ? 0 : 1) || a[0].length - b[0].length).slice(0, 7);
    items = [];
    let html = "";
    if (archs.length) {
      html += `<div class="sr-head">Mazzi · ${esc(D.format)}</div>`;
      archs.forEach((a) => { const ci = archArt(a); items.push(archLink(a)); html += `<a role="option" href="${archLink(a)}">${ci?.art ? `<img src="${IMG(ci.art, "art_crop")}" alt="">` : `<img alt="">`}<span>${esc(a)}</span><small>${n0(counts.get(a) || 0)} liste</small></a>`; });
    }
    if (cards.length) {
      html += `<div class="sr-head">Carte · ${esc(D.format)}</div>`;
      cards.forEach(([c, i]) => { const ci = D.info[i]; items.push(cardLink(c)); html += `<a role="option" href="${cardLink(c)}">${ci.art ? `<img src="${IMG(ci.art, "art_crop")}" alt="">` : `<img alt="">`}<span>${esc(c)}</span><small>${manaCost(ci.mana)}</small></a>`; });
    }
    out.innerHTML = html || `<div class="sr-head">Nessun risultato in ${esc(D.format)}</div>`;
    out.hidden = false; input.setAttribute("aria-expanded", "true"); sel = -1;
  });
  input.addEventListener("keydown", (e) => {
    const opts = $$("a", out);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!opts.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.setAttribute("aria-selected", i === sel));
    } else if (e.key === "Enter") {
      const target = opts[Math.max(sel, 0)]; if (target) { location.hash = target.getAttribute("href"); input.value = ""; close(); input.blur(); }
    } else if (e.key === "Escape") { close(); input.blur(); }
  });
  out.addEventListener("click", () => { input.value = ""; close(); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) close(); });
})();

/* tema */
$("#theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("mm-theme", next); } catch (_) { /* */ }
});

/* filtri */
function syncFilters() {
  const f = state.f;
  $$("[data-filter=days] button").forEach((b) => b.classList.toggle("on", +b.dataset.v === f.days));
  $$("[data-filter=type] button").forEach((b) => b.classList.toggle("on", b.dataset.v === f.type));
  $$("[data-filter=place] button").forEach((b) => b.classList.toggle("on", b.dataset.v === f.place));
  $$("[data-filter=tiers] button").forEach((b) => { b.classList.toggle("on", f.tiers.has(b.dataset.v)); b.setAttribute("aria-pressed", f.tiers.has(b.dataset.v)); });
}
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const g = b.parentElement.dataset.filter; const f = state.f;
  if (g === "days") f.days = +b.dataset.v;
  else if (g === "type") f.type = b.dataset.v;
  else if (g === "place") f.place = b.dataset.v;
  else if (g === "tiers") {
    if (f.tiers.has(b.dataset.v) && f.tiers.size > 1) f.tiers.delete(b.dataset.v); else f.tiers.add(b.dataset.v);
  }
  saveFilters(); syncFilters(); route({ keepScroll: true });
});

/* ---------- router ---------- */
async function route(opts = {}) {
  try {
    await loadMeta();
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    const fmts = state.meta.formats;
    const navHTML = (slug) => fmts.map((f) => `<a href="#/${f.slug}" class="${f.slug === slug ? "on" : ""}">${esc(f.format)}</a>`).join("");
    if (!parts[0]) { $("#formats").innerHTML = navHTML(null); $("#filters").hidden = true; return renderHome(); }
    if (parts[0] === "metodo") { $("#formats").innerHTML = navHTML(null); $("#filters").hidden = true; return renderMethod(); }
    const f = fmts.find((x) => x.slug === parts[0]);
    if (!f) { location.replace("#/"); return; }
    $("#formats").innerHTML = navHTML(f.slug);
    $("#formats a.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    $("#filters").hidden = false;
    if (state.slug !== f.slug || !state.data) {
      if (!opts.keepScroll) $("#app").innerHTML = `<div class="loading"><span></span></div>`;
      state.showAll = false;
      await loadFormat(f.slug);
    }
    syncFilters();
    const [, kind, arg] = parts;
    if (kind === "mazzo") renderArch(arg, opts);
    else if (kind === "lista") renderDeck(+arg, opts);
    else if (kind === "carta") renderCard(arg, opts);
    else if (kind === "tornei") renderEvents(opts);
    else if (kind === "torneo") renderEvent(+arg, opts);
    else renderFormat(opts);
  } catch (e) {
    console.error(e);
    view(empty("Qualcosa è andato storto", `Non siamo riusciti a caricare i dati (${esc(e.message)}). Riprova tra poco.`));
  }
}
window.addEventListener("hashchange", () => route());
syncFilters();
route();
