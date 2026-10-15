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
import { DrillSim, BEHAVIOR_FOR } from "./sim";
import { TICKS_PER_FLOW_UPDATE } from "./orderflow";
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

console.log(`\n=== FLOWPATH RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
