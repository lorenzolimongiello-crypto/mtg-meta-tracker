"""Source: mtgo.com — the official Wizards of the Coast decklist pages, read directly.

Why direct instead of the intermediate archive:
  - each event page embeds the official JSON: real number of players (`player_count`), official
    start time, final standings after the playoffs, W-L records, full decklists;
  - every event has a unique id (`event_id`, or `instance_id` for Leagues), so the same tournament
    can never be stored twice;
  - MTGO sometimes REUSES page addresses for later events: we detect it (start date ≠ date in the
    address) and store the content under the event it really is.

Politeness: no robots.txt restrictions are published; we still make ~1 request per second,
identify ourselves, and only fetch pages we have not stored yet.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import time

from ..store import save_tournament
from ..util import http_get
from . import normalize_format

BASE = "https://www.mtgo.com"
DELAY = 1.0
UA = {"User-Agent": "Mozilla/5.0 (compatible; MetagameDataCollector/1.0)"}
_DATA = re.compile(r"window\.MTGO\.decklists\.data\s*=\s*(\{.*?\});\s*\n", re.S)
_SLUG = re.compile(r'/decklist/([a-z0-9-]+)')
_SLUG_DATE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')} Place"


def _cards(lst: list) -> list:
    out = []
    for c in lst or []:
        name = (c.get("card_attributes") or {}).get("card_name")
        if name:
            out.append([int(c.get("qty") or 0), name])
    return out


def parse_event(slug: str, data: dict) -> dict | None:
    """Official JSON -> our tournament format. Returns None for empty pages."""
    decks_raw = data.get("decklists") or []
    if not decks_raw:
        return None
    is_league = "instance_id" in data or "publish_date" in data
    name = data.get("description") or data.get("name") or slug
    date = (data.get("starttime") or data.get("publish_date") or "")[:10]
    if not date:
        return None
    fmt = normalize_format(None, name)
    if fmt is None:
        return None
    players = None
    if not is_league:
        try:
            players = int((data.get("player_count") or {}).get("players") or 0) or None
        except (TypeError, ValueError):
            players = None
    final = {f.get("loginid"): int(f["rank"]) for f in data.get("final_rank") or [] if f.get("rank")}
    swiss = {s.get("loginid"): int(s["rank"]) for s in data.get("standings") or [] if s.get("rank")}
    records = {w.get("loginid"): (w.get("wins"), w.get("losses")) for w in data.get("winloss") or []}
    decks = []
    for d in decks_raw:
        main = _cards(d.get("main_deck"))
        if not main:
            continue
        side = _cards(d.get("sideboard_deck"))
        lid = d.get("loginid")
        if is_league:
            w = d.get("wins") or {}
            result = f"{w.get('wins', '?')}-{w.get('losses', '?')}"
        else:
            rank = final.get(lid) or swiss.get(lid)
            result = _ordinal(rank) if rank else "-".join(str(x) for x in records.get(lid, ()) if x is not None) or None
        decks.append({
            "player": d.get("player"), "result": result,
            "url": f"{BASE}/decklist/{slug}#deck_{d.get('player')}",
            "source_archetype": None, "main": main, "side": side,
        })
    if not decks:
        return None
    event_key = data.get("instance_id") or data.get("event_id") or slug
    return {
        "id": f"mtgo:{event_key}", "source": "mtgo.com", "via": "direct", "name": name, "date": date,
        "format": fmt, "type": "online", "url": f"{BASE}/decklist/{slug}",
        "players": players, "players_official": players is not None,
        "decks": decks,
    }


def _months(since: dt.date, until: dt.date):
    y, m = since.year, since.month
    while (y, m) <= (until.year, until.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def fetch(state: dict, days: int = 3, max_pages: int = 600) -> int:
    seen: dict = state.setdefault("mtgo_direct", {})  # slug -> "event id" | "empty:<date>"
    today = dt.date.today()
    since = today - dt.timedelta(days=days)
    budget = max_pages
    slugs = []
    for y, m in _months(since, today):
        found = []
        for attempt in range(3):  # an index page without links is an error, never "no events"
            try:
                html = http_get(f"{BASE}/decklists/{y}/{m:02d}", headers=UA).decode("utf-8", "replace")
                found = list(dict.fromkeys(_SLUG.findall(html)))
            except Exception as e:  # noqa: BLE001
                print(f"[mtgo] listing {y}/{m:02d} attempt {attempt + 1} failed: {e}")
            if found:
                break
            time.sleep(5 * (attempt + 1))
        if not found:
            print(f"[mtgo] WARNING: listing {y}/{m:02d} returned no events after 3 attempts")
        for s in found:
            md = _SLUG_DATE.search(s)
            if md and md.group(1) >= since.isoformat():
                slugs.append(s)
        time.sleep(DELAY)
    # an empty page may be published later: retry empties from the last 2 days
    recent = (today - dt.timedelta(days=2)).isoformat()
    todo = [s for s in slugs if s not in seen or (seen[s].startswith("empty") and _SLUG_DATE.search(s).group(1) >= recent)]
    print(f"[mtgo] {len(slugs)} events since {since}, {len(todo)} to fetch")
    stored = recycled = 0
    for s in todo:
        if budget <= 0:
            print("[mtgo] page budget reached, the rest next run")
            break
        budget -= 1
        try:
            html = http_get(f"{BASE}/decklist/{s}", headers=UA, timeout=60).decode("utf-8", "replace")
            m = _DATA.search(html)
            t = parse_event(s, json.loads(m.group(1))) if m else None
        except Exception as e:  # noqa: BLE001
            print(f"[mtgo] {s}: {e}")
            time.sleep(DELAY)
            continue
        if t is None:
            seen[s] = f"empty:{today.isoformat()}"
        else:
            if t["date"] != _SLUG_DATE.search(s).group(1):
                recycled += 1  # reused address: content belongs to another (later) event
            save_tournament(t, re.sub(r"[^a-z0-9]+", "-", t["id"].lower()))
            seen[s] = t["id"]
            stored += 1
        time.sleep(DELAY)
    print(f"[mtgo] stored {stored} events ({recycled} from reused addresses)")
    return stored
