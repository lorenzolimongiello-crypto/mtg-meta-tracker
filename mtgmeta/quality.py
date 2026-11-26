"""Data quality gate. Every list and every tournament passes through here before it is counted.

Nothing is trusted blindly, whatever the source:
  - duplicated tournaments (the same event published twice, e.g. MTGO recycling URLs) are merged;
  - invalid lists (wrong deck size, too many copies...) are excluded from the statistics;
  - tournaments below the minimum size are excluded.
Every exclusion is counted with its reason and published (data/export/excluded.csv) for transparency.
"""
from __future__ import annotations

import collections
import datetime as dt
import difflib
import re

from .util import card_key


def _d(iso: str) -> dt.date:
    return dt.date.fromisoformat(iso[:10])


# lower = more authoritative (the organiser's own platform first, aggregators last)
SOURCE_PRIORITY = {"mtgo.com": 0, "melee.gg": 1, "topdeck.gg": 2, "GetPaird": 3, "CardsRealm": 3, "mtgtop8.com": 9}


def _kind(t: dict) -> str:
    n = t["name"].lower()
    if "league" in n:
        return "league"
    if "challenge" in n:
        return "challenge"
    return "other"


def _norm_name(s: str) -> str:
    s = s.split(" @ ")[0].lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _similar_names(a: str, b: str) -> bool:
    a, b = _norm_name(a), _norm_name(b)
    if not a or not b or a in b or b in a:
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.6

MIN_PLAYERS = 16
SINGLETON_FORMATS = {"Duel Commander", "Commander", "cEDH", "Pauper Commander", "Oathbreaker", "Brawl",
                     "Canadian Highlander", "Highlander"}
# cards that allow any number of copies
ANY_NUMBER = {"relentless rats", "shadowborn apostle", "persistent petitioners", "rat colony", "dragon's approach",
              "slime against humanity", "hare apparent", "templar knight", "cid, timeless artificer",
              "tempest hawk", "nazgul", "seven dwarves"}
ANY_NUMBER_LIMIT = {"seven dwarves": 7, "nazgul": 9}


def _is_basic(key: str, cards: dict) -> bool:
    c = cards.get(key) or {}
    return "Basic" in (c.get("type_line") or "") or key in {"wastes"} or key.startswith("snow-covered ")


def deck_problem(fmt: str, main: list, side: list, cards: dict) -> str | None:
    """Returns the reason why a list is invalid, or None if it looks legal."""
    m = sum(q for q, _ in main)
    s = sum(q for q, _ in side)
    if fmt in SINGLETON_FORMATS:
        if not 98 <= m + s <= 102:
            return "commander deck size"
        limit = 1
    else:
        if m < 60:
            return "main deck under 60 cards"
        if m > 90:
            return "main deck over 90 cards"
        if s > 15:
            return "sideboard over 15 cards"
        limit = 4
    totals = collections.Counter()
    for q, n in main + side:
        totals[card_key(n)] += q
    for k, q in totals.items():
        if q > limit and not _is_basic(k, cards):
            if k in ANY_NUMBER and q <= ANY_NUMBER_LIMIT.get(k, 999):
                continue
            return f"more than {limit} copies of a card"
    return None


def deck_signature(player: str | None, main: list, side: list) -> tuple:
    c = collections.Counter()
    for q, n in main:
        c[("m", card_key(n))] += q
    for q, n in side:
        c[("s", card_key(n))] += q
    return ((player or "").strip().lower(), tuple(sorted(c.items())))


def merge_duplicate_tournaments(tournaments: list[dict], sig_of) -> tuple[list[dict], list[tuple]]:
    """Drops a tournament when >= 80% of its lists (same player, same 75) appear in another tournament
    of the same format on a nearby date. Keeps the larger one (ties: the one whose id carries its own date)."""
    by_fmt = collections.defaultdict(list)
    for t in tournaments:
        by_fmt[t["format"]].append(t)
    dropped = set()
    log = []
    for fmt, group in by_fmt.items():
        sigs = {id(t): {sig_of(t, d) for d in t["decks"]} for t in group}
        index = collections.defaultdict(set)  # signature -> tournaments containing it
        for t in group:
            for s in sigs[id(t)]:
                index[s].add(id(t))
        by_id = {id(t): t for t in group}
        for t in group:
            if id(t) in dropped or not sigs[id(t)]:
                continue
            overlap = collections.Counter()
            for s in sigs[id(t)]:
                for o in index[s]:
                    if o != id(t) and o not in dropped:
                        overlap[o] += 1
            for o, n in overlap.items():
                u = by_id[o]
                small, big = (t, u) if len(sigs[id(t)]) <= len(sigs[o]) else (u, t)
                if n / max(1, len(sigs[id(small)])) < 0.8:
                    continue
                # regulars play the same 75 every week: only merge if the dates are close,
                # or if so many identical lists coincide that it cannot be chance
                days = abs((_d(t["date"]) - _d(u["date"])).days)
                if days > 3 and n < 16:
                    continue
                # same kind of event and similar names: a League is never "the same" as a Challenge,
                # even when the same players used the same 75 in both
                if _kind(t) != _kind(u) or not _similar_names(t["name"], u["name"]):
                    continue
                def rank(x):
                    # read directly from the organiser's site first, then the most authoritative source,
                    # then the copy whose id carries its own date
                    own = x["date"] in x["id"] or x["date"].replace("-", "") in x["id"]
                    return (x.get("via") != "direct", SOURCE_PRIORITY.get(x["source"], 5), not own)
                direct_pair = (small.get("via") == "direct") != (big.get("via") == "direct")
                if (direct_pair or len(sigs[id(small)]) == len(sigs[id(big)])) and rank(small) < rank(big):
                    small, big = big, small
                dropped.add(id(small))
                log.append((small["id"], big["id"], len(sigs[id(small)])))
                if small is t:
                    break
    return [t for t in tournaments if id(t) not in dropped], log
