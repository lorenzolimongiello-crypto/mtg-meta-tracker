/* ==========================================================================
   Metagame — static front end.
   Data is split per page (index / archetype / cards / search) and statistics
   are computed in the browser, so every filter is instant.
   ========================================================================== */
"use strict";

/* ---------- utilities ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;
const NF1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat("en-US");
const pct = (x) => NF1.format(100 * x) + "%";
const pct0 = (x) => (x > 0 && x < 0.005 ? "<1%" : Math.round(100 * x) + "%");
const n0 = (x) => NF0.format(x);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dShort = (s) => `${MONTHS[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}`;
const dLong = (s) => `${MONTHS[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}, ${s.slice(0, 4)}`;
const IMG = (path, size = "normal") => (path ? `https://cards.scryfall.io/${size}/${path}` : null);
const SYM = (s) => `https://svgs.scryfall.io/card-symbols/${s.replace(/\//g, "")}.svg`;
const plural = (n, one, many = one + "s") => `${n0(n)} ${n === 1 ? one : many}`;
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

const TIERS = ["large", "medium", "small"];
const TIER_L = { large: "Large", medium: "Medium", small: "Small", league: "MTGO League" };
const TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Kindred", "Other", "Land"];
const TYPE_L = { Creature: "Creatures", Planeswalker: "Planeswalkers", Battle: "Battles", Instant: "Instants", Sorcery: "Sorceries", Artifact: "Artifacts", Enchantment: "Enchantments", Kindred: "Kindred", Other: "Other", Land: "Lands" };

/* ---------- state ---------- */
const DEFAULTS = { days: 30, type: "all", tiers: ["large", "medium", "small"], leagues: true, place: "all" };
const state = { meta: null, D: null, slug: null, cache: {}, archCache: {}, sort: "share", showAll: false, varSel: {} };
state.f = { ...DEFAULTS, tiers: new Set(DEFAULTS.tiers) };
try {
  const s = JSON.parse(localStorage.getItem("mm-filters-v2") || "{}");
  if ([7, 30, 90].includes(s.days)) state.f.days = s.days;
  if (["all", "online", "paper"].includes(s.type)) state.f.type = s.type;
  if (Array.isArray(s.tiers) && s.tiers.length) state.f.tiers = new Set(s.tiers.filter((t) => TIERS.includes(t)));
  if (typeof s.leagues === "boolean") state.f.leagues = s.leagues;
  if (["all", "top8", "win"].includes(s.place)) state.f.place = s.place;
} catch (_) { /* storage unavailable */ }
const saveFilters = () => {
  try { localStorage.setItem("mm-filters-v2", JSON.stringify({ ...state.f, tiers: [...state.f.tiers] })); } catch (_) { /* */ }
};

/* ---------- data loading ---------- */
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} on ${url}`);
  return r.json();
}
const dataURL = (p) => `data/${p}?v=${enc(state.meta?.generated || "")}`;

async function loadMeta() {
  if (state.meta) return;
  state.meta = await getJSON(`data/meta.json?t=${Date.now()}`);
  const g = new Date(state.meta.generated);
  $("#updated").textContent = `Updated ${g.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${g.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} · ${n0(state.meta.totals.decks)} lists from ${n0(state.meta.totals.tournaments)} tournaments.`;
}

async function loadFormat(slug) {
  if (!state.cache[slug]) {
    const raw = await getJSON(dataURL(`f/${slug}/index.json`));
    const ev = raw.events.map((e, i) => ({ i, id: e[0], name: e[1], date: e[2], type: e[3], source: e[4], url: e[5], players: e[6], kind: e[7], tier: e[8] }));
    const archs = raw.archetypes;
    const D = { format: raw.format, slug, maxDate: raw.maxDate, events: ev, archs, trends: raw.trends };
    D.archBy = new Map(archs.map((a) => [a.n, a]));
    D.decks = raw.decks.map((d) => ({ id: d[0], ev: ev[d[1]], player: d[2], result: d[3], rank: d[4], wins: d[5], losses: d[6], arch: archs[d[7]].n, colors: d[8], pts: d[9] }));
    D.byId = new Map(D.decks.map((d) => [d.id, d]));
    D.minDate = ev.reduce((m, e) => (e.date < m ? e.date : m), "9999");
    state.cache[slug] = D;
  }
  state.D = state.cache[slug];
  state.slug = slug;
}

/* archetype file: adds cards to the deck objects of that archetype */
async function loadArch(arch) {
  const D = state.D;
  const key = `${D.slug}/${arch}`;
  if (!state.archCache[key]) {
    const a = D.archBy.get(arch);
    if (!a) throw new Error(`Unknown deck: ${arch}`);
    const raw = await getJSON(dataURL(`f/${D.slug}/a/${a.s}.json`));
    const A = {
      arch, cards: raw.cards,
      info: raw.info.map((c) => ({ type: c[0] || "Other", cmc: c[1] || 0, mana: c[2] || "", img: c[3], art: c[4], artist: c[5] })),
    };
    A.decks = raw.decks.map((r) => Object.assign({}, D.byId.get(r[0]), { url: r[1], main: r[2], side: r[3] })).filter((d) => d.ev);
    A.byId = new Map(A.decks.map((d) => [d.id, d]));
    state.archCache[key] = A;
  }
  return state.archCache[key];
}

async function loadCardChunk(name) {
  const D = state.D;
  const k = (name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]/) || ["_"])[0];
  const key = `${D.slug}/c/${k}`;
  if (!state.cache[key]) state.cache[key] = await getJSON(dataURL(`f/${D.slug}/c/${k}.json`));
  return state.cache[key];
}

/* ---------- filters ---------- */
function shiftDate(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const isTop8 = (d) => (d.rank != null && d.rank <= 8) || (d.ev.tier === "league" && d.wins >= 5 && !d.losses);
function windowDates(offset = 0) {
  const to = shiftDate(state.D.maxDate, -offset * state.f.days);
  return [shiftDate(to, -state.f.days + 1), to];
}
function passes(d, from, to) {
  const f = state.f;
  if (d.ev.date < from || d.ev.date > to) return false;
  if (f.type !== "all" && d.ev.type !== f.type) return false;
  if (d.ev.tier === "league" ? !f.leagues : !f.tiers.has(d.ev.tier)) return false;
  if (f.place === "top8" && !isTop8(d)) return false;
  if (f.place === "win" && d.rank !== 1) return false;
  return true;
}
function filtered(list = state.D.decks, offset = 0) {
  const [from, to] = windowDates(offset);
  return list.filter((d) => passes(d, from, to));
}
const hasPrev = () => windowDates(1)[0] >= state.D.minDate;
function filterSummary() {
  const f = state.f;
  const parts = [`Last ${f.days} days`];
  parts.push(f.type === "all" ? "Online + paper" : f.type === "online" ? "Online only" : "Paper only");
  if (f.tiers.size < 3) parts.push([...f.tiers].map((t) => TIER_L[t]).join(" + ") + " events");
  parts.push(f.leagues ? "Leagues on" : "Leagues off");
  if (f.place !== "all") parts.push(f.place === "top8" ? "Top 8 only" : "Winners only");
  return parts.join(" · ");
}
const isDefault = () => state.f.days === 30 && state.f.type === "all" && state.f.tiers.size === 3 && state.f.leagues && state.f.place === "all";

/* ---------- statistics ---------- */
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
  return [...m.values()].map((s) => ({ ...s, incl: s.n / N, avg: s.qty / s.n, exp: s.qty / N, mode: s.dist.indexOf(Math.max(...s.dist)) + 1 }))
    .sort((a, b) => b.incl - a.incl || b.avg - a.avg);
}

/* Average list: expected copies per list; integer parts first, then the copies needed to reach the
   typical deck size go to the largest remainders. */
function aggregate(comp, target) {
  const it = comp.map((s) => ({ card: s.card, exp: s.exp, incl: s.incl, q: Math.floor(s.exp) }));
  let tot = it.reduce((a, b) => a + b.q, 0);
  [...it].sort((a, b) => (b.exp - b.q) - (a.exp - a.q)).forEach((x) => { if (tot < target && x.exp > x.q) { x.q++; tot++; } });
  return { cards: it.filter((x) => x.q > 0).map((x) => [x.card, x.q, x.incl]), total: tot };
}
const deckSize = (decks, key) => { let t = 0; for (const d of decks) for (let i = 1; i < d[key].length; i += 2) t += d[key][i]; return Math.round(t / (decks.length || 1)); };
const cardsOf = (flat) => { const o = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; };
const total = (flat) => { let t = 0; for (let i = 1; i < flat.length; i += 2) t += flat[i]; return t; };

/* ---------- variants: k-medoids on weighted Jaccard over non-land "flex" cards ---------- */
function findVariants(A, decks, comp) {
  const N = decks.length;
  if (N < 14) return { reason: "few" };
  const feats = comp.filter((s) => s.incl >= 0.1 && s.incl <= 0.9 && A.info[s.card].type !== "Land").map((s) => s.card);
  if (feats.length < 3) return { reason: "stable" };
  const fi = new Map(feats.map((c, i) => [c, i]));
  const F = feats.length;
  const step = Math.max(1, Math.ceil(N / 500));
  const sample = decks.filter((_, i) => i % step === 0);
  const vec = (d) => { const v = new Float32Array(F); for (let i = 0; i < d.main.length; i += 2) { const j = fi.get(d.main[i]); if (j != null) v[j] = Math.min(d.main[i + 1], 4) / 4; } return v; };
  const V = sample.map(vec), S = V.length;
  const dist = (a, b) => { let mn = 0, mx = 0; for (let j = 0; j < F; j++) { const x = a[j], y = b[j]; if (x < y) { mn += x; mx += y; } else { mn += y; mx += x; } } return mx ? 1 - mn / mx : 0; };
  const M = new Float32Array(S * S);
  for (let i = 0; i < S; i++) for (let j = i + 1; j < S; j++) { const v = dist(V[i], V[j]); M[i * S + j] = v; M[j * S + i] = v; }
  const Dm = (i, j) => M[i * S + j];
  function kmedoids(k) {
    let best = 0, bs = Infinity;
    for (let i = 0; i < S; i++) { let s = 0; for (let j = 0; j < S; j++) s += Dm(i, j); if (s < bs) { bs = s; best = i; } }
    const med = [best];
    while (med.length < k) { let far = -1, fd = -1; for (let i = 0; i < S; i++) { const md = Math.min(...med.map((m) => Dm(i, m))); if (md > fd) { fd = md; far = i; } } med.push(far); }
    const asg = new Int32Array(S);
    for (let it = 0; it < 12; it++) {
      for (let i = 0; i < S; i++) { let b = 0, bd = Infinity; med.forEach((m, c) => { const v = Dm(i, m); if (v < bd) { bd = v; b = c; } }); asg[i] = b; }
      let changed = false;
      for (let c = 0; c < k; c++) {
        const mem = []; for (let i = 0; i < S; i++) if (asg[i] === c) mem.push(i);
        if (!mem.length) continue;
        let bm = med[c], bsum = Infinity;
        for (const i of mem) { let s = 0; for (const j of mem) s += Dm(i, j); if (s < bsum) { bsum = s; bm = i; } }
        if (bm !== med[c]) { med[c] = bm; changed = true; }
      }
      if (!changed) break;
    }
    let sil = 0;
    for (let i = 0; i < S; i++) {
      const sums = new Float64Array(k), cnt = new Int32Array(k);
      for (let j = 0; j < S; j++) if (j !== i) { sums[asg[j]] += Dm(i, j); cnt[asg[j]]++; }
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
  const medV = pick.med.map((m) => V[m]);
  const groups = Array.from({ length: pick.k }, () => []);
  for (const d of decks) { const v = vec(d); let b = 0, bd = Infinity; medV.forEach((mv, c) => { const x = dist(v, mv); if (x < bd) { bd = x; b = c; } }); groups[b].push(d); }
  const used = new Set();
  const list = groups.map((g, c) => {
    const gs = new Set(g);
    const rest = decks.filter((d) => !gs.has(d));
    const inG = new Map(composition(g).map((s) => [s.card, s]));
    const inR = new Map(composition(rest).map((s) => [s.card, s.incl]));
    const diffs = [];
    for (const s of comp) {
      const a = inG.get(s.card)?.incl || 0, b = inR.get(s.card) || 0;
      if (Math.abs(a - b) >= 0.25) diffs.push({ card: s.card, a, b, d: a - b, q: inG.get(s.card)?.mode || 0 });
    }
    const plus = diffs.filter((x) => x.d > 0).sort((x, y) => y.d - x.d);
    const minus = diffs.filter((x) => x.d < 0).sort((x, y) => x.d - y.d);
    const key = plus.find((x) => !used.has(x.card) && A.info[x.card].type !== "Land") || plus.find((x) => !used.has(x.card));
    let name;
    if (key) { used.add(key.card); name = `with ${A.cards[key.card]}`; }
    else if (minus[0]) name = `without ${A.cards[minus[0].card]}`;
    else name = `Variant ${c + 1}`;
    return { name, decks: g, plus: plus.slice(0, 4), minus: minus.slice(0, 3), medoid: sample[pick.med[c]] };
  }).sort((a, b) => b.decks.length - a.decks.length);
  return { list, sil: pick.sil };
}
/* stable variants: computed once on all loaded lists of the archetype; filters only change the numbers */
function archVariants(A) {
  if (!A.variants) {
    A.variants = findVariants(A, A.decks, composition(A.decks, "main"));
    if (A.variants.list) A.variants.of = new Map(A.variants.list.flatMap((x) => x.decks.map((d) => [d.id, x])));
  }
  return A.variants;
}

/* ---------- UI fragments ---------- */
function manaCost(cost, cls = "") {
  if (!cost) return "";
  const parts = cost.split(" // ")[0].match(/\{[^}]+\}/g) || [];
  return `<span class="mana ${cls}">${parts.map((p) => { const s = p.slice(1, -1); return `<img src="${SYM(s)}" alt="{${esc(s)}}" loading="lazy" width="15" height="15">`; }).join("")}</span>`;
}
function pips(colors, cls = "") {
  const c = colors || "C";
  return `<span class="mana ${cls}" title="${esc(colors || "Colorless")}">${[..."WUBRG"].filter((x) => c.includes(x)).concat(c === "C" ? ["C"] : []).map((x) => `<img src="${SYM(x)}" alt="${x}" loading="lazy" width="15" height="15">`).join("")}</span>`;
}
const fmtLink = (p = "") => `#/${state.slug}${p}`;
const archLink = (a) => fmtLink(`/deck/${enc(a)}`);
const listLink = (id) => fmtLink(`/list/${id}`);
const cardLink = (c) => fmtLink(`/card/${enc(c)}`);
const evLink = (i) => fmtLink(`/event/${i}`);
const tierDot = (t) => `<i class="tier-dot ${t}" aria-hidden="true"></i>`;
function sizeBadge(ev) {
  const p = ev.players ? `${n0(ev.players)} players` : ev.tier === "league" ? "MTGO League" : ev.kind === "challenge" ? "MTGO Challenge" : "size n/a";
  return `<span class="tier" title="${TIER_L[ev.tier]} event">${tierDot(ev.tier)}${p}</span>`;
}
function delta(cur, prev) {
  if (prev == null) return "";
  const d = (cur - prev) * 100;
  if (Math.abs(d) < 0.3) return `<span class="delta flat" title="Stable vs the previous ${state.f.days} days">=</span>`;
  return `<span class="delta ${d > 0 ? "up" : "down"}" title="vs the previous ${state.f.days} days (percentage points)">${d > 0 ? "▲" : "▼"} ${NF1.format(Math.abs(d))}</span>`;
}
function cardImg(ci, name, { size = "normal", eager = false, sizes = "(max-width: 560px) 30vw, 160px" } = {}) {
  if (!ci?.img) return `<div class="card-img"><div class="fallback">${esc(name)}</div></div>`;
  const srcset = size === "normal" ? ` srcset="${IMG(ci.img, "small")} 146w, ${IMG(ci.img, "normal")} 488w" sizes="${sizes}"` : "";
  return `<div class="card-img"><img src="${IMG(ci.img, size)}"${srcset} alt="${esc(name)}" ${eager ? "" : 'loading="lazy"'} decoding="async" width="488" height="680"></div>`;
}
const credit = (art) => (art?.artist ? `<span class="credit">Art: ${esc(art.artist)}</span>` : "");
const empty = (title, text) => `<div class="empty"><b>${title}</b>${text}</div>`;
const archArt = (arch) => state.D.archBy.get(arch);

function resultsStack(a, maxTop8) {
  const parts = ["large", "medium", "small", "league"].map((t) => [t, a.tiers[t]?.top8 || 0]).filter(([, n]) => n);
  const tip = ["large", "medium", "small", "league"].filter((t) => a.tiers[t]).map((t) => `${TIER_L[t]}: ${a.tiers[t].wins || 0} wins, ${a.tiers[t].top8 || 0} ${t === "league" ? "5-0s" : "top 8s"}`).join("\n");
  return `<span class="rs" title="${esc(tip)}">
    <span class="rs-n"><b>${a.wins}</b> ${a.wins === 1 ? "win" : "wins"} <span class="dot-sep">·</span> <b>${a.top8}</b> top 8</span>
    <span class="rs-bar" style="width:${Math.max(4, 100 * a.top8 / maxTop8)}%">${parts.map(([t, n]) => `<i class="t-${t}" style="flex:${n}"></i>`).join("")}</span>
  </span>`;
}

/* ---------- page shell ---------- */
function view(html, { keepScroll = false } = {}) {
  $("#app").innerHTML = `<div class="fade-in">${html}</div>`;
  if (!keepScroll) window.scrollTo(0, 0);
  enableSorting();
}
function formatHeader(active) {
  const D = state.D;
  return `<div class="ctx wrap">
    ${active === "deck" ? "" : `<nav class="tabs" aria-label="${esc(D.format)} sections">
      <a href="${fmtLink()}" class="${active === "meta" ? "on" : ""}">Metagame</a>
      <a href="${fmtLink("/tournaments")}" class="${active === "events" ? "on" : ""}">Tournaments</a>
      <a href="${fmtLink("/cards")}" class="${active === "cards" ? "on" : ""}">Cards</a>
    </nav>`}
    ${active === "cards" ? "" : `<button class="filter-bar ${isDefault() ? "" : "custom"}" data-open-filters>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M6 10h8M9 15h2"/></svg>
      <span>${esc(filterSummary())}</span><b>Filters</b></button>`}
  </div>`;
}

/* ---------- home ---------- */
function renderHome() {
  const M = state.meta;
  const main = M.formats.filter((f) => f.top?.length && f.decks >= 100);
  const minor = M.formats.filter((f) => !main.includes(f));
  const cards = main.map((f) => {
    const top = f.top[0];
    return `<a class="fcard" href="#/${f.slug}">
      <div class="art">${top?.art ? `<img src="${IMG(top.art, "art_crop")}" alt="" loading="lazy">` : ""}<h3>${esc(f.format)}</h3>${top?.artist ? `<span class="credit">Art: ${esc(top.artist)}</span>` : ""}</div>
      <div class="body">
        <div class="meta"><span>${n0(f.decks)} lists</span><span>${n0(f.events)} events</span><span>through ${dShort(f.last)}</span></div>
        <ol>${f.top.map((a) => `<li><span class="nm">${pips(a.colors)} ${esc(a.name)}</span><span class="bar"><i style="width:${Math.min(100, a.share / f.top[0].share * 100)}%"></i></span><span class="pc">${pct(a.share)}</span></li>`).join("")}</ol>
      </div></a>`;
  }).join("");
  const q = M.quality || {};
  const removed = Object.values(q).reduce((s, v) => s + v, 0);
  view(`<div class="wrap">
    <section class="home-hero">
      <div class="eyebrow">Updated every 12 hours</div>
      <h1 class="display">Magic tournament results, <em>explained</em>.</h1>
      <p class="lede">Online and paper results from around the world, <b>checked one by one</b>: which decks win, with which cards, and in which events — from the local store to the Pro Tour.</p>
      <div class="home-stats">
        <div><b>${n0(M.totals.decks)}</b><span>lists</span></div>
        <div><b>${n0(M.totals.tournaments)}</b><span>tournaments</span></div>
        <div><b>${n0(M.tiers?.large || 0)}</b><span>large events</span></div>
        <div><b>${n0(removed)}</b><span><a href="#/about">records rejected</a> by our checks</span></div>
      </div>
    </section>
    <section class="sec">
      <div class="sec-head"><div><h2>Choose a format</h2><p>Most played decks of the last 30 days, tournaments only.</p></div></div>
      <div class="format-grid">${cards}</div>
      ${minor.length ? `<p class="more-formats">More formats: ${minor.map((f) => `<a href="#/${f.slug}">${esc(f.format)} <span>${n0(f.decks)}</span></a>`).join("")}</p>` : ""}
    </section></div>`);
  document.title = "Metagame — Magic tournament results, explained";
}

/* ---------- format: metagame ---------- */
function renderFormat(opts) {
  const D = state.D;
  const decks = filtered();
  const prev = hasPrev() ? new Map(metagame(filtered(D.decks, 1)).map((a) => [a.arch, a.share])) : null;
  const meta = metagame(decks);
  const N = decks.length;
  if (!N) return view(`${formatHeader("meta")}<div class="wrap"><header class="page-head"><h1 class="display">${esc(D.format)}</h1></header>${empty("No lists match these filters", "Try a longer period or include more events.")}</div>`, opts);
  const evs = [...new Map(decks.map((d) => [d.ev.i, d.ev])).values()];
  const tierCount = Object.fromEntries(["large", "medium", "small", "league"].map((t) => [t, evs.filter((e) => e.tier === t).length]));
  const byShare = [...meta].sort((a, b) => b.n - a.n);
  const byPts = [...meta].sort((a, b) => b.pts - a.pts);
  const list = state.sort === "pts" ? byPts : byShare;
  const shown = state.showAll ? list : list.slice(0, 15);
  const maxShare = Math.max(...list.map((a) => a.share));
  const maxPts = byPts[0].pts || 1;
  const maxTop8 = Math.max(1, ...meta.map((a) => a.top8));
  const lead = byShare[0], best = byPts[0];

  const podium = byShare.slice(0, 3).map((a, i) => {
    const art = archArt(a.arch);
    return `<a class="pcard" href="${archLink(a.arch)}">
      ${art?.art ? `<img src="${IMG(art.art, "art_crop")}" alt="" ${i ? 'loading="lazy"' : ""}>` : ""}
      <span class="rank">#${i + 1}</span>${credit(art)}
      <div>${pips(a.color, "lg")}</div>
      <h3>${esc(a.arch)}</h3>
      <div class="stats">
        <div><b>${pct(a.share)}</b><span>of the meta ${prev ? delta(a.share, prev.get(a.arch) || 0) : ""}</span></div>
        <div><b>${a.wins}</b><span>${a.wins === 1 ? "win" : "wins"}</span></div>
        <div><b>${a.top8}</b><span>top 8</span></div>
      </div></a>`;
  }).join("");

  const rows = shown.map((a) => {
    const art = archArt(a.arch);
    const pos = list.indexOf(a) + 1;
    return `<a class="meta-row" href="${archLink(a.arch)}">
      <span class="pos">${pos}</span>
      <span class="who">${art?.art ? `<img class="thumb" src="${IMG(art.art, "art_crop")}" alt="" loading="lazy" width="62" height="44">` : `<span class="thumb"></span>`}
        <span class="who-t"><span class="name">${esc(a.arch)}</span><span class="sub">${pips(a.color)} ${plural(a.n, "list")}</span></span></span>
      <span class="share"><span class="bar"><i style="width:${(100 * a.share / maxShare).toFixed(1)}%"></i></span><span class="v">${pct(a.share)}</span></span>
      <span class="trend">${prev ? delta(a.share, prev.get(a.arch) || 0) : ""}</span>
      <span class="results">${resultsStack(a, maxTop8)}</span>
      <span class="score" title="Results index (0–100)">${Math.round(100 * a.pts / maxPts)}<small>index</small></span>
    </a>`;
  }).join("");

  const winners = new Map(); decks.forEach((d) => { if (d.rank === 1) winners.set(d.ev.i, d); });
  const tierRank = { large: 0, medium: 1, small: 2, league: 3 };
  const bigEvents = evs.filter((e) => e.tier !== "league")
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || (b.players || 0) - (a.players || 0) || (a.date < b.date ? 1 : -1)).slice(0, 5);

  view(`${formatHeader("meta")}<div class="wrap">
    <header class="page-head">
      <h1 class="display">${esc(D.format)}</h1>
      <p class="lede"><b>${n0(N)} lists</b> from <b>${plural(evs.length, "event")}</b>. The most played deck is <a href="${archLink(lead.arch)}"><b>${esc(lead.arch)}</b></a> (${pct(lead.share)})${best.arch !== lead.arch ? `; the one with the <b>best results</b>, weighted by event size, is <a href="${archLink(best.arch)}"><b>${esc(best.arch)}</b></a>` : ", and it also has the best results"}.</p>
      <div class="tier-summary">${["large", "medium", "small", "league"].filter((t) => tierCount[t]).map((t) => `<span class="tier">${tierDot(t)}<b>${tierCount[t]}</b>&nbsp;${t === "league" ? (tierCount[t] === 1 ? "MTGO league" : "MTGO leagues") : `${TIER_L[t].toLowerCase()} ${tierCount[t] === 1 ? "event" : "events"}`}</span>`).join("")}</div>
    </header>

    <section class="podium" aria-label="Top 3 decks">${podium}</section>

    <section class="sec">
      <div class="sec-head">
        <div><h2>All decks</h2><p>Share of the metagame and results. The results bar splits top 8s by event size:
          <span class="tier">${tierDot("large")}large</span> <span class="tier">${tierDot("medium")}medium</span> <span class="tier">${tierDot("small")}small</span> <span class="tier">${tierDot("league")}league 5-0</span>.</p></div>
        <div class="seg" role="group" aria-label="Sort by">
          <button data-sort="share" class="${state.sort === "share" ? "on" : ""}">Most played</button>
          <button data-sort="pts" class="${state.sort === "pts" ? "on" : ""}">Best results</button>
        </div>
      </div>
      <div class="meta-list">
        <div class="meta-head"><span>#</span><span>Deck</span><span>Share</span><span>${prev ? "Trend" : ""}</span><span>Results</span><span class="r" title="Sum of result points, 0–100 vs the best deck">Index</span></div>
        ${rows}
        ${list.length > 15 ? `<div class="meta-foot"><button class="btn" data-showall>${state.showAll ? "Show top 15 only" : `Show all ${list.length} decks`}</button></div>` : ""}
      </div>
    </section>

    <section class="sec">
      <div class="sec-head"><div><h2>Biggest events</h2><p>The largest tournaments of the period and their winners.</p></div><a class="link-more" href="${fmtLink("/tournaments")}">All tournaments →</a></div>
      <div class="events">${bigEvents.map((e) => evRow(e, winners.get(e.i))).join("") || empty("No events", "")}</div>
    </section></div>`, opts);

  $$("[data-sort]").forEach((b) => b.addEventListener("click", () => { state.sort = b.dataset.sort; renderFormat({ keepScroll: true }); }));
  $("[data-showall]")?.addEventListener("click", () => { state.showAll = !state.showAll; renderFormat({ keepScroll: true }); });
  document.title = `${D.format} metagame · Metagame`;
}

function evRow(e, w) {
  return `<a class="ev" href="${evLink(e.i)}">
    <span class="date"><b>${+e.date.slice(8, 10)}</b><span>${MONTHS[+e.date.slice(5, 7) - 1]}</span></span>
    <span class="ev-t"><span class="t">${esc(e.name)}</span><span class="s">${sizeBadge(e)}<span>${e.type === "paper" ? "paper" : "online"}</span><span>${esc(e.source)}</span></span></span>
    ${w ? `<span class="win"><span class="wl">Winner</span> <b>${esc(w.arch)}</b> <span class="wp">${esc(w.player)}</span></span>` : `<span></span>`}
  </a>`;
}

/* ---------- format: tournaments ---------- */
function renderEvents(opts) {
  const D = state.D;
  const decks = filtered();
  const evs = new Map(); const winners = new Map();
  decks.forEach((d) => { evs.set(d.ev.i, d.ev); if (d.rank === 1) winners.set(d.ev.i, d); });
  const list = [...evs.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.players || 0) - (a.players || 0)));
  view(`${formatHeader("events")}<div class="wrap">
    <header class="page-head"><h1 class="display">${esc(D.format)} tournaments</h1>
      <p class="lede">${plural(list.length, "event")}. The dot shows the size: <span class="tier">${tierDot("large")}large (100+ players or premier event)</span> <span class="tier">${tierDot("medium")}medium (32–99, MTGO Challenges, qualifiers)</span> <span class="tier">${tierDot("small")}small (16–31)</span> <span class="tier">${tierDot("league")}MTGO league</span>. Events under 16 players are excluded.</p></header>
    <div class="events">${list.slice(0, 300).map((e) => evRow(e, winners.get(e.i))).join("") || empty("No events", "Try wider filters.")}</div></div>`, opts);
  document.title = `${D.format} tournaments · Metagame`;
}

function renderEvent(idx, opts) {
  const D = state.D;
  const ev = D.events[idx];
  if (!ev) return view(`<div class="wrap">${empty("Event not found", "")}</div>`, opts);
  const list = D.decks.filter((d) => d.ev === ev).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (b.wins ?? 0) - (a.wins ?? 0));
  const meta = metagame(list).sort((a, b) => b.n - a.n);
  view(`<div class="wrap">
    <nav class="crumbs"><a href="${fmtLink()}">${esc(D.format)}</a><span aria-hidden="true">/</span><a href="${fmtLink("/tournaments")}">Tournaments</a></nav>
    <header class="page-head">
      <div class="eyebrow">${dLong(ev.date)} · ${ev.type} · ${TIER_L[ev.tier].toLowerCase()}${ev.tier === "league" ? "" : " event"}</div>
      <h1 class="display sm">${esc(ev.name)}</h1>
      <p class="lede">${sizeBadge(ev)} · ${plural(list.length, "list")} published${ev.url ? ` · <a class="link-more" href="${esc(ev.url)}" target="_blank" rel="noopener">original page ↗</a>` : ""}</p>
      ${ev.kind === "challenge" && !ev.players ? `<p class="note">For this Challenge we only have the top 32 lists, so the real number of players is not known.</p>` : ""}
      ${ev.kind === "challenge" && ev.players ? `<p class="note">Read directly from mtgo.com: official player count and final standings.</p>` : ""}
      ${ev.tier === "league" ? `<p class="note">MTGO Leagues have no standings: Wizards publishes a selection of 5-0 lists.</p>` : ""}
      ${ev.source === "magic.gg" && list.some((d) => d.rank == null || /^top/i.test(d.result || "")) ? `<p class="note">Read directly from magic.gg. The official page does not say who finished where, so placements are shown as published (e.g. “Top 16”), never guessed.</p>` : ""}
      ${ev.source === "topdeck.gg" ? `<p class="note">Official standings and player count from the TopDeck.gg API. Data provided by <a href="https://topdeck.gg" target="_blank" rel="noopener">TopDeck.gg</a>.</p>` : ""}
    </header>
    ${meta.length > 1 ? `<div class="chiplist">${meta.map((a) => `<a href="${archLink(a.arch)}">${pips(a.color)} ${esc(a.arch)}<span>${a.n}</span></a>`).join("")}</div>` : ""}
    <div class="sec" style="margin-top:24px">${listsTable(list, { limit: 200, showArch: true, showEvent: false })}</div></div>`, opts);
  bindMore();
  document.title = `${ev.name} · Metagame`;
}

/* ---------- format: cards ---------- */
function renderCards(opts) {
  const D = state.D;
  const T = D.trends;
  const row = (r, i, kind) => {
    const d = (r[2] - r[3]) * 100;
    return `<a class="trend-row" href="${cardLink(r[0])}" data-img="${esc(r[1] || "")}">
      <span class="mini">${r[1] ? `<img src="${IMG(r[1], "small")}" alt="" loading="lazy" width="146" height="204">` : ""}</span>
      <span class="nm"><b>${esc(r[0])}</b><span>${pct0(r[3])} → <b>${pct0(r[2])}</b> of lists</span></span>
      <span class="delta ${kind === "up" ? "up" : "down"}">${kind === "up" ? "▲" : "▼"} ${NF1.format(Math.abs(d))}</span></a>`;
  };
  view(`${formatHeader("cards")}<div class="wrap">
    <header class="page-head"><h1 class="display">${esc(D.format)} cards</h1>
      <p class="lede">What is moving in the format: cards gaining and losing ground in tournament lists over the <b>last 30 days</b> compared with the 30 before (${n0(T.decksNow)} vs ${n0(T.decksPrev)} lists, MTGO leagues excluded).</p></header>
    ${T.decksPrev ? `<div class="two-col">
      <section><h2 class="h2">Rising</h2><div class="flex-list">${T.rising.map((r, i) => row(r, i, "up")).join("") || `<p class="note pad">Nothing notable.</p>`}</div></section>
      <section><h2 class="h2">Falling</h2><div class="flex-list">${T.falling.map((r, i) => row(r, i, "down")).join("") || `<p class="note pad">Nothing notable.</p>`}</div></section>
    </div>` : `<div class="note-box">Not enough history yet to compare two periods.</div>`}
    <section class="sec">
      <div class="sec-head"><div><h2>New to ${esc(D.format)}? The staples</h2><p>The non-land cards you will meet most often, with the share of lists that play them.</p></div></div>
      <div class="card-grid">${T.staples.map((r) => `<a class="tile" href="${cardLink(r[0])}">
        <div class="tile-img">${cardImg({ img: r[1] }, r[0])}</div><div class="cap"><b>${esc(r[0])}</b><span>in ${pct0(r[2])} of lists</span></div></a>`).join("")}</div>
    </section></div>`, opts);
  document.title = `${D.format} cards · Metagame`;
}

/* ---------- archetype ---------- */
async function renderArch(arch, opts) {
  const D = state.D;
  const A = await loadArch(arch);
  const all = filtered();
  const decks = filtered(A.decks);
  const art = archArt(arch);
  const N = decks.length;
  const heroImg = art?.art ? `<img class="bg" src="${IMG(art.art, "art_crop")}" alt="">` : "";
  const head = (stats = "") => `<section class="hero">${heroImg}<div class="hero-inner wrap">
      <nav class="crumbs"><a href="${fmtLink()}">${esc(D.format)}</a><span aria-hidden="true">/</span><span>Deck</span></nav>
      <h1>${esc(arch)}</h1>${stats}</div>${credit(art)}</section>`;
  if (!N) {
    return view(`${head()}${formatHeader("deck")}<div class="wrap">${empty("No lists match these filters", "This deck doesn't appear in the selected period or events. Try wider filters.")}</div>`, opts);
  }
  const meta = metagame(all);
  const me = meta.find((a) => a.arch === arch);
  const ptsPos = [...meta].sort((a, b) => b.pts - a.pts).findIndex((a) => a.arch === arch) + 1;
  const prevShare = hasPrev() ? (metagame(filtered(D.decks, 1)).find((a) => a.arch === arch)?.share || 0) : null;

  // selected variant: when a deck splits into variants, composition is read per variant
  const vars = archVariants(A);
  const varRows = vars.list ? vars.list.map((x) => ({ x, n: decks.filter((d) => vars.of.get(d.id) === x).length })).filter((r) => r.n).sort((a, b) => b.n - a.n) : [];
  let sel = state.varSel[arch];
  if (sel === undefined) sel = varRows.length >= 2 ? varRows[0].x.name : "all";
  if (sel !== "all" && !varRows.some((r) => r.x.name === sel)) sel = "all";
  const scope = sel === "all" ? decks : decks.filter((d) => vars.of.get(d.id)?.name === sel);
  const S = scope.length;
  const scopeTxt = sel === "all" ? "" : ` of the variant <b>${esc(sel)}</b>`;

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
  const mS = sel === "all" ? me : metagame(scope)[0];
  const bestTier = ["large", "medium", "small"].find((t) => mS.tiers[t]?.top8);
  const aggM = aggregate(main, size), aggS = aggregate(side, deckSize(scope, "side"));
  const results = [...scope].sort((a, b) => b.pts - a.pts || (a.ev.date < b.ev.date ? 1 : -1));
  const C = A.cards;

  // one plain-English summary instead of separate boxes
  const stab = stability >= 0.75 ? "a <b>very stable</b> deck: lists look almost the same"
    : stability >= 0.5 ? "a <b>fairly stable</b> deck, with room for personal choices" : "a <b>very flexible</b> deck: lists change a lot";
  const story = [
    `<b>${esc(arch)}</b> is <b>${pct(me.share)}</b> of the metagame${prevShare != null ? ` (${me.share - prevShare >= 0 ? "up" : "down"} ${NF1.format(Math.abs(me.share - prevShare) * 100)} points)` : ""}, with ${plural(N, "list")} and ${plural(me.wins, "tournament win")}.`,
    bestTier ? `Its best results come from <b>${bestTier} events</b>: ${plural(mS.tiers[bestTier].top8, "top 8")}${mS.tiers[bestTier].wins ? `, ${plural(mS.tiers[bestTier].wins, "win")}` : ""}${sel === "all" ? "" : " for this variant"}.` : "",
    `${core.length === 1 ? "One card is" : `${core.length} cards are`} in almost every list${scopeTxt}: it's ${stab}.`,
    divisive ? `The choice that splits players is <a href="${cardLink(C[divisive.card])}" data-card="${divisive.card}"><b>${esc(C[divisive.card])}</b></a>, in ${pct0(divisive.incl)} of lists.` : "",
    S < 10 ? `<i>Small sample (${plural(S, "list")}): read the numbers with care.</i>` : "",
  ].filter(Boolean).join(" ");

  const varBar = varRows.length >= 2 ? `<div class="varbar">
      <span>This deck comes in <b>${varRows.length} distinct variants</b>. You are looking at:</span>
      <div class="seg wrapseg" role="group" aria-label="Variant" data-var>
        <button data-v="all" class="${sel === "all" ? "on" : ""}">All lists</button>
        ${varRows.map((r) => `<button data-v="${esc(r.x.name)}" class="${sel === r.x.name ? "on" : ""}">${esc(r.x.name)} <span class="muted">${pct0(r.n / N)}</span></button>`).join("")}
      </div></div>` : "";

  view(`${head(`<div class="hero-stats">
        <div><b>${pct(me.share)}</b><span>of the meta ${prevShare != null ? delta(me.share, prevShare) : ""}</span></div>
        <div><b>${n0(N)}</b><span>${N === 1 ? "list" : "lists"}</span></div>
        <div><b>${me.wins}</b><span>${me.wins === 1 ? "win" : "wins"}</span></div>
        <div><b>#${ptsPos}</b><span>by results</span></div>
      </div>`)}
    ${formatHeader("deck")}
    <div class="wrap">
      <p class="story">${story}</p>
      ${varBar}
      <nav class="subnav" aria-label="Sections"><a href="#s-core">Core</a><a href="#s-flex">Flex</a>${vars.list ? `<a href="#s-variants">Variants</a>` : ""}<a href="#s-side">Sideboard</a><a href="#s-avg">Average list</a><a href="#s-results">Results</a></nav>

      <section id="s-core" class="sec">
        <div class="sec-head"><div><h2>The core</h2><p>Cards in at least 90% of the lists${scopeTxt}. The badge shows the usual number of copies.</p></div><span class="side">${plural(core.length, "card")} · ${NF1.format(coreSlots)} of ${size} slots</span></div>
        ${core.length ? `<div class="card-grid">${core.map((s) => tile(A, s.card, s.mode, `in ${pct0(s.incl)} of lists`)).join("")}</div>` : `<div class="note-box">No card reaches 90%: these lists vary a lot.</div>`}
      </section>

      <section id="s-flex" class="sec">
        <div class="sec-head"><div><h2>The flex slots</h2><p>Cards played by part of the lists${scopeTxt} (25–90%): this is where players make the deck their own. The small bars show how many lists play 1, 2, 3 or 4 copies.</p></div></div>
        ${flex.length ? `<div class="flex-list">${flex.map((s) => flexRow(A, s)).join("")}</div>` : `<div class="note-box">No flexible slots: everyone plays the same list.</div>`}
        ${spice.length ? `<h3 class="h3">Occasional picks</h3><div class="chiplist">${spice.map((s) => `<a href="${cardLink(C[s.card])}" data-card="${s.card}">${esc(C[s.card])}<span>${pct0(s.incl)}</span></a>`).join("")}</div>` : ""}
      </section>

      ${vars.list ? `<section id="s-variants" class="sec">
        <div class="sec-head"><div><h2>The variants</h2><p>Lists making similar choices, grouped automatically. For each variant, the cards that set it apart: “95% vs 10%” means 95% of its lists play the card, against 10% of the other lists.</p></div></div>
        ${variantsHTML(A, vars, decks)}
      </section>` : ""}

      <section id="s-side" class="sec">
        <div class="sec-head"><div><h2>Sideboard</h2><p>The most used sideboard cards (in at least 20% of the lists${scopeTxt}).</p></div></div>
        ${sideMain.length ? `<div class="flex-list">${sideMain.map((s) => flexRow(A, s)).join("")}</div>` : `<div class="note-box">Not enough sideboard data.</div>`}
        ${sideSpice.length ? `<h3 class="h3">Other sideboard cards</h3><div class="chiplist">${sideSpice.map((s) => `<a href="${cardLink(C[s.card])}" data-card="${s.card}">${esc(C[s.card])}<span>${pct0(s.incl)}</span></a>`).join("")}</div>` : ""}
      </section>

      <section id="s-avg" class="sec">
        <div class="sec-head"><div><h2>The average list</h2><p>The “typical” deck${scopeTxt}: average copies of each card across ${plural(S, "list")}, rounded to ${size} + ${aggS.total}. On the right, the share of lists playing the card.${sel === "all" && varRows.length >= 2 ? " <b>Note:</b> this mixes different variants — pick one above for a playable list." : ""}</p></div>
          <button class="btn" data-copy="avg">Copy list</button></div>
        <div class="avg-layout">
          <div class="panel">${groupedList(A, aggM.cards, aggS.cards)}</div>
          <div class="side-stack"><div class="panel curve">${curveHTML(A, aggM.cards)}</div><div class="panel types">${typesHTML(A, aggM.cards)}</div></div>
        </div>
      </section>

      <section id="s-results" class="sec">
        <div class="sec-head"><div><h2>Results</h2><p>Lists of the period${scopeTxt}, rarest result first: finishing high in a large event counts more than winning a small one.</p></div></div>
        ${listsTable(results, { limit: 30 })}
      </section>
    </div>`, opts);

  $("[data-copy=avg]")?.addEventListener("click", (e) => copyList(A, aggM.cards, aggS.cards, e.currentTarget));
  const pick = (v, jump) => { state.varSel[arch] = v; renderArch(arch, { keepScroll: true }); if (jump) setTimeout(() => $("#s-core")?.scrollIntoView({ behavior: "smooth" }), 30); };
  $$("[data-var] button").forEach((b) => b.addEventListener("click", () => pick(b.dataset.v)));
  $$("[data-pickvar]").forEach((b) => b.addEventListener("click", () => pick(b.dataset.pickvar, true)));
  bindMore();
  bindSubnav();
  document.title = `${arch} · ${D.format} · Metagame`;
}

function tile(A, card, qty, caption, cls = "") {
  const ci = A.info[card], name = A.cards[card];
  return `<a class="tile ${cls}" href="${cardLink(name)}">
    <div class="tile-img">${cardImg(ci, name)}${qty ? `<span class="qty">${qty}</span>` : ""}</div>
    <div class="cap"><b>${esc(name)}</b>${caption ? `<span>${caption}</span>` : ""}</div></a>`;
}

function flexRow(A, s) {
  const ci = A.info[s.card], name = A.cards[s.card];
  const mx = Math.max(...s.dist, 1);
  return `<a class="flex-row" href="${cardLink(name)}" data-card="${s.card}">
    <span class="mini">${ci.img ? `<img src="${IMG(ci.img, "small")}" alt="" loading="lazy" width="146" height="204">` : ""}</span>
    <span class="nm"><b>${esc(name)}</b><span>usually ${s.mode} ${s.mode === 1 ? "copy" : "copies"} · avg ${s.avg.toFixed(1)}</span></span>
    <span class="incl"><span class="bar"><i style="width:${(100 * s.incl).toFixed(1)}%"></i></span><span class="v">${pct0(s.incl)}</span></span>
    <span class="copies" title="${s.dist.map((n, i) => `${i + 1}${i === 3 ? "+" : ""} ${i ? "copies" : "copy"}: ${n} lists`).join("\n")}">
      ${s.dist.map((n, i) => `<span class="cb"><i class="${n ? "" : "zero"}" style="height:${n ? Math.max(3, 22 * n / mx) : 2}px"></i><small>${i + 1}${i === 3 ? "+" : ""}</small></span>`).join("")}
    </span></a>`;
}

function variantsHTML(A, v, decks) {
  const N = decks.length;
  const rows = v.list.map((x) => {
    const g = decks.filter((d) => v.of.get(d.id) === x);
    return { x, g, share: g.length / (N || 1), wins: g.filter((d) => d.rank === 1).length, top8: g.filter(isTop8).length };
  }).filter((r) => r.g.length).sort((a, b) => b.g.length - a.g.length);
  if (rows.length < 2) return `<div class="note-box">With the current filters only one variant shows up${rows[0] ? `: <b>${esc(rows[0].x.name)}</b>` : ""}. Widen the filters to compare them.</div>`;
  const C = A.cards;
  return `<div class="variants">${rows.map(({ x, g, share, wins, top8 }) => {
    const fan = (x.plus.length ? x.plus : x.minus).slice(0, 3).map((p) => p.card);
    return `<article class="variant">
      <div class="v-top">
        <div class="fan">${fan.map((c) => cardImg(A.info[c], C[c], { size: "small" })).join("")}</div>
        <div><h3>${esc(x.name.charAt(0).toUpperCase() + x.name.slice(1))}</h3><p>${plural(g.length, "list")} · ${plural(wins, "win")} · ${top8} top 8</p></div>
      </div>
      <div class="v-share"><span class="bar"><i style="width:${(100 * share).toFixed(1)}%"></i></span><b>${pct0(share)}</b></div>
      <ul>
        ${x.plus.map((p) => `<li><span class="sg plus">+</span><a href="${cardLink(C[p.card])}" data-card="${p.card}">${p.q ? p.q + " " : ""}${esc(C[p.card])}</a><span class="n">${pct0(p.a)} vs ${pct0(p.b)}</span></li>`).join("")}
        ${x.minus.map((p) => `<li><span class="sg minus">−</span><a href="${cardLink(C[p.card])}" data-card="${p.card}">${esc(C[p.card])}</a><span class="n">${pct0(p.a)} vs ${pct0(p.b)}</span></li>`).join("")}
        ${!x.plus.length && !x.minus.length ? `<li><span></span><span class="muted">Small differences spread across many cards</span><span></span></li>` : ""}
      </ul>
      <div class="v-foot"><button class="linklike" data-pickvar="${esc(x.name)}">Analyse this variant</button><a href="${listLink(x.medoid.id)}">Typical list →</a></div>
    </article>`;
  }).join("")}</div>`;
}

function groupedList(A, mainCards, sideCards, opts = {}) {
  const C = A.cards, I = A.info;
  const groups = new Map();
  for (const row of mainCards) { const t = TYPE_ORDER.includes(I[row[0]].type) ? I[row[0]].type : "Other"; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(row); }
  const line = ([c, q, incl]) => `<div class="dl-line ${opts.odd?.(c) ? "odd" : ""}"><span class="q">${q}</span><a class="n" href="${cardLink(C[c])}" data-card="${c}">${esc(C[c])}</a><span class="x">${manaCost(I[c].mana)}${incl != null ? `<span class="p">${pct0(incl)}</span>` : ""}</span></div>`;
  const sortL = (l) => l.sort((a, b) => b[1] - a[1] || I[a[0]].cmc - I[b[0]].cmc || C[a[0]].localeCompare(C[b[0]]));
  const blocks = TYPE_ORDER.filter((t) => groups.has(t)).map((t) => { const l = sortL(groups.get(t)); return `<div class="dl-group"><h4><span>${TYPE_L[t]}</span><span>${l.reduce((s, x) => s + x[1], 0)}</span></h4>${l.map(line).join("")}</div>`; });
  if (sideCards?.length) { const l = sortL([...sideCards]); blocks.push(`<div class="dl-group"><h4><span>Sideboard</span><span>${l.reduce((s, x) => s + x[1], 0)}</span></h4>${l.map(line).join("")}</div>`); }
  return `<div class="decklist">${blocks.join("")}</div>`;
}
function curveHTML(A, mainCards) {
  const b = new Array(8).fill(0);
  for (const [c, q] of mainCards) { const ci = A.info[c]; if (ci.type === "Land") continue; b[Math.min(7, Math.floor(ci.cmc || 0))] += q; }
  const mx = Math.max(...b, 1), tot = b.reduce((s, x) => s + x, 0);
  const avg = tot ? b.reduce((s, x, i) => s + x * i, 0) / tot : 0;
  return `<h4>Mana curve <span class="h4-sub">· avg ${avg.toFixed(2)}</span></h4>
    <div class="curve-bars">${b.map((x, i) => `<div title="${x} cards at mana value ${i === 7 ? "7+" : i}"><b>${x || ""}</b><i style="height:${(100 * x / mx).toFixed(1)}%"></i></div>`).join("")}</div>
    <div class="curve-x">${b.map((_, i) => `<span>${i === 7 ? "7+" : i}</span>`).join("")}</div>`;
}
function typesHTML(A, mainCards) {
  const t = new Map();
  for (const [c, q] of mainCards) { const k = A.info[c].type; t.set(k, (t.get(k) || 0) + q); }
  const tot = [...t.values()].reduce((s, x) => s + x, 0) || 1;
  return `<h4>By card type</h4><ul>${TYPE_ORDER.filter((k) => t.has(k)).map((k) => `<li><span>${TYPE_L[k]}</span><b>${t.get(k)}</b><span class="bar"><i style="width:${(100 * t.get(k) / tot).toFixed(1)}%"></i></span></li>`).join("")}</ul>`;
}

const resultText = (d) => /^top\s*\d+$/i.test(d.result || "") ? d.result.replace(/^top\s*/i, "Top ")
  : d.rank != null && d.wins == null && /^\d+\s*-\s*\d+$/.test(d.result || "") ? d.result.split("-").map((x) => ordinal(+x)).join("–") // a range: "5th–8th"
  : d.rank != null ? (d.ev.tier === "league" ? "5-0" : ordinal(d.rank)) : d.wins != null ? `${d.wins}-${d.losses}` : (d.result || "—");
let moreState = null;
function listsTable(list, { limit = 30, showArch = false, showEvent = true } = {}) {
  if (!list.length) return empty("No lists", "");
  const row = (d) => `<a class="lrow" href="${listLink(d.id)}">
    <span class="l-date">${dShort(d.ev.date)}</span>
    <span class="l-main">${showArch ? `<b>${pips(d.colors)} ${esc(d.arch)}</b>` : `<b>${esc(d.player || "—")}</b>`}
      <span class="l-sub">${showArch ? esc(d.player || "—") : ""}${showEvent ? `${showArch ? " · " : ""}${esc(d.ev.name)}` : ""}</span></span>
    <span class="l-ev">${sizeBadge(d.ev)}</span>
    <span class="l-res">${esc(resultText(d))}</span>
    <span class="l-pts" title="Result points: log₂(players ÷ placement)">${NF1.format(d.pts)}<small>pts</small></span>
  </a>`;
  moreState = { list, row };
  return `<div class="ltable">${list.slice(0, limit).map(row).join("")}
    ${list.length > limit ? `<div class="meta-foot"><button class="btn" data-more>Show ${Math.min(list.length - limit, 100)} more</button></div>` : ""}</div>`;
}
function bindMore() {
  $$("[data-more]").forEach((b) => b.addEventListener("click", () => {
    const wrap = b.closest(".ltable"), shown = $$(".lrow", wrap).length;
    const { list, row } = moreState;
    b.parentElement.insertAdjacentHTML("beforebegin", list.slice(shown, shown + 100).map(row).join(""));
    const left = list.length - $$(".lrow", wrap).length;
    if (left <= 0) b.parentElement.remove(); else b.textContent = `Show ${Math.min(left, 100)} more`;
  }));
}

/* ---------- a single list ---------- */
async function renderList(id, opts) {
  const D = state.D;
  const base = D.byId.get(id);
  if (!base) return view(`<div class="wrap">${empty("List not found", "It may be older than the loaded period.")}</div>`, opts);
  const A = await loadArch(base.arch);
  const d = A.byId.get(id);
  // compare with the VARIANT the list belongs to, when the deck splits into variants
  let peers = A.decks;
  const myVar = archVariants(A).of?.get(d.id);
  if (myVar) peers = myVar.decks;
  const refLabel = myVar ? `${esc(d.arch)} (${esc(myVar.name)})` : esc(d.arch);
  const pm = new Map(composition(peers, "main").map((s) => [s.card, s]));
  const ps = new Map(composition(peers, "side").map((s) => [s.card, s]));
  const agg = aggregate(composition(peers, "main"), deckSize(peers, "main"));
  // artwork: the card that defines the list's variant, otherwise the deck's own signature card
  const vKey = myVar?.plus.find((p) => A.info[p.card].art && A.info[p.card].type !== "Land");
  const art = vKey ? A.info[vKey.card] : archArt(d.arch);
  const odd = (c, m) => (m.get(c)?.incl ?? 0) < 0.15;
  const groups = new Map();
  for (const [c, q] of cardsOf(d.main)) { const t = TYPE_ORDER.includes(A.info[c].type) ? A.info[c].type : "Other"; if (!groups.has(t)) groups.set(t, []); groups.get(t).push([c, q]); }
  const sortL = (l) => l.sort((a, b) => b[1] - a[1] || A.info[a[0]].cmc - A.info[b[0]].cmc);
  const vis = TYPE_ORDER.filter((t) => groups.has(t)).map((t) => { const l = sortL(groups.get(t)); return `<div class="vd-group"><h4>${TYPE_L[t]} · ${l.reduce((s, x) => s + x[1], 0)}</h4><div class="vd-grid">${l.map(([c, q]) => tile(A, c, q, `${pct0(pm.get(c)?.incl ?? 0)} of lists`, odd(c, pm) ? "odd" : "")).join("")}</div></div>`; });
  if (d.side.length) { const l = sortL(cardsOf(d.side)); vis.push(`<div class="vd-group"><h4>Sideboard · ${total(d.side)}</h4><div class="vd-grid">${l.map(([c, q]) => tile(A, c, q, `${pct0(ps.get(c)?.incl ?? 0)} of lists`, odd(c, ps) ? "odd" : "")).join("")}</div></div>`); }
  const mine = new Map(cardsOf(d.main)), avgM = new Map(agg.cards.map(([c, q]) => [c, q]));
  const diffs = [];
  new Set([...mine.keys(), ...avgM.keys()]).forEach((c) => { const x = (mine.get(c) || 0) - (avgM.get(c) || 0); if (x) diffs.push([c, x]); });
  diffs.sort((a, b) => b[1] - a[1]);
  const ev = d.ev;
  view(`<section class="hero short">${art?.art ? `<img class="bg" src="${IMG(art.art, "art_crop")}" alt="">` : ""}
      <div class="hero-inner wrap">
        <nav class="crumbs"><a href="${fmtLink()}">${esc(D.format)}</a><span aria-hidden="true">/</span><a href="${archLink(d.arch)}">${esc(d.arch)}</a></nav>
        <h1>${esc(d.player || "Unknown player")}</h1>
        <p class="hero-sub">${esc(d.arch)}${myVar ? ` · <i>${esc(myVar.name)}</i>` : ""}</p>
        <div class="hero-stats">
          <div><b>${esc(resultText(d))}</b><span>result</span></div>
          <div><b>${NF1.format(d.pts)}</b><span>points</span></div>
          <div><b>${ev.players ? n0(ev.players) : "—"}</b><span>players</span></div>
        </div>
      </div>${credit(art)}</section>
    <div class="wrap deck-layout">
      <div class="visual-deck">${vis.join("")}
        <p class="note">Under each card: share of ${refLabel} lists playing it (${plural(peers.length, "list")}). Highlighted = unusual pick (under 15%).</p></div>
      <aside class="side-stack">
        <div class="panel"><dl class="facts">
          <div><dt>Event</dt><dd><a href="${evLink(ev.i)}">${esc(ev.name)}</a></dd></div>
          <div><dt>Date</dt><dd>${dLong(ev.date)}</dd></div>
          <div><dt>Size</dt><dd>${sizeBadge(ev)}</dd></div>
          <div><dt>Type</dt><dd>${ev.type === "paper" ? "Paper" : "Online"}</dd></div>
          <div><dt>Source</dt><dd>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(ev.source)} ↗</a>` : esc(ev.source)}</dd></div>
        </dl></div>
        <div class="panel"><h4 class="panel-h">Compared with the average list</h4><p class="note" style="margin:0 0 12px">of ${refLabel}</p>
          ${diffs.length ? `<div class="diff-list">${diffs.map(([c, x]) => `<div><span class="q ${x > 0 ? "plus" : "minus"}">${x > 0 ? "+" : "−"}${Math.abs(x)}</span><a href="${cardLink(A.cards[c])}" data-card="${c}">${esc(A.cards[c])}</a><span>${pct0(pm.get(c)?.incl ?? 0)}</span></div>`).join("")}</div>` : `<p class="muted" style="margin:0">Identical to the average list.</p>`}
        </div>
        <div class="panel curve">${curveHTML(A, cardsOf(d.main))}</div>
        <div class="btn-row"><button class="btn primary" data-copy="deck">Copy list</button><a class="btn" href="${archLink(d.arch)}">Deck analysis</a></div>
      </aside>
    </div>`, opts);
  $("[data-copy=deck]").addEventListener("click", (e) => copyList(A, cardsOf(d.main), cardsOf(d.side), e.currentTarget));
  document.title = `${d.arch} by ${d.player} · Metagame`;
}

/* ---------- card ---------- */
async function renderCard(name, opts) {
  const D = state.D;
  const chunk = await loadCardChunk(name);
  const key = Object.keys(chunk.cards).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return view(`<div class="wrap">${empty(esc(name), `This card doesn't appear in ${esc(D.format)} lists of the loaded period.`)}</div>`, opts);
  const c = chunk.cards[key];
  const ci = { type: c.info[0], cmc: c.info[1], mana: c.info[2], img: c.info[3], art: c.info[4], artist: c.info[5] };
  const wkey = `${state.f.days}${state.f.leagues ? "L" : ""}`;
  const w = c.w[wkey];
  const rows = w ? w.rows : [];
  view(`<div class="wrap">
    <section class="card-hero">
      <div class="card-hero-img">${cardImg(ci, key, { eager: true, sizes: "(max-width: 820px) 60vw, 300px" })}</div>
      <div>
        <div class="eyebrow">${esc(D.format)} · last ${state.f.days} days · ${state.f.leagues ? "leagues included" : "tournaments only"}</div>
        <h1 class="display sm">${esc(key)}</h1>
        <p class="card-meta">${manaCost(ci.mana, "lg")} <span class="muted">${esc(TYPE_L[ci.type] || "")}</span></p>
        <p class="lede">${w ? `Played in <b>${pct(w.lists / (w.total || 1))}</b> of ${esc(D.format)} lists, across <b>${plural(rows.length, "deck")}</b>.` : `Not played in the last ${state.f.days} days.`}</p>
        <p class="note">Card pages use the period and league settings; size and placement filters don't apply here.</p>
        <p><a class="link-more" href="https://scryfall.com/search?q=${enc('!"' + key + '"')}" target="_blank" rel="noopener">View on Scryfall ↗</a>${ci.artist ? ` <span class="muted" style="font-size:13px;margin-left:12px">Art by ${esc(ci.artist)}</span>` : ""}</p>
      </div>
    </section>
    ${rows.length ? `<section class="sec"><div class="sec-head"><div><h2>Where it's played</h2><p>For each deck: share of its lists playing the card in the main deck and in the sideboard.</p></div></div>
      <div class="flex-list">${rows.map((r) => { const a = chunk.archetypes[r[0]]; const art = archArt(a); return `<a class="card-arch" href="${archLink(a)}">
        <span class="thumbwrap">${art?.art ? `<img class="thumb" src="${IMG(art.art, "art_crop")}" alt="" loading="lazy" width="62" height="44">` : `<span class="thumb"></span>`}</span>
        <span class="nm"><b>${esc(a)}</b><span>${plural(r[1], "list")}${r[2] ? ` · ${(r[3] / r[2]).toFixed(1)} copies on average` : ""}</span></span>
        <span class="incl"><span class="bar"><i style="width:${(100 * r[2] / r[1]).toFixed(1)}%"></i></span><span class="v">${r[2] ? pct0(r[2] / r[1]) : "—"}</span></span>
        <span class="sidev">${r[4] ? `SB ${pct0(r[4] / r[1])}` : ""}</span></a>`; }).join("")}</div></section>` : ""}
  </div>`, opts);
  document.title = `${key} · ${D.format} · Metagame`;
}

/* ---------- about ---------- */
function renderAbout() {
  const M = state.meta, q = M.quality || {};
  const qRows = Object.entries(q).sort((a, b) => b[1] - a[1]);
  view(`<div class="wrap">
    <header class="page-head"><div class="eyebrow">Method, sources and credits</div><h1 class="display">How we collect and rank the data</h1>
      <p class="lede">One good data point is worth more than many. Here is where every number comes from, what we throw away, and why.</p></header>
    <article class="prose">
      <h2>Where the lists come from</h2>
      <p>Every 12 hours we collect tournaments from the original sources wherever we can:</p>
      <ul>
        <li><b>mtgo.com</b> — every MTGO Challenge, League and Showcase, read directly from the official Wizards site.</li>
        <li><b>magic.gg</b> — Wizards' premier events: Pro Tours, World Championship, Arena Championships, Regional Championships, Spotlight Series. Read directly.</li>
        <li><b><a href="https://topdeck.gg" target="_blank" rel="noopener">TopDeck.gg</a></b> — paper and webcam events (cEDH, Duel Commander, Legacy, Pauper…) through its official public API. Data provided by TopDeck.gg.</li>
        <li><b>Melee.gg</b>, <b>CardsRealm</b>, <b>GetPaird</b> — through the public MTGODecklistCache archive (Melee does not allow automated access to its site, so we use the archive's copy, updated weekly).</li>
        <li><b>MTGTop8</b> — local events worldwide.</li>
      </ul>
      <p> The archive currently holds <b>${n0(M.totals.decks)} lists</b> from <b>${n0(M.totals.tournaments)} tournaments</b>.</p>
      <h2>What we check — and reject</h2>
      <p>No source is trusted blindly. Every tournament and every list goes through these checks; everything we reject is listed, with the reason, in <a href="data/export/excluded.csv">excluded data.csv</a>.</p>
      <table><tr><th>Check</th><th>Rejected</th></tr>${qRows.map(([k, v]) => `<tr><td>${esc(k.charAt(0).toUpperCase() + k.slice(1))}</td><td>${n0(v)}</td></tr>`).join("")}</table>
      <p><b>Duplicate tournaments</b> are a real problem: MTGO reuses page addresses, so the same event can be published twice under two dates. We merge two events when at least 80% of their lists (same player, same 75 cards) coincide, they are the same kind of event with similar names, and we keep the best copy: first the one with placements (magic.gg publishes Worlds alphabetically, Melee with the final standings), then the one read directly from the organiser. When player names are written differently (“Rosdahl, Alexander”), eight or more identical 75s at the same event within three days are enough proof.</p>
      <p><b>Placements are never guessed.</b> magic.gg often publishes “top 32” pages without saying who finished where: those lists get “Top 32” and the points of 32nd place (the minimum they certainly earned). We write exact placements only when the page states the lists are in final standing order.</p>
      <p><b>Invalid lists</b>: main deck under 60 or over 90 cards, sideboard over 15, more than 4 copies of a non-basic card (singleton formats: 1), wrong Commander deck size. Card names are cleaned of set codes and collector numbers, and matched to Scryfall.</p>
      <p><b>Small events</b>: tournaments with fewer than <b>${M.min_players || 16} players</b> are left out when the number of players is known.</p>
      <h2>Event size</h2>
      <table><tr><th>Size</th><th>When</th></tr>
        <tr><td><span class="tier">${tierDot("large")}<b>Large</b></span></td><td>100+ players, or premier events (Pro Tour, Regional Championships, MTGO Showcases, Opens…)</td></tr>
        <tr><td><span class="tier">${tierDot("medium")}<b>Medium</b></span></td><td>32–99 players, or MTGO Challenges and qualifiers whose size we don't know</td></tr>
        <tr><td><span class="tier">${tierDot("small")}<b>Small</b></span></td><td>16–31 players</td></tr>
        <tr><td><span class="tier">${tierDot("league")}<b>MTGO League</b></span></td><td>a selection of 5-0 lists published by Wizards, no standings (can be switched off in the filters)</td></tr></table>
      <p><b>MTGO events are read directly from mtgo.com</b>, the official Wizards of the Coast site: we take the official player count, the final standings after the playoffs and each event's unique id (so the same event can never be counted twice). This also fixes real errors in third-party archives — in one Pauper Challenge, every placement was wrong there. For older Challenges collected before this change, the player count is unknown and we treat them as medium events.</p>
      <h2>Points and the results index</h2>
      <p>Each list earns points measuring <b>how rare its result is</b>: <code>points = log₂(players ÷ placement)</code>. Every point is a doubling of difficulty:</p>
      <table><tr><th>Result</th><th>Points</th></tr>
        <tr><td>Winning an 8-player event</td><td>3</td></tr><tr><td>Winning a 64-player event</td><td>6</td></tr>
        <tr><td>6th out of 407 players (Regional Championship)</td><td>≈ 6</td></tr><tr><td>8th out of 32</td><td>2</td></tr><tr><td>A 5-0 in an MTGO League</td><td>3</td></tr></table>
      <p>When the number of players is unknown we use cautious estimates: 64 for an MTGO Challenge, 48 for a qualifier, 256 for a premier event. A deck's <b>results index</b> is the sum of its points, scaled 0–100 against the best deck of the period.</p>
      <h2>Share of the metagame</h2>
      <p>The share of published lists. Many sources only publish the top finishers (top 8, top 32 or 5-0s), so share measures how often a deck <b>finishes high</b>, not how often it is played.</p>
      <h2>Core, flex and variants</h2>
      <p><b>Core</b>: cards in at least 90% of a deck's lists. <b>Flex</b>: 25–90%. <b>Occasional</b>: 6–25%. <b>Variants</b> are found automatically: we compare lists on their non-land flexible cards, group them with a clustering algorithm (k-medoids) and keep groups only when they are clearly distinct and large enough. Each variant is named after the card that best sets it apart. The <b>average list</b> takes the average copies of each card and rounds them to the typical deck size.</p>
      <h2>Archetypes</h2>
      <p>Decks are recognised with the community's public rules (MTGOFormatData) for Standard, Pioneer, Modern, Legacy, Vintage and Pauper. In Commander formats the deck is its commander. Lists no rule recognises are grouped by colours, e.g. “Izzet (Other)”.</p>
      <h2>Credits</h2>
      <p>Metagame is created by <b>Lorenzo Limongiello</b> — <a href="https://x.com/LorenzoLimongi1" target="_blank" rel="noopener">@LorenzoLimongi1 on X</a>. Card data and images by Scryfall; archetype rules by the MTGOFormatData contributors; tournament data from the organisers' platforms listed above.</p>
    </article></div>`);
  document.title = "How we collect and rank the data · Metagame";
}

/* ---------- interactions ---------- */
async function copyList(A, main, side, btn) {
  const txt = (l) => l.map(([c, q]) => `${q} ${A.cards[c]}`).join("\n");
  try {
    await navigator.clipboard.writeText(`${txt(main)}\n\nSideboard\n${txt(side)}`);
    const t = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = t), 1600);
  } catch (_) { btn.textContent = "Copy unavailable"; }
}
function enableSorting() { /* tables replaced by list rows: nothing to bind */ }
function bindSubnav() {
  $$(".subnav a").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); document.getElementById(a.getAttribute("href").slice(1))?.scrollIntoView({ behavior: "smooth" }); }));
}

/* card image preview on hover (desktop only) */
(function preview() {
  if (!matchMedia("(hover: hover)").matches) return;
  const box = $("#preview"), img = $("img", box);
  let cur = null;
  const hide = () => { box.classList.remove("on"); cur = null; };
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-card]");
    if (!el) { if (cur) hide(); return; }
    const A = state.archCache[`${state.slug}/${currentArch()}`];
    const ci = A?.info[+el.dataset.card];
    if (!ci?.img) return;
    cur = el; img.src = IMG(ci.img, "normal"); box.classList.add("on");
  });
  document.addEventListener("mousemove", (e) => {
    if (!cur) return;
    const w = 250, h = 349, pad = 18;
    let x = e.clientX + pad, y = e.clientY - h / 2;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    box.style.left = x + "px"; box.style.top = Math.max(8, Math.min(innerHeight - h - 8, y)) + "px";
  });
  window.addEventListener("hashchange", hide);
  window.addEventListener("scroll", hide, { passive: true });
})();
function currentArch() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[1] === "deck") return parts[2];
  if (parts[1] === "list") return state.D?.byId.get(+parts[2])?.arch;
  return null;
}

/* format picker */
function renderPicker() {
  const fmts = state.meta.formats;
  const main = fmts.filter((f) => f.decks >= 100), minor = fmts.filter((f) => f.decks < 100);
  const item = (f) => `<a role="menuitem" href="#/${f.slug}" class="${f.slug === state.slug ? "on" : ""}"><span>${esc(f.format)}</span><small>${n0(f.decks)} lists</small></a>`;
  $("#fmt-menu").innerHTML = main.map(item).join("") + (minor.length ? `<div class="menu-sep">More formats</div>${minor.map(item).join("")}` : "");
}
const fmtBtn = $("#fmt-btn"), fmtMenu = $("#fmt-menu");
const closeMenu = () => { fmtMenu.hidden = true; fmtBtn.setAttribute("aria-expanded", "false"); };
fmtBtn.addEventListener("click", (e) => { e.stopPropagation(); const open = fmtMenu.hidden; fmtMenu.hidden = !open; fmtBtn.setAttribute("aria-expanded", String(open)); });
fmtMenu.addEventListener("click", closeMenu);
document.addEventListener("click", (e) => { if (!e.target.closest(".picker")) closeMenu(); });

/* filter sheet */
const sheet = $("#sheet");
function syncFilters() {
  const f = state.f;
  $$("[data-filter=days] button").forEach((b) => b.classList.toggle("on", +b.dataset.v === f.days));
  $$("[data-filter=type] button").forEach((b) => b.classList.toggle("on", b.dataset.v === f.type));
  $$("[data-filter=place] button").forEach((b) => b.classList.toggle("on", b.dataset.v === f.place));
  $$("[data-filter=tiers] button").forEach((b) => { const on = f.tiers.has(b.dataset.v); b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  $("[data-filter=leagues]").setAttribute("aria-checked", String(f.leagues));
}
function openSheet() { syncFilters(); sheet.hidden = false; document.body.classList.add("locked"); setTimeout(() => $(".sheet-panel button.on, .sheet-panel button", sheet)?.focus(), 30); }
function closeSheet() { sheet.hidden = true; document.body.classList.remove("locked"); }
document.addEventListener("click", (e) => { if (e.target.closest("[data-open-filters]")) openSheet(); });
sheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) return closeSheet();
  const f = state.f;
  if (e.target.closest("[data-reset]")) { Object.assign(f, { ...DEFAULTS, tiers: new Set(DEFAULTS.tiers) }); }
  else {
    const b = e.target.closest("button[data-v], .switch"); if (!b) return;
    const g = b.closest("[data-filter]")?.dataset.filter || b.dataset.filter;
    if (g === "days") f.days = +b.dataset.v;
    else if (g === "type") f.type = b.dataset.v;
    else if (g === "place") f.place = b.dataset.v;
    else if (g === "leagues") f.leagues = !f.leagues;
    else if (g === "tiers") { if (f.tiers.has(b.dataset.v) && f.tiers.size > 1) f.tiers.delete(b.dataset.v); else f.tiers.add(b.dataset.v); }
  }
  saveFilters(); syncFilters(); route({ keepScroll: true });
});

/* search */
const searchBox = $("#search"), q = $("#q"), qOut = $("#q-results");
let searchIdx = null, searchSlug = null;
async function openSearch() {
  searchBox.hidden = false; document.body.classList.add("locked"); q.value = ""; qOut.innerHTML = `<p class="sr-hint">Type at least 2 letters.</p>`; q.focus();
  if (!state.D) { await loadMeta(); await loadFormat(state.meta.formats[0].slug); }
  if (searchSlug !== state.D.slug) { searchIdx = await getJSON(dataURL(`f/${state.D.slug}/search.json`)); searchSlug = state.D.slug; }
}
function closeSearch() { searchBox.hidden = true; document.body.classList.remove("locked"); }
$("#search-btn").addEventListener("click", openSearch);
searchBox.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSearch(); if (e.target.closest("a")) closeSearch(); });
q.addEventListener("input", () => {
  const s = q.value.trim().toLowerCase();
  if (s.length < 2 || !searchIdx) { qOut.innerHTML = `<p class="sr-hint">Type at least 2 letters.</p>`; return; }
  const archs = searchIdx.archetypes.filter(([a]) => a.toLowerCase().includes(s)).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const cards = searchIdx.cards.filter(([c]) => c.toLowerCase().includes(s))
    .sort((a, b) => (a[0].toLowerCase().startsWith(s) ? 0 : 1) - (b[0].toLowerCase().startsWith(s) ? 0 : 1) || b[1] - a[1]).slice(0, 8);
  let html = "";
  if (archs.length) html += `<div class="sr-head">Decks · ${esc(state.D.format)}</div>` + archs.map(([a, n]) => { const art = archArt(a); return `<a role="option" href="${archLink(a)}">${art?.art ? `<img src="${IMG(art.art, "art_crop")}" alt="">` : `<span class="ph"></span>`}<span>${esc(a)}</span><small>${n0(n)} lists</small></a>`; }).join("");
  if (cards.length) html += `<div class="sr-head">Cards · ${esc(state.D.format)}</div>` + cards.map(([c, n, art]) => `<a role="option" href="${cardLink(c)}">${art ? `<img src="${IMG(art, "art_crop")}" alt="">` : `<span class="ph"></span>`}<span>${esc(c)}</span><small>${n0(n)} lists</small></a>`).join("");
  qOut.innerHTML = html || `<p class="sr-hint">Nothing found in ${esc(state.D.format)}.</p>`;
});
q.addEventListener("keydown", (e) => {
  const opts = $$("a", qOut); if (!opts.length) return;
  let i = opts.findIndex((o) => o.getAttribute("aria-selected") === "true");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); i = (i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length; opts.forEach((o, j) => o.setAttribute("aria-selected", j === i)); opts[i].scrollIntoView({ block: "nearest" }); }
  else if (e.key === "Enter") { location.hash = opts[Math.max(i, 0)].getAttribute("href"); closeSearch(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeSearch(); closeSheet(); closeMenu(); }
  if (e.key === "/" && !e.target.closest("input")) { e.preventDefault(); openSearch(); }
});

/* theme */
$("#theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("mm-theme", next); } catch (_) { /* */ }
});

/* ---------- router ---------- */
async function route(opts = {}) {
  try {
    await loadMeta();
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    const fmts = state.meta.formats;
    if (!parts[0] || parts[0] === "about") {
      fmtBtn.hidden = true; $(".masthead").classList.remove("has-fmt");
      return parts[0] ? renderAbout() : renderHome();
    }
    const f = fmts.find((x) => x.slug === parts[0]);
    if (!f) { location.replace("#/"); return; }
    if (state.slug !== f.slug || !state.D) {
      if (!opts.keepScroll) $("#app").innerHTML = `<div class="loading"><span></span></div>`;
      state.showAll = false;
      await loadFormat(f.slug);
    }
    fmtBtn.hidden = false; $(".masthead").classList.add("has-fmt"); $("#fmt-label").textContent = f.format; renderPicker();
    const [, kind, arg] = parts;
    if (kind === "deck") await renderArch(arg, opts);
    else if (kind === "list") await renderList(+arg, opts);
    else if (kind === "card") await renderCard(arg, opts);
    else if (kind === "tournaments") renderEvents(opts);
    else if (kind === "event") renderEvent(+arg, opts);
    else if (kind === "cards") renderCards(opts);
    else renderFormat(opts);
  } catch (e) {
    console.error(e);
    view(`<div class="wrap">${empty("Something went wrong", `We couldn't load the data (${esc(e.message)}). Please try again in a moment.`)}</div>`);
  }
}
window.addEventListener("hashchange", () => { closeSheet(); closeSearch(); route(); });
route();
