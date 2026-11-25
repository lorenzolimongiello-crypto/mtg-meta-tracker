# MTG Meta Tracker

Sito statico che raccoglie le liste dei tornei di Magic: The Gathering, sia online sia cartacei, per
tutti i formati. Le liste vengono classificate per archetipo e il sito mostra la **composizione** di
ogni archetipo: % di liste che giocano ogni carta, copie medie, distribuzione 1-2-3-4, carte core,
flex e tech, sideboard, lista media e confronto della singola lista con il suo archetipo.
Si aggiorna da solo **ogni 12 ore** con GitHub Actions ed è pubblicato gratis su GitHub Pages.

## Fonti

| Fonte | Cosa copre | Come |
|---|---|---|
| mtgo.com | Challenge, League 5-0, Showcase (online) | tramite [MTGODecklistCache](https://github.com/Jiliac/MTGODecklistCache) |
| Melee.gg, Topdeck.gg, CardsRealm, GetPaird | RCQ, Regional, grandi eventi cartacei | tramite MTGODecklistCache |
| MTGTop8 | tornei cartacei locali (molti italiani ed europei) | scraper proprio, 1 richiesta ogni 5 s come da robots.txt |

- Gli eventi MTGO presenti anche su MTGTop8 vengono saltati.
- Le liste identiche, stesso formato e stesso giorno, arrivate da fonti diverse vengono scartate come duplicati.

Gli archetipi vengono riconosciuti con le regole pubbliche di [MTGOFormatData](https://github.com/Badaro/MTGOFormatData)
(Standard, Pioneer, Modern, Legacy, Vintage, Pauper). Nei formati Commander l'archetipo è il comandante.
Le liste non riconosciute vengono raggruppate per colori, es. "Izzet (Other)". Puoi aggiungere regole
tue in [`rules/`](rules/README.md).

## Struttura

```
mtgmeta/
  sources/decklistcache.py   raccolta da MTGODecklistCache (API GitHub + raw, incrementale)
  sources/mtgtop8.py         scraper MTGTop8
  archetypes.py              classificatore (regole, varianti, fallback, colori)
  build.py                   SQLite + CSV + JSON per il sito
web/                         frontend (HTML/CSS/JS vanilla, statistiche calcolate nel browser)
data/tournaments/            archivio grezzo: un JSON per torneo (salvato nel repo a ogni aggiornamento)
site/                        output generato (non versionato)
```

## Dati lavorabili

Ogni build pubblica in `site/data/export/`:
- `mtg-meta.sqlite`: tabelle `tournaments`, `decks`, `cards`, `deck_cards`, più le viste
  `v_deck_cards` (una riga per carta per lista) e `v_archetype_card_stats` (composizione degli archetipi);
- `decks.csv`, `deck_cards.csv`, `archetype_card_stats.csv`, `tournaments.csv`, che si aprono in Excel o pandas.

Esempio di query: le carte flex di Boros Energy in Modern.

```sql
SELECT card, inclusion_pct, avg_copies FROM v_archetype_card_stats
WHERE format='Modern' AND archetype='Boros Energy' AND board='main'
  AND inclusion_pct BETWEEN 30 AND 90 ORDER BY inclusion_pct DESC;
```

## Uso in locale

Serve Python 3.10 o superiore, senza dipendenze esterne.

```bash
python -m mtgmeta update --days 7          # scarica gli ultimi 7 giorni (+ MTGTop8)
python -m mtgmeta build                    # classifica e genera site/
python -m http.server 8000 -d site         # apri http://localhost:8000
```

Opzioni utili:
- `--no-mtgtop8` salta MTGTop8.
- `--mtgtop8-requests 50` limita il tempo speso su MTGTop8.
- `--site-days 90` imposta quanti giorni di liste vengono caricati nel sito.

## Pubblicazione su GitHub (aggiornamento automatico ogni 12 ore)

1. Crea un repository su GitHub e carica questa cartella.
2. **Settings → Pages → Source: GitHub Actions**.
3. **Actions → "Aggiorna dati e sito" → Run workflow** con `days = 90` per il primo riempimento.
4. Da lì in poi il workflow gira da solo alle 05:17 e alle 17:17 UTC. Scarica i tornei nuovi, li salva
   nel repo, rigenera il sito e lo pubblica su `https://<utente>.github.io/<repo>/`.
