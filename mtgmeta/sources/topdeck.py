"""Source: TopDeck.gg — official public API (v2), read directly.

TopDeck.gg runs thousands of paper and webcam tournaments (cEDH, Duel Commander, Pauper, Legacy,
Modern...). The intermediate archive stopped copying it in April 2025, so this is the only way to
have its events.

Terms (https://topdeck.gg/docs/tournaments-v2):
  - a free API key, set as the TOPDECK_API_KEY secret: without it this collector does nothing;
  - a visible "Data provided by TopDeck.gg" credit with a link (in the site footer and About page);
  - rate limit: 5 requests per minute on the search endpoint -> one request every 13 seconds.

Data care:
  - only finished events with at least 16 participants (participantMin), no leagues, no team events;
  - placements are the official standings order; the player count is the real number of entrants;
  - a decklist given only as an external link (e.g. Moxfield) is skipped and counted, never guessed;
  - in Commander formats the commander(s) go in the sideboard, like MTGO and MTGTop8 do.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import time
import urllib.error
import urllib.request

from ..store import save_tournament
from . import guess_event_type

API = "https://topdeck.gg/api/v2/tournaments"
DELAY = 13.0  # 5 requests per minute on this endpoint
WINDOW_DAYS = 7  # long backfills are split into weekly windows to keep responses small

# TopDeck format name -> our canonical format (formats not listed are ignored: casual, limited, teams)
FORMATS = {
    "EDH": "cEDH", "Pauper EDH": "Pauper Commander", "Duel Commander": "Duel Commander",
    "Standard": "Standard", "Pioneer": "Pioneer", "Modern": "Modern", "Legacy": "Legacy",
    "Vintage": "Vintage", "Pauper": "Pauper", "Premodern": "Premodern", "Timeless": "Timeless",
    "Historic": "Historic", "Explorer": "Explorer", "Canadian Highlander": "Canadian Highlander",
    "Oathbreaker": "Oathbreaker", "Old School 93/94": "Old School",
}
COMMANDER = {"cEDH", "Pauper Commander", "Duel Commander", "Oathbreaker"}
_LINE = re.compile(r"^\s*(?:(\d+)\s*x?\s+)?(.+?)\s*$", re.I)
_SECTION = re.compile(r"^\s*~~\s*(.+?)\s*~~\s*$")
_SIDE_SECTIONS = {"sideboard", "companion", "companions"}
_CMD_SECTIONS = {"commander", "commanders", "signature spell", "signature spells"}
_SKIP_SECTIONS = {"maybeboard", "maybe", "considering", "tokens"}


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')} Place"


def _from_obj(obj: dict) -> tuple[list, list]:
    main, side = [], []
    for section, cards in (obj or {}).items():
        low = section.strip().lower()
        if low in _SKIP_SECTIONS or not isinstance(cards, dict):
            continue
        dest = side if low in _SIDE_SECTIONS | _CMD_SECTIONS else main if low in ("mainboard", "main", "deck") else None
        if dest is None:
            continue
        for name, v in cards.items():
            q = v.get("count") if isinstance(v, dict) else v
            try:
                q = int(q or 1)
            except (TypeError, ValueError):
                q = 1
            if name and q > 0:
                dest.append([q, name])
    return main, side


def _from_text(text: str) -> tuple[list, list]:
    main, side = [], []
    dest = main
    for line in text.splitlines():
        if not line.strip():
            continue
        m = _SECTION.match(line)
        if m:
            low = m.group(1).lower()
            dest = None if low in _SKIP_SECTIONS else side if low in _SIDE_SECTIONS | _CMD_SECTIONS else main
            continue
        if dest is None:
            continue
        m = _LINE.match(line)
        if m and m.group(2):
            dest.append([int(m.group(1) or 1), m.group(2)])
    return main, side


def parse_deck(row: dict) -> tuple[list, list] | None:
    """Returns (main, side), or None when there is no usable list (missing or external link)."""
    if row.get("deckObj"):
        main, side = _from_obj(row["deckObj"])
        if main:
            return main, side
    text = (row.get("decklist") or "").strip()
    if not text or re.match(r"https?://", text):
        return None
    main, side = _from_text(text)
    return (main, side) if main else None


def parse_tournament(raw: dict, fmt: str) -> tuple[dict | None, int]:
    """Returns (tournament or None, number of lists skipped because they were only a link)."""
    if raw.get("isTeamEvent") or raw.get("isLeague"):
        return None, 0
    standings = raw.get("standings") or []
    start = raw.get("startDate")
    if not standings or not start:
        return None, 0
    date = dt.datetime.fromtimestamp(int(start), dt.timezone.utc).date().isoformat()
    tid = raw.get("TID")
    name = raw.get("tournamentName") or tid
    decks, linked = [], 0
    for i, row in enumerate(standings):
        parsed = parse_deck(row)
        if parsed is None:
            linked += bool((row.get("decklist") or "").startswith("http"))
            continue
        main, side = parsed
        rank = int(row.get("standing") or i + 1)
        src_arch = row.get("leader") if fmt in COMMANDER else row.get("archetype")
        decks.append({"player": row.get("name"), "result": _ordinal(rank),
                      "url": f"https://topdeck.gg/event/{tid}", "source_archetype": src_arch,
                      "main": main, "side": side})
    if not decks:
        return None, linked
    return {
        "id": f"topdeck:{tid}", "source": "topdeck.gg", "via": "direct", "name": name, "date": date,
        "format": fmt, "type": guess_event_type("topdeck.gg", name), "url": f"https://topdeck.gg/event/{tid}",
        "players": len(standings), "players_official": True, "decks": decks,
    }, linked


def _post(key: str, body: dict) -> list:
    req = urllib.request.Request(API, data=json.dumps(body).encode(), method="POST", headers={
        "Authorization": key, "Content-Type": "application/json",
        "User-Agent": "MetagameDataCollector/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                time.sleep(65)
                continue
            raise
    return []


def fetch(state: dict, days: int = 4) -> int:
    key = os.environ.get("TOPDECK_API_KEY", "").strip()
    if not key:
        print("[topdeck] no TOPDECK_API_KEY: skipped (free key from https://topdeck.gg/docs/tournaments-v2)")
        return 0
    seen: dict = state.setdefault("topdeck", {})  # TID -> date stored
    now = int(time.time())
    windows = []
    end = now
    while end > now - days * 86400:
        start = max(now - days * 86400, end - WINDOW_DAYS * 86400)
        windows.append((start, end))
        end = start
    stored = linked = requests = 0
    for td_fmt, fmt in FORMATS.items():
        for start, end in windows:
            if requests:
                time.sleep(DELAY)
            requests += 1
            try:
                data = _post(key, {"game": "Magic: The Gathering", "format": td_fmt, "start": start, "end": end,
                                   "participantMin": 16, "columns": ["name", "id", "decklist", "wins", "losses", "draws"]})
            except Exception as e:  # noqa: BLE001 - one failed format must not stop the others
                print(f"[topdeck] {td_fmt}: {e}")
                continue
            for raw in data if isinstance(data, list) else []:
                tid = raw.get("TID")
                if not tid or tid in seen:
                    continue
                t, n_link = parse_tournament(raw, fmt)
                linked += n_link
                if t:
                    save_tournament(t, re.sub(r"[^a-z0-9]+", "-", t["id"].lower()))
                    stored += 1
                seen[tid] = dt.date.today().isoformat()
    print(f"[topdeck] stored {stored} events in {requests} requests ({linked} lists given only as an external link, skipped)")
    return stored
