/**
 * F10 verification (2026-10-15, L2/T&S audit fixes): DrillSim-level
 * order-flow assertions along REAL simulated price paths — the evolved
 * book, not stateless generator calls. The pre-fix stateless spot
 * checks passed while live behavior differed (the Failed wall was
 * present in 8–21% of live at-the-level windows); these tests run the
 * actual sim and measure what a user would see:
 *
 *  - event timing: distribution flow begins within one candle of the
 *    first close back below HOD; no class book character in approach
 *  - spread behavior: 2–6¢ band, varies, widens with activity
 *  - volume conservation: prints partition candle volume exactly
 *  - cross-panel consistency: prints execute at the contemporaneous
 *    quote by side; tape direction agrees with price direction
 *  - class stories at the decision moment, with overlap bands (the
 *    classes must be readable in aggregate, never one constant)
 */
import { HOD_SCENARIOS } from "./scenarios";
import { DrillSim, BEHAVIOR_FOR, historyCountFor } from "./sim";
import { TICKS_PER_FLOW_UPDATE, FLOW_UPDATES_PER_CANDLE } from "./orderflow";
import type { DrillScenario } from "./types";
import type { SimEvent } from "./sim";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${name}`); }
}

type FlowEv = Extract<SimEvent, { kind: "flow" }>;
interface Win {
  ci: number;
  phase: string;
  price: number;
  bidTot: number;
  askTot: number;
  maxAsk: number;
  spreadC: number;
  bestAsk: number;
  bestBid: number;
  prints: { side: "buy" | "sell"; size: number; price: number }[];
}

/** Run one scenario a flow window at a time, capturing the live path. */
function runPath(s: DrillScenario): Win[] {
  const sim = new DrillSim(s);
  const wins: Win[] = [];
  let guard = 0;
  while (!sim.atEnd && guard++ < 100000) {
    const evs = sim.advance(TICKS_PER_FLOW_UPDATE);
    const price = sim.engine.displayPrice;
    for (const e of evs) {
      if (e.kind !== "flow") continue;
      wins.push({
        ci: e.candleIndex,
        phase: e.phase,
        price,
        bidTot: e.book.bids.reduce((a, l) => a + l.size, 0),
        askTot: e.book.asks.reduce((a, l) => a + l.size, 0),
        maxAsk: Math.max(...e.book.asks.map((l) => l.size)),
        spreadC: Math.round((e.book.asks[0].price - e.book.bids[0].price) * 100),
        bestAsk: e.book.asks[0].price,
        bestBid: e.book.bids[0].price,
        prints: e.prints,
      });
    }
  }
  return wins;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const buyShare = (ws: Win[]) => {
  let b = 0, t = 0;
  for (const w of ws) for (const p of w.prints) { t += p.size; if (p.side === "buy") b += p.size; }
  return t ? b / t : NaN;
};
const std = (a: number[]) => { const m = mean(a); return a.length ? Math.sqrt(mean(a.map((x) => (x - m) ** 2))) : NaN; };
function autocorr1(a: number[]): number {
  if (a.length < 3) return NaN;
  const m = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { den += (a[i] - m) ** 2; if (i > 0) num += (a[i] - m) * (a[i - 1] - m); }
  return den ? num / den : NaN;
}

const allWins = new Map<string, Win[]>();
for (const s of HOD_SCENARIOS) allWins.set(s.id, runPath(s));

// =====================================================================
// 1. CROSS-PANEL CONSISTENCY + VOLUME CONSERVATION (all scenarios)
// =====================================================================
console.log("\n=== Cross-panel consistency & volume conservation ===");
for (const s of HOD_SCENARIOS) {
  const wins = allWins.get(s.id)!;
  // F3: every print executes exactly at the contemporaneous quote.
  let quoteOk = true;
  for (const w of wins) {
    for (const p of w.prints) {
      if (p.side === "buy" && p.price !== w.bestAsk) quoteOk = false;
      if (p.side === "sell" && p.price !== w.bestBid) quoteOk = false;
    }
  }
  check(`${s.id}: prints execute at the quote by side (100%)`, quoteOk);

  // Exact accounting along the path.
  const vol = new Map<number, number>();
  for (const w of wins) for (const p of w.prints) vol.set(w.ci, (vol.get(w.ci) ?? 0) + p.size);
  let acctOk = vol.size > 0;
  for (const [ci, sum] of vol) if (sum !== s.candles[ci].v) acctOk = false;
  check(`${s.id}: print volume per candle == candle volume (exact)`, acctOk);
}

// Tape direction agrees with price direction (pooled, statistical):
// windows that rose within their candle carry a higher buy-share than
// windows that fell.
{
  let upB = 0, upT = 0, dnB = 0, dnT = 0;
  for (const s of HOD_SCENARIOS) {
    const wins = allWins.get(s.id)!;
    let candleStart = s.candles[wins[0].ci].o;
    let prevCi = wins[0].ci;
    for (const w of wins) {
      if (w.ci !== prevCi) { candleStart = s.candles[w.ci].o; prevCi = w.ci; }
      const dir = w.price > candleStart ? 1 : w.price < candleStart ? -1 : 0;
      for (const p of w.prints) {
        if (dir > 0) { upT += p.size; if (p.side === "buy") upB += p.size; }
        if (dir < 0) { dnT += p.size; if (p.side === "buy") dnB += p.size; }
      }
    }
  }
  const upShare = upB / upT, dnShare = dnB / dnT;
  console.log(`  direction agreement: up-windows buy-share ${upShare.toFixed(2)} vs down-windows ${dnShare.toFixed(2)}`);
  check("tape direction agrees with price direction (pooled)", upShare > dnShare + 0.1);
}

// =====================================================================
// 2. SPREAD BEHAVIOR (F5)
// =====================================================================
console.log("\n=== Spread ===");
for (const s of HOD_SCENARIOS) {
  const wins = allWins.get(s.id)!;
  const spreads = wins.map((w) => w.spreadC);
  check(`${s.id}: spread stays in the 2-6c band`, Math.min(...spreads) >= 2 && Math.max(...spreads) <= 6);
  check(`${s.id}: spread is not a constant`, new Set(spreads).size >= 2);
}
{
  const appr: number[] = [], active: number[] = [];
  for (const s of HOD_SCENARIOS) {
    for (const w of allWins.get(s.id)!) (w.phase === "approach" ? appr : active).push(w.spreadC);
  }
  console.log(`  pooled spread: approach mean ${mean(appr).toFixed(2)}c, active mean ${mean(active).toFixed(2)}c`);
  check("spread widens with activity (pooled active > approach)", mean(active) > mean(appr));
  check("quiet approach quotes stay tight (pooled mean < 3c)", mean(appr) < 3);
}

// =====================================================================
// 3. APPROACH NEUTRALITY (F1) — no class character before the coil
// =====================================================================
console.log("\n=== Approach neutrality ===");
for (const s of HOD_SCENARIOS) {
  const wins = allWins.get(s.id)!;
  const appr = wins.filter((w) => w.phase === "approach");
  const ratio = mean(appr.map((w) => w.bidTot / w.askTot));
  const depth = mean(appr.map((w) => w.bidTot + w.askTot));
  const bs = buyShare(appr);
  check(`${s.id}: approach book ratio neutral [0.8, 1.25]`, ratio >= 0.8 && ratio <= 1.25);
  check(`${s.id}: approach depth in the shared band [2000, 3800]`, depth >= 2000 && depth <= 3800);
  check(`${s.id}: approach tape uncommitted [0.30, 0.70]`, bs >= 0.3 && bs <= 0.7);
  if (BEHAVIOR_FOR[s.id] === "ambiguous") {
    const cv = std(appr.map((w) => w.askTot)) / mean(appr.map((w) => w.askTot));
    const ac = autocorr1(appr.map((w) => w.bidTot));
    check(`${s.id}: ambiguous approach depth CV < 0.25 (no slow-swell signature)`, cv < 0.25);
    check(`${s.id}: ambiguous approach depth autocorr < 0.55`, Math.abs(ac) < 0.55);
  }
}

// =====================================================================
// 4. CLASS STORIES AT THE DECISION MOMENT (event-segmented)
// =====================================================================
console.log("\n=== Class stories ===");
for (const s of HOD_SCENARIOS) {
  const behavior = BEHAVIOR_FOR[s.id];
  const wins = allWins.get(s.id)!;
  const cp = s.checkpointIndex;
  const cross = wins.filter((w) => w.ci === cp - 1);
  const brk = wins.filter((w) => w.phase === "breakout");
  const res = wins.filter((w) => w.phase === "resolution");

  if (behavior === "clean") {
    check(`${s.id}: clean cross-candle tape backs the break (>= 0.65)`, buyShare(cross) >= 0.65);
    const ratio = mean(brk.map((w) => w.bidTot / w.askTot));
    check(`${s.id}: clean breakout book strong but credible [1.7, 3.2]`, ratio >= 1.7 && ratio <= 3.2);
  }
  if (behavior === "weak") {
    check(`${s.id}: weak cross-candle tape hesitates (<= 0.55)`, buyShare(cross) <= 0.55);
    check(`${s.id}: weak resolution tape no longer buy-skewed (<= 0.55)`, buyShare(res) <= 0.55);
  }
  if (behavior === "failed") {
    const lure = buyShare(cross);
    check(`${s.id}: failed lure intact on the cross candle [0.45, 0.80]`, lure >= 0.45 && lure <= 0.8);
    // F7: the wall — majority of at/above-level breakout windows show
    // a >= 1500-share ask rung in the EVOLVED book.
    const atLevel = brk.filter((w) => w.price >= s.hod);
    const wallPct = atLevel.length ? atLevel.filter((w) => w.maxAsk >= 1500).length / atLevel.length : 0;
    check(`${s.id}: wall present in majority of at-level breakout windows`, wallPct >= 0.5);
    // F2 timing: distribution (resolution phase) in force within one
    // candle after the first close back below HOD, and sell-leaning.
    const firstSub = s.candles.findIndex((cand, i) => i >= cp - 1 && cand.c < s.hod);
    const byCandle = new Map<number, Win[]>();
    for (const w of wins) { const a = byCandle.get(w.ci) ?? []; a.push(w); byCandle.set(w.ci, a); }
    let distStart = Infinity;
    for (const [ci, ws] of byCandle) {
      if (ws.filter((w) => w.phase === "resolution").length > ws.length / 2) { distStart = Math.min(distStart, ci); }
    }
    check(`${s.id}: distribution begins within 1 candle of first sub-HOD close`,
      firstSub >= 0 && distStart <= firstSub + 1);
    const postRes = wins.filter((w) => w.phase === "resolution" && w.ci > firstSub);
    check(`${s.id}: post-rejection tape is distribution (< 0.35 buy)`, buyShare(postRes) < 0.35);
  }
  if (behavior === "ambiguous") {
    const cs = buyShare(cross);
    check(`${s.id}: ambiguous cross tape genuinely mixed [0.30, 0.65]`, cs >= 0.3 && cs <= 0.65);
    check(`${s.id}: ambiguous resolution never resolves [0.30, 0.60]`,
      buyShare(res) >= 0.3 && buyShare(res) <= 0.6);
  }
}

// =====================================================================
// 5. PRINT FREQUENCY RESPONDS TO ACTIVITY (F4)
// =====================================================================
console.log("\n=== Print frequency ===");
{
  const per = (ph: string) => {
    const counts: number[] = [];
    for (const s of HOD_SCENARIOS) {
      for (const w of allWins.get(s.id)!) if (w.phase === ph) counts.push(w.prints.length);
    }
    return mean(counts);
  };
  const a = per("approach"), b = per("breakout"), r = per("resolution");
  console.log(`  prints/window: approach ${a.toFixed(2)}, breakout ${b.toFixed(2)}, resolution ${r.toFixed(2)}`);
  check("breakout prints more frequently than approach", b > a * 1.1);
  check("resolution prints more frequently than approach", r > a * 1.1);
  check("quiet approach stays sparse (<= 2 prints/window)", a <= 2);
}

// =====================================================================
// 6. RESIDUAL #1 — FAILED TEST-REJECTION CHAPTER + DISTRIBUTION RAMP,
//    AND RESIDUAL #2a — CLEAN APPROACH LEAN
// =====================================================================
console.log("\n=== Residual #1: failed rejection trajectories ===");
for (const s of HOD_SCENARIOS) {
  if (BEHAVIOR_FOR[s.id] !== "failed") continue;
  const wins = allWins.get(s.id)!;
  const cp = s.checkpointIndex;
  const firstSub = s.candles.findIndex((cand, i) => i >= cp - 1 && cand.c < s.hod);
  const post = wins.filter((w) => w.ci > firstSub && w.ci <= firstSub + 2);
  const postRatio = mean(post.map((w) => w.bidTot / w.askTot));
  check(`${s.id}: book is distributed within 2 candles of the main confirming close (mean ratio < 0.35)`,
    post.length > 0 && postRatio < 0.35);
}
{
  // failed-003 (grind trap): candle 9 closes AT the level, candle 10
  // closes below — a decisive test the strict cross semantics never
  // confirm. The flow chapter must open on that confirming close, the
  // book must bend within one candle, and the lure must survive both
  // before it and at the real cross that follows.
  const s = HOD_SCENARIOS.find((x) => x.id === "hod-failed-003")!;
  const hist = historyCountFor(s);
  const wins = allWins.get(s.id)!;
  const confirmIdx = s.candles.findIndex(
    (c, i) => i >= hist && c.h >= s.hod && c.c < s.hod && c.c >= s.hod * 0.995
  );
  check("failed-003: decisive live test found (chapter anchor exists)", confirmIdx === 10);
  const at = (ci: number) => wins.filter((w) => w.ci === ci);
  const ratioAt = (ci: number) => mean(at(ci).map((w) => w.bidTot / w.askTot));
  const resAt = (ci: number) => at(ci).filter((w) => w.phase === "resolution").length;
  check("failed-003: no distribution before the confirming close",
    wins.filter((w) => w.ci < confirmIdx && w.phase === "resolution").length === 0);
  check("failed-003: no premature distribution on the test candle itself (mean ratio > 0.85)",
    ratioAt(confirmIdx - 1) > 0.85);
  check("failed-003: confirming candle does not teleport (mean ratio > 0.7)",
    ratioAt(confirmIdx) > 0.7);
  check("failed-003: ratio bends below 0.85 within the first post-confirmation candle",
    ratioAt(confirmIdx + 1) < 0.85);
  const bend = at(confirmIdx + 1).map((w) => w.bidTot / w.askTot);
  check("failed-003: >= 80% of first post-confirmation windows are ask-heavy",
    bend.filter((r) => r < 0.85).length / bend.length >= 0.8);
  const first3 = wins.filter((w) => w.ci > confirmIdx && w.ci <= confirmIdx + 3);
  check("failed-003: approaches the distribution band within 3 candles (mean ratio < 0.6)",
    mean(first3.map((w) => w.bidTot / w.askTot)) < 0.6);
  check("failed-003: chapter closes for the re-break (no resolution windows at the checkpoint candle)",
    resAt(s.checkpointIndex) === 0);
  check("failed-003: cross candle stays lure (<= 2 resolution windows before the spike)",
    resAt(s.checkpointIndex - 1) <= 2);
  // The confirming candle's own resolution window, if any, is its
  // FINAL window (emitted on the finalizing tick — after the close).
  const sim = new DrillSim(s);
  let lastWinUi = -1, resUiAtConfirm: number[] = [];
  let g = 0;
  while (!sim.atEnd && g++ < 100000) {
    for (const e of sim.advance(TICKS_PER_FLOW_UPDATE)) {
      if (e.kind === "flow" && e.candleIndex === confirmIdx && e.phase === "resolution") {
        resUiAtConfirm.push(e.updateIndex);
      }
      if (e.kind === "flow") lastWinUi = e.updateIndex;
    }
  }
  void lastWinUi;
  check("failed-003: confirming candle's resolution window is post-close only",
    resUiAtConfirm.every((ui) => ui === FLOW_UPDATES_PER_CANDLE - 1));
}

console.log("\n=== Residual #2a: clean approach lean ===");
{
  const byClass = new Map<string, number[]>();
  for (const s of HOD_SCENARIOS) {
    const appr = allWins.get(s.id)!.filter((w) => w.phase === "approach");
    const arr = byClass.get(BEHAVIOR_FOR[s.id]) ?? [];
    arr.push(buyShare(appr));
    byClass.set(BEHAVIOR_FOR[s.id], arr);
  }
  const cleanMean = mean(byClass.get("clean")!);
  console.log(`  approach buy-share class means: clean ${cleanMean.toFixed(3)}, weak ${mean(byClass.get("weak")!).toFixed(3)}, failed ${mean(byClass.get("failed")!).toFixed(3)}, ambiguous ${mean(byClass.get("ambiguous")!).toFixed(3)}`);
  check("clean approach tape lean softened (class mean <= 0.57)", cleanMean <= 0.57);
  check("failed approach tape overlaps clean (no reliable approach shortcut)",
    Math.max(...byClass.get("failed")!) >= Math.min(...byClass.get("clean")!));
}

console.log(`\n=== FLOWPATH RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
