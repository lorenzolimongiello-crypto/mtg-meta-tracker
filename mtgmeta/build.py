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

from . import scryfall, site_export
from .archetypes import Classifier
from .events import classify_event, points
from .quality import MIN_PLAYERS, deck_problem, deck_signature, merge_duplicate_tournaments
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

    stats = Counter()
    tiers = Counter()
    unclassified = defaultdict(Counter)
    excluded: list[tuple] = []  # (level, reason, source, tournament_id, event, date, format, player)

    def exclude(level, reason, t, d=None):
        stats[f"excluded: {reason}"] += 1
        excluded.append((level, reason, t["source"], t["id"], t["name"], t["date"], t["format"],
                         (d or {}).get("player")))

    # 1) pulizia nomi + scarto Limited
    tournaments = []
    for t in iter_tournaments():
        if _LIMITED.search(t["name"]):
            exclude("tournament", "limited event", t)
            continue
        for d in t["decks"]:
            d["main"], d["side"] = clean_card_list(d["main"]), clean_card_list(d["side"])
        t["decks"] = [d for d in t["decks"] if d["main"]]
        if t["decks"]:
            tournaments.append(t)

    # 2) dati carte (servono per riconoscere le terre base nei controlli di validità)
    all_names = {n for t in tournaments for d in t["decks"] for _, n in d["main"] + d["side"]}
    cards_by_key = scryfall.enrich(sorted(all_names))

    # 3) tornei duplicati (stesso evento pubblicato due volte)
    tournaments, merged = merge_duplicate_tournaments(
        tournaments, lambda t, d: deck_signature(d.get("player"), d["main"], d["side"]))
    for small_id, big_id, n in merged:
        stats["excluded: duplicate tournament"] += 1
        excluded.append(("tournament", f"duplicate of {big_id}", "", small_id, "", "", "", None))

    # MTGTop8 per ultimo: se una lista è già arrivata da Melee/MTGO la scartiamo come duplicato
    tournaments.sort(key=lambda t: (t["source"] == "mtgtop8.com", t["date"], t["id"]))
    seen_sig: dict[tuple, str] = {}
    deck_id = 0
    t_rows, d_rows, dc_rows = [], [], []

    for t in tournaments:
        prof = classify_event(t["source"], t["name"], t.get("players"), len(t["decks"]))
        # 4) soglia minima di partecipanti (solo quando il numero è noto)
        if prof["players_known"] and prof["players"] and prof["players"] < MIN_PLAYERS:
            exclude("tournament", f"fewer than {MIN_PLAYERS} players", t)
            continue
        kept = 0
        for d in t["decks"]:
            # 5) validità della lista
            problem = deck_problem(t["format"], d["main"], d["side"], cards_by_key)
            if problem:
                exclude("list", problem, t, d)
                continue
            key = (t["format"], t["date"], _signature(d["main"], d["side"]))
            if key in seen_sig and seen_sig[key] != t["source"]:
                stats["excluded: same list from another source"] += 1
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

    info = scryfall.enrich(card_names, cards_by_key)
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
    formats = site_export.export(SITE, db, card_names, card_info, site_days)
    db.close()

    with open(SITE / "data" / "export" / "excluded.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["level", "reason", "source", "tournament_id", "event", "date", "format", "player"])
        w.writerows(excluded)

    total = len(d_rows)
    quality = {k[len("excluded: "):]: v for k, v in stats.items() if k.startswith("excluded: ")}
    meta = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "site_days": site_days,
        "totals": {"tournaments": len(t_rows), "decks": total, "cards": len(card_names)},
        "tiers": dict(tiers),
        "classification": {k: v for k, v in stats.items() if not k.startswith("excluded")},
        "quality": quality,
        "min_players": MIN_PLAYERS,
        "formats": formats,
        "unclassified_top": {f: c.most_common(15) for f, c in unclassified.items()},
    }
    (SITE / "data" / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    pct = 100 * (stats["rule"] + stats["fallback"] + stats["commander"]) / max(total, 1)
    print(f"[build] {len(t_rows)} tornei, {total} liste, {len(card_names)} carte; "
          f"classificate da regole/fallback/commander: {pct:.1f}%  fasce: {dict(tiers)}")
    print(f"[quality] escluse/unite: {quality}")
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
