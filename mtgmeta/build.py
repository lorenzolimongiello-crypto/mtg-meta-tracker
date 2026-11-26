"""Costruzione: archivio grezzo -> classificazione -> SQLite + CSV + JSON per il sito statico."""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import re
import shutil
import sqlite3
from collections import Counter, defaultdict

from . import scryfall
from .archetypes import Classifier
from .events import classify_event, points
from .store import ROOT, iter_tournaments
from .util import card_key, clean_card_list, front_name, parse_result, slugify

SITE = ROOT / "site"
WEB = ROOT / "web"
_LIMITED = re.compile(r"\blimited\b|\bdraft\b|\bsealed\b|\bcube\b", re.I)

SCHEMA = """
CREATE TABLE tournaments (
  id TEXT PRIMARY KEY, source TEXT, name TEXT, date TEXT, format TEXT, type TEXT, url TEXT,
  players INTEGER,          -- iscritti reali (NULL se non noti, es. Challenge MTGO / Leghe)
  kind TEXT,                -- league | challenge | premier | qualifier | local
  tier TEXT                 -- large | medium | small | league
);
CREATE TABLE decks (
  id INTEGER PRIMARY KEY, tournament_id TEXT REFERENCES tournaments(id),
  player TEXT, result TEXT, rank INTEGER, wins INTEGER, losses INTEGER,
  archetype TEXT, archetype_method TEXT, colors TEXT, source_archetype TEXT, url TEXT,
  points REAL               -- log2(giocatori / piazzamento): rarità del risultato (vedi mtgmeta/events.py)
);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE, type TEXT, type_line TEXT, cmc REAL, mana_cost TEXT,
  color_identity TEXT, rarity TEXT, scryfall_uri TEXT
);
CREATE TABLE deck_cards (
  deck_id INTEGER REFERENCES decks(id), card_id INTEGER REFERENCES cards(id),
  board TEXT CHECK(board IN ('main','side')), qty INTEGER
);
CREATE INDEX ix_dc_deck ON deck_cards(deck_id);
CREATE INDEX ix_dc_card ON deck_cards(card_id);
CREATE INDEX ix_decks_arch ON decks(archetype);
CREATE INDEX ix_t_fmt_date ON tournaments(format, date);

-- Vista "piatta": una riga per carta per lista, comoda per Excel / pandas
CREATE VIEW v_deck_cards AS
SELECT d.id AS deck_id, t.format, t.date, t.type AS event_type, t.tier, t.name AS event, d.player,
       d.result, d.rank, d.points, d.archetype, c.name AS card, c.type AS card_type, dc.board, dc.qty
FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
JOIN tournaments t ON t.id = d.tournament_id JOIN cards c ON c.id = dc.card_id;

-- Composizione degli archetipi (su tutto lo storico): % di liste che giocano la carta e copie medie
CREATE VIEW v_archetype_card_stats AS
WITH tot AS (
  SELECT t.format, d.archetype, COUNT(*) AS n
  FROM decks d JOIN tournaments t ON t.id = d.tournament_id GROUP BY 1, 2
)
SELECT t.format, d.archetype, c.name AS card, c.type AS card_type, dc.board,
       COUNT(*) AS decks_with_card, tot.n AS archetype_decks,
       ROUND(100.0 * COUNT(*) / tot.n, 1) AS inclusion_pct,
       ROUND(AVG(dc.qty), 2) AS avg_copies
FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
JOIN tournaments t ON t.id = d.tournament_id JOIN cards c ON c.id = dc.card_id
JOIN tot ON tot.format = t.format AND tot.archetype = d.archetype
GROUP BY t.format, d.archetype, c.name, dc.board;

-- Classifica archetipi per fascia di torneo
CREATE VIEW v_archetype_results AS
SELECT t.format, d.archetype, t.tier, COUNT(*) AS decks,
       SUM(d.rank = 1) AS wins, SUM(d.rank <= 8) AS top8, ROUND(SUM(d.points), 1) AS points
FROM decks d JOIN tournaments t ON t.id = d.tournament_id
GROUP BY t.format, d.archetype, t.tier;
"""


def _cache_bust() -> None:
    """style.css -> style.css?v=<hash>: ogni pubblicazione viene caricata subito dai browser."""
    index = SITE / "index.html"
    html = index.read_text(encoding="utf-8")
    for asset in ("style.css", "app.js"):
        h = hashlib.sha1((SITE / asset).read_bytes()).hexdigest()[:10]
        html = html.replace(f'"{asset}"', f'"{asset}?v={h}"')
    index.write_text(html, encoding="utf-8")


def _signature(main, side) -> str:
    items = sorted((card_key(n), q, b) for b, lst in (("m", main), ("s", side)) for q, n in lst)
    return hashlib.sha1(json.dumps(items).encode()).hexdigest()[:16]


def build(site_days: int = 90) -> None:
    clf = Classifier()
    if SITE.exists():
        shutil.rmtree(SITE)
    shutil.copytree(WEB, SITE)
    _cache_bust()
    (SITE / "data" / "formats").mkdir(parents=True)
    (SITE / "data" / "export").mkdir(parents=True)

    db = sqlite3.connect(SITE / "data" / "export" / "mtg-meta.sqlite")
    db.executescript(SCHEMA)

    card_ids: dict[str, int] = {}
    card_names: list[str] = []

    def cid(name: str) -> int:
        k = card_key(name)
        if k not in card_ids:
            card_ids[k] = len(card_names) + 1
            card_names.append(front_name(name))
        return card_ids[k]

    # MTGTop8 per ultimo: se una lista è già arrivata da Melee/MTGO la scartiamo come duplicato
    tournaments = sorted(iter_tournaments(), key=lambda t: (t["source"] == "mtgtop8.com", t["date"], t["id"]))
    seen_sig: dict[tuple, str] = {}
    stats = Counter()
    tiers = Counter()
    unclassified = defaultdict(Counter)
    deck_id = 0
    t_rows, d_rows, dc_rows = [], [], []

    for t in tournaments:
        if _LIMITED.search(t["name"]):
            stats["limited_scartati"] += 1
            continue
        prof = classify_event(t["source"], t["name"], t.get("players"), len(t["decks"]))
        kept = 0
        for d in t["decks"]:
            d["main"], d["side"] = clean_card_list(d["main"]), clean_card_list(d["side"])
            if not d["main"]:
                continue
            key = (t["format"], t["date"], _signature(d["main"], d["side"]))
            if key in seen_sig and seen_sig[key] != t["source"]:
                stats["duplicati"] += 1
                continue
            seen_sig[key] = t["source"]
            arch, method, colors = clf.classify(t["format"], d["main"], d["side"], d.get("source_archetype"))
            if method in ("colors", "source"):
                unclassified[t["format"]][arch] += 1
            stats[method] += 1
            rank, w, l = parse_result(d.get("result"))
            deck_id += 1
            kept += 1
            d_rows.append((deck_id, t["id"], d.get("player"), d.get("result"), rank, w, l, arch, method, colors,
                           d.get("source_archetype"), d.get("url"),
                           points(rank, w, l, prof["tier"], prof["players"], prof["kind"], t["name"])))
            agg: dict[tuple, int] = defaultdict(int)
            for board, lst in (("main", d["main"]), ("side", d["side"])):
                for q, n in lst:
                    agg[(cid(n), board)] += int(q)
            dc_rows.extend((deck_id, c, b, q) for (c, b), q in agg.items())
        if kept:
            tiers[prof["tier"]] += 1
            t_rows.append((t["id"], t["source"], t["name"], t["date"], t["format"], t["type"], t.get("url"),
                           prof["players"], prof["kind"], prof["tier"]))

    info = scryfall.enrich(card_names)
    used_keys = {card_key(n) for n in card_names}
    scryfall.save_cache({k: v for k, v in info.items() if k in used_keys})  # niente voci orfane
    card_info = [info.get(card_key(n), {}) for n in card_names]
    missing = [n for n, ci in zip(card_names, card_info) if ci.get("missing")]
    if missing:
        print(f"[build] {len(missing)} carte senza dati Scryfall (es. nomi non in inglese): {missing[:12]}")

    db.executemany("INSERT INTO tournaments VALUES (?,?,?,?,?,?,?,?,?,?)", t_rows)
    db.executemany("INSERT INTO decks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", d_rows)
    db.executemany("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?)", [
        (i + 1, n, ci.get("type"), ci.get("type_line"), ci.get("cmc"), ci.get("mana"), ci.get("colors"),
         ci.get("rarity"), ci.get("uri")) for i, (n, ci) in enumerate(zip(card_names, card_info))])
    db.executemany("INSERT INTO deck_cards VALUES (?,?,?,?)", dc_rows)
    db.commit()

    _export_csv(db)
    formats = _export_site_json(db, card_names, card_info, site_days)
    db.close()

    total = sum(v for k, v in stats.items() if k not in ("duplicati", "limited_scartati"))
    meta = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "site_days": site_days,
        "totals": {"tournaments": len(t_rows), "decks": total, "cards": len(card_names)},
        "tiers": dict(tiers),
        "classification": dict(stats),
        "formats": formats,
        "unclassified_top": {f: c.most_common(15) for f, c in unclassified.items()},
    }
    (SITE / "data" / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    pct = 100 * (stats["rule"] + stats["fallback"] + stats["commander"]) / max(total, 1)
    print(f"[build] {len(t_rows)} tornei, {total} liste, {len(card_names)} carte; "
          f"classificate da regole/fallback/commander: {pct:.1f}%  {dict(stats)}  fasce: {dict(tiers)}")
    if clf.unknown_condition_types:
        print(f"[warn] tipi di condizione sconosciuti: {clf.unknown_condition_types}")


def _export_csv(db: sqlite3.Connection) -> None:
    out = SITE / "data" / "export"
    queries = {
        "tournaments.csv": "SELECT * FROM tournaments ORDER BY date DESC",
        "decks.csv": """SELECT d.id AS deck_id, t.format, t.date, t.type AS event_type, t.tier, t.players, t.source,
                        t.name AS event, d.player, d.result, d.rank, d.wins, d.losses, d.points, d.archetype,
                        d.archetype_method, d.colors, d.url
                        FROM decks d JOIN tournaments t ON t.id=d.tournament_id ORDER BY t.date DESC""",
        "deck_cards.csv": """SELECT dc.deck_id, c.name AS card, c.type AS card_type, dc.board, dc.qty FROM deck_cards dc
                             JOIN cards c ON c.id = dc.card_id ORDER BY dc.deck_id""",
        "archetype_card_stats.csv": "SELECT * FROM v_archetype_card_stats ORDER BY format, archetype, board, inclusion_pct DESC",
        "archetype_results.csv": "SELECT * FROM v_archetype_results ORDER BY format, archetype, tier",
    }
    for fname, q in queries.items():
        cur = db.execute(q)
        with open(out / fname, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow([c[0] for c in cur.description])
            w.writerows(cur)


def _signature_card(arch_decks: list, fmt_incl: Counter, n_fmt: int, card_info: list) -> int | None:
    """La carta che più 'rappresenta' un archetipo: molto giocata lì, poco altrove (escluse le terre)."""
    cnt = Counter()
    for main in arch_decks:
        cnt.update(main[::2])
    n = len(arch_decks)
    best, best_s = None, -1.0
    for c, k in cnt.items():
        ci = card_info[c - 1]
        if ci.get("type") == "Land" or not ci.get("art"):
            continue
        incl = k / n
        if incl < 0.5:
            continue
        s = incl - fmt_incl[c] / n_fmt
        if s > best_s:
            best, best_s = c, s
    return best


def _export_site_json(db: sqlite3.Connection, card_names: list[str], card_info: list[dict], site_days: int) -> list[dict]:
    """Un JSON compatto per formato con le liste degli ultimi `site_days` giorni.

    Le statistiche (metagame, composizione, varianti, filtri) le calcola il browser: così i filtri
    sono istantanei e liberi, senza file precalcolati per ogni combinazione.
    """
    since = (dt.date.today() - dt.timedelta(days=site_days)).isoformat()
    formats = []
    for (fmt,) in db.execute("SELECT DISTINCT format FROM tournaments WHERE date >= ?", (since,)).fetchall():
        evs = db.execute("""SELECT id, name, date, type, source, url, players, kind, tier FROM tournaments
                            WHERE format=? AND date>=? ORDER BY date DESC""", (fmt, since)).fetchall()
        ev_idx = {e[0]: i for i, e in enumerate(evs)}
        decks = db.execute("""SELECT d.id, d.tournament_id, d.player, d.result, d.rank, d.wins, d.losses,
                                     d.archetype, d.archetype_method, d.colors, d.url, d.points
                              FROM decks d JOIN tournaments t ON t.id=d.tournament_id
                              WHERE t.format=? AND t.date>=?""", (fmt, since)).fetchall()
        if not decks:
            continue
        cards_by_deck = defaultdict(lambda: ([], []))
        ids = [d[0] for d in decks]
        for i in range(0, len(ids), 900):
            chunk = ids[i:i + 900]
            q = f"SELECT deck_id, card_id, board, qty FROM deck_cards WHERE deck_id IN ({','.join('?' * len(chunk))})"
            for did, c, b, qty in db.execute(q, chunk):
                cards_by_deck[did][0 if b == "main" else 1].extend((c, qty))
        used = sorted({c for m, s in cards_by_deck.values() for c in m[::2] + s[::2]})
        remap = {c: i for i, c in enumerate(used)}
        archs = sorted({d[7] for d in decks})
        a_idx = {a: i for i, a in enumerate(archs)}
        out_decks = []
        for d in decks:
            m, s = cards_by_deck[d[0]]
            out_decks.append([
                d[0], ev_idx[d[1]], d[2], d[3], d[4], d[5], d[6], a_idx[d[7]], d[8], d[9], d[10], d[11],
                [remap[x] if j % 2 == 0 else x for j, x in enumerate(m)],
                [remap[x] if j % 2 == 0 else x for j, x in enumerate(s)],
            ])
        cinfo = []
        for c in used:
            ci = card_info[c - 1]
            cinfo.append([ci.get("type", "Other"), ci.get("cmc", 0), ci.get("mana", ""), ci.get("img"),
                          ci.get("art"), ci.get("artist"), ci.get("colors", "")])

        # firma visiva di ogni archetipo (carta rappresentativa con illustrazione)
        fmt_incl = Counter()
        by_arch = defaultdict(list)
        for d in decks:
            m = cards_by_deck[d[0]][0]
            fmt_incl.update(m[::2])
            by_arch[d[7]].append(m)
        sig = {}
        for a, lst in by_arch.items():
            c = _signature_card(lst, fmt_incl, len(decks), card_info)
            if c is not None:
                sig[a] = remap[c]

        payload = {
            "format": fmt,
            "cards": [card_names[c - 1] for c in used],
            "cardFields": ["type", "cmc", "mana", "img", "art", "artist", "colors"],
            "cardInfo": cinfo,
            "archetypes": archs,
            "signature": {a: sig.get(a) for a in archs},
            "eventFields": ["id", "name", "date", "type", "source", "url", "players", "kind", "tier"],
            "events": [list(e) for e in evs],
            "deckFields": ["id", "event", "player", "result", "rank", "wins", "losses", "archetype", "method",
                           "colors", "url", "points", "main", "side"],
            "decks": out_decks,
        }
        slug = slugify(fmt)
        (SITE / "data" / "formats" / f"{slug}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

        # riepilogo per la home: archetipi principali degli ultimi 30 giorni
        recent_since = (dt.date.fromisoformat(evs[0][2]) - dt.timedelta(days=29)).isoformat()
        recent = [d for d in decks if evs[ev_idx[d[1]]][2] >= recent_since]
        share = Counter(d[7] for d in recent)
        top = []
        for a, n in share.most_common(5):
            s = sig.get(a)
            ci = card_info[used[s] - 1] if s is not None else {}
            top.append({"name": a, "share": round(n / len(recent), 4), "decks": n,
                        "art": ci.get("art"), "artist": ci.get("artist"), "colors": Counter(
                            d[9] for d in recent if d[7] == a).most_common(1)[0][0]})
        tier_counts = Counter(e[8] for e in evs)
        formats.append({"format": fmt, "slug": slug, "decks": len(decks), "events": len(evs),
                        "last": evs[0][2] if evs else None, "recentDecks": len(recent),
                        "tiers": dict(tier_counts), "top": top})
    formats.sort(key=lambda f: -f["decks"])
    return formats
