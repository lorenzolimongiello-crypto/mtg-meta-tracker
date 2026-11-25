"""Classificazione delle liste per archetipo.

Usa le definizioni pubbliche di MTGOFormatData (le stesse usate dalla community per i report
di metagame MTGO): ogni archetipo è un insieme di condizioni sulle carte, con eventuali varianti,
più dei "fallback" basati sulla somiglianza con carte tipiche.

Ordine di classificazione di una lista:
  1. regole dell'archetipo (+ variante)            -> method = "rule"
  2. fallback per somiglianza                      -> method = "fallback"
  3. formati Commander: nome del comandante        -> method = "commander"
  4. etichetta della fonte (es. MTGTop8)           -> method = "source"
  5. solo colori, es. "Izzet (Other)"              -> method = "colors"

Puoi aggiungere regole tue in rules/<Formato>/*.json con la stessa sintassi: vengono caricate
dopo quelle ufficiali e hanno priorità in caso di conflitto.
"""
from __future__ import annotations

import json
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from .store import DATA, ROOT
from .util import card_key, color_name, http_get, lenient_json, sort_colors

FORMAT_DATA_URLS = [
    "https://github.com/Badaro/MTGOFormatData/archive/HEAD.zip",
    "https://github.com/Jiliac/MTGOFormatData/archive/HEAD.zip",
]
ZIP_CACHE = DATA / "cache" / "MTGOFormatData.zip"
CUSTOM_RULES = ROOT / "rules"
FALLBACK_MIN_SIMILARITY = 0.1
COMMANDER_FORMATS = {"Duel Commander", "Commander", "cEDH", "Pauper Commander", "Oathbreaker", "Brawl"}


def download_format_data() -> None:
    ZIP_CACHE.parent.mkdir(parents=True, exist_ok=True)
    for url in FORMAT_DATA_URLS:
        try:
            ZIP_CACHE.write_bytes(http_get(url, timeout=120))
            print(f"[archetypes] definizioni scaricate da {url}")
            return
        except Exception as e:  # noqa: BLE001
            print(f"[warn] {url}: {e}")
    if not ZIP_CACHE.exists():
        raise RuntimeError("Impossibile scaricare MTGOFormatData")


@dataclass
class Condition:
    type: str
    cards: list[str]


@dataclass
class Archetype:
    name: str
    include_color: bool
    conditions: list[Condition]
    variants: list["Archetype"] = field(default_factory=list)
    custom: bool = False


@dataclass
class Fallback:
    name: str
    include_color: bool
    common: list[str]


def _parse_arch(d: dict, custom=False) -> Archetype:
    return Archetype(
        name=d["Name"],
        include_color=bool(d.get("IncludeColorInName")),
        conditions=[Condition(c["Type"], [card_key(x) for x in c.get("Cards", [])]) for c in d.get("Conditions", [])],
        variants=[_parse_arch(v, custom) for v in d.get("Variants") or []],
        custom=custom,
    )


def _check(c: Condition, main: dict, side: dict) -> bool:
    t = c.type.lower()  # alcuni file hanno refusi di maiuscole, es. "OneorMoreInMainboard"
    if t.endswith("mainorsideboard"):
        pool = lambda k: k in main or k in side  # noqa: E731
    elif t.endswith("sideboard"):
        pool = lambda k: k in side  # noqa: E731
    else:
        pool = lambda k: k in main  # noqa: E731
    if t == "doesnotcontain":
        return not any(k in main or k in side for k in c.cards)
    if t.startswith("doesnotcontain"):
        return not any(pool(k) for k in c.cards)
    n = sum(1 for k in c.cards if pool(k))
    if t.startswith("oneormore"):
        return n >= 1
    if t.startswith("twoormore"):
        return n >= 2
    if t.startswith("threeormore"):
        return n >= 3
    if t.startswith("in"):
        return n == len(c.cards)
    raise ValueError(c.type)


class Classifier:
    def __init__(self):
        if not ZIP_CACHE.exists():
            download_format_data()
        self.formats: dict[str, tuple[list[Archetype], list[Fallback], dict]] = {}
        self.land_colors: dict[str, str] = {}
        self.spell_colors: dict[str, str] = {}
        self.unknown_condition_types: set[str] = set()
        with zipfile.ZipFile(ZIP_CACHE) as z:
            files = {n.split("/", 1)[1]: n for n in z.namelist() if "/" in n}
            cc = lenient_json(z.read(files["Formats/card_colors.json"]))
            self._load_colors(cc, self.land_colors, self.spell_colors)
            fmt_names = {p.split("/")[1] for p in files if p.startswith("Formats/") and p.count("/") >= 3}
            for fmt in fmt_names:
                if "-" in fmt:  # vecchie rotazioni, es. Standard-20230701-20240802
                    continue
                archs, fbs = [], []
                lands, spells = {}, {}
                for p, full in files.items():
                    if not p.endswith(".json"):
                        continue
                    if p.startswith(f"Formats/{fmt}/Archetypes/"):
                        archs.append(_parse_arch(lenient_json(z.read(full))))
                    elif p.startswith(f"Formats/{fmt}/Fallbacks/"):
                        d = lenient_json(z.read(full))
                        fbs.append(Fallback(d["Name"], bool(d.get("IncludeColorInName")),
                                            [card_key(x) for x in d.get("CommonCards", [])]))
                    elif p == f"Formats/{fmt}/color_overrides.json":
                        self._load_colors(lenient_json(z.read(full)), lands, spells)
                self.formats[fmt] = (archs, fbs, {"lands": lands, "spells": spells})
        self._load_custom()

    def _load_custom(self):
        if not CUSTOM_RULES.exists():
            return
        for p in CUSTOM_RULES.glob("*/*.json"):
            fmt = p.parent.name
            archs, fbs, ov = self.formats.setdefault(fmt, ([], [], {"lands": {}, "spells": {}}))
            archs.insert(0, _parse_arch(lenient_json(p.read_text(encoding="utf-8")), custom=True))

    @staticmethod
    def _load_colors(d: dict, lands: dict, spells: dict):
        for e in d.get("Lands") or []:
            lands[card_key(e["Name"])] = e["Color"]
        for e in d.get("NonLands") or []:
            spells[card_key(e["Name"])] = e["Color"]

    def known_formats(self) -> list[str]:
        return sorted(self.formats)

    def deck_colors(self, fmt: str, main: dict, side: dict) -> str:
        ov = self.formats.get(fmt, (None, None, {"lands": {}, "spells": {}}))[2]
        land_c, spell_c = set(), set()
        known_land = False
        for k in main:
            if k in ov["lands"] or k in self.land_colors:
                known_land = True
                land_c.update(ov["lands"].get(k) or self.land_colors.get(k, ""))
            else:
                spell_c.update(ov["spells"].get(k) or self.spell_colors.get(k, ""))
        colors = spell_c & land_c if known_land and land_c else spell_c
        colors.discard("C")
        return sort_colors("".join(colors))

    def classify(self, fmt: str, main_list, side_list, source_archetype: str | None = None):
        """main_list/side_list: [[qty, name], ...]. Ritorna (archetipo, metodo, colori)."""
        main = {card_key(n): q for q, n in main_list}
        side = {card_key(n): q for q, n in side_list}
        colors = self.deck_colors(fmt, main, side)
        cname = color_name(colors)

        if fmt in COMMANDER_FORMATS:
            # MTGO/MTGTop8 mettono il comandante nel sideboard (1-2 carte)
            cmd = [n for q, n in side_list if q == 1] if 0 < len(side_list) <= 2 else []
            if cmd:
                return " + ".join(sorted(n.split("//")[0].strip() for n in cmd)), "commander", colors

        archs, fbs, _ = self.formats.get(fmt, ([], [], None))
        matches = []
        for a in archs:
            try:
                if all(_check(c, main, side) for c in a.conditions):
                    matches.append(a)
            except ValueError as e:
                self.unknown_condition_types.add(f"{a.name}: {e}")
        if matches:
            # regole personali prima; poi la regola più specifica (più condizioni)
            a = max(matches, key=lambda x: (x.custom, len(x.conditions)))
            chosen = a
            for v in a.variants:
                if all(_check(c, main, side) for c in v.conditions):
                    chosen = v
                    break
            name = f"{cname} {chosen.name}" if chosen.include_color else chosen.name
            return name, "rule", colors

        best, best_score = None, 0.0
        for fb in fbs:
            if not fb.common:
                continue
            score = sum(1 for k in fb.common if k in main or k in side) / len(fb.common)
            if score > best_score:
                best, best_score = fb, score
        if best and best_score >= FALLBACK_MIN_SIMILARITY:
            name = f"{cname} {best.name}" if best.include_color else best.name
            return name, "fallback", colors

        if source_archetype:
            return source_archetype, "source", colors
        return f"{cname} (Other)", "colors", colors


if __name__ == "__main__":
    c = Classifier()
    print(json.dumps({f: len(v[0]) for f, v in c.formats.items()}, indent=1))
