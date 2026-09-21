"use strict";
/* Wingo — bingo taktika. Lokalni alat; podaci ostaju u localStorage.
 * Logika: statistika za zadnjih N kola + heurističke preporuke („drži 6”)
 * + egzaktni covering-wheel (greedy + provera garancije).
 * Napomena: RNG igre nemaju memoriju — alat je organizator igre, ne predskazivač.
 */

const BALL_COLORS = ["purple","yellow","green","blue","red","brown","orange","black"];
const ballColor = (n) => BALL_COLORS[n % 8];
const LIGHT = new Set(["yellow", "orange"]);

// Podrazumevani feed: live JSON iz ovog repoa (radi lokalno i na GitHub Pages-u).
// Ne moraš ništa da kucaš ručno u „Podaci & podešavanja” — automatski se koristi.
const DEFAULT_FEED_URL =
  "https://raw.githubusercontent.com/dexilio13-ui/wingo/main/data/bingo-results.json";

const LS = {
  feedUrl: "wingo.feedUrl",
  manual: "wingo.manualRounds",
  settings: "wingo.settings",
  held: "wingo.held",
  wheel: "wingo.wheel",
  seenRound: "wingo.seenRound",
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

/* ── Tabovi ─────────────────────────────────────────────────────────────── */

document.querySelectorAll(".tab-btn").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    b.classList.add("active");
    $("#panel-" + b.dataset.tab).classList.add("active");
  });
});

/* ── Feed ───────────────────────────────────────────────────────────────── */

function applyFeedData(data) {
  if (data && Array.isArray(data.rounds)) {
    state.rounds = data.rounds
      .filter((r) => Array.isArray(r.balls) && r.balls.length)
      .map((r) => ({
        round_number: r.round_number, drawn_at: r.drawn_at, balls: r.balls,
        sweet_spot: r.sweet_spot ?? null, sweet_spot2: r.sweet_spot2 ?? null,
      }));
    state.feedInfo = { updated_at: data.updated_at, source: data.source };
  }
  if (data && data.live_round && Array.isArray(data.live_round.balls)) {
    state.live = data.live_round;
  }
  renderAll();
}

async function reloadFeed(silent) {
  const url = $("#feedUrl").value.trim();
  if (!url) { if (!silent) toast("Unesi feed URL u „Podaci & podešavanja”"); return; }
  try {
    // cache-busting: radi i za GitHub Pages (CDN keš) i za raw.githubusercontent.com
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
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

/* ── Istorija panel ─────────────────────────────────────────────────────── */

function renderAll() {
  const uni = +($("#universe").value || 48);
  const depth = +($("#depth").value || 40);
  const rounds = allRounds();
  renderSweetSpot();
  if (!rounds.length) { $("#feedStatus").textContent = "feed: nema podataka"; return; }

  const A = analyze(rounds, uni, depth);

  $("#feedStatus").textContent =
    `feed: ${A.use.length} kola` + (state.feedInfo?.updated_at ? ` · ažurirano ${state.feedInfo.updated_at.slice(11, 16)} UTC` : "");
  $("#lastRound").textContent = state.rounds[0] ? `zadnje kolo #${state.rounds[0].round_number}` : "";

  renderLive();
  renderHeatmap(A);
  renderKpis(A);
  renderHistTable(A.use);
  renderHeld();
  renderWheelTracking();
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
  const depth = +($("#depth").value || 40);
  const rounds = state.rounds.filter((r) => r.sweet_spot != null).slice(0, depth);
  if (!rounds.length) {
    box.textContent = "Učitaj feed (tab „⚙️ Podaci & podešavanja”) — nema sweet spot podataka.";
    return;
  }
  box.replaceChildren();

  const counts = new Map();
  for (const r of rounds) {
    for (const x of [r.sweet_spot, r.sweet_spot2].filter((x) => x != null))
      counts.set(x, (counts.get(x) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  const top = el("div", "balls");
  for (const [num, c] of sorted.slice(0, 12)) {
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
  for (const r of use.slice(0, 40)) {
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
  const depth = +($("#depth").value || 40);
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
    h.rounds_left = Math.max(0, h.until_round - top);
    const active = h.rounds_left > 0;
    if (active) anyActive = true;

    const row = el("div", "card");
    row.style.background = "#10131a";
    row.style.marginBottom = "8px";
    const head = el("div", "row");
    head.appendChild(el("b", null, `Brojevi (${h.numbers.length})`));
    head.appendChild(el("span", active ? "ok" : "muted",
      active ? `važi još ${h.rounds_left} kola (do #${h.until_round})` : "isteklo"));
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

  // brzina: limitiraj složene slučajeve
  const tCount = combinatorial(uniq.length, t);
  if (tCount > 30000) {
    out.innerHTML = `<span class="bad">Previše kombinacija za proveru (C(${uniq.length},${t})=${tCount}). Smanji biricu ili T.</span>`;
    return;
  }

  const combos = greedyWheel(uniq, k, t);
  const guaranteed = verifyGuarantee(uniq, combos, k, t);
  const payin = Math.max(1, +$("#wheelPayin").value || 20);

  state.wheelResult = { pool: uniq, k, t, combos, payin, created_round: allRounds()[0]?.round_number ?? 0, hits: [] };
  save(LS.wheel, state.wheelResult);

  out.replaceChildren();
  const sum = el("div", null);
  sum.innerHTML =
    `<b>${combos.length}</b> kombinacija ${k}/${uniq.length} · garancija: ako ${t}+ iz birice izađe, bar jedna kombinacija ima ${t} pogodaka — ` +
    (guaranteed ? '<span class="ok">provereno ✓</span>' : '<span class="bad">NIJE provereno ✗</span>') +
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
  sel.replaceChildren(el("option", { value: "" }, "— izaberi —"));
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

  $("#btnReloadFeed").addEventListener("click", async () => {
    // 1) odmah osveži lokalno (iz cache-busted feed-a),
    await reloadFeed(false);
    // 2) pa u pozadini triggeruj GitHub Action da bot povuče i najnovije kolo
    //    (odgovor stiže kroz ~1–2 min kroz automatski reload na 60 s)
    try {
      const r = await fetch("http://localhost:3333/trigger");
      if (r.ok) toast("GitHub Action pokrenut — feed stiže za ~1–2 min");
    } catch { /* lokalni agent nije aktivan — feed se ionako osvežava na 60 s */ }
    renderAll();
  });
  $("#btnSaveUrl").addEventListener("click", () => reloadFeed(false));
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
    document.querySelector(`.tab-btn[data-tab="${hash}"]`)?.click();
  }

  if ($("#feedUrl").value) reloadFeed(true);
  setInterval(() => { if ($("#feedUrl").value) reloadFeed(true); }, 60_000);
}

document.addEventListener("DOMContentLoaded", init);
