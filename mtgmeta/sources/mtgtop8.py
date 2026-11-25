"""Fonte: MTGTop8 (tornei cartacei locali di tutto il mondo, molto forte su Italia/Europa).

Rispetta robots.txt (Crawl-delay: 5): una richiesta ogni 5 secondi.
Gli eventi "MTG Online" vengono saltati perché arrivano già, completi, dai dati ufficiali MTGO.
Per ogni esecuzione c'è un tetto di richieste (default 200 ≈ 17 minuti); gli eventi non
completati vengono ripresi alla volta successiva.
"""
from __future__ import annotations

import datetime as dt
import html
import re
import time

from ..store import save_tournament
from ..util import http_get

BASE = "https://www.mtgtop8.com"
DELAY = 5.0

# codice MTGTop8 -> nome formato
FORMATS = {
    "ST": "Standard", "PI": "Pioneer", "MO": "Modern", "LE": "Legacy", "VI": "Vintage",
    "PAU": "Pauper", "PREM": "Premodern", "EDH": "Duel Commander", "cEDH": "cEDH",
    "EX": "Explorer", "HI": "Historic", "ALCH": "Alchemy", "PEA": "Peasant", "BL": "Block",
}

_EVENT_ROW = re.compile(
    r"<tr class=hover_tr>\s*<td[^>]*><img src=/graph/online/(\w+)\.png[^>]*></td>\s*"
    r"<td[^>]*><a href=event\?e=(\d+)&f=(\w+)>([^<]+)</a>([^\n]*?)</td>.*?"
    r"<td align=right[^>]*>(\d\d/\d\d/\d\d)</td>",
    re.S,
)
_DECK_ROW = re.compile(
    r"<div[^>]*class=S14>([^<]*)</div>\s*<div[^>]*><a href=\?e=\d+&d=(\d+)&f=\w+>.*?"
    r"<a href=\?e=\d+&d=\d+&f=\w+>([^<]*)</a>.*?<a class=player href=[^>]*>([^<]*)</a>",
    re.S,
)
_PLAYERS = re.compile(r"(\d+)\s+players\s*-\s*(\d\d/\d\d/\d\d)")
_PLACE = re.compile(r"^\s*@\s*<a[^>]*>([^<]+)</a>")


class Crawler:
    def __init__(self, budget: int):
        self.budget = budget
        self._last = 0.0

    def get(self, path: str) -> str | None:
        if self.budget <= 0:
            return None
        wait = DELAY - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self.budget -= 1
        try:
            return http_get(BASE + path).decode("latin-1", "replace")
        except Exception as e:  # noqa: BLE001
            print(f"[mtgtop8] errore {path}: {e}")
            return ""
        finally:
            self._last = time.monotonic()


def _date(ddmmyy: str) -> str:
    d, m, y = ddmmyy.split("/")
    return f"20{y}-{m}-{d}"


def parse_decklist(text: str) -> tuple[list, list]:
    main, side = [], []
    cur = main
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.lower().startswith("sideboard"):
            cur = side
            continue
        m = re.match(r"(\d+)\s+(.+)", line)
        if m:
            cur.append([int(m.group(1)), m.group(2).strip()])
    return main, side


def fetch(state: dict, max_requests: int = 200, days: int = 30, formats: list[str] | None = None) -> int:
    seen: dict = state.setdefault("mtgtop8_events", {})
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    cr = Crawler(max_requests)

    # 1) raccogli gli eventi recenti di ogni formato
    events = []
    for code in formats or FORMATS:
        page = cr.get(f"/format?f={code}")
        if page is None:
            break
        for icon, eid, fcode, name, rest, date in _EVENT_ROW.findall(page):
            date = _date(date)
            if icon == "mtgo" or eid in seen or date < since:
                continue
            place = _PLACE.search(rest)
            events.append({"id": eid, "code": fcode, "name": html.unescape(name).strip(),
                           "place": html.unescape(place.group(1)) if place else None,
                           "date": date, "type": "paper" if icon == "paper" else "online"})
    print(f"[mtgtop8] {len(events)} eventi nuovi da scaricare (budget {cr.budget} richieste)")

    # 2) per ogni evento: pagina evento + export testuale di ogni lista
    done = 0
    for ev in sorted(events, key=lambda e: e["date"], reverse=True):
        page = cr.get(f"/event?e={ev['id']}&f={ev['code']}")
        if not page:
            if page is None:
                break
            continue
        rows = _DECK_ROW.findall(page)
        if cr.budget < len(rows):
            break  # non abbastanza budget per completarlo: lo riprendiamo la prossima volta
        m = _PLAYERS.search(page)
        decks = []
        for rank, deck_id, arch, player in rows:
            txt = cr.get(f"/mtgo?d={deck_id}")
            if not txt:
                continue
            main, side = parse_decklist(txt)
            if not main:
                continue
            decks.append({
                "player": html.unescape(player).strip(),
                "result": rank.strip(),
                "url": f"{BASE}/event?e={ev['id']}&d={deck_id}&f={ev['code']}",
                "source_archetype": html.unescape(arch).strip() or None,
                "main": main, "side": side,
            })
        if decks:
            name = ev["name"] + (f" @ {ev['place']}" if ev["place"] else "")
            t = {
                "id": f"mtgtop8:{ev['id']}", "source": "mtgtop8.com", "name": name, "date": ev["date"],
                "format": FORMATS.get(ev["code"], ev["code"]), "type": ev["type"],
                "url": f"{BASE}/event?e={ev['id']}&f={ev['code']}",
                "players": int(m.group(1)) if m else None, "decks": decks,
            }
            save_tournament(t, f"mtgtop8-{ev['id']}")
            done += 1
        seen[ev["id"]] = ev["date"]

    # pulizia: dimentica eventi vecchi
    cutoff = (dt.date.today() - dt.timedelta(days=days + 30)).isoformat()
    for k in [k for k, v in seen.items() if v < cutoff]:
        del seen[k]
    return done
