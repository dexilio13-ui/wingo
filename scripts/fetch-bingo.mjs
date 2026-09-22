// Volcanobet online bingo — scraper rezultata kola.
//
// Kako radi:
//  - www.volcanobet.rs/bingo je Angular SPA; njegov frontend (Xtreme/NSoft "virtual bingo")
//    rezultate dobija preko javnog SignalR WebSocket huba:
//      https://virtualbingodataprovider-VolcanoRs.xtreme.bet/hubs/messagehub
//    (podaci sa te stranice su javno dostupni i bez prijave; ova skripta ne koristi
//    nikakve naloge, tokene ni autentifikaciju — samo očitava javni feed).
//  - Nakon "SubscribeClient" hub odmah pošalje "ReceiveOfferState" sa zadnjih ~10
//    procesuiranih kola (kompletan redosled 35 izvučenih lopti), a zatim uživo
//    "ReceivePartialResult" (lopta po lopta) i "ReceiveFullResult" za svako novo kolo.
//  - Skripta merguje kola u data/bingo-results.json, drži zadnjih MAX_ROUNDS (40)
//    i u "stats" bloku održava statistiku (frekvencija brojeva, parno/neparno, boje).
//  - Boja lopte je deterministički izvedena iz broja (n % 8), isto kao u frontendu.
//  - Ako je podešen webhook (env: BINGO_WEBHOOK_URL, opciono BINGO_WEBHOOK_FORMAT),
//    šalje notifikaciju svaki put kada se u JSON doda novo (ranije neviđeno) kolo.
//
// Pokretanje:
//   npm run fetch                          # jedan ciklus: snapshot + čekaj tekuće kolo (~6 min)
//   npm run fetch -- --quick               # brzi snimak bez čekanja (CI mod)
//   npm run watch                          # neprekidno + notifikacije po novom kolu
//   BINGO_WEBHOOK_URL=... npm run watch    # + Discord/Slack/generički webhook

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as signalR from "@microsoft/signalr";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "bingo-results.json");

const HUB_URL = "https://virtualbingodataprovider-VolcanoRs.xtreme.bet/hubs/messagehub";
// Vrednosti iz javnog FetchConfiguration odgovora za VolcanoRs tenant.
const NULL_GUID = "00000000-0000-0000-0000-000000000000";

const MAX_ROUNDS = 120;         // koliko kola čuvamo u JSON-u (120 kola ≈ 7,7 h istorije; hub vraća ~10, ostatak se akumulira)
const SOURCE_LABEL = "volcanobet.rs/bingo (tab: tickets / results=last)";
const WATCH = process.argv.includes("--watch");
const QUICK = process.argv.includes("--quick"); // bez čekanja na tekuće kolo (CI)

const WEBHOOK_URL = process.env.BINGO_WEBHOOK_URL || "";
const WEBHOOK_FORMAT = (process.env.BINGO_WEBHOOK_FORMAT || "auto").toLowerCase(); // auto|discord|slack|generic

// ── Baza podataka: istorija preko 120 kola (za tačnu statistiku i ritam izvlačenja) ──
const HISTORY_FILE = path.join(DATA_DIR, "bingo-history.json");
const HISTORY_LIMIT = 300; // ~19 h istorije za analizu

function readHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(raw.rounds) ? raw.rounds : [];
  } catch {
    return []; // prvo pokretanje — samo napred se beleži
  }
}

function writeHistory(rounds) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify({
      note: "sporedni artefakt (gitignore-ovan): duža istorija preko 120 kola za analizu",
      rounds_count: rounds.length,
      rounds,
    }, null, 2) + "\n",
    "utf8"
  );
}

/** Gap između početaka kola (start-to-start) iz istorije — osnova za ritam i procenu trenutnog kola. */
function computeRhythm(rounds) {
  const rs = rounds.filter((r) => r.round_number != null && r.drawn_at)
    .sort((a, b) => a.round_number - b.round_number);
  const gaps = [];
  for (let i = 1; i < rs.length; i++) {
    const dt = new Date(rs[i].drawn_at) - new Date(rs[i - 1].drawn_at);
    if (Number.isFinite(dt) && dt > 0 && dt < 30 * 60_000) gaps.push(dt); // ignoriši pauze/održavanja ≥ 30 min
  }
  if (!gaps.length) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  return {
    sample_gaps: gaps.length,
    median_ms: Math.round(med),
    p25_ms: Math.round(p25),
    p75_ms: Math.round(p75),
    updated_at: nowIso(),
  };
}

// n % 8 — identična logika boje lopte kao u volcanobet frontendu (BallColorPipe)
const BALL_COLORS = ["purple", "yellow", "green", "blue", "red", "brown", "orange", "black"];
const ballColor = (n) => BALL_COLORS[n % 8];

const nowIso = () => new Date().toISOString();

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (Array.isArray(raw.rounds)) return raw;
  } catch {
    /* prvo pokretanje */
  }
  return {
    source: SOURCE_LABEL,
    updated_at: null,
    rounds_count: 0,
    rounds: [], // newest first
    stats: null,
  };
}

/* ── Procena trenutnog kola (ritam izvlačenja) ─────────────────────────── */

const fmtMs = (ms) => `${Math.floor(ms / 60_000)} min ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")} s`;

/**
 * Na osnovu ritma (medijan start→start) i zadnjeg zabeleženog kola procenjuje:
 *  - koje kolo je verovatno TRENUTNO u toku (podaci za njega još nisu u feedu),
 *  - kada (okvirno) počinje sledeće kolo i koliko sekundi do tada,
 *  - da li je feed zastareo (npr. cron nije radio).
 * Ovo je procena za orijentaciju („čekaj do runde #X, to je za ~3 min”), ne garancija —
 * pauze/održavanja pomeraju ritam (vidi p25/p75).
 */
function estimateCurrentRound(rhythm, lastRound, feedUpdatedIso) {
  if (!rhythm || !lastRound || lastRound.drawn_at == null) return null;
  const med = rhythm.median_ms || 228_000;
  const start = new Date(lastRound.drawn_at).getTime();
  if (!Number.isFinite(start)) return null;
  const now = Date.now();
  const elapsed = now - start;
  const k = Math.max(0, Math.floor(elapsed / med)); // koliko punih ciklusa je prošlo od zadnjeg kola
  const currentRound = lastRound.round_number + k;
  const nextStart = start + (k + 1) * med;
  const feedAgeS = feedUpdatedIso ? Math.max(0, Math.round((now - new Date(feedUpdatedIso).getTime()) / 1000)) : null;
  return {
    current_round_number: currentRound,
    current_round_in_progress: elapsed - k * med < med - 20_000, // izvlačenje zauzima veći deo ciklusa
    next_round_number: currentRound + 1,
    next_start_estimate: new Date(nextStart).toISOString(),
    seconds_to_next_start: Math.max(0, Math.round((nextStart - now) / 1000)),
    cycle_ms: med,
    cycle_label: fmtMs(med),
    feed_age_seconds: feedAgeS,
    stale: feedAgeS != null && feedAgeS > 2.5 * med + 60_000, // nema novog kola > ~2,5 ciklusa
    generated_at: nowIso(),
  };
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store.rounds_count = store.rounds.length;
  store.updated_at = nowIso();
  store.stats = computeStats(store.rounds);
  // ritam + procena trenutnog kola (istorija preko 120 kola → stabilnija procena)
  const rhythm = computeRhythm(readHistory().concat(store.rounds));
  if (rhythm) {
    rhythm.cycle_label = fmtMs(rhythm.median_ms);
    store.rhythm = rhythm;
    store.estimate = estimateCurrentRound(rhythm, store.rounds[0], store.updated_at);
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/* ── Statistika za zadnjih MAX_ROUNDS kola ─────────────────────────────── */

function computeStats(rounds) {
  const numberCounts = new Map();
  const colorCounts = {};
  for (const c of BALL_COLORS) colorCounts[c] = 0;

  let odd = 0, even = 0;
  let ballTotal = 0;

  for (const r of rounds) {
    const balls = Array.isArray(r.balls) ? r.balls : [];
    for (const n of balls) {
      ballTotal++;
      numberCounts.set(n, (numberCounts.get(n) || 0) + 1);
      if (n % 2 === 0) even++; else odd++;
      colorCounts[ballColor(n)]++;
    }
  }

  const numberFrequency = [...numberCounts.entries()]
    .map(([number, count]) => ({
      number,
      count,
      percentage: ballTotal ? Math.round((count / ballTotal) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count || a.number - b.number);

  const topNumbers = numberFrequency.slice(0, 10);
  const coldNumbers = numberFrequency.slice(-10).reverse();

  return {
    computed_over_rounds: rounds.length,
    balls_total: ballTotal,
    number_frequency: numberFrequency,
    top_numbers: topNumbers,
    cold_numbers: coldNumbers,
    even_odd: {
      even, odd,
      even_percentage: ballTotal ? Math.round((even / ballTotal) * 1000) / 10 : 0,
      odd_percentage: ballTotal ? Math.round((odd / ballTotal) * 1000) / 10 : 0,
    },
    colors: Object.fromEntries(
      Object.entries(colorCounts).map(([c, n]) => [
        c,
        { count: n, percentage: ballTotal ? Math.round((n / ballTotal) * 1000) / 10 : 0 },
      ])
    ),
    updated_at: nowIso(),
  };
}

/* ── Normalizacija podataka ────────────────────────────────────────────── */

/** Kompletan rezultat jednog kola -> naš normalizovani format. */
function normalizeRound(r) {
  const res = r.result || {};
  const balls = Array.isArray(res.ballNumbers) ? res.ballNumbers : [];
  return {
    round_number: r.number ?? res.roundNumber ?? null,
    round_id: r.roundId || res.roundId || null,
    drawn_at: r.startDatetime || null,
    captured_at: nowIso(),
    ball_count: balls.length,
    balls: balls,
    ball_colors: balls.map(ballColor),
    first_five: Array.isArray(res.firstFiveNumbers) ? res.firstFiveNumbers : balls.slice(0, 5),
    last_ball: balls.length ? balls[balls.length - 1] : null,
    sweet_spot: res.sweetSpot1 ?? null,
    sweet_spot2: res.sweetSpot2 ?? null,
    jackpot_numbers: Array.isArray(res.jackpotNumbers) ? res.jackpotNumbers : [],
  };
}

/** Kratki "snapshot" nepotpunog (kola u toku) — čuvamo ga odvojeno, ne u rounds. */
function normalizePartial(p) {
  return {
    round_number: p.number ?? null,
    round_id: p.roundId || null,
    drawn_at: null,
    captured_at: nowIso(),
    ball_count: Array.isArray(p.ballNumbers) ? p.ballNumbers.length : 0,
    balls: Array.isArray(p.ballNumbers) ? p.ballNumbers : [],
  };
}

/**
 * Merguje kola; vraća listu NOVIH (ranije neviđenih) kompletnih kola —
 * koristi se za webhook notifikacije.
 */
function mergeRounds(store, incomingRounds) {
  // istorija (data/bingo-history.json, gitignore-ovana) — da statistika/ritam
  // ostanu tačni i preko 120 kola, a glavni JSON ostane mali i brz
  const history = readHistory();
  const histByNo = new Map(history.map((r) => [r.round_number, r]));
  for (const h of store.rounds) if (!histByNo.has(h.round_number)) histByNo.set(h.round_number, h);

  const known = new Set(store.rounds.map((r) => r.round_number));
  const byNumber = new Map(store.rounds.map((r) => [r.round_number, r]));
  const added = [];

  for (const raw of incomingRounds) {
    const norm = normalizeRound(raw);
    if (norm.round_number == null || norm.ball_count === 0) continue;
    const prev = byNumber.get(norm.round_number);
    // zameni samo ako je novi podatak kompletniji (npr. 35/35 lopti)
    if (!prev || norm.ball_count >= prev.ball_count) {
      byNumber.set(norm.round_number, norm);
      if (!known.has(norm.round_number) && norm.ball_count >= 35) added.push(norm);
    }
  }

  store.rounds = [...byNumber.values()]
    .sort((a, b) => b.round_number - a.round_number)
    .slice(0, MAX_ROUNDS);

  // upiši sva (i starija) kola u istoriju preko MAX_ROUNDS
  for (const r of byNumber.values()) if (!histByNo.has(r.round_number)) histByNo.set(r.round_number, r);
  writeHistory([...histByNo.values()].sort((a, b) => b.round_number - a.round_number).slice(0, HISTORY_LIMIT));

  return added;
}

/* ── Webhook notifikacije (Discord / Slack / generički) ────────────────── */

function detectWebhookFormat(url) {
  if (WEBHOOK_FORMAT !== "auto") return WEBHOOK_FORMAT;
  if (url.includes("discord.com/api") || url.includes("discordapp.com")) return "discord";
  if (url.includes("hooks.slack.com")) return "slack";
  return "generic";
}

function formatMessage(round, totalRounds) {
  const first5 = round.first_five?.join(", ") ?? "";
  const sweet = [round.sweet_spot, round.sweet_spot2].filter((x) => x != null).join(" i ");
  const jp = round.jackpot_numbers?.length ? ` | jackpot: ${round.jackpot_numbers.join(", ")}` : "";
  return (
    `🎱 Bingo kolo #${round.round_number} završeno!\n` +
    `Lopte: ${round.balls.join(", ")}\n` +
    `Prvih 5: ${first5} | poslednja: ${round.last_ball} | sweet spot: ${sweet}${jp}\n` +
    `Ukupno praćeno kola: ${totalRounds}`
  );
}

async function sendWebhook(round, totalRounds) {
  if (!WEBHOOK_URL) return;
  const format = detectWebhookFormat(WEBHOOK_URL);
  const text = formatMessage(round, totalRounds);

  let payload;
  if (format === "discord") {
    payload = { content: "```" + text + "```" };
  } else if (format === "slack") {
    payload = { text: "```" + text + "```" };
  } else {
    payload = {
      text,
      event: "round_finished",
      round_number: round.round_number,
      balls: round.balls,
      drawn_at: round.drawn_at,
      total_rounds: totalRounds,
      source: SOURCE_LABEL,
    };
  }

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`[${nowIso()}] webhook vratio HTTP ${res.status}`);
    else console.log(`[${nowIso()}] webhook poslat (kolo #${round.round_number})`);
  } catch (err) {
    console.error(`[${nowIso()}] webhook greška:`, err?.message || err);
  }
}

/* ── Glavni ciklus ─────────────────────────────────────────────────────── */

async function connectAndCapture({ waitMs }) {
  const store = readStore();
  const conn = new signalR.HubConnectionBuilder()
    .withUrl(HUB_URL)
    .configureLogging(signalR.LogLevel.Error)
    .build();

  let resolved = false;
  let fullResults = 0;
  let latestPartial = null;
  const newRounds = [];

  conn.on("ReceiveOfferState", (state) => {
    // Inicijalni snapshot: zadnjih ~10 procesuiranih kola + predstojeća kola.
    newRounds.push(...mergeRounds(store, state?.processedRounds || []));
    if (!resolved && QUICK) finish();
  });

  conn.on("ReceiveFullResult", (res) => {
    // Završeno kolo uživo (isti oblik kao processedRounds[].result).
    fullResults++;
    newRounds.push(...mergeRounds(store, [{ roundId: res.roundId, number: res.roundNumber, result: res }]));
    if (!resolved && !QUICK && fullResults >= 1) finish();
  });

  conn.on("ReceivePartialResult", (p) => {
    latestPartial = normalizePartial(p);
    if (!resolved && !QUICK && latestPartial.ball_count >= 35) {
      // fallback: ako FullResult kasni, imamo svih 35 lopti ovde
      finish();
    }
  });

  function finish() {
    if (resolved) return;
    resolved = true;
    store.live_round = latestPartial; // kolo u toku (može biti null)
    writeStore(store);
    const last = store.rounds[0];
    console.log(
      `[${nowIso()}] sačuvano: ${store.rounds.length} kola (limit ${MAX_ROUNDS}); ` +
      `zadnje kolo #${last?.round_number} (${last?.ball_count} lopti)` +
      (latestPartial ? `; uživo #${latestPartial.round_number}: ${latestPartial.ball_count}/35` : "")
    );
    // Notifikacije samo za kola koja su tek završena (u watch/režimu sa webhook-om),
    // ne za inicijalni backlog pri prvom pokretanju.
    for (const r of newRounds.sort((a, b) => a.round_number - b.round_number)) {
      void sendWebhook(r, store.rounds.length);
    }
  }

  await conn.start();
  await conn.invoke("SubscribeClient", NULL_GUID);

  // Glavni timeout ciklusa
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  finish();
  try { await conn.stop(); } catch { /* ignore */ }
  return store;
}

async function main() {
  const waitMs = QUICK ? 12_000 : 6 * 60_000; // kola se vuku ~4 min; 6 min pokrije i tekuće
  if (WEBHOOK_URL) {
    console.log(`[${nowIso()}] webhook aktivan (format: ${detectWebhookFormat(WEBHOOK_URL)})`);
  }
  do {
    try {
      await connectAndCapture({ waitMs });
    } catch (err) {
      console.error(`[${nowIso()}] greška:`, err?.message || err);
      if (!WATCH) process.exitCode = 1;
    }
    if (!WATCH) break;
    // mali predah pre sledećeg ciklusa u watch modu
    await new Promise((r) => setTimeout(r, 15_000));
  } while (WATCH);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
