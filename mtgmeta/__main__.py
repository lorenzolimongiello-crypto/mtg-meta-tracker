"""Uso:
  python -m mtgmeta update [--days 3] [--mtgtop8-requests 200] [--no-mtgtop8]
  python -m mtgmeta build  [--site-days 90]
  python -m mtgmeta all    (update + build: è quello che gira ogni 12 ore)
"""
from __future__ import annotations

import argparse
import time

from . import archetypes, build, store
from .sources import decklistcache, mtgtop8


def cmd_update(a) -> None:
    state = store.load_state()
    t0 = time.time()
    try:
        n = decklistcache.fetch(a.days, state)
        print(f"[update] MTGODecklistCache: {n} tornei aggiornati")
        store.save_state(state)
        if not a.no_mtgtop8:
            n = mtgtop8.fetch(state, max_requests=a.mtgtop8_requests, days=max(a.days, a.mtgtop8_days))
            print(f"[update] MTGTop8: {n} tornei nuovi")
    finally:
        store.save_state(state)
    archetypes.download_format_data()  # regole archetipi sempre aggiornate
    print(f"[update] completato in {time.time() - t0:.0f}s")


def main() -> None:
    p = argparse.ArgumentParser(prog="mtgmeta")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("update", "all"):
        s = sub.add_parser(name)
        s.add_argument("--days", type=int, default=3, help="giorni indietro da controllare (backfill iniziale: 60-90)")
        s.add_argument("--mtgtop8-days", type=int, default=21)
        s.add_argument("--mtgtop8-requests", type=int, default=200, help="tetto richieste MTGTop8 (5s l'una)")
        s.add_argument("--no-mtgtop8", action="store_true")
    for name in ("build", "all"):
        s = sub.choices[name] if name in sub.choices else sub.add_parser(name)
        s.add_argument("--site-days", type=int, default=90, help="giorni di liste caricati nel sito")
    a = p.parse_args()
    if a.cmd in ("update", "all"):
        cmd_update(a)
    if a.cmd in ("build", "all"):
        build.build(a.site_days)


if __name__ == "__main__":
    main()
