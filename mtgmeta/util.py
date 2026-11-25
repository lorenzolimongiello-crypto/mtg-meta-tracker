"""Funzioni di supporto: HTTP, JSON tollerante, normalizzazione nomi carte e risultati."""
from __future__ import annotations

import gzip
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.request

USER_AGENT = "mtg-meta-tracker/0.1 (+https://github.com/)"


def http_get(url: str, *, headers: dict | None = None, retries: int = 3, timeout: int = 60) -> bytes:
    """GET con retry e gestione gzip. Solleva urllib.error.HTTPError sui 4xx."""
    h = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"}
    if headers:
        h.update(headers)
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return data
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                raise
            last_err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_err = e
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET fallito dopo {retries} tentativi: {url}: {last_err}")


def github_headers() -> dict:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    h = {"Accept": "application/vnd.github+json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


_TRAILING_COMMA = re.compile(r",(\s*[\]}])")


def lenient_json(text: str | bytes):
    """Alcuni file di MTGOFormatData hanno virgole finali: le togliamo prima del parse."""
    if isinstance(text, bytes):
        text = text.decode("utf-8-sig")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(_TRAILING_COMMA.sub(r"\1", text))


def card_key(name: str) -> str:
    """Chiave di confronto: solo fronte delle carte bifronti, senza accenti, minuscolo."""
    name = name.split("//")[0].strip()
    name = unicodedata.normalize("NFKD", name)
    name = "".join(c for c in name if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", name).casefold()


def front_name(name: str) -> str:
    return name.split("//")[0].strip()


_RANK = re.compile(r"^\s*(?:top\s*)?(\d+)")
_RECORD = re.compile(r"(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?")


def parse_result(result: str | None) -> tuple[int | None, int | None, int | None]:
    """Ritorna (posizione, vittorie, sconfitte) da stringhe come '1st Place', '5-0', '3-4', 'Top 8'."""
    if not result:
        return None, None, None
    low = result.strip().lower()
    m = re.fullmatch(r"(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?", low)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        # MTGTop8 usa "3-4" / "5-8" come intervallo di piazzamento; MTGO usa "5-0" come record W-L.
        if not m.group(3) and (a, b) in _PLACE_RANGES:
            return a, None, None
        return None, a, b
    m = _RANK.match(low)
    return (int(m.group(1)) if m else None), None, None


_PLACE_RANGES = {(3, 4), (5, 8), (9, 16), (17, 32), (33, 64), (65, 128)}


COLOR_ORDER = "WUBRG"
COLOR_NAMES = {
    "": "Colorless", "W": "Mono White", "U": "Mono Blue", "B": "Mono Black", "R": "Mono Red", "G": "Mono Green",
    "WU": "Azorius", "UB": "Dimir", "BR": "Rakdos", "RG": "Gruul", "WG": "Selesnya",
    "WB": "Orzhov", "UR": "Izzet", "BG": "Golgari", "WR": "Boros", "UG": "Simic",
    "WUB": "Esper", "UBR": "Grixis", "BRG": "Jund", "WRG": "Naya", "WUG": "Bant",
    "WBG": "Abzan", "WUR": "Jeskai", "UBG": "Sultai", "WBR": "Mardu", "URG": "Temur",
    "WUBR": "4c (no G)", "UBRG": "4c (no W)", "WBRG": "4c (no U)", "WURG": "4c (no B)", "WUBG": "4c (no R)",
    "WUBRG": "5 Color",
}


def sort_colors(c: str) -> str:
    return "".join(x for x in COLOR_ORDER if x in c)


def color_name(c: str) -> str:
    return COLOR_NAMES.get(sort_colors(c), sort_colors(c))


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower() or "x"
