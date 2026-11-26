"""Dati delle carte da Scryfall (tipo, costo, CMC, immagine, illustratore), con cache su disco.

Rispettiamo le linee guida dell'API Scryfall: User-Agent e Accept espliciti, max ~10 richieste/s,
endpoint /cards/collection (75 carte per richiesta) e cache locale in data/cards.json così
che ogni aggiornamento chieda solo le carte mai viste prima.
Le immagini vengono poi servite direttamente da cards.scryfall.io (CDN di Scryfall).
"""
from __future__ import annotations

import difflib
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from .store import DATA
from .util import USER_AGENT, card_key

CACHE = DATA / "cards.json"
API = "https://api.scryfall.com"
HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json", "Content-Type": "application/json"}

TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Kindred", "Land"]


def _type_group(type_line: str) -> str:
    front = type_line.split("//")[0]
    for t in ("Land", "Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Kindred"):
        if t in front:
            # "Artifact Creature" -> Creature; "Artifact Land" -> Land
            return t
    return "Other"


def _img_path(uri: str | None) -> str | None:
    # https://cards.scryfall.io/normal/front/a/b/uuid.jpg?123 -> front/a/b/uuid.jpg?123
    if not uri:
        return None
    p = urllib.parse.urlparse(uri)
    parts = p.path.lstrip("/").split("/", 1)
    return parts[1] + (f"?{p.query}" if p.query else "") if len(parts) == 2 else None


def _compact(card: dict) -> dict:
    face = (card.get("card_faces") or [card])[0]
    imgs = card.get("image_uris") or face.get("image_uris") or {}
    return {
        "name": card.get("name", "").split(" // ")[0] if card.get("layout") not in ("split",) else card.get("name"),
        "type": _type_group(card.get("type_line") or face.get("type_line") or ""),
        "type_line": card.get("type_line") or face.get("type_line") or "",
        "cmc": card.get("cmc", face.get("cmc", 0)) or 0,
        "mana": face.get("mana_cost") or card.get("mana_cost") or "",
        "colors": "".join(card.get("color_identity") or []),
        "img": _img_path(imgs.get("normal")),
        "art": _img_path(imgs.get("art_crop")),
        "artist": face.get("artist") or card.get("artist"),
        "rarity": card.get("rarity"),
        "uri": card.get("scryfall_uri", "").split("?")[0],
    }


def _post(path: str, body: dict) -> dict:
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(API + path, data=json.dumps(body).encode(), headers=HEADERS, method="POST")
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1 + 2 * attempt)
    raise RuntimeError(last)


def _get(path: str) -> dict | None:
    for attempt in range(4):
        try:
            req = urllib.request.Request(API + path, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(6 if e.code == 429 else 1.5)  # 429 = troppe richieste: aspettiamo di più
        except Exception:  # noqa: BLE001
            time.sleep(1.5)
    return None


def load_cache() -> dict:
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding="utf-8"))
    return {}


def save_cache(cache: dict) -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, sort_keys=True, indent=0), encoding="utf-8")


def enrich(names: list[str], cache: dict | None = None) -> dict:
    """Ritorna {card_key: info}. Scarica da Scryfall solo le chiavi assenti dalla cache."""
    cache = load_cache() if cache is None else cache
    missing = {}
    for n in names:
        k = card_key(n)
        if k not in cache and k not in missing:
            missing[k] = n.split("//")[0].strip()
    if not missing:
        return cache
    print(f"[scryfall] {len(missing)} carte nuove da arricchire")
    items = list(missing.items())
    not_found = []
    for i in range(0, len(items), 75):
        chunk = items[i:i + 75]
        try:
            res = _post("/cards/collection", {"identifiers": [{"name": n} for _, n in chunk]})
        except Exception as e:  # noqa: BLE001
            print(f"[scryfall] errore collection: {e}")
            time.sleep(2)
            not_found.extend(chunk)
            continue
        found_keys = set()
        cards = res.get("data", [])
        # 1) corrispondenza sul nome principale (fronte): ha sempre la precedenza
        for card in cards:
            k = card_key(card.get("name", ""))
            if k in missing:
                cache[k] = _compact(card)
                found_keys.add(k)
        # 2) corrispondenza su un'altra faccia (es. "Reflection of Kiki-Jiki"), solo se ancora libera.
        #    Evita che "Emeritus of Conflict // Lightning Bolt" sovrascriva Lightning Bolt.
        for card in cards:
            for f in (card.get("card_faces") or [])[1:]:
                k = card_key(f.get("name", ""))
                if k in missing and k not in found_keys and k not in cache:
                    cache[k] = _compact(card)
                    found_keys.add(k)
        not_found.extend((k, n) for k, n in chunk if k not in found_keys)
        if (i // 75) % 20 == 0:
            print(f"[scryfall] {min(i + 75, len(items))}/{len(items)} (non trovate finora: {len(not_found)})", flush=True)
        time.sleep(0.12)
    print(f"[scryfall] ricerca fuzzy per {len(not_found)} nomi non trovati", flush=True)
    # secondo tentativo: ricerca "fuzzy" una per una (nomi con accenti, refusi, carte Alchemy...)
    for k, n in not_found:
        card = _get("/cards/named?fuzzy=" + urllib.parse.quote(n))
        # accettiamo il risultato "fuzzy" solo se il nome è davvero simile (refusi sì, traduzioni no)
        if card:
            # printed_name / flavor_name: nomi alternativi (es. versioni "Universes Within" usate su MTGO)
            names = [card.get("name", ""), card.get("printed_name") or "", card.get("flavor_name") or ""]
            names += [f.get(x) or "" for f in card.get("card_faces") or [] for x in ("name", "printed_name", "flavor_name")]
            if max(difflib.SequenceMatcher(None, k, card_key(x)).ratio() for x in names) < 0.85:
                card = None
        cache[k] = _compact(card) if card else {"name": n, "type": "Other", "cmc": 0, "mana": "", "colors": "",
                                                 "img": None, "art": None, "artist": None, "missing": True}
        time.sleep(0.15)
    save_cache(cache)
    return cache
