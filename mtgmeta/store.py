"""Archivio grezzo normalizzato: un file JSON per torneo in data/tournaments/<fonte>/<anno>/<mese>/.

Formato (uguale per tutte le fonti):
{
  "id": "melee.gg:modern-rcq-...", "source": "melee.gg", "name": "...", "date": "2026-11-22",
  "format": "Modern", "type": "paper" | "online", "url": "...", "players": 64 | null,
  "decks": [{"player": "...", "result": "1st Place", "url": "...", "source_archetype": null,
             "main": [[4, "Lightning Bolt"], ...], "side": [[2, "Blood Moon"], ...]}]
}
Testo JSON = diff leggibili su git e salvataggio incrementale (append-only).
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TOURNAMENTS = DATA / "tournaments"
STATE_FILE = DATA / "state.json"


def tournament_path(source: str, date: str, slug: str) -> Path:
    y, m = date[:4], date[5:7]
    return TOURNAMENTS / source / y / m / f"{slug}.json"


def save_tournament(t: dict, slug: str) -> Path:
    p = tournament_path(t["source"], t["date"], slug)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(t, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return p


def iter_tournaments():
    for p in sorted(TOURNAMENTS.rglob("*.json")):
        try:
            yield json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"[warn] file corrotto ignorato: {p}")


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")
