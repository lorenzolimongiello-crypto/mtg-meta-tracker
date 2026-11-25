"""Fonti dati e normalizzazione comune (formati, tipo evento)."""
from __future__ import annotations

import re

_CANON = {
    "standard": "Standard", "pioneer": "Pioneer", "modern": "Modern", "legacy": "Legacy",
    "vintage": "Vintage", "pauper": "Pauper", "premodern": "Premodern", "historic": "Historic",
    "explorer": "Explorer", "timeless": "Timeless", "alchemy": "Alchemy", "penny dreadful": "Penny Dreadful",
    "duel commander": "Duel Commander", "duelcommander": "Duel Commander", "cedh": "cEDH",
    "commander": "Commander", "edh": "Commander", "oathbreaker": "Oathbreaker", "old school": "Old School",
    "pauper commander": "Pauper Commander", "pdh": "Pauper Commander", "brawl": "Brawl",
    "canadian highlander": "Canadian Highlander", "highlander": "Highlander",
}
LIMITED = {"draft", "sealed", "limited", "booster draft", "cube", "jumpstart"}


def normalize_format(raw: str | None, event_name: str = "") -> str | None:
    """Ritorna il nome canonico del formato, oppure None se è Limited (non ci interessa)."""
    f = (raw or "").split(",")[0].strip()
    low = f.lower()
    name = event_name.lower()
    if low in LIMITED or any(w in name for w in (" draft", " sealed", "cube ")):
        return None
    if low in ("commander", "edh") and "duel" in name:
        return "Duel Commander"
    if low in _CANON:
        return _CANON[low]
    if not low or low in ("unknown", "unspecified", "other"):
        # prova a dedurlo dal nome del torneo
        for key in sorted(_CANON, key=len, reverse=True):
            if re.search(rf"\b{re.escape(key)}\b", name):
                return _CANON[key]
        return "Other"
    return f


_ONLINE_HINTS = ("mtgo", "online", "webcam", "spelltable", "arena", "discord")


def guess_event_type(source: str, event_name: str) -> str:
    if source.startswith("mtgo"):
        return "online"
    n = event_name.lower()
    return "online" if any(h in n for h in _ONLINE_HINTS) else "paper"
