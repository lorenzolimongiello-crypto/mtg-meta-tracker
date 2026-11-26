"""Source: magic.gg — Wizards of the Coast's official esports site, read directly.

It publishes the decklists of the biggest events: Pro Tours, World Championship, Arena Championships,
Regional Championships (top finishers) and Spotlight Series. Many of them (Worlds, Arena Championship,
the Japanese / Asian / Oceanian Regional Championships) are published nowhere else.

Data care:
  - placements are written ONLY when the page states the lists are in final standing order;
    otherwise a "Top N" page gives "Top N" to every list (points computed as the minimum: rank N),
    and an alphabetical page (Pro Tour, Worlds) gives no placement at all;
  - pages split alphabetically (A–K, L–Z...) are joined into one event;
  - the Arena "Ranked" pages are ladder snapshots, not tournaments: skipped;
  - "Surname, Name" is turned into "Name Surname" so the same player matches other sources.

Politeness: robots.txt allows everything; ~1 request per second, only pages we have not stored yet.
"""
from __future__ import annotations

import collections
import datetime as dt
import html as htmllib
import re
import time

from ..store import save_tournament
from ..util import http_get
from . import normalize_format

BASE = "https://magic.gg"
DELAY = 1.0
UA = {"User-Agent": "Mozilla/5.0 (compatible; MetagameDataCollector/1.0)"}
_SLUG = re.compile(r"/decklists/([a-z0-9-]+)")
_SPLIT = re.compile(r"-[a-z]-[a-z]$")  # alphabetical split pages: ...-decklists-a-k
_DECK = re.compile(r"<deck-list\b([^>]*)>(.*?)</deck-list>", re.S)
_ATTR = re.compile(r'([a-z-]+)="([^"]*)"')
_LINE = re.compile(r"^\s*(\d+)\s+(.+?)\s*$")
_ORDERED = re.compile(r"(final )?standings? order|order of (final )?(finish|standing|placement)", re.I)
_FIELD = re.compile(r"field of (?:more than |over |nearly |almost )?([\d,.]+) (?:players|competitors)", re.I)
_TOP = re.compile(r"-top-(\d+)-")


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')} Place"


def _player(name: str) -> str:
    name = htmllib.unescape(name).strip()
    if name.count(",") == 1:  # "Rosdahl, Alexander" -> "Alexander Rosdahl"
        last, first = (p.strip() for p in name.split(","))
        if first and last:
            return f"{first} {last}"
    return name


def _cards(block: str) -> list:
    out = []
    for line in htmllib.unescape(re.sub(r"<[^>]+>", "\n", block)).splitlines():
        m = _LINE.match(line)
        if m:
            out.append([int(m.group(1)), m.group(2)])
    return out


def _section(body: str, tag: str) -> str:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", body, re.S)
    return m.group(1) if m else ""


def _intro(page: str) -> str:
    text = re.sub(r"<deck-list.*?</deck-list>", " ", page, flags=re.S)
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", text, flags=re.S)
    text = htmllib.unescape(re.sub(r"<[^>]+>", " ", text))
    i = text.find("Back")
    return re.sub(r"\s+", " ", text[i:i + 1500] if i >= 0 else text[:3000])


def parse_page(slug: str, page: str) -> tuple[list[dict], str]:
    """Returns (decks with their event attributes, intro text)."""
    decks = []
    for attrs, body in _DECK.findall(page):
        a = {k: htmllib.unescape(v) for k, v in _ATTR.findall(attrs)}
        main = _cards(_section(body, "main-deck"))
        if not main:
            continue
        side = _cards(_section(body, "side-board"))
        for q, n in _cards(_section(body, "companion-card")) or []:
            if all(n.lower() != s.lower() for _, s in side):  # the companion lives in the sideboard
                side.append([1, n])
        decks.append({"event": a.get("event-name") or "", "date": a.get("event-date") or "",
                      "format": a.get("format") or "", "player": _player(a.get("deck-title") or ""),
                      "archetype": a.get("subtitle") or None, "main": main, "side": side,
                      "url": f"{BASE}/decklists/{slug}"})
    return decks, _intro(page)


def _iso(date: str) -> str | None:
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(date.strip(), fmt).date().isoformat()
        except ValueError:
            pass
    return None


def build_events(pages: list[tuple[str, str]]) -> list[dict]:
    """pages: [(slug, html)] of one group (split pages of the same event)."""
    groups = collections.OrderedDict()
    meta = {}
    for slug, page in pages:
        decks, intro = parse_page(slug, page)
        ordered = bool(_ORDERED.search(intro)) and len(pages) == 1
        top = _TOP.search(slug + "-")
        field = _FIELD.search(intro)
        for i, d in enumerate(decks):
            key = (d["event"], d["format"], d["date"])
            groups.setdefault(key, []).append((i, d))
            meta[key] = {"ordered": ordered, "top": top, "field": field, "slug": slug}
    events = []
    for (event, fmt_raw, date_raw), items in groups.items():
        fmt = normalize_format(fmt_raw, event)
        date = _iso(date_raw)
        if fmt is None or not date or not event:
            continue
        m = meta[(event, fmt_raw, date_raw)]
        seen = set()
        decks = []
        for i, d in items:
            sig = (d["player"].lower(), tuple(sorted((n.lower(), q) for q, n in d["main"] + d["side"])))
            if sig in seen:
                continue
            seen.add(sig)
            if m["ordered"]:
                result = _ordinal(i + 1)
            elif m["top"]:
                result = f"Top {m['top'].group(1)}"
            elif "top" in m["slug"].split("-"):
                result = f"Top {len(items)}"
            else:
                result = None  # alphabetical list of all participants: no placement published
            decks.append({"player": d["player"], "result": result, "url": d["url"],
                          "source_archetype": d["archetype"], "main": d["main"], "side": d["side"]})
        players = None
        if m["field"]:
            try:
                players = int(re.sub(r"[,.]", "", m["field"].group(1)))
            except ValueError:
                players = None
        key = re.sub(r"[^a-z0-9]+", "-", f"{event} {fmt}".lower()).strip("-")
        events.append({
            "id": f"magic.gg:{key}-{date}", "source": "magic.gg", "via": "direct", "name": event,
            "date": date, "format": fmt, "type": "online" if "arena" in event.lower() else "paper",
            "url": f"{BASE}/decklists/{_SPLIT.sub('', m['slug'])}" if len(pages) > 1 else f"{BASE}/decklists/{m['slug']}",
            "players": players, "players_official": players is not None, "decks": decks,
        })
    return events


def fetch(state: dict) -> int:
    seen: dict = state.setdefault("magicgg", {})  # slug -> date fetched
    try:
        listing = http_get(f"{BASE}/decklists", headers=UA).decode("utf-8", "replace")
        listing = listing.replace(r"\u002F", "/")  # links inside the embedded page data are escaped
    except Exception as e:  # noqa: BLE001
        print(f"[magic.gg] listing failed: {e}")
        return 0
    slugs = [s for s in dict.fromkeys(_SLUG.findall(listing)) if "ranked-decklists" not in s]
    if not slugs:
        print("[magic.gg] WARNING: listing returned no decklist pages")
        return 0
    groups = collections.OrderedDict()
    for s in slugs:
        groups.setdefault(_SPLIT.sub("", s), []).append(s)
    todo = [g for g, members in groups.items() if any(s not in seen for s in members)]
    print(f"[magic.gg] {len(slugs)} pages listed, {len(todo)} events to fetch")
    stored = 0
    today = dt.date.today().isoformat()
    for g in todo:
        pages = []
        for s in groups[g]:
            try:
                pages.append((s, http_get(f"{BASE}/decklists/{s}", headers=UA, timeout=60).decode("utf-8", "replace")))
            except Exception as e:  # noqa: BLE001
                print(f"[magic.gg] {s}: {e}")
            time.sleep(DELAY)
        pages = [(s, p) for s, p in pages if "<deck-list" in p]  # the bare index page has no lists
        if not pages:
            for s in groups[g]:
                seen.setdefault(s, today)
            continue
        for t in build_events(pages):
            save_tournament(t, re.sub(r"[^a-z0-9]+", "-", t["id"].lower()))
            stored += 1
            print(f"[magic.gg] {t['date']} {t['name']} ({t['format']}): {len(t['decks'])} lists"
                  f"{', ' + str(t['players']) + ' players' if t['players'] else ''}")
        for s in groups[g]:
            seen[s] = today
    print(f"[magic.gg] stored {stored} events")
    return stored
