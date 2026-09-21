# Volcanobet Bingo Tracker

Prati rezultate **online bingo** kola sa [volcanobet.rs/bingo](https://www.volcanobet.rs/bingo)
(tab *Tickets* → *Results / last*) i u jednom fajlu — `data/bingo-results.json` — održava
**zadnjih 40 kola** (novija prva), uz automatsko osvežavanje **na svaki minut** (GitHub Actions).

## Kako radi

Stranica volcanobet.rs/bingo je Angular SPA čiji frontend rezultate vuče sa Xtreme/NSoft
"virtual bingo" servisa. Ova skripta ne skrejpe HTML već se direktno kači na **javni SignalR
WebSocket feed** koji i sam sajt koristi:

```
wss://virtualbingodataprovider-VolcanoRs.xtreme.bet/hubs/messagehub
```

- Nakon `SubscribeClient` hub odmah pošalje `ReceiveOfferState` — snapshot **zadnjih ~10
  završenih kola** sa kompletnim redosledom svih 35 izvučenih lopti.
- Zatim uživo stižu `ReceivePartialResult` (lopta po lopta tekućeg kola) i
  `ReceiveFullResult` (završeno kolo).
- Nema prijave ni tokena — feed je javno dostupan (isti podaci vide se i bez naloga na sajtu).
- Skripta merguje kola (bez duplikata, uvek čuva kompletniju verziju) i seče na 40.

Boja lopte se izračunava iz broja (`n % 8`), identično frontend logici:
0=purple, 1=yellow, 2=green, 3=blue, 4=red, 5=brown, 6=orange, 7=black.

## Struktura `data/bingo-results.json`

```jsonc
{
  "source": "volcanobet.rs/bingo (tab: tickets / results=last)",
  "updated_at": "2026-09-21T19:10:00.000Z",
  "rounds_count": 40,
  "rounds": [
    {
      "round_number": 302,
      "round_id": "974af645-...",
      "drawn_at": "2026-09-21T19:06:57.479Z",
      "captured_at": "2026-09-21T19:09:51.000Z",
      "ball_count": 35,
      "balls": [17, 21, 44, 2, 31, "... ostalih 30 ..."],
      "ball_colors": ["yellow", "green", "blue", "red", "brown", "..."],
      "first_five": [17, 21, 44, 2, 31],
      "last_ball": 23,
      "sweet_spot": 19,
      "sweet_spot2": 24,
      "jackpot_numbers": [10, 25, 24, 1, 23]
    }
    // ... zadnjih 40 kola, novija prva
  ],
  "live_round": { "round_number": 303, "ball_count": 12, "balls": [ /* do sada izvučene */ ] },

  "stats": {
    "computed_over_rounds": 40,
    "balls_total": 1400,
    "number_frequency": [ { "number": 7, "count": 34, "percentage": 2.4 }, "..." ],
    "top_numbers":    [ { "number": 7, "count": 34, "percentage": 2.4 }, "... top 10 ..." ],
    "cold_numbers":   [ { "number": 41, "count": 21, "percentage": 1.5 }, "... 10 najređih ..." ],
    "even_odd": { "even": 700, "odd": 700, "even_percentage": 50.0, "odd_percentage": 50.0 },
    "colors": {
      "purple": { "count": 175, "percentage": 12.5 },
      "yellow": { "count": 178, "percentage": 12.7 },
      "...": "green, blue, red, brown, orange, black"
    }
  }
}
```

## Viewer (HTML stranica)

```bash
npm run serve   # → http://localhost:8080
```

Prikazuje zadnjih 40 kola sa obojenim loptama (isti kod boja kao sajt), kolo u toku uživo,
statistiku (najčešći/najređi brojevi, parno/neparno, boje) i auto-osvežava na 60 s.
Radi i kao statička stranica na GitHub Pages — samo otvori `index.html`.

## Notifikacije (webhook) — novo kolo završeno

Postavi repo secret `BINGO_WEBHOOK_URL` (opciono `BINGO_WEBHOOK_FORMAT`) i Actions će
poslati poruku svaki put kada se pojavi novo završeno kolo. Format se detektuje automatski:

- **Discord** webhook (`discord.com/api/webhooks/...`) → `{"content": "..."}` 
- **Slack** webhook (`hooks.slack.com/...`) → `{"text": "..."}`
- **Generički** (n8n, Telegram bot proxy, vlastiti server…) → JSON `{event, round_number, balls, ...}`

Lokalno, umesto secrets:

```bash
BINGO_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm run watch
```

## Pokretanje

```bash
npm install

npm run fetch              # jedan ciklus: snapshot + sačekaj da se izvuče tekuće kolo (~6 min)
npm run fetch -- --quick   # brzi snimak (~12 s): samo zadnjih ~10 završenih kola
npm run watch              # neprekidno radi + notifikacije po svakom novom kolu
npm run serve              # viewer na http://localhost:8080
```

## GitHub Actions (auto-osvežavanje na minut)

Workflow [`.github/workflows/update-bingo.yml`](.github/workflows/update-bingo.yml):

- pokreće se **cron-om na svaki minut** (ili ručno preko *Run workflow* dugmeta),
- radi `npm ci` + `node scripts/fetch-bingo.mjs --quick`,
- commituje i pushuje `data/bingo-results.json` **samo ako se sadržaj promenio**
  (novo kolo završeno), uz `git pull --rebase` pre push-a.

Napomene:
- GitHub onemogućava scheduled workflow-e u repozitorijumima bez aktivnosti duže od 60 dana —
  povremeno nešto commitujte ili ručno pokrenite workflow.
- Cron na minut je u praksi pouzdan na ~1–5 min kašnjenja; kola se izvuku na ~4 min,
  pa to i dalje pokriva svako kolo.
