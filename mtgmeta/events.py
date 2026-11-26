"""Profilo di un torneo: tipo, fascia di dimensione e punteggio dei piazzamenti.

Il problema della "bontà del dato": un 1° posto in un torneo da 8 giocatori non vale quanto
un 1° posto a un Regional da 400. Ogni torneo riceve quindi una FASCIA:

  large   Grande   ≥ 100 giocatori, oppure eventi premier (Pro Tour, Regional, Showcase MTGO...)
  medium  Medio    32–99 giocatori, oppure Challenge MTGO / RCQ di cui non conosciamo i numeri
  small   Piccolo  < 32 giocatori
  league  Lega     Leghe MTGO: solo liste 5-0, nessuna classifica né numero di iscritti

Attenzione: per le Challenge MTGO il sito ufficiale pubblica solo i primi 32, quindi il numero di
"giocatori" che leggiamo è falso (sempre ≤ 32). Per quelle segniamo players_known = False.

Il PUNTEGGIO di una lista = log2(giocatori / piazzamento), cioè quanto è raro quel risultato
(vedi points()). Serve a ordinare gli archetipi per "quanto hanno fatto bene", non solo per
quante volte compaiono.
"""
from __future__ import annotations

import math
import re

_PREMIER = re.compile(
    r"pro tour|world championship|regional championship|\brc\b(?! ?q)|grand prix|\bgp\b|"
    r"showcase|super qualifier|eternal weekend(?! trial)|\bopen\b|scg ?con|magiccon|"
    r"championship(?! qualifier)|nationals|national championship|legacy european|bazaar of moxen",
    re.I,
)
_QUALIFIER = re.compile(r"\brcq\b|qualifier|\bptq\b|\bwmcq\b|trial|preliminary|\brecq\b", re.I)


def classify_event(source: str, name: str, players: int | None, n_decks: int, official: bool = False) -> dict:
    """official=True: the player count comes from the organiser's own data (e.g. mtgo.com player_count)."""
    low = name.lower()
    mtgo = source.startswith("mtgo")
    if mtgo and "league" in low:
        return {"kind": "league", "tier": "league", "players": None, "players_known": False}

    # MTGO: the published standings stop at the top 32, so the count is only trusted when official
    if mtgo and "challenge" in low and "showcase" not in low:
        kind = "challenge"
        players_known = official and players is not None
    elif _PREMIER.search(low) or source == "magic.gg":  # magic.gg only covers Wizards' premier events
        kind = "premier"
        players_known = players is not None and (official or not mtgo)
    elif _QUALIFIER.search(low):
        kind = "qualifier"
        players_known = players is not None and (official or not mtgo)
    else:
        kind = "local"
        players_known = players is not None

    if players is not None and players < n_decks:
        players = n_decks

    if players_known and players:
        tier = "large" if players >= 100 else "medium" if players >= 32 else "small"
        # un evento premier con pochi iscritti resta almeno "medio"
        if kind == "premier" and tier == "small":
            tier = "medium"
    elif kind == "premier":
        tier = "large"
    elif kind in ("challenge", "qualifier"):
        tier = "medium"
    else:
        tier = "small"
    return {"kind": kind, "tier": tier, "players": players if players_known else None,
            "players_known": bool(players_known)}


# Iscritti stimati quando il numero reale non è noto (stime prudenti, dichiarate nella pagina "Metodo")
ASSUMED_FIELD = {"challenge": 64, "premier": 256, "qualifier": 48, "local": 16}


def field_size(players: int | None, kind: str, name: str = "") -> int:
    if players:
        return players
    if kind == "challenge" and re.search(r"challenge 64\b", name, re.I):
        return 128
    if kind == "challenge" and re.search(r"challenge 16\b", name, re.I):
        return 32
    return ASSUMED_FIELD.get(kind, 16)


def points(rank, wins, losses, tier, players=None, kind="local", name="") -> float:
    """Punti = log2(giocatori / piazzamento): quanto è RARO il risultato.
    Ogni punto è un raddoppio di difficoltà: vincere su 8 = 3, vincere su 64 = 6,
    arrivare 6° su 407 ≈ 6. Le leghe MTGO 5-0 valgono 3 (≈ 1 lista su 32 chiude 5-0)."""
    if tier == "league":
        return 3.0 if (wins or 0) >= 5 and not losses else 1.0
    field = field_size(players, kind, name)
    if rank is None:
        if wins is not None and losses is not None and wins + losses:
            return round(max(0.0, math.log2(field) * wins / (wins + losses) - 1), 2)
        return 0.5
    return round(max(0.0, math.log2(field / max(rank, 1))), 2)
