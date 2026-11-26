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
SOURCE_PRIORITY = {"mtgo.com": 0, "magic.gg": 0, "melee.gg": 1, "topdeck.gg": 2, "GetPaird": 3, "CardsRealm": 3, "mtgtop8.com": 9}


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
    of the same format on a nearby date. Keeps the more complete copy; between equally complete copies,
    the one read directly from the organiser, then the most authoritative source.

    Player names are not always written the same way across sources ("Rosdahl, Alexander", nicknames):
    when at least 8 lists coincide card for card (same 75) within 3 days, the same kind of event, that is
    enough - eight identical 75s cannot be a coincidence."""
    by_fmt = collections.defaultdict(list)
    for t in tournaments:
        by_fmt[t["format"]].append(t)
    dropped = set()
    log = []
    for fmt, group in by_fmt.items():
        sigs = {id(t): {sig_of(t, d) for d in t["decks"]} for t in group}
        cards = {id(t): {sig_of(t, {**d, "player": None}) for d in t["decks"]} for t in group}
        index = collections.defaultdict(set)  # signature -> tournaments containing it
        cindex = collections.defaultdict(set)  # 75 without the player -> tournaments
        for t in group:
            for s in sigs[id(t)]:
                index[s].add(id(t))
            for s in cards[id(t)]:
                cindex[s].add(id(t))
        by_id = {id(t): t for t in group}
        for t in group:
            if id(t) in dropped or not sigs[id(t)]:
                continue
            overlap = collections.Counter()
            for s in sigs[id(t)]:
                for o in index[s]:
                    if o != id(t) and o not in dropped:
                        overlap[o] += 1
            coverlap = collections.Counter()
            for s in cards[id(t)]:
                for o in cindex[s]:
                    if o != id(t) and o not in dropped:
                        coverlap[o] += 1
            for o in set(overlap) | set(coverlap):
                u = by_id[o]
                small, big = (t, u) if len(sigs[id(t)]) <= len(sigs[o]) else (u, t)
                days = abs((_d(t["date"]) - _d(u["date"])).days)
                n = overlap[o]
                same_players = n / max(1, len(sigs[id(small)])) >= 0.8
                same_75s = (coverlap[o] >= 8 and days <= 3 and t["source"] != u["source"]
                            and coverlap[o] / max(1, len(cards[id(small)])) >= 0.8)
                if not same_players and not same_75s:
                    continue
                # regulars play the same 75 every week: only merge if the dates are close,
                # or if so many identical lists coincide that it cannot be chance
                if same_players and not same_75s and days > 3 and n < 16:
                    continue
                # same kind of event (a League is never "the same" as a Challenge, even when the same
                # players used the same 75 in both); names must look alike unless the 75s prove it
                if _kind(t) != _kind(u) or not (same_75s or _similar_names(t["name"], u["name"])):
                    continue
                def rank(x):
                    # the copy with placements first (an alphabetical list loses information), then the one
                    # read directly from the organiser, the most authoritative source, the id with its own date
                    placed = sum(1 for d in x["decks"] if d.get("result")) >= 0.5 * len(x["decks"])
                    own = x["date"] in x["id"] or x["date"].replace("-", "") in x["id"]
                    return (not placed, x.get("via") != "direct", SOURCE_PRIORITY.get(x["source"], 5), not own)
                # prefer the better source only when it is (almost) as complete as the other copy
                if len(sigs[id(small)]) >= 0.9 * len(sigs[id(big)]) and rank(small) < rank(big):
                    small, big = big, small
                dropped.add(id(small))
                log.append((small["id"], big["id"], len(sigs[id(small)])))
                if small is t:
                    break
    return [t for t in tournaments if id(t) not in dropped], log
