"use strict";
/* Wingo — bingo taktika. Lokalni alat; podaci ostaju u localStorage.
 * Logika: statistika za zadnjih N kola + heurističke preporuke („drži 6”)
 * + egzaktni covering-wheel (greedy + provera garancije).
 * Napomena: RNG igre nemaju memoriju — alat je organizator igre, ne predskazivač.
 */

const BALL_COLORS = ["purple","yellow","green","blue","red","brown","orange","black"];
const ballColor = (n) => BALL_COLORS[n % 8];
const LIGHT = new Set(["yellow", "orange"]);

/* ── Ritam izvlačenja (sa feeda: rhythm/estimate blokovi) ──────────────── */

const CYCLE_MS = 228_000; // medijan 3 min 48 s po kolu (mereno iz feeda)
const DEFAULT_RHYTHM = { median_ms: CYCLE_MS, p25_ms: CYCLE_MS, p75_ms: CYCLE_MS, cycle_label: "3 min 48 s", sample_gaps: 0 };

function getRhythm() {
  const r = state.feedInfo?.rhythm;
  return (r && r.median_ms) ? r : DEFAULT_RHYTHM;
}

const fmtDur = (ms) => `${Math.floor(ms / 60_000)} min ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")} s`;

/** Vreme (s) do početka zadatog kola; negativno = kolo je već počelo/ranije. */
function secondsToRound(targetRound, rhythm = getRhythm()) {
  const last = state.rounds[0];
  if (!last?.drawn_at) return null;
  const med = rhythm.median_ms || CYCLE_MS;
  const elapsedMs = Date.now() - new Date(last.drawn_at).getTime();
  const roundsAhead = targetRound - last.round_number;
  const eta = roundsAhead * med - elapsedMs;
  return Math.round(eta / 1000);
}

/** Ljudski opis do zadatog kola + upozorenje ako je procenjeno vreme već isteklo. */
function etaLabel(targetRound) {
  const s = secondsToRound(targetRound);
  if (s == null) return "vreme zadnjeg kola nije poznato";
  if (s <= -120) return `procenjeno vreme je već prošlo (${fmtDur(-s * 1000)} ranije) — feed je verovatno zastareo, klikni „↻ Feed”`;
  if (s <= 0) return `procenjeno vreme je već isteklo (${fmtDur(-s * 1000)} ranije) — proveri feed`;
  return `za ~${fmtDur(s * 1000)}${s > 600 ? " (duži period — verovatno pauza/održavanje)" : ""}`;
}

/** Procena trenutnog kola (ritam). Server-side estimate sa feeda ima prednost. */
function estimateCurrentRound() {
  const est = state.feedInfo?.estimate;
  if (est?.current_round_number) return est;
  const last = state.rounds[0];
  if (!last?.drawn_at) return null;
  const med = getRhythm().median_ms || CYCLE_MS;
  const elapsed = Date.now() - new Date(last.drawn_at).getTime();
  const k = Math.max(0, Math.floor(elapsed / med));
  return { current_round_number: last.round_number + k, next_round_number: last.round_number + k + 1,
           seconds_to_next_start: Math.max(0, Math.round(((k + 1) * med - elapsed) / 1000)),
           cycle_label: getRhythm().cycle_label, feed_age_seconds: null, stale: false, estimate: true };
}

/** Da li je kolo #no već (po proceni) izvučeno — koriguje „još N kola” kad feed kasni. */
function roundProbablyDrawn(no) {
  const est = estimateCurrentRound();
  return est ? no <= est.current_round_number : false;
}

// Podrazumevani feed: live JSON iz ovog repoa (radi lokalno i na GitHub Pages-u).
// Ne moraš ništa da kucaš ručno u „Podaci & podešavanja” — automatski se koristi.
const DEFAULT_FEED_URL =
  "https://raw.githubusercontent.com/dexilio13-ui/wingo/refs/heads/main/data/bingo-results.json";

// Ostalo u repo-u (za linkove u „Podaci & podešavanja”).
const REPO = "dexilio13-ui/wingo";
const WORKFLOW_FILE = "update-bingo.yml";

const LS = {
  feedUrl: "wingo.feedUrl",
  manual: "wingo.manualRounds",
  settings: "wingo.settings",
  held: "wingo.held",
  wheel: "wingo.wheel",
  seenRound: "wingo.seenRound",
  ghToken: "wingo.ghToken",
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2200);
}

function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function load(k, dflt) {
  try { const v = JSON.parse(localStorage.getItem(k)); return v ?? dflt; }
  catch { return dflt; }
}

/* ── Stanje ─────────────────────────────────────────────────────────────── */

const state = {
  rounds: [],        // [{round_number, drawn_at, balls:[...], ball_count}] newest first
  live: null,        // {round_number, balls}
  feedInfo: null,    // {updated_at, source}
  selected: new Set(), // brojevi iz toplotne mape → birica
  wheelResult: null, // {pool, k, t, combos, payin}
};

/* ── Ball rendering ─────────────────────────────────────────────────────── */

function ballEl(num, { sm = false, xs = false, clickable = false } = {}) {
  const b = el("span", "ball" + (sm ? " sm" : "") + (xs ? " xs" : "") + (LIGHT.has(ballColor(num)) ? " light" : ""));
  b.style.background = `var(--c-${ballColor(num)})`;
  b.textContent = num;
  b.title = `${num} — ${ballColor(num)}`;
  if (clickable) {
    b.style.cursor = "pointer";
    b.addEventListener("click", () => toggleSelect(num));
    if (state.selected.has(num)) b.style.outline = "2px solid var(--accent)";
  }
  return b;
}

function ballsRow(balls, opts) {
  const r = el("div", "balls");
  (balls || []).forEach((n) => r.appendChild(ballEl(n, opts)));
  return r;
}

/* ── Statistika ─────────────────────────────────────────────────────────── */

function analyze(rounds, universe, depth) {
  const use = rounds.slice(0, depth);
  const counts = new Map();
  const lastSeen = new Map(); // broj -> koliko kola unazad je poslednji put izašao
  const colors = {};
  for (const c of BALL_COLORS) colors[c] = 0;

  let balls = 0, even = 0, odd = 0;

  use.forEach((r, idx) => {
    for (const n of r.balls) {
      balls++;
      counts.set(n, (counts.get(n) || 0) + 1);
      if (n % 2 === 0) even++; else odd++;
      colors[ballColor(n)]++;
      if (!lastSeen.has(n)) lastSeen.set(n, idx); // idx = "kola unazad"
    }
  });

  const numbers = [];
  for (let n = 1; n <= universe; n++) {
    const cnt = counts.get(n) || 0;
    const gap = lastSeen.has(n) ? lastSeen.get(n) : use.length; // kola bez pojavljivanja
    numbers.push({
      number: n, count: cnt,
      freq: balls ? cnt / balls : 0,
      gap,
      expectedGap: balls ? Math.max(1, universe / 35) : 1, // gruba očekivana prosečna pauza
    });
  }
  numbers.sort((a, b) => b.count - a.count || a.gap - b.gap || a.number - b.number);

  const maxCount = numbers[0]?.count || 1;
  // skorovi normalizovani na [0..1] pa množeni težinama
  const maxGap = Math.max(...numbers.map((n) => n.gap), 1);
  const setW = getWeights();
  for (const n of numbers) {
    n.hotScore = n.count / maxCount;
    n.gapScore = n.gap / maxGap;
  }

  const rep = use[1] ? use[0].balls.filter((n) => use[1].balls.includes(n)) : [];

  return {
    use, numbers, counts, lastSeen,
    ballsTotal: balls, even, odd,
    colors,
    repeated: rep,
    maxCount, maxGap, weights: setW,
  };
}

function getWeights() {
  return {
    hot: +($("#wHot").value || 1),
    gap: +($("#wGap").value || 0.6),
    rep: +($("#wRep").value || 1.3),
    cold: +($("#wCold").value || 0.5),
  };
}

function combinedScore(n, repeated, w) {
  let s = w.hot * n.hotScore + w.gap * n.gapScore;
  if (repeated.includes(n.number)) s += w.rep;
  if (n.count === 0) s += w.cold * n.gapScore; // nagrađuj i "dospelo-neradjanje" hladnih ako je uključeno
  return s;
}

/* ── Tabovi (sa istorijom: browser Back/Forward radi između tabova) ────── */

function activateTab(name) {
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (!btn) return false;
  document.querySelectorAll(".tab-btn").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
  $("#panel-" + name).classList.add("active");
  return true;
}

document.querySelectorAll(".tab-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (!activateTab(b.dataset.tab)) return;
    // zabeleži u istoriju browsera da ← Back prebacuje nazad na prethodni tab
    const target = "#" + b.dataset.tab;
    if (location.hash !== target) history.pushState({ tab: b.dataset.tab }, "", target);
  });
});

// Back/Forward dugme browsera (i ručna promena hash-a)
function onHistoryNav() {
  const name = location.hash.slice(1);
  if (name && document.getElementById("panel-" + name)) activateTab(name);
}
window.addEventListener("popstate", onHistoryNav);
window.addEventListener("hashchange", onHistoryNav);

/* ── Feed (automatski) ──────────────────────────────────────────────────── */

function applyFeedData(data) {
  if (data && Array.isArray(data.rounds)) {
    state.rounds = data.rounds
      .filter((r) => Array.isArray(r.balls) && r.balls.length)
      .map((r) => ({
        round_number: r.round_number, drawn_at: r.drawn_at, balls: r.balls,
        sweet_spot: r.sweet_spot ?? null, sweet_spot2: r.sweet_spot2 ?? null,
      }));
    state.feedInfo = {
      updated_at: data.updated_at,
      source: data.source,
      rhythm: data.rhythm || null,     // {median_ms, p25_ms, p75_ms, cycle_label, sample_gaps}
      estimate: data.estimate || null, // {current_round_number, next_round_number, seconds_to_next_start, stale}
    };
  }
  if (data && data.live_round && Array.isArray(data.live_round.balls)) {
    state.live = data.live_round;
  }
  renderAll();
}

/** Pokuša zadati URL; ako ne uspe, vrati se na lokalnu kopiju data/bingo-results.json. */
async function fetchFeed(url) {
  try {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    if (url === DEFAULT_FEED_URL) throw e; // i lokalni fallback nije proban
    console.warn("Feed URL ne radi (" + (e?.message || e) + "), probavam lokalnu kopiju…");
    const res2 = await fetch(`data/bingo-results.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res2.ok) throw new Error("HTTP " + res2.status);
    return await res2.json();
  }
}

async function reloadFeed(silent) {
  const url = $("#feedUrl").value.trim() || DEFAULT_FEED_URL;
  try {
    const data = await fetchFeed(url);
    applyFeedData(data);
    save(LS.feedUrl, url);
    const prev = load(LS.seenRound, 0);
    const top = state.rounds[0]?.round_number ?? 0;
    if (prev && top > prev) maybeNotify(top, state.rounds[0]);
    save(LS.seenRound, top);
    if (!silent) toast("Feed učitan ✓");
  } catch (e) {
    if (!silent) toast("Greška: " + (e.message || e));
  }
}

/* ── GitHub Action trigger (iz browsera) ────────────────────────────────── */

function setActionStatus(text, cls) {
  const elx = $("#actionStatus");
  if (elx) { elx.textContent = text || ""; if (cls != null) elx.className = cls; }
}

/** Pokrene workflow "Update bingo results": preko GitHub API-ja (token iz localStorage)
 *  ili preko lokalnog servera (npm run serve / START-ALL.bat → /trigger endpoint). */
async function triggerAction(silent = true) {
  const token = load(LS.ghToken, "");
  if (token) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
        method: "POST",
        headers: { "Authorization": "token " + token, "Accept": "application/vnd.github+json" },
        body: JSON.stringify({ ref: "main", inputs: { quick: true } }),
      });
      if (res.status === 204 || res.ok) {
        setActionStatus("GitHub Action pokrenut ✓ — svež feed stiže za ~1–2 min.", "ok");
        return true;
      }
      setActionStatus(`Action dispatch nije prošao (HTTP ${res.status}) — proveri token (Actions: Write).`, "bad");
    } catch (e) {
      setActionStatus("Greška pri pozivu GitHub API-ja: " + (e?.message || e), "bad");
    }
  }
  // fallback: lokalni server (radi samo ako je otvoreno preko npm run serve / START-ALL.bat)
  try {
    const r = await fetch("/trigger");
    if (r.ok) {
      setActionStatus("Lokalni triger pokrenut ✓ — svež feed stiže za ~1–2 min.", "ok");
      return true;
    }
  } catch { /* nije lokalni server */ }
  if (!silent) {
    setActionStatus("Nije pokrenuto ništa: nema tokena niti lokalnog servera. Action i dalje radi sam na 5 min (cron).", "warn");
  }
  return false;
}

/** Dugme "↻ Feed" / "Generiši preporuku": triggeruj akciju → sačekaj → povuci svež feed. */
async function refreshNow(btn) {
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "⏳ osvežavam…"; }
  setActionStatus("Pokrećem GitHub Action…", "warn");
  const kicked = await triggerAction(true);
  if (!kicked) setActionStatus("Samo osvežavam feed (Action radi sam na 5 min).", "muted");
  await new Promise((r) => setTimeout(r, 8000)); // kratak predah da bot stigne da commituje
  await reloadFeed(true);
  if (btn) { btn.disabled = false; btn.textContent = old ?? "↻ Feed"; }
}

/* ── Istorija panel ─────────────────────────────────────────────────────── */

function renderAll() {
  const uni = +($("#universe").value || 48);
  const depth = +($("#depth").value || 60);
  const rounds = allRounds();
  renderSweetSpot();
  buildDashboard();
  if (!rounds.length) { $("#feedStatus").textContent = "feed: nema podataka"; return; }

  const A = analyze(rounds, uni, depth);

  $("#feedStatus").textContent =
    `feed: ${A.use.length} kola` + (state.feedInfo?.updated_at ? ` · ažurirano ${state.feedInfo.updated_at.slice(11, 16)} UTC` : "");
  $("#lastRound").textContent = state.rounds[0] ? `zadnje kolo #${state.rounds[0].round_number}` : "";

  renderRhythmBanner();
  renderLive();
  renderHeatmap(A);
  renderKpis(A);
  renderHistTable(A.use);
  renderHeld();
  renderWheelTracking();
  renderAutoRec(A, rounds); // 🟢 početnička preporuka — automatski, bez klika
}

/* ── 🟢 Auto-preporuka za početnike (bez klika) ─────────────────────────────
 * Čim feed stigne: iz zadnjih 120 kola izabere 6 brojeva (mix skor) i odmah
 * izračuna wheel kombinacije (min. 6) koje pokrivaju SVU biricu sa cenom u din.
 */
function renderAutoRec(A, rounds) {
  const box = $("#autoRecBody");
  if (!box) return;
  if (rounds.length < 3) {
    box.textContent = "Treba bar 3 kola podataka — feed se još puni (automatski).";
    return;
  }

  // 1) 6 brojeva: isti mix-skoring ko i glavna preporuka (frekvencija + gap + ponavljanja)
  const pool = [...A.numbers];
  for (const n of pool) n.score = combinedScore(n, A.repeated, getWeights());
  pool.sort((a, b) => b.score - a.score);
  const chosen = pool.slice(0, 6).map((n) => n.number).sort((a, b) => a - b);
  const topRound = rounds[0].round_number;
  const holdRounds = 4;

  // 2) wheel: k=5, T=4 iz birice od tih 6 — pokriva SVAKU kombinaciju od 5 od tih 6 brojeva.
  //    Ako se 4+ tvojih brojeva izvuče, bar jedna kombinacija ima 4 pogotka (delimična isplata).
  const K = 5, T = 4;
  let combos = greedyWheel(chosen, K, T);
  if (!verifyGuarantee(chosen, combos, K, T)) {
    if (!combos.length) combos = [chosen.slice(0, K)];
  }
  // dopuni na bar 6 JEDINSTVENIH kombinacija („minimum 6 — ništa ispod”): dodajemo
  // one 5-podskupove birice koji još nisu u listi (C(6,5)=6, pa uvek može do 6)
  const seen = new Set(combos.map((c) => c.join(",")));
  const allK = [];
  const cur = [];
  const genK = (start) => {
    if (cur.length === K) { allK.push([...cur]); return; }
    for (let i = start; i < chosen.length - (K - cur.length) + 1; i++) { cur.push(chosen[i]); genK(i + 1); cur.pop(); }
  };
  genK(0);
  for (const c of allK) {
    if (combos.length >= 6) break;
    const key = c.join(",");
    if (!seen.has(key)) { combos.push(c); seen.add(key); }
  }
  const uniqueCombos = combos;

  // 3) cena u dinarima (RSD) — ulog po kombinaciji, podrazumevano 20 din
  const stake = Math.max(1, +($("#recStakeDin")?.value) || 20);
  const total = uniqueCombos.length * stake;

  box.replaceChildren();
  const head = el("div", null);
  head.innerHTML =
    `<b>Drži ovih 6 brojeva narednih ${holdRounds} kola (do kola #${topRound + holdRounds}):</b> ` +
    `<span class="muted">iz zadnjih ${A.use.length} kola — najjači mix skor (frekvencija + gap + ponavljanja).</span>`;
  head.style.marginBottom = "8px";
  box.appendChild(head);
  box.appendChild(ballsRow(chosen, {}));

  const w = el("div", null);
  w.style.marginTop = "10px";
  w.innerHTML =
    `<b>🧩 Minimalne kombinacije koje pokrivaju sve:</b> ${uniqueCombos.length} × ${stake} din = <b>${total} din po kolu</b> ` +
    `<span class="muted">(kombinacija ${K} brojeva iz tvojih 6; garancija: ako 4+ tvojih brojeva izvuče, bar jedna kombinacija ima 4 pogotka — provereno računski ✓)</span>`;
  box.appendChild(w);
  const list = el("div", "combo-list");
  list.style.marginTop = "6px";
  uniqueCombos.forEach((c) => {
    const d = el("div", "combo");
    d.appendChild(ballsRow(c, { sm: true }));
    list.appendChild(d);
  });
  box.appendChild(list);

  const note = el("div", "rec-note");
  note.innerHTML =
    `Klikni 📌 da ovo držanje pratimo za tebe (pogotci se sami računaju po novim kolima). ` +
    `Cena se menja sa ulogom: `;
  const stakeInput = el("input");
  stakeInput.type = "number"; stakeInput.min = "1"; stakeInput.value = String(stake); stakeInput.style.width = "64px";
  stakeInput.id = "recStakeDin";
  stakeInput.addEventListener("change", renderAutoRecRefresh);
  note.appendChild(stakeInput);
  note.appendChild(document.createTextNode(" din po kombinaciji (min. 6 kombinacija — ništa ispod toga)."));
  box.appendChild(note);

  const holdBtn = el("button", "primary", "📌 Drži ovu preporuku");
  holdBtn.style.marginTop = "8px";
  holdBtn.addEventListener("click", () => {
    holdPick({
      numbers: chosen, from_round: topRound, until_round: topRound + holdRounds,
      rounds_left: holdRounds, mode: "mix-auto", created_at: new Date().toISOString(), hits: [],
    });
  });
  box.appendChild(holdBtn);
}

function renderAutoRecRefresh() {
  const uni = +($("#universe").value || 48);
  const depth = +($("#depth").value || 60);
  const rounds = allRounds();
  if (rounds.length >= 3) renderAutoRec(analyze(rounds, uni, depth), rounds);
}

function allRounds() {
  // feed + ručni unosi (novije prvo); bez duplikata po round_number (ručni imaju negativne brojeve)
  const map = new Map();
  for (const r of state.rounds) if (!map.has(r.round_number)) map.set(r.round_number, r);
  for (const r of load(LS.manual, [])) if (!map.has(r.round_number)) map.set(r.round_number, r);
  return [...map.values()].sort((a, b) => b.round_number - a.round_number);
}

function renderLive() {
  const box = $("#liveBox");
  box.replaceChildren();
  if (state.live?.balls?.length) {
    box.appendChild(el("div", null, `Kolo #${state.live.round_number} — izvučeno ${state.live.balls.length}/35:`));
    box.appendChild(ballsRow(state.live.balls, { sm: true }));
  } else {
    box.textContent = "— trenutno nema kola u toku —";
  }
}

/* ── Sweet spot statistika (vodič) ─────────────────────────────────────── */

function renderSweetSpot() {
  const box = $("#ssBox");
  if (!box) return;
  const depth = +($("#depth").value || 60);
  const rounds = state.rounds.filter((r) => r.sweet_spot != null).slice(0, depth);
  if (!rounds.length) {
    box.textContent = "Učitaj feed — nema sweet spot podataka.";
    return;
  }
  box.replaceChildren();

  const counts = new Map();
  for (const r of rounds) {
    for (const x of [r.sweet_spot, r.sweet_spot2].filter((x) => x != null))
      counts.set(x, (counts.get(x) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  const top = el("div", "pick-grid");
  for (const [num, c] of sorted.slice(0, 6)) {
    const w = el("div", "pick");
    w.appendChild(ballEl(num, { sm: true }));
    w.appendChild(el("small", "muted", `${c}× (${Math.round((c / rounds.length) * 100)}%)`));
    top.appendChild(w);
  }
  box.appendChild(el("div", null, `Najčešći sweet spot brojevi (zadnjih ${rounds.length} kola sa podacima):`));
  box.appendChild(top);

  let rep = 0;
  for (let i = 0; i + 1 < rounds.length; i++) {
    const a = [rounds[i].sweet_spot, rounds[i].sweet_spot2];
    const b = [rounds[i + 1].sweet_spot, rounds[i + 1].sweet_spot2];
    if (a.some((x) => x != null && b.includes(x))) rep++;
  }
  const note = el("div", "muted");
  note.style.marginTop = "8px";
  note.textContent =
    `Sweet spot se ponovio iz kola u kolo: ${rep}/${Math.max(1, rounds.length - 1)} ` +
    `(očekivano za 2 broja od 48: ~${((2 / 48) * 100).toFixed(1)}%). Zadnje kolo #${rounds[0].round_number}: ` +
    `${rounds[0].sweet_spot}` + (rounds[0].sweet_spot2 != null ? ` i ${rounds[0].sweet_spot2}` : "") + ".";
  box.appendChild(note);
}

/* ── Kalkulator isplate (vodič) ─────────────────────────────────────────── */

function calcFairOdds(picks) {
  // fer kvota da SVIH picks tipovanih brojeva bude među 35 od 48
  return combinatorial(48, picks) / combinatorial(35, picks);
}

function renderCalc() {
  const out = $("#calcOut");
  if (!out) return;
  const picks = Math.min(8, Math.max(1, +($("#calcPicks").value || 5)));
  const odds = +($("#calcOdds").value || 0);
  const stake = +($("#calcStake").value || 0);
  const combos = Math.max(1, +($("#calcCombos").value || 1));
  out.replaceChildren();

  const totalStake = stake * combos;
  const fair = calcFairOdds(picks);
  const pWin = 1 / fair;
  const hasOdds = odds > 0;
  const ev = hasOdds ? (odds * pWin - 1) * totalStake : NaN;
  const edge = hasOdds ? (odds / fair - 1) * 100 : NaN;

  const kpi = (val, label, cls) => {
    const d = el("div", "k");
    d.appendChild(el("b", cls, val));
    d.appendChild(el("span", null, label));
    return d;
  };

  out.appendChild(kpi(`${(pWin * 100).toFixed(2)}%`, `šansa da svih ${picks} brojeva pogodi`));
  out.appendChild(kpi(`×${fair.toFixed(2)}`, "fer kvota (35/48)"));
  out.appendChild(kpi(`${totalStake.toFixed(2)} €`, `ukupan ulog (${combos} komb.)`));
  out.appendChild(kpi(hasOdds ? `${(odds * totalStake).toFixed(2)} €` : "—", "isplata ako pogodiš"));
  out.appendChild(kpi(hasOdds ? `${ev.toFixed(2)} €` : "—", "očekivana vrednost (EV) po tiketu", ev > 0 ? "ok" : "bad"));
  out.appendChild(kpi(hasOdds ? `${edge.toFixed(1)}%` : "—", "kvota u odnosu na fer", edge >= 0 ? "ok" : "bad"));
}

function renderHeatmap(A) {
  const hm = $("#heatmap");
  hm.replaceChildren();
  $("#heatScope").textContent = `(zadnjih ${A.use.length} kola, univerzum 1–${A.numbers.length})`;
  const maxC = A.maxCount || 1;
  for (const n of A.numbers) {
    const d = el("div", "heat" + (state.selected.has(n.number) ? " sel" : ""));
    const intensity = 0.12 + 0.75 * (n.count / maxC);
    d.style.background = `rgba(255,209,102,${intensity.toFixed(2)})`;
    d.style.color = intensity > 0.55 ? "#1c1600" : "var(--text)";
    d.appendChild(el("b", null, String(n.number)));
    d.appendChild(el("small", null, `${n.count}× · gap ${n.gap}`));
    if (A.repeated.includes(n.number)) d.appendChild(el("small", "ok", "ponovo ↑"));
    d.title = `#${n.number}: ${n.count} puta, zadnji put pre ${n.gap} kola`;
    d.addEventListener("click", () => toggleSelect(n.number));
    hm.appendChild(d);
  }
}

function renderKpis(A) {
  const kpi = $("#kpiBox");
  kpi.replaceChildren();
  const add = (label, val) => {
    const k = el("div", "k");
    k.appendChild(el("b", null, val));
    k.appendChild(el("span", null, label));
    kpi.appendChild(k);
  };
  const eo = A.ballsTotal ? Math.round((A.even / A.ballsTotal) * 100) : 50;
  add("ukupno lopti", String(A.ballsTotal));
  add("parno %", eo + "%");
  add("neparno %", (100 - eo) + "%");
  add("top broj", A.numbers[0] ? `#${A.numbers[0].number} (${A.numbers[0].count}×)` : "—");
  const maxGapN = [...A.numbers].sort((a, b) => b.gap - a.gap)[0];
  add("najviše čeka", maxGapN ? `#${maxGapN.number} (${maxGapN.gap} kola)` : "—");
  add("ponovljeni iz proslog", A.repeated.length ? A.repeated.join(", ") : "—");

  // boje mini bar
  const colorsCard = el("div");
  colorsCard.style.gridColumn = "1/-1";
  const maxColor = Math.max(...Object.values(A.colors), 1);
  for (const c of BALL_COLORS) {
    const row = el("div", "bar-row");
    row.appendChild(el("span", null, c));
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = (A.colors[c] / maxColor) * 100 + "%";
    fill.style.background = `var(--c-${c})`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("span", "stat-num muted", String(A.colors[c])));
    colorsCard.appendChild(row);
  }
  kpi.appendChild(colorsCard);

  // liste
  const top = $("#topList"); top.replaceChildren();
  A.numbers.slice(0, 8).forEach((n) => top.appendChild(ballEl(n.number, { xs: true, clickable: true })));
  const cold = $("#coldList"); cold.replaceChildren();
  [...A.numbers].sort((a, b) => a.count - b.count || b.gap - a.gap).slice(0, 8)
    .forEach((n) => cold.appendChild(ballEl(n.number, { xs: true, clickable: true })));
  const rep = $("#repList"); rep.replaceChildren();
  (A.repeated.length ? A.repeated : [0]).forEach((n) => {
    if (n) rep.appendChild(ballEl(n, { xs: true }));
    else rep.appendChild(el("span", "muted", "—"));
  });
}

function renderHistTable(use) {
  const t = $("#histTable");
  t.replaceChildren();
  const thead = el("thead");
  thead.innerHTML = "<tr><th>#</th><th>Vreme</th><th>Brojevi (redosled izvlačenja)</th></tr>";
  t.appendChild(thead);
  const tb = el("tbody");
  for (const r of use.slice(0, 120)) {
    const tr = el("tr");
    tr.appendChild(el("td", null, "#" + r.round_number));
    tr.appendChild(el("td", "muted", r.drawn_at ? r.drawn_at.slice(11, 19) : "—"));
    const td = el("td");
    td.appendChild(ballsRow(r.balls, { xs: true }));
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
}

/* ── Drži N ─────────────────────────────────────────────────────────────── */

function generatePicks(reroll) {
  const rounds = allRounds();
  if (rounds.length < 3) { toast("Treba bar 3 kola (feed ili ručni unos)"); return; }
  const uni = +($("#universe").value || 48);
  const depth = +($("#depth").value || 60);
  const count = Math.max(3, Math.min(12, +($("#holdCount").value || 6)));
  const holdRounds = Math.max(1, Math.min(8, +($("#holdRounds").value || 4)));
  const mode = $("#poolMode").value;
  const A = analyze(rounds, uni, depth);
  const w = getWeights();

  let pool;
  if (mode === "hot") {
    pool = A.numbers.slice(0, Math.max(count * 2, 12));
  } else if (mode === "overdue") {
    pool = [...A.numbers].sort((a, b) => b.gap - a.gap).slice(0, Math.max(count * 2, 12));
  } else if (mode === "repeat") {
    const repSet = new Set(A.repeated);
    pool = A.numbers.filter((n) => repSet.has(n.number));
    if (pool.length < count) pool = A.numbers.slice(0, count * 2); // fallback
  } else {
    pool = [...A.numbers]; // mix: sortiraćemo po kombinovanom skoru
    for (const n of pool) n.score = combinedScore(n, A.repeated, w);
    pool.sort((a, b) => b.score - a.score);
    pool = pool.slice(0, Math.max(count * 2, 12));
  }

  // biramo count brojeva iz pool-a; reroll dodaje nasumičnost među top kandidatima
  let chosen;
  if (reroll) {
    chosen = [...pool].sort(() => Math.random() - 0.5).slice(0, count).map((n) => n.number);
  } else {
    chosen = pool.slice(0, count).map((n) => n.number);
  }
  chosen.sort((a, b) => a - b);

  const roundNos = rounds[0].round_number;
  const pick = {
    numbers: chosen,
    from_round: roundNos,
    until_round: roundNos + holdRounds,
    rounds_left: holdRounds,
    mode, created_at: new Date().toISOString(),
    hits: [], // per-round hits log
  };

  const box = $("#picksBox");
  box.replaceChildren();
  box.appendChild(el("div", null, `Preporuka (${mode}, važi do kola #${pick.until_round}):`));
  box.appendChild(ballsRow(chosen, {}));
  box.appendChild(el("div", "muted", `Argument: ` + explainPick(chosen, A, mode)));

  const btn = el("button", "primary", "📌 Drži ovu kombinaciju");
  btn.style.marginTop = "8px";
  btn.addEventListener("click", () => { holdPick(pick); });
  box.appendChild(btn);
}

function explainPick(chosen, A, mode) {
  const parts = chosen.map((n) => {
    const d = A.numbers.find((x) => x.number === n);
    return `#${n} (${d.count}×, gap ${d.gap})`;
  });
  const why = {
    mix: "kombinovani skor (frekvencija + dužina čekanja + ponavljanja)",
    hot: "najveća frekvencija u posmatranom periodu",
    overdue: "najduže se ne pojavljuju (gap)",
    repeat: "ponovljeni iz zadnjeg kola (empirijski najjači short-term signal u ovom feedu)",
  }[mode];
  return `${why}. ` + parts.join(", ");
}

function holdPick(pick) {
  const held = load(LS.held, []);
  held.unshift(pick);
  save(LS.held, held);
  renderHeld();
  buildDashboard();
  toast("Držanje aktivirano ✓");
}

function renderHeld() {
  const held = load(LS.held, []);
  const rounds = allRounds();
  const top = rounds[0]?.round_number ?? 0;
  const box = $("#heldBox");
  const log = $("#heldLog");
  box.replaceChildren();
  log.replaceChildren();

  if (!held.length) {
    box.textContent = "Još nema aktivnog držanja — generiši preporuku i klikni „Drži ovu kombinaciju”.";
    log.textContent = "—";
    return;
  }

  let anyActive = false;
  held.forEach((h, i) => {
    // korekcija za kašnjenje feeda: ako je ritmu kolo već počelo/izvuklo, ne uračunavaj ga u „preostala”
    const overdue = roundProbablyDrawn(h.until_round);
    h.rounds_left = Math.max(0, h.until_round - top);
    const active = h.rounds_left > 0 || overdue;
    if (active) anyActive = true;

    const row = el("div", "card");
    row.style.background = "#10131a";
    row.style.marginBottom = "8px";
    const head = el("div", "row");
    head.appendChild(el("b", null, `Brojevi (${h.numbers.length})`));
    head.appendChild(el("span", active ? "ok" : "muted",
      active
        ? (h.rounds_left > 0
            ? `važi još ${h.rounds_left} kola (do #${h.until_round}) — ${etaLabel(h.until_round)}`
            : `po ritmu je isteklo (do #${h.until_round}), ali feed još ne potvrđuje — proveri „↻ Feed”`)
        : "isteklo"));
    head.appendChild(el("span", "muted", `· od kola #${h.from_round} · mod: ${h.mode}`));
    const hitInfo = h.hits.length
      ? `pogodci po kolima: ${h.hits.map((x) => `#${x.round}:${x.hits}`).join(", ")}`
      : "još nema provere";
    head.appendChild(el("span", "muted", "· " + hitInfo));
    row.appendChild(head);
    row.appendChild(ballsRow(h.numbers, { sm: true }));

    const del = el("button", "small bad", "Ukloni");
    del.style.marginTop = "6px";
    del.addEventListener("click", () => {
      held.splice(i, 1);
      save(LS.held, held);
      renderHeld();
      buildDashboard();
    });
    row.appendChild(del);
    if (active) box.appendChild(row);
    log.appendChild(row);
  });
  if (!anyActive) box.appendChild(el("div", "muted", "Sva držanja su istekla."));
}

/* ── Wheel (covering designs) ───────────────────────────────────────────── */

function combinatorial(n, k) {
  // C(n,k)
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

function hitsOf(combo, drawnSet) {
  let h = 0;
  for (const x of combo) if (drawnSet.has(x)) h++;
  return h;
}

function greedyWheel(pool, k, t) {
  // Celo pool pokrivanje: tražimo k-subset-e tako da SVAKI t-subset pool-a
  // bude sadržan u bar jednom izabranom k-subsetu (greedy + egzaktna provera).
  const idx = [...pool.keys()];
  const gen = (start, cur, target, store) => {
    if (cur.length === target) { store.push([...cur]); return; }
    for (let i = start; i < pool.length - (target - cur.length) + 1; i++) {
      cur.push(idx[i]); gen(i + 1, cur, target, store); cur.pop();
    }
  };
  const tSets = [];
  gen(0, [], t, tSets);

  const kSets = [];
  gen(0, [], k, kSets);

  const covered = new Set();  // t-subset -> key
  const used = new Set();     // k-subset (indeksi) -> key, za dedup
  const keyOf = (arr) => arr.join(",");
  const combos = [];

  // greedy: biraj k-subset koji pokriva najviše nepokrivenih t-setova
  const deadline = Date.now() + 25_000; // ograničenje da browser ne zamrzne
  let guard = 0;
  while (covered.size < tSets.length && guard++ < 50000) {
    if (Date.now() > deadline) break;
    let bestCov = -1, best = null;
    for (const ks of kSets) {
      if (used.has(keyOf(ks))) continue;
      let cov = 0;
      for (const ts of tSets) {
        if (covered.has(keyOf(ts))) continue;
        if (ts.every((i) => ks.includes(i))) cov++;
      }
      if (cov > bestCov) { bestCov = cov; best = ks; }
    }
    if (!best || bestCov <= 0) break; // ne bi trebalo da se desi
    used.add(keyOf(best));
    combos.push(best.map((i) => pool[i]));
    for (const ts of tSets) {
      if (ts.every((i) => best.includes(i))) covered.add(keyOf(ts));
    }
  }
  return combos;
}

function verifyGuarantee(pool, combos, k, t) {
  // za svaki t-subset pool-a, postoji combo koji ga sadrži
  const comboSets = combos.map((c) => new Set(c));
  const test = [];
  const cur = [];
  const genT = (start) => {
    if (cur.length === t) { test.push([...cur]); return; }
    for (let i = start; i < pool.length - (t - cur.length) + 1; i++) { cur.push(pool[i]); genT(i + 1); cur.pop(); }
  };
  genT(0);
  for (const ts of test) {
    if (!comboSets.some((cs) => ts.every((x) => cs.has(x)))) return false;
  }
  return true;
}

function runWheel() {
  const pool = $("#wheelPool").value
    .split(/[^0-9]+/)
    .map(Number)
    .filter((n) => n >= 1 && n <= 99);
  const uniq = [...new Set(pool)].sort((a, b) => a - b);
  const k = +$("#wheelK").value;
  const tSel = $("#wheelT").value;
  const out = $("#wheelOut");

  if (uniq.length < k) { out.innerHTML = '<span class="bad">Birica ima manje brojeva od k.</span>'; return; }
  if (!tSel) { out.innerHTML = '<span class="bad">Izaberi garanciju T.</span>'; return; }
  const t = Math.min(k, +tSel);

  // brzina: limitiraj složene slučajeve (i t-subsets za proveru, i k-subsets za greedy pretragu —
  // greedy petlja je O(kSets × tSets) po iteraciji, pa oba moraju biti ograničena)
  const tCount = combinatorial(uniq.length, t);
  const kCount = combinatorial(uniq.length, k);
  if (tCount > 30000 || kCount > 5000) {
    out.innerHTML = `<span class="bad">Previše kombinacija za proveru (C(${uniq.length},${t})=${tCount}, C(${uniq.length},${k})=${kCount}). Smanji biricu ili T.</span>`;
    return;
  }

  const t0 = Date.now();
  const combos = greedyWheel(uniq, k, t);
  const guaranteed = verifyGuarantee(uniq, combos, k, t);
  const timedOut = !guaranteed && (Date.now() - t0) > 24_000;
  const payin = Math.max(1, +$("#wheelPayin").value || 20);

  state.wheelResult = { pool: uniq, k, t, combos, payin, created_round: allRounds()[0]?.round_number ?? 0, hits: [] };
  save(LS.wheel, state.wheelResult);

  out.replaceChildren();
  const sum = el("div", null);
  sum.innerHTML =
    `<b>${combos.length}</b> kombinacija ${k}/${uniq.length} · garancija: ako ${t}+ iz birice izađe, bar jedna kombinacija ima ${t} pogodaka — ` +
    (guaranteed
      ? '<span class="ok">provereno ✓</span>'
      : timedOut
        ? '<span class="bad">NIJE provereno ✗ (pretraga je prekinuta zbog vremena — smanji biricu ili T i pokušaj ponovo)</span>'
        : '<span class="bad">NIJE provereno ✗</span>') +
    ` · ukupan ulog: <b>${combos.length * payin}</b>`;
  out.appendChild(sum);

  const list = el("div", "combo-list");
  combos.forEach((c) => {
    const d = el("div", "combo");
    d.appendChild(ballsRow(c, { sm: true }));
    list.appendChild(d);
  });
  out.appendChild(list);
  renderWheelTracking();
  buildDashboard();
}

function renderWheelTracking() {
  const w = load(LS.wheel, null);
  const box = $("#wheelTrack");
  if (!w || !w.combos?.length) { box.textContent = "—"; return; }
  box.replaceChildren();
  box.appendChild(el("div", null,
    `Set: ${w.combos.length} komb. ${w.k}/${w.pool.length}, T=${w.t}, od kola #${w.created_round}. ` +
    `Unesi nova kola (feed) i pogledaj pogotke:`));

  // zadnja 4 kola prikaz sa pogocima
  const rounds = allRounds().slice(0, 4);
  for (const r of rounds) {
    const drawn = new Set(r.balls);
    const row = el("div");
    row.style.marginTop = "8px";
    row.appendChild(el("b", null, `Kolo #${r.round_number}`));
    row.appendChild(ballsRow(r.balls, { xs: true }));
    const scores = w.combos.map((c) => hitsOf(c, drawn));
    const best = Math.max(...scores);
    row.appendChild(el("div", best >= w.t ? "ok" : "muted",
      `najbolja kombinacija: ${best}/${w.k} pogodaka${best >= w.t ? " — GARANCIJA ISPORUČENA ✓" : ""}`));
    box.appendChild(row);
  }
}

/* ── Banner ritma: trajanje kola + odbrojavanje + svežina feeda ────────── */

function renderRhythmBanner() {
  const box = $("#rhythmBanner");
  if (!box) return;
  const rhythm = getRhythm();
  const est = estimateCurrentRound();
  box.replaceChildren();
  if (!est) {
    box.textContent = "Ritam izvlačenja: — (treba bar jedno kolo sa vremenom iz feeda).";
    return;
  }
  const age = est.feed_age_seconds;
  const nextEta = fmtDur((est.seconds_to_next_start ?? 0) * 1000);
  const ageTxt = age != null ? (age < 90 ? "feed svež" : `feed star ${fmtDur(age * 1000)}`) : "";
  const staleTxt = est.stale || (age != null && age > 10 * 60)
    ? ' — <span class="warn">feed možda zastareo (cron prospio?) → „↻ Feed”</span>' : "";
  const d = el("div");
  d.innerHTML =
    `<b>⏱ Ritam:</b> prosečno kolo traje <b>${rhythm.cycle_label || fmtDur(rhythm.median_ms)}</b>` +
    (rhythm.sample_gaps ? ` (mereno na ${rhythm.sample_gaps} razmaka)` : " (podrazumevano)") +
    ` · <b>kolo #${est.current_round_number}</b> bi trebalo da je u toku` +
    ` · sledeće <b>#${est.next_round_number}</b> okvirno za ~${nextEta}` + staleTxt +
    (ageTxt ? ` · ${ageTxt}` : "");
  box.appendChild(d);
  if (rhythm.p25_ms && rhythm.p75_ms) {
    box.appendChild(el("div", "muted", `raspon (p25–p75): ${fmtDur(rhythm.p25_ms)} – ${fmtDur(rhythm.p75_ms)} — retke duže pauze su održavanje, ne novi ritam.`));
  }
}

/* ── ⚡ Preporuka: sve u jednom ─────────────────────────────────────────── */

function fillRecTOptions() {
  const k = +($("#recK").value || 6);
  const sel = $("#recT");
  sel.replaceChildren();
  for (let t = k; t >= Math.max(2, k - 2); t--) {
    const o = document.createElement("option");
    o.value = String(t);
    o.textContent = `T=${t}`;
    sel.appendChild(o);
  }
  sel.value = String(Math.max(2, k - 1));
}

function recSection(title, noteText, noteClass) {
  const sec = el("div", "rec-section");
  sec.appendChild(el("h4", null, title));
  if (noteText) {
    const n = el("div", noteClass || "rec-note");
    n.textContent = noteText;
    sec.appendChild(n);
  }
  return sec;
}

/** Glavno dugme „Generiši preporuku”: brojevi + boje + broj kola + wheel + ostali tipovi. */
function generateAllRecs(reroll) {
  const out = $("#allOut");
  const rounds = allRounds();
  if (rounds.length < 3) {
    out.replaceChildren();
    out.appendChild(el("div", "bad", "Treba bar 3 kola podataka — sačekaj da feed učita (automatski) ili unesi kola ručno u „Podaci & podešavanja”."));
    return;
  }

  const uni = +($("#universe").value || 48);
  const depth = +($("#depth").value || 60);
  const count = Math.max(3, Math.min(12, +($("#recCount").value || 6)));
  const holdRounds = Math.max(1, Math.min(8, +($("#recRounds").value || 4)));
  const k = Math.max(2, Math.min(8, +($("#recK").value || 6)));
  let t = +($("#recT").value || (k - 1));
  t = Math.min(k, Math.max(2, t));
  const stake = Math.max(0.1, +($("#recStake").value || 0.5));
  const budget = Math.max(1, +($("#recBudget").value || 10));

  const A = analyze(rounds, uni, depth);
  const w = getWeights();
  const topRound = rounds[0].round_number;
  const est = estimateCurrentRound(); // ritam: koje kolo je verovatno u toku + ETA sledećeg

  // ── 1) Brojevi: mix skor (frekvencija + gap + ponavljanja) ──
  const pool = [...A.numbers];
  for (const n of pool) n.score = combinedScore(n, A.repeated, w);
  pool.sort((a, b) => b.score - a.score);
  let chosen = (reroll
    ? [...pool.slice(0, Math.max(count * 2, 12))].sort(() => Math.random() - 0.5).slice(0, count)
    : pool.slice(0, count)
  ).map((n) => n.number);
  chosen = [...new Set(chosen)].sort((a, b) => a - b);

  // ── 2) Boje: izabrani brojevi + najjače boje perioda ──
  const colorCount = new Map();
  for (const n of chosen) colorCount.set(ballColor(n), (colorCount.get(ballColor(n)) || 0) + 1);
  const topColors = [...colorCount.entries()].sort((a, b) => b[1] - a[1]);

  // ── 3) Wheel kombinacije iz izabranih brojeva (birica) ──
  let combos = [], guaranteed = false, wheelNote = "";
  const poolCount = chosen.length;
  if (poolCount >= k) {
    const tCount = combinatorial(poolCount, t);
    if (tCount <= 30000) {
      combos = greedyWheel(chosen, k, t);
      guaranteed = verifyGuarantee(chosen, combos, k, t);
      if (!combos.length) { combos = [chosen.slice(0, k)]; guaranteed = false; }
    } else {
      wheelNote = `Birica ${poolCount} je prevelika za T=${t} (C(${poolCount},${t})=${tCount}) — smanji k ili T.`;
    }
  } else {
    wheelNote = `Za wheel treba birica ≥ k (${k}). Povećaj „Brojeva držim” na bar ${k}.`;
  }

  // ── 4) Ostali tipovi ──
  const lastBallTop = pool.slice(0, 3).map((n) => n.number);
  const ssTop = (() => {
    const counts = new Map();
    for (const r of state.rounds.filter((r) => r.sweet_spot != null).slice(0, depth))
      for (const x of [r.sweet_spot, r.sweet_spot2].filter((x) => x != null))
        counts.set(x, (counts.get(x) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]);
  })();
  const ffTop = pool.slice(0, 2).map((n) => n.number);

  // ── render ──
  out.replaceChildren();
  out.appendChild(el("div", null,
    `Osnova: zadnjih ${A.use.length} kola (zadnje #${topRound}) · drži ovih ${count} brojeva narednih ${holdRounds} kola (do kola #${topRound + holdRounds}).`));

  // 1. brojevi
  const sec1 = recSection(`1 · Brojevi za držanje (${count}) — glavni tip`,
    `Važi do kola #${topRound + holdRounds} — ${etaLabel(topRound + holdRounds)}.` + (reroll ? " Varijanta 🎲 — iz istog top-pool-a, drugačiji raspored." : ""));
  sec1.appendChild(ballsRow(chosen, {}));
  sec1.appendChild(el("div", "rec-note",
    "Izbor: " + explainPick(chosen, A, "mix")));
  const holdBtn = el("button", "primary", "📌 Drži ovu kombinaciju");
  holdBtn.style.marginTop = "8px";
  holdBtn.addEventListener("click", () => {
    holdPick({
      numbers: chosen, from_round: topRound, until_round: topRound + holdRounds,
      rounds_left: holdRounds, mode: "mix", created_at: new Date().toISOString(), hits: [],
    });
  });
  sec1.appendChild(holdBtn);
  out.appendChild(sec1);

  // 2. boje
  const sec2 = recSection("2 · Boje — na šta da računaš");
  const cRow = el("div", "row");
  cRow.appendChild(el("span", "muted", "u tvojim brojevima:"));
  topColors.forEach(([c, n]) => {
    const tag = el("span", "tag", `${c} ×${n}`);
    tag.style.borderColor = `var(--c-${c})`;
    tag.style.color = `var(--c-${c})`;
    cRow.appendChild(tag);
  });
  sec2.appendChild(cRow);
  const cAll = el("div", "row");
  cAll.style.marginTop = "6px";
  cAll.appendChild(el("span", "muted", "najjače boje perioda:"));
  [...BALL_COLORS].sort((a, b) => A.colors[b] - A.colors[a]).slice(0, 3).forEach((c) => {
    const tag = el("span", "tag", `${c} (${A.colors[c]})`);
    tag.style.borderColor = `var(--c-${c})`;
    tag.style.color = `var(--c-${c})`;
    cAll.appendChild(tag);
  });
  sec2.appendChild(cAll);
  sec2.appendChild(el("div", "rec-note",
    "Boja lopte je deterministička (broj % 8) — ni ovde nema predskazanja; ovo ti je orijentacija kako izgleda raspored. U vodiču je tabela i za sweet spot / jackpot."));
  out.appendChild(sec2);

  // 3. wheel kombinacije
  const totalWheel = combos.length * stake;
  const sec3 = recSection(`3 · Kombinacije sa malim ulogom (wheel ${k} iz birice ${poolCount}, T=${t})`);
  if (combos.length) {
    sec3.appendChild(el("div", null,
      `${combos.length} kombinacija × ${stake.toFixed(2)} € = ukupno ${totalWheel.toFixed(2)} € po kolu` +
      (guaranteed ? " · garancija proverena ✓" : " · garancija NIJE proverena ✗")));
    const list = el("div", "combo-list");
    combos.forEach((c) => {
      const d = el("div", "combo" + (guaranteed ? " best" : ""));
      d.appendChild(ballsRow(c, { sm: true }));
      list.appendChild(d);
    });
    sec3.appendChild(list);
  sec3.appendChild(el("div", "rec-note",
    `Ako ${t}+ broja iz birice izađe u kolu, bar jedna kombinacija ima ${t} pogodaka (delimična isplata po kvotniku). ` +
    `Budžet sesije ${budget.toFixed(2)} € ≈ ${Math.floor(budget / Math.max(totalWheel, 0.005))} kola wheel-a` +
    (est?.seconds_to_next_start != null ? ` · do sledećeg kola ~${fmtDur(est.seconds_to_next_start * 1000)} — tikete plasiraj pre isteka` : "") + "."));
  } else {
    sec3.appendChild(el("div", "warn", wheelNote || "Nema kombinacija za zadate parametre."));
  }
  out.appendChild(sec3);

  // 4. ostali tipovi
  const sec4 = recSection("4 · Ostali tipovi — samo mali odvojeni ulozi (0,50–1 €)");
  const ul = el("ul", "guide");
  const li = (html) => { const x = el("li"); x.innerHTML = html; ul.appendChild(x); };
  li(`<b>Poslednja lopta:</b> kandidati ${lastBallTop.join(" / ")} — fer kvota ×48, čisto mali ulog za bonus.`);
  li(`<b>Sweet spot:</b> kandidati ${ssTop.length ? ssTop.join(" / ") : "—"} (najčešći sweet spot brojevi perioda) — fer kvota ≈ ×24.`);
  li(`<b>Prvih 5:</b> kandidati ${ffTop.join(" / ")} — fer kvota ×9,6 po broju; velika varijansa, igraj najmanje.`);
  li(`<b>Jackpot:</b> dolazi uz tiket — ne plaćaj ništa dodatno.`);
  sec4.appendChild(ul);
  out.appendChild(sec4);

  // 5. plan sesije
  const planStake = totalWheel + stake + 1.5; // wheel + glavni tiket + okvirno ~1,5 € za sporedne tipove
  const sec5 = recSection("5 · Plan sesije", null);
  sec5.appendChild(el("div", "rec-note",
    `Okvirna potrošnja po kolu: wheel ${totalWheel.toFixed(2)} € + glavni tiket ${stake.toFixed(2)} € + sporedni tipovi ~1,50 € ` +
    `≈ ${planStake.toFixed(2)} €. Sa budžetom ${budget.toFixed(2)} € to je ~${Math.max(1, Math.floor(budget / planStake))} kola. ` +
    `Drži brojeva ${holdRounds} kola — ne menjaj set posle jednog lošeg kola (zato postoji „📌 Drži”). ` +
    `Ako je kolo Gold/Back-up (zlatni/zelena ekran), to je prirodni pokrića period — ne diži ulog.`));
  out.appendChild(sec5);

  buildDashboard();
}

/** Kontrolna tabla: aktivno držanje + wheel set + šta prati dalje (automatski). */
function buildDashboard() {
  const box = $("#dashBox");
  if (!box) return;
  const held = load(LS.held, []);
  const wheel = load(LS.wheel, null);
  const rounds = allRounds();
  const top = rounds[0]?.round_number ?? 0;

  if (!held.length && !wheel?.combos?.length) {
    box.textContent = "Još ništa ne pratiš — klikni „Generiši preporuku” pa „📌 Drži ovu kombinaciju”.";
    return;
  }
  box.replaceChildren();
  const esc = (s) => String(s).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  for (const h of held.filter((h) => h.until_round > top)) {
    const drawn = rounds[0]?.balls ?? [];
    const hits = drawn.filter((n) => h.numbers.includes(n)).length;
    const d = el("div", "rec-section");
    d.innerHTML =
      `<b>📌 Držanje</b> (${h.numbers.length} brojeva, još ${h.until_round - top} kola, do #${h.until_round}) — ` +
      `u zadnjem kolu: <span class="${hits >= 3 ? "ok" : "muted"}">${hits}/${h.numbers.length} pogodaka</span>`;
    d.appendChild(ballsRow(h.numbers, { sm: true }));
    box.appendChild(d);
  }
  if (wheel?.combos?.length) {
    const drawn = rounds[0]?.balls ?? [];
    const drawnSet = new Set(drawn);
    const best = Math.max(...wheel.combos.map((c) => hitsOf(c, drawnSet)));
    const d = el("div", "rec-section");
    d.innerHTML =
      `<b>🧩 Wheel set</b> (${wheel.combos.length} komb. ${wheel.k}/${wheel.pool.length}, T=${wheel.t}) — ` +
      `u zadnjem kolu: <span class="${best >= wheel.t ? "ok" : "muted"}">najbolja ${best}/${wheel.k}</span>` +
      (best >= wheel.t ? ' <span class="ok">— garancija isporučena ✓</span>' : "");
    d.appendChild(el("div", "rec-note", `Ukupan ulog po kolu: ${(wheel.combos.length * wheel.payin).toFixed(2)} €`));
    box.appendChild(d);
  }
  const dashEst = estimateCurrentRound();
  box.appendChild(el("div", "rec-note",
    `Feed se osvežava automatski na 60 s; pogotci se sami ažuriraju. ` +
    (dashEst ? `Po ritmu (${dashEst.cycle_label}) kolo #${dashEst.current_round_number} je u toku; sledeće #${dashEst.next_round_number} za ~${fmtDur((dashEst.seconds_to_next_start ?? 0) * 1000)}. ` : "") +
    `Zadnje kolo u feedu: #${top}.`));
}

/* ── Selekcija (toplotna mapa → birica) ─────────────────────────────────── */

function toggleSelect(num) {
  if (state.selected.has(num)) state.selected.delete(num);
  else state.selected.add(num);
  $("#wheelPool").value = [...state.selected].sort((a, b) => a - b).join(", ");
  renderAll();
}

/* ── Notifikacije ───────────────────────────────────────────────────────── */

async function ensureNotifyPermission() {
  if (!("Notification" in window)) { toast("Browser ne podržava notifikacije"); return false; }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") { toast("Notifikacije blokirane u browseru"); return false; }
  const p = await Notification.requestPermission();
  return p === "granted";
}

function maybeNotify(newRoundNo, round) {
  if (!$("#chkNotify").checked) return;
  if (Notification.permission !== "granted") return;
  const held = load(LS.held, []);
  let extra = "";
  if (held.length) {
    const active = held.filter((h) => h.until_round >= newRoundNo);
    for (const h of active) {
      const hits = h.numbers.filter((n) => round.balls.includes(n)).length;
      extra += `\nDržanje: ${hits}/${h.numbers.length} pogodaka!`;
    }
  }
  new Notification(`🎱 Bingo kolo #${newRoundNo} završeno`, {
    body: `Brojevi: ${round.balls.slice(0, 10).join(", ")}${round.balls.length > 10 ? "…" : ""}${extra}`,
  });
}

/* ── Ručni unos / import / export ───────────────────────────────────────── */

function addManualRound() {
  const nums = [...new Set($("#manualBalls").value.split(/[^0-9]+/).map(Number).filter((n) => n >= 1))];
  if (nums.length < 5) { toast("Unesi bar 5 brojeva"); return; }
  const manual = load(LS.manual, []);
  const minNo = Math.min(0, ...manual.map((r) => r.round_number), allRounds()[0]?.round_number ?? 0) - 1;
  manual.push({ round_number: minNo, drawn_at: null, balls: nums.slice(0, 35) });
  save(LS.manual, manual);
  $("#manualBalls").value = "";
  renderAll();
  toast(`Dodato kolo (${nums.length} brojeva)`);
}

function importJson() {
  try {
    const data = JSON.parse($("#pasteJson").value);
    applyFeedData(data);
    toast("Uvezeno ✓");
  } catch (e) {
    toast("Neispravan JSON: " + e.message);
  }
}

function exportState() {
  const dump = {
    rounds: allRounds(),
    live_round: state.live,
    held: load(LS.held, []),
    wheel: load(LS.wheel, null),
    exported_at: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = "wingo-state.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

function fillWheelTOptions() {
  const k = +$("#wheelK").value;
  const sel = $("#wheelT");
  sel.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "— izaberi —";
  sel.appendChild(empty);
  for (let t = k; t >= Math.max(2, k - 3); t--) {
    const o = document.createElement("option");
    o.value = String(t);
    o.textContent = `T=${t} (garantuj ${t} pogodaka)`;
    sel.appendChild(o);
  }
  sel.value = String(Math.max(2, k - 1));
}

function initSettings() {
  const s = load(LS.settings, {});
  if (s.universe) $("#universe").value = s.universe;
  if (s.depth) $("#depth").value = s.depth;
  if (s.wHot) $("#wHot").value = s.wHot;
  if (s.wGap) $("#wGap").value = s.wGap;
  if (s.wRep) $("#wRep").value = s.wRep;
  if (s.wCold) $("#wCold").value = s.wCold;
  if (s.chkNotify) $("#chkNotify").checked = s.chkNotify;
  const persist = () => save(LS.settings, {
    universe: $("#universe").value, depth: $("#depth").value,
    wHot: $("#wHot").value, wGap: $("#wGap").value, wRep: $("#wRep").value, wCold: $("#wCold").value,
    chkNotify: $("#chkNotify").checked,
  });
  ["universe", "depth", "wHot", "wGap", "wRep", "wCold", "chkNotify"].forEach((id) => {
    $("#" + id).addEventListener("change", () => { persist(); renderAll(); });
  });
}

function init() {
  initSettings();
  $("#feedUrl").value = load(LS.feedUrl, DEFAULT_FEED_URL);
  fillWheelTOptions();
  fillRecTOptions();

  $("#btnReloadFeed").addEventListener("click", (e) => refreshNow(e.currentTarget));
  // „🏠 Početna\”: uvek vraća na početnu stranu (viewer) + prvi tab ovde za sledeći put
  $("#btnHome").addEventListener("click", () => {
    try {
      if (history.state?.fromIndex) { history.back(); activateTab("preporuka"); }
      else location.href = "index.html"; // direktno otvoren wingo.html → idi na viewer
    } catch { location.href = "index.html"; }
  });
  // „← Nazad": vraća kroz istoriju (tab u app-u → prethodni tab → index strana)
  $("#btnBack").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    let done = false;
    const finish = () => { if (!done) { done = true; btn.disabled = false; } };
    window.addEventListener("popstate", finish, { once: true });
    setTimeout(finish, 250); // ako nema zabeležene istorije, samo vrati dugme
    history.back();
  });
  $("#btnSaveUrl").addEventListener("click", () => reloadFeed(false));
  $("#btnDefaultUrl").addEventListener("click", () => {
    $("#feedUrl").value = DEFAULT_FEED_URL;
    save(LS.feedUrl, DEFAULT_FEED_URL);
    reloadFeed(false);
  });
  $("#ghToken").value = load(LS.ghToken, "");
  $("#ghToken").addEventListener("change", (e) => {
    save(LS.ghToken, e.target.value.trim());
    toast(e.target.value.trim() ? "Token sačuvan ✓ (samo lokalno)" : "Token obrisan");
  });
  $("#btnAddManual").addEventListener("click", addManualRound);
  $("#btnImport").addEventListener("click", importJson);
  $("#btnExport").addEventListener("click", exportState);
  $("#btnReset").addEventListener("click", () => {
    if (confirm("Obrisati sva lokalna stanja?")) {
      Object.values(LS).forEach((k) => localStorage.removeItem(k));
      state.selected.clear();
      location.reload();
    }
  });
  $("#btnGenPicks").addEventListener("click", () => generatePicks(false));
  $("#btnReroll").addEventListener("click", () => generatePicks(true));
  $("#btnGenAll").addEventListener("click", (e) => refreshNow(e.currentTarget).then(() => generateAllRecs(false)));
  $("#btnRecReroll").addEventListener("click", () => generateAllRecs(true));
  $("#recK").addEventListener("change", fillRecTOptions);
  $("#btnPoolFromPicks").addEventListener("click", () => {
    const held = load(LS.held, [])[0];
    if (held) $("#wheelPool").value = held.numbers.join(", ");
  });
  $("#btnPoolFromHot").addEventListener("click", () => {
    const rounds = allRounds();
    if (!rounds.length) return toast("Nema podataka");
    const A = analyze(rounds, +($("#universe").value || 48), +($("#depth").value || 40));
    $("#wheelPool").value = A.numbers.slice(0, 8).map((n) => n.number).join(", ");
  });
  $("#btnPoolClear").addEventListener("click", () => {
    state.selected.clear();
    $("#wheelPool").value = "";
    renderAll();
  });
  $("#wheelK").addEventListener("change", fillWheelTOptions);
  $("#btnWheel").addEventListener("click", runWheel);
  $("#btnUseLive").addEventListener("click", () => {
    if (state.live?.balls?.length) {
      $("#manualBalls").value = state.live.balls.join(", ");
      toast("Zalepljeno u polje za ručni unos");
    } else toast("Nema kola u toku");
  });
  $("#chkNotify").addEventListener("change", async (e) => {
    if (e.target.checked) await ensureNotifyPermission();
  });
  ["calcPicks", "calcOdds", "calcStake", "calcCombos"].forEach((id) => {
    $("#" + id).addEventListener("input", renderCalc);
  });

  renderAll();
  renderCalc();

  // otvori tab iz URL hash-a (npr. wingo.html#vodic)
  const hash = location.hash.slice(1);
  if (hash && document.getElementById("panel-" + hash)) {
    activateTab(hash);
    history.replaceState({ tab: hash }, "", "#" + hash); // bez duplog unosa u istoriji
  }

  if ($("#feedUrl").value) reloadFeed(true);
  setInterval(() => { if ($("#feedUrl").value) reloadFeed(true); }, 60_000);
}

document.addEventListener("DOMContentLoaded", init);
