"""Fonte: MTGODecklistCache (MTGO, Melee.gg, Topdeck.gg, CardsRealm, GetPaird...).

Il repository è enorme (~800 MB) quindi NON lo cloniamo: per ogni fonte/anno chiediamo
all'API GitHub l'albero dei file (1 richiesta), poi scarichiamo da raw.githubusercontent.com
solo i file nuovi o cambiati (confronto dello SHA del blob salvato in state.json).
"""
from __future__ import annotations

import datetime as dt
import json
import urllib.error
from concurrent.futures import ThreadPoolExecutor

from ..store import save_tournament
from ..util import github_headers, http_get
from . import guess_event_type, normalize_format

REPO = "Jiliac/MTGODecklistCache"
BRANCH = "master"
API = f"https://api.github.com/repos/{REPO}"
RAW = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}"


def _api(path: str):
    return json.loads(http_get(f"{API}/{path}", headers=github_headers()))


def list_sources() -> list[str]:
    return [e["name"] for e in _api(f"contents/Tournaments?ref={BRANCH}") if e["type"] == "dir"]


def list_files(source: str, year: int) -> list[dict]:
    """Tutti i file JSON di una fonte in un anno: [{'path','sha','date'}]."""
    try:
        tree = _api(f"git/trees/{BRANCH}:Tournaments/{source}/{year}?recursive=1")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    if tree.get("truncated"):
        print(f"[warn] albero troncato per {source}/{year}")
    out = []
    for e in tree.get("tree", []):
        if e["type"] != "blob" or not e["path"].endswith(".json"):
            continue
        parts = e["path"].split("/")  # MM/DD/file.json
        if len(parts) != 3:
            continue
        out.append({
            "path": f"Tournaments/{source}/{year}/{e['path']}",
            "sha": e["sha"],
            "date": f"{year}-{parts[0]}-{parts[1]}",
        })
    return out


SOURCE_LABELS = {"mtgo.com_limited_data": "mtgo.com"}


def _convert(source: str, raw: dict) -> dict | None:
    source = SOURCE_LABELS.get(source, source)
    t = raw.get("Tournament") or {}
    name = t.get("Name") or "?"
    fmt = normalize_format(t.get("Formats"), name)
    if fmt is None:
        return None
    date = (t.get("Date") or "")[:10]
    decks = []
    for d in raw.get("Decks") or []:
        main = [[c["Count"], c["CardName"]] for c in d.get("Mainboard") or [] if c.get("CardName")]
        if not main:
            continue
        decks.append({
            "player": d.get("Player"),
            "result": d.get("Result"),
            "url": d.get("AnchorUri"),
            "source_archetype": None,
            "main": main,
            "side": [[c["Count"], c["CardName"]] for c in d.get("Sideboard") or [] if c.get("CardName")],
        })
    if not decks:
        return None
    standings = raw.get("Standings") or []
    return {
        "source": source,
        "name": name,
        "date": date,
        "format": fmt,
        "type": guess_event_type(source, name),
        "url": t.get("Uri"),
        "players": len(standings) or None,
        "decks": decks,
    }


def fetch(days: int, state: dict, workers: int = 8) -> int:
    seen: dict = state.setdefault("decklistcache", {})
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    years = range(int(since[:4]), dt.date.today().year + 1)

    todo = []
    for source in list_sources():
        for y in years:
            for f in list_files(source, y):
                if f["date"] >= since and seen.get(f["path"]) != f["sha"]:
                    todo.append((source, f))
    print(f"[decklistcache] {len(todo)} file nuovi/aggiornati dal {since}")

    def work(item):
        source, f = item
        try:
            raw = json.loads(http_get(f"{RAW}/{f['path']}"))
        except Exception as e:  # noqa: BLE001 - un file rotto non deve fermare l'aggiornamento
            print(f"[warn] {f['path']}: {e}")
            return None
        t = _convert(source, raw)
        slug = f["path"].rsplit("/", 1)[1][:-5]
        if t:
            t["id"] = f"{t['source']}:{slug}"
            save_tournament(t, slug)
        return f

    n = 0
    with ThreadPoolExecutor(workers) as ex:
        for f in ex.map(work, todo):
            if f:
                seen[f["path"]] = f["sha"]
                n += 1
    return n
