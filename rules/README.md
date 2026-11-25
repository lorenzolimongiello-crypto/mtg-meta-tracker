# Regole archetipi personali

Metti qui le tue regole, in una cartella per formato (`rules/Modern/`, `rules/Standard/`, ...).
Hanno **priorità** su quelle ufficiali di MTGOFormatData. Sono utili quando nasce un archetipo nuovo
che le regole ufficiali non conoscono ancora, cioè quando nel sito compaiono gruppi come "Izzet (Other)".

Esempio `rules/Standard/IzzetProwess.json`:

```json
{
  "Name": "Prowess",
  "IncludeColorInName": true,
  "Conditions": [
    { "Type": "InMainboard", "Cards": ["Monastery Swiftspear"] },
    { "Type": "OneOrMoreInMainboard", "Cards": ["Slickshot Show-Off", "Stormchaser's Talent"] }
  ]
}
```

Tipi di condizione supportati:
- `InMainboard`, `InSideboard`, `InMainOrSideboard`: richiedono **tutte** le carte elencate.
- `OneOrMoreIn...`, `TwoOrMoreIn...`: richiedono almeno 1 o almeno 2 delle carte elencate.
- `DoesNotContain`, `DoesNotContainMainboard`, `DoesNotContainSideboard`: escludono le liste con quelle carte.

Si possono aggiungere anche delle `Variants`, con lo stesso formato.
