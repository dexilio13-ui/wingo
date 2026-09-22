# Volcanobet Bingo Tracker

Prati rezultate **online bingo** kola sa [volcanobet.rs/bingo](https://www.volcanobet.rs/bingo)
(tab *Tickets* → *Results / last*) i u jednom fajlu — `data/bingo-results.json` — održava
**zadnjih 120 kola** (novija prva, ≈ 7,7 h), uz automatsko osvežavanje **na svakih 5 minuta** (GitHub Actions).
Paralelno se vodi i `data/bingo-history.json` (gitignore-ovan) sa **zadnjih 300 kola (≈ 19 h)** —
zato statistika i merenje ritma izvlačenja ostaju tačni i kad se glavni JSON puni (60).

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
- Skripta merguje kola (bez duplikata, uvek čuva kompletniju verziju); glavni JSON seče na 60,
  a duža istorija ide u `data/bingo-history.json` (300).

Boja lopte se izračunava iz broja (`n % 8`), identično frontend logici:
0=purple, 1=yellow, 2=green, 3=blue, 4=red, 5=brown, 6=orange, 7=black.

## Struktura `data/bingo-results.json`

```jsonc
{
  "source": "volcanobet.rs/bingo (tab: tickets / results=last)",
  "updated_at": "2026-09-21T19:10:00.000Z",
  "rounds_count": 60,
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
    // ... zadnjih 120 kola, novija prva
  ],

  // NOVO: ritam izvlačenja i procena trenutnog kola (procena, ne garancija — pauze/održavanja pomeraju ritam)
  "rhythm": { "sample_gaps": 59, "median_ms": 228000, "p25_ms": 228000, "p75_ms": 229000, "cycle_label": "3 min 48 s" },
  "estimate": {
    "current_round_number": 361,   // koje kolo je verovatno u toku (podaci za njega još nisu u feedu)
    "next_round_number": 362,
    "next_start_estimate": "2026-09-22T20:04:00.000Z",
    "seconds_to_next_start": 95,
    "feed_age_seconds": 42,
    "stale": false
  },
  "live_round": { "round_number": 303, "ball_count": 12, "balls": [ /* do sada izvučene */ ] },

  "stats": {
    "computed_over_rounds": 60,
    "balls_total": 2100,
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

Prikazuje zadnjih 120 kola sa obojenim loptama (isti kod boja kao sajt), kolo u toku uživo,
statistiku (najčešći/najređi brojevi, parno/neparno, boje), **ritam izvlačenja** (prosečno kolo
traje **~3 min 48 s** — mereno iz podataka, uz upozorenje kad je feed zastareo) i auto-osvežava na 60 s.

**Live na GitHub Pages:** <https://dexilio13-ui.github.io/wingo/> — viewer i Wingo taktika (`wingo.html`)
rade direktno sa GitHub-a, bez lokalnog servera. Pages se automatski rebuilduje pri svakom bot commitu.

## Wingo — šta znači svako klađenje (pravila, min/max, taktika)

Wingo je Volcanobet-ova verzija popularnog **klađenja na brojeve**: runde se nižu uzastopno,
a rezultati stižu u naš `data/bingo-results.json`.

### Sistem igre u kratkim crtama

- **35 od 48:** u svakom kolu izvuče se **35 lopti od 48** (1–48); runda traje **~3 min 48 s start→start** (mereno iz feeda: medijan razmaka početaka kola; p25–p75 se prikazuje u alatu).
- **Tiket:** biraš **1–8 brojeva** (jedna kombinacija); na isti tiket možeš dodati i druga tržišta
  (sweet spot, poslednja lopta…). Više kombinacija = više uloga na tiketu.
- **Minimalna uplata: 0,50 €** po tiketu (zvanično, promo sajt Volcanobet).
- **Dobitak:** ako su **svi** tvoji brojevi među 35 izvučenih; parcijalni pogoci se plaćaju po važećem
  kvotniku runde — **uvek ga proveri u aplikaciji pre uplate**, kvote se menjaju iz runde u rundu.
- **Gold runda:** dobitak se množi (najmanje ×2). **Back-up runda:** ako nemaš pogodak, ulog ti se vraća
  (zlatna/zelena boja ekrana ih najavljuje).
- **Wingo Pinjata:** nasumični bonus — može pasti i na gubitnički tiket.
- **Jackpot:** 5 posebnih brojeva po kolu; pogodak svih nosi jackpot (mjesečno i preko 100.000 €).
  Dolazi uz redovan tiket, ne plaća se posebno.

### Tipovi klađenja i matematika (35/48)

Fer kvota = 1/verovatnoća. Realne kvote su obično 10–20% ispod fer vrednosti (marža kuće).

| Tip | Šta je | Min–max | Verovatnoća (fer kvota) | Napomena |
|---|---|---|---|---|
| **Brojevi** (glavni tip) | Tvojih 1–8 brojeva mora biti među 35 izvučenih | **1–8 brojeva** po kombinaciji, min. 0,50 € | 1: 72,9% (×1,4) · 2: 52,8% (×1,9) · 3: 37,8% (×2,6) · 4: 26,9% (×3,7) · 5: 19,0% (×5,3) · 6: 13,2% (×7,6) · 7: 9,1% (×11) · 8: 6,2% (×16) | Manje brojeva = češći manji dobici; više = redji veći |
| **Delimični pogoci** | npr. bar 4 od tvojih 6 | po kvotniku runde | bar 4/6: 80,9% · bar 5/6: 47,6% · bar 5/7: 72,2% · bar 6/8: 63,0% | Bitno za wheel garancije |
| **Prvih 5** | tvoj broj među prvih 5 lopti | obično 1–3 broja | 1 broj: 10,4% (×9,6) · 2: 0,9% (×113) · 3: 0,06% (×1729) | Mali uzorak = čista sreća, velike kvote |
| **Poslednja lopta** | koja će biti 35. (poslednja) | 1 broj | 1/48 = 2,1% (×48) | Matematički isto kao bilo koji jedan broj |
| **Sweet spot 1/2** | 2 posebna broja kola (označeni na sajtu) | 1 broj | ≈ 2/48 = 4,2% (×24) | Prati se u JSON-u (`sweet_spot`) |
| **Jackpot brojevi** | 5 posebnih brojeva, svi moraju da pogode | uz tiket | ~1 : 1,71 mil. (tačnih 5 od 48) | Bonus, ne strategija |

Ponuda tržišta se menja iz runde u rundu — gornja tabela je matematika sistema 35/48, ne zvanični kvotnik.

### Predlozi taktike

**Glavni tip (brojevi):**

1. **Drži konstantan set** — izaberi 6 brojeva i drži ih narednih 4–8 kola. Smanjuje impulsno igranje;
   tab „🎯 Drži 6” u `wingo.html` radi tačno ovo i vodi istoriju držanja.
2. **Wheel (pokrivanje)** — umesto jedne kombinacije od 6, odigraj npr. 4 kombinacije po 6 iz birice od 8
   brojeva: ako 5 od tvojih 8 izađe, bar jedna kombinacija ima 5 pogodaka. Ukupni ulog ×4, a pokrivaš varijansu.
   Tab „🧩 Kombinacije (wheel)” računa **minimalan** broj kombinacija i računski proverava garanciju
   (birica 10 i k=6, T=4 → ~10 kombinacija; birica 12 → ~29).
3. **Statistika ≠ prednost** — RNG nema memoriju; „topli/hladni” su orijentir za SOPSTVENI izbor i disciplinu,
   ne način da „nadvladaš” sistem.
4. **Bankroll** — fiksni budžet po sesiji (npr. 10 € = 20 kombinacija × 0,50 €), nikad „povraćaj” posle gubitka;
   Back-up runde koristi kao pokriće, ne kao razlog da dižeš ulog.

**Ostali tipovi:**

- **Prvih 5 / poslednja lopta** — ako ih igraš, fiksni mali ulog (0,50–1 €) odvojen od glavnog pokrivača;
  statistika `first_five`/`last_ball` iz JSON-a može pomoći pri izboru broja, ali ne menja verovatnoću.
- **Sweet spot** — bonus karakter; prati `sweet_spot`/`sweet_spot2` u JSON-u.
- **Jackpot** — ne plaćaj nikakav dodatni ulog radi njega; dolazi uz tiket.
- **Kombinovanje tržišta na tiketu** — korisno uz Back-up runde (ulog nazad), ali diže cenu tiketa;
  češće je isplativije više kombinacija glavnog tipa nego rasipanje po sporednim tržištima.

> ⚠️ Bingo/Wingo izvlačenja su RNG — prošla frekvencija ne utiče na buduća. Ovaj vodič objašnjava
> matematiku i organizaciju igre, ne garantuje dobitak. Igraj odgovorno, 18+.

## 🟢 Vodič za početnike — „nemam pojma, odakle da krenem?”

Ovo je najkraći put od „otvorio sam stranicu” do prve uplate. Sve ostale sekcije su detalji —
ovde je suština.
### Šta uopšte gledam na sajtu?

| Sekcija u alatu | Šta ti daje | Kad je koristiš |
|---|---|---|
| **⚡ Preporuka (1 klik)** | Automatski izračunatih **6 brojeva** iz zadnjih 120 kola + spremne **kombinacije** sa cenom u dinarima | **Ovo je jedino što početniku treba.** Otvori, pročitaj, odigraj. |
| **Istorija & toploga** | Sva zadnjih 120 kola + „toplotna mapa” (koji su brojevi češće izlazili) | Ako želiš sam da biraš brojeve umesto preporuke |
| **🎯 Drži 6** | Prati tvoja 6 brojeva kroz kola i piše koliko si pogodaka imao | Kad jednom počneš da igraš redovno |
| **🧩 Kombinacije (wheel)** | Napredno: veća birica (8–12 brojeva) → više kombinacija | Tek kad savladaš osnovu |
| **📖 Pravila & taktika** | Sva pravila, kvote, tipovi klađenja | Kad želiš da razumeš „zašto” |
| **⚙️ Podaci & podešavanja** | Feed URL, ručni unos kola, težine skora | Preskoči — podešeno je unapred |

### Šta znače pojmovi koje ćeš videti

- **Kolo** — jedno izvlačenje: 35 lopti od 48, traje ~3 min 48 s. Svako kolo ima broj (#507…).
- **Birica** — brojevi koje si izabrao za sebe (npr. tvojih 6).
- **Kombinacija** — tiket sa nekoliko tvojih brojeva; jedna uplata.
- **Wheel** — više kombinacija iz iste birice, raspoređenih tako da pokriju što više mogućih ishoda.
- **Garancija T=4** — ako 4+ tvojih brojeva bude izvučeno, bar jedna tvoja kombinacija ima 4 pogotka.
- **Pogodak** — tvoj broj se pojavio među 35 izvučenih. Više pogodaka = veća isplata (po kvotniku).
- **„Drži”** — ne menjaš brojeve nekoliko kola zaredom (disciplina, ne magija).

### 🎯 Primer tvoje prve igre (korak po korak, 6 brojeva, 20 din)

**Pretpostavka:** min. ulog 20 dinara po kombinaciji (zaokruženo; kvotnik u aplikaciji je autoritet).
Odlučio si: **minimum 6 kombinacija, nikad manje.**

1. **Pokreni `START-ALL.bat`** → otvara se `http://localhost:8080` → klikni **„🎯 Wingo taktika →”**.
2. Na tabu **„⚡ Preporuka”** već čeka **🟢 Početnička preporuka**: 6 brojeva + gotove kombinacije
   + ukupna cena u dinarima. Ništa ne klikćeš da bi se to pojavilo — samih par sekundi po učitavanju feeda.
3. **Odigraj tačno ono što piše:** primere iz preporuke:
   - 6 brojeva za držanje (npr. `5, 11, 19, 27, 33, 42`) — važe naredna 4 kola
   - ispod: **bar 6 kombinacija** (npr. 6 kom. po 5 brojeva iz tvojih 6)
   - cena: `6 kombinacija × 20 din = 120 din po kolu`
4. **U Volcanobet aplikaciji** (tiket → brojevi): unesi prvu kombinaciju (npr. `5, 11, 19, 27, 33`),
   ulog **20 din**, dodaj u tiket. Ponovi za svih 6 kombinacija sa liste.
5. **Potvrdi tiket pre kraja kola** — banner u alatu pokazuje „sledeće kolo za ~X min”; plasiraj pre isteka.
6. **Kad kolo završi**, feed se automatski osvežava i alat ti ispisuje pogotke po kombinacijama.
   Držanje i wheel set se prate sami — ne moraš ništa da unosiš.
7. **Sledeća 4 kola igraj ISTE brojeve** (zato postoji „📌 Drži”). Ne menjaš posle jednog lošeg kola.

**Ukupan trošak sesije od 4 kola:** 6 komb. × 20 din × 4 kola = **480 din**. To ti je ceo budžet —
kad potrošiš, gotovo. Ne uplaćuj „još samo jedno”.

**Šta da očekuješ:** 6 brojeva od 48 se pogodi u celosti retko (≈13% da su SVI među 35 izvučenih);
češće pada 3–4 pogotka, što uz wheel garantuje delimičnu isplatu. Cilj početnika: igraj izdržljivo,
mali ulozi, duže — ne „jedan veliki potes”.

**Zašto minimum 6 kombinacija?** Jedna kombinacija od 6 je „sve ili ništa”. 6 kombinacija raspoređenih
kao wheel pokriva više mogućih ishoda istim ulogom — zato alat nikad ne nudi manje od 6.

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

**Najlakše: pokreni `START-ALL.bat`** — on radi sve u pravom redosledu za igrača:

1. **fetch** — dovlači zadnjih ~10 završenih kola (~12 s) → **sveži brojevi odmah lokalno**
2. **watch + server + browser** — startuju se **odmah, bez čekanja**
3. **GitHub trigger u pozadini** — osvežava *online* feed (GitHub/Pages) dok ti ti već gledaš lokalno

Nema čekanja na GitHub Action niti na Pages deployment — lokalni podaci su prvi korak,
a GitHub osvežavanje teče u pozadini paralelno (cron na 5 min ionako radi sam po sebi).

## GitHub Actions (auto-osvežavanje na 5 min)

Workflow [`.github/workflows/update-bingo.yml`](.github/workflows/update-bingo.yml):

- pokreće se **cron-om na svakih 5 minuta** (ili ručno preko *Run workflow* dugmeta),
- radi `npm ci` + `node scripts/fetch-bingo.mjs --quick`,
- commituje i pushuje `data/bingo-results.json` **samo ako se sadržaj promenio**
  (novo kolo završeno), uz `git pull --rebase` pre push-a.

Napomene:
- GitHub onemogućava scheduled workflow-e u repozitorijumima bez aktivnosti duže od 60 dana —
  povremeno nešto commitujte ili ručno pokrenite workflow.
- Cron na 5 min u praksi kašnji do par minuta; kola se izvuku na ~3 min 48 s, a fetch svaki put
  vuče zadnjih ~10 kola, pa ništa ne propušta. Na javnom repou Actions su neograničeni.
- **Zašto je 5 min cron dovoljno:** kolo traje ~3 min 48 s, a svaki fetch vuče zadnjih ~10 završenih
  kola — čak i da cron u potpunosti propadne 3 puta zaredom (~19 min), ništa se ne propušta. Zato
  ručni trigger skraćuje čekanje samo za trenutni interval (0–5 min u proseku 2,5 min, jer se novi
  podaci i inače dovuče pri sledećem ciklusu), a ne za nekoliko minuta.
- **Cron vs. trajanje kola:** ovaj workflow je „ kratki pull”: radi ~20–40 s, čeka se samo dok se
  ne poveže na hub (pa pogleda da li je tekuće kolo završeno). Ako je tekuće kolo usred izvlačenja,
  quick-mode samo snimi trenutno stanje i završi — sledeći cron (za max 5 min) pokupi kolo.
  Zato propušteno nijedno kolo ne ostaje, a čekanje „do runde #X” u alatu uvek proverava i
  starost feeda (upozorenje „procenjeno vreme je već isteklo” znači: feed je zastareo, klikni ↻).

## Automatizacija "na klik"

- **Feed se sam popuni** — u Wingo taktici (`wingo.html` → ⚙️ Podaci & podešavanja) podrazumevani
  feed je `https://raw.githubusercontent.com/dexilio13-ui/wingo/refs/heads/main/data/bingo-results.json`;
  ne moraš ništa da kucaš ručno. Radi i lokalno i na GitHub Pages-u.
- **"↻ Osveži" pokreće i GitHub Action** — viewer (lokalno na :8080) uz osvežavanje feed-a
  poziva i `http://localhost:8080/trigger`, a lokalni agent (`npm run trigger`) pokreće workflow
  na GitHub-u. Novo kolo stiže u feed za ~1–2 min bez ikakvog ručnog koraka.
  Sa GitHub tokenom (⚙ dugme u vieweru, čuva se samo lokalno) radi i sa GitHub Pages-a, bez lokalnog servera.
- **Ručni trigger sa lokala:** `npm run trigger` (dodaj `-- --wait` da sačekaš kraj i vidiš status).
- **START-ALL.bat** radi ceo tok za igrača: fetch (sveži brojevi) → watch/server/browser **odmah** →
  trigger workflow-a u pozadini (bez čekanja na Actions/Pages — lokalno je sveže pre GitHub-a).
