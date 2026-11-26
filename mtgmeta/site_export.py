"""Site data, split so that every page downloads only what it needs (mobile first).

data/f/<format>/index.json      events + light deck rows (no cards) + archetypes + card trends
data/f/<format>/a/<arch>.json   the lists of ONE archetype (cards included) -> archetype & deck pages
data/f/<format>/c/<x>.json      precomputed card stats (7/30/90 days), chunked by first character
data/f/<format>/search.json     names for the search box (archetypes + cards)

Light deck rows keep every filter (period, online/paper, tournament size, leagues, placement)
computable in the browser, instantly.
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

from .util import slugify

WINDOWS = (7, 30, 90)


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def _chunk_key(name: str) -> str:
    c = slugify(name)[:1]
    return c if c.isalnum() else "_"


def _signature_card(mains: list, fmt_incl: Counter, n_fmt: int, card_info: list) -> int | None:
    """The card that best represents an archetype: played a lot there, little elsewhere (no lands)."""
    cnt = Counter()
    for main in mains:
        cnt.update(main[::2])
    n = len(mains)
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


def export(site: Path, db: sqlite3.Connection, card_names: list[str], card_info: list[dict], site_days: int) -> list[dict]:
    since = (dt.date.today() - dt.timedelta(days=site_days)).isoformat()
    formats = []
    for (fmt,) in db.execute("SELECT DISTINCT format FROM tournaments WHERE date >= ?", (since,)).fetchall():
        evs = db.execute("""SELECT id, name, date, type, source, url, players, kind, tier FROM tournaments
                            WHERE format=? AND date>=? ORDER BY date DESC""", (fmt, since)).fetchall()
        ev_idx = {e[0]: i for i, e in enumerate(evs)}
        decks = db.execute("""SELECT d.id, d.tournament_id, d.player, d.result, d.rank, d.wins, d.losses,
                                     d.archetype, d.colors, d.points, d.url
                              FROM decks d JOIN tournaments t ON t.id=d.tournament_id
                              WHERE t.format=? AND t.date>=?""", (fmt, since)).fetchall()
        if not decks:
            continue
        slug = slugify(fmt)
        base = site / "data" / "f" / slug
        max_date = max(e[2] for e in evs)

        cards_by_deck = defaultdict(lambda: ([], []))
        ids = [d[0] for d in decks]
        for i in range(0, len(ids), 900):
            chunk = ids[i:i + 900]
            q = f"SELECT deck_id, card_id, board, qty FROM deck_cards WHERE deck_id IN ({','.join('?' * len(chunk))})"
            for did, c, b, qty in db.execute(q, chunk):
                cards_by_deck[did][0 if b == "main" else 1].extend((c, qty))

        archs = sorted({d[7] for d in decks})
        a_idx = {a: i for i, a in enumerate(archs)}
        a_slug = {a: slugify(a) for a in archs}

        # visual signature of each archetype
        fmt_incl = Counter()
        mains_by_arch = defaultdict(list)
        for d in decks:
            m = cards_by_deck[d[0]][0]
            fmt_incl.update(m[::2])
            mains_by_arch[d[7]].append(m)
        arch_rows = []
        for a in archs:
            c = _signature_card(mains_by_arch[a], fmt_incl, len(decks), card_info)
            ci = card_info[c - 1] if c else {}
            arch_rows.append({"n": a, "s": a_slug[a], "art": ci.get("art"), "artist": ci.get("artist"),
                              "card": card_names[c - 1] if c else None})

        # 1) index: light deck rows
        index = {
            "format": fmt, "maxDate": max_date,
            "events": [list(e) for e in evs],
            "archetypes": arch_rows,
            # [id, event, player, result, rank, wins, losses, archetype, colors, points]
            "decks": [[d[0], ev_idx[d[1]], d[2], d[3], d[4], d[5], d[6], a_idx[d[7]], d[8], d[9]] for d in decks],
            "trends": _trends(decks, evs, ev_idx, cards_by_deck, card_names, card_info, max_date),
        }
        _write(base / "index.json", index)

        # 2) one file per archetype, with its own small card table
        by_arch = defaultdict(list)
        for d in decks:
            by_arch[d[7]].append(d)
        for a, lst in by_arch.items():
            used = sorted({c for d in lst for c in cards_by_deck[d[0]][0][::2] + cards_by_deck[d[0]][1][::2]})
            remap = {c: i for i, c in enumerate(used)}
            rows = []
            for d in lst:
                m, s = cards_by_deck[d[0]]
                rows.append([d[0], d[10],
                             [remap[x] if j % 2 == 0 else x for j, x in enumerate(m)],
                             [remap[x] if j % 2 == 0 else x for j, x in enumerate(s)]])
            _write(base / "a" / f"{a_slug[a]}.json", {
                "archetype": a,
                "cards": [card_names[c - 1] for c in used],
                # [type, cmc, mana, img, art, artist]
                "info": [[card_info[c - 1].get(k) for k in ("type", "cmc", "mana", "img", "art", "artist")] for c in used],
                "decks": rows,
            })

        # 3) card stats per window, chunked by first character
        _card_files(base, decks, evs, ev_idx, cards_by_deck, card_names, card_info, archs, a_idx, max_date)

        # 4) search names
        cnt = Counter(d[7] for d in decks)
        all_cards = Counter()
        for m, s in cards_by_deck.values():
            all_cards.update(set(m[::2]) | set(s[::2]))
        _write(base / "search.json", {
            "archetypes": [[a, cnt[a]] for a in archs],
            "cards": [[card_names[c - 1], n, card_info[c - 1].get("art")] for c, n in all_cards.most_common()],
        })

        # home summary: top archetypes of the last 30 days
        recent_since = (dt.date.fromisoformat(max_date) - dt.timedelta(days=29)).isoformat()
        recent = [d for d in decks if evs[ev_idx[d[1]]][2] >= recent_since and evs[ev_idx[d[1]]][8] != "league"]
        share = Counter(d[7] for d in recent)
        top = []
        for a, n in share.most_common(5):
            r = arch_rows[a_idx[a]]
            top.append({"name": a, "share": round(n / len(recent), 4), "decks": n, "art": r["art"], "artist": r["artist"],
                        "colors": Counter(d[8] for d in recent if d[7] == a).most_common(1)[0][0]})
        formats.append({"format": fmt, "slug": slug, "decks": len(decks), "events": len(evs), "last": max_date,
                        "tiers": dict(Counter(e[8] for e in evs)), "top": top})
    formats.sort(key=lambda f: -f["decks"])
    return formats


def _window_decks(decks, evs, ev_idx, max_date, days, offset=0, leagues=False):
    to = dt.date.fromisoformat(max_date) - dt.timedelta(days=offset * days)
    frm = (to - dt.timedelta(days=days - 1)).isoformat()
    to = to.isoformat()
    return [d for d in decks if frm <= evs[ev_idx[d[1]]][2] <= to and (leagues or evs[ev_idx[d[1]]][8] != "league")]


def _trends(decks, evs, ev_idx, cards_by_deck, card_names, card_info, max_date):
    """Cards gaining/losing ground: share of lists playing them (main), last 30 days vs the 30 before.
    Plus the format staples (useful to newcomers). Tournaments only (no leagues)."""
    def incl(ds):
        c = Counter()
        for d in ds:
            c.update(set(cards_by_deck[d[0]][0][::2]))
        return c, max(1, len(ds))
    now, prev = _window_decks(decks, evs, ev_idx, max_date, 30), _window_decks(decks, evs, ev_idx, max_date, 30, 1)
    cn, nn = incl(now)
    cp, np_ = incl(prev)
    def row(c):
        ci = card_info[c - 1]
        return [card_names[c - 1], ci.get("img"), round(cn[c] / nn, 4), round(cp[c] / np_, 4)]
    nonland = [c for c in set(cn) | set(cp) if card_info[c - 1].get("type") != "Land"]
    moves = sorted(nonland, key=lambda c: cn[c] / nn - cp[c] / np_)
    rising = [row(c) for c in reversed(moves) if cn[c] / nn - cp[c] / np_ >= 0.01][:12]
    falling = [row(c) for c in moves if cp[c] / np_ - cn[c] / nn >= 0.01][:12]
    staples = [row(c) for c, _ in cn.most_common() if card_info[c - 1].get("type") != "Land"][:24]
    return {"rising": rising, "falling": falling, "staples": staples, "decksNow": nn, "decksPrev": np_ if prev else 0}


def _card_files(base, decks, evs, ev_idx, cards_by_deck, card_names, card_info, archs, a_idx, max_date):
    out = defaultdict(dict)
    per = {}
    for w in WINDOWS:
        for leagues in (False, True):
            ds = _window_decks(decks, evs, ev_idx, max_date, w, leagues=leagues)
            arch_n = Counter(d[7] for d in ds)
            stat = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))  # card -> arch -> [main lists, main copies, side lists]
            anywhere = Counter()  # card -> lists playing it in main OR side
            for d in ds:
                m, s = cards_by_deck[d[0]]
                for i in range(0, len(m), 2):
                    r = stat[m[i]][d[7]]
                    r[0] += 1
                    r[1] += m[i + 1]
                for c in set(s[::2]):
                    stat[c][d[7]][2] += 1
                anywhere.update(set(m[::2]) | set(s[::2]))
            per[(w, leagues)] = (stat, arch_n, len(ds), anywhere)
    all_cards = set()
    for stat, _, _, _ in per.values():
        all_cards.update(stat)
    for c in all_cards:
        name = card_names[c - 1]
        ci = card_info[c - 1]
        entry = {"info": [ci.get(k) for k in ("type", "cmc", "mana", "img", "art", "artist")], "w": {}}
        for (w, leagues), (stat, arch_n, total, anywhere) in per.items():
            rows = stat.get(c)
            if not rows:
                continue
            entry["w"][f"{w}{'L' if leagues else ''}"] = {
                "total": total,
                "lists": anywhere[c],
                # [archetype index, archetype lists, main lists, main copies, side lists]
                "rows": sorted(([a_idx[a], arch_n[a], r[0], r[1], r[2]] for a, r in rows.items()), key=lambda x: -(x[2] + x[4])),
            }
        out[_chunk_key(name)][name] = entry
    for k, v in out.items():
        _write(base / "c" / f"{k}.json", {"archetypes": archs, "cards": v})
