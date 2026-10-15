/**
 * Drill rebuild verification (2026-10-14 audit): DrillSim invariants.
 *
 * Covers spec §11: candle aggregation, simulation timing (pause/resume/
 * reset/speed/chunking/bounded catch-up), Level 2 & Time & Sales
 * invariants with exact volume accounting, scenario rules + HOD,
 * reproducibility, no future leakage, blind-surface, and integration
 * (scenario isolation, cycles, /replay default-engine regression).
 */
import { HOD_SCENARIOS, getScenario } from "./scenarios";
import { generateScenarioCandles } from "./candleGen";
import {
  DrillSim, SimClock, historyCountFor,
  MAX_FRAME_TICKS, MAX_FRAME_DT_MS, PRINT_BUFFER_MAX,
} from "./sim";
import { DRILL_TICKS_PER_CANDLE, TICKS_PER_FLOW_UPDATE } from "./orderflow";
import { hodMarketState } from "./hodState";
import { ReplayEngine, TICKS_PER_CANDLE } from "../engine";
import type { DrillScenario } from "./types";
import type { SimEvent } from "./sim";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${name}`); }
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Run a sim to completion in fixed chunks; return its full event stream. */
function runToEnd(s: DrillScenario, chunk: number): { sim: DrillSim; events: SimEvent[] } {
  const sim = new DrillSim(s);
  const events: SimEvent[] = [];
  let guard = 0;
  while (!sim.atEnd && guard++ < 100000) {
    events.push(...sim.advance(chunk));
  }
  return { sim, events };
}

const flowEvents = (evs: SimEvent[]) => evs.filter((e) => e.kind === "flow") as Extract<SimEvent, { kind: "flow" }>[];
const finalEvents = (evs: SimEvent[]) => evs.filter((e) => e.kind === "final") as Extract<SimEvent, { kind: "final" }>[];

// =====================================================================
// 1. CANDLE AGGREGATION
// =====================================================================
console.log("\n=== Candle aggregation ===");
for (const s of HOD_SCENARIOS) {
  const { sim, events } = runToEnd(s, DRILL_TICKS_PER_CANDLE);
  const finals = finalEvents(events);
  const hist = historyCountFor(s);

  check(`${s.id}: every live candle finalized`, finals.length === s.candles.length - hist);
  check(
    `${s.id}: finalized candles equal scenario candles exactly`,
    finals.every((f, i) => eq(f.candle, s.candles[hist + i]) && f.candleIndex === hist + i)
  );
  check(`${s.id}: engine ends at last candle`, sim.engine.index === s.candles.length - 1 && sim.atEnd);

  // Timestamps unique and strictly 60s apart across the whole scenario
  const ts = s.candles.map((c) => c.t);
  check(
    `${s.id}: candle timestamps unique, 60s spacing`,
    new Set(ts).size === ts.length && ts.every((t, i) => i === 0 || t - ts[i - 1] === 60_000)
  );
  // Chain continuity: next open == previous close (within rounding)
  check(
    `${s.id}: candles chain (open == prev close)`,
    s.candles.every((c, i) => i === 0 || Math.abs(c.o - s.candles[i - 1].c) < 0.011)
  );
}

// Forming-candle invariants + finalized immutability, sampled live.
for (const s of HOD_SCENARIOS) {
  const sim = new DrillSim(s);
  const hist = historyCountFor(s);
  let formingOk = true, immutableOk = true, leakOk = true;
  const finalizedJson: string[] = sim.engine.revealed.map((c) => JSON.stringify(c));
  let step = 0;
  while (!sim.atEnd && step++ < 100000) {
    sim.advance(7); // odd chunk: samples many intra-candle positions
    const eng = sim.engine;
    const dc = eng.displayCandles;
    // No future leak: display never goes past the forming candle, and
    // every displayed timestamp belongs to a candle at or before it.
    const maxIdx = Math.min(eng.index + 1, s.candles.length - 1);
    if (dc.length > maxIdx + 1) leakOk = false;
    if (dc.some((c, i) => c.t !== s.candles[i].t)) leakOk = false;
    // Forming candle: opens at the true open, stays inside true [l, h],
    // volume partial and monotone-bounded by the true volume.
    const forming = sim.formingCandle();
    if (forming) {
      const target = s.candles[eng.index + 1];
      if (
        forming.o !== target.o ||
        forming.h < Math.max(forming.o, forming.c) ||
        forming.l > Math.min(forming.o, forming.c) ||
        forming.h > target.h || forming.l < target.l ||
        forming.c < target.l || forming.c > target.h ||
        forming.v < 0 || forming.v > target.v
      ) formingOk = false;
    }
    // Finalized candles never change after the fact.
    const now = eng.revealed.map((c) => JSON.stringify(c));
    for (let i = 0; i < finalizedJson.length; i++) {
      if (now[i] !== finalizedJson[i]) immutableOk = false;
    }
    if (now.length > finalizedJson.length) finalizedJson.push(...now.slice(finalizedJson.length));
  }
  check(`${s.id}: forming candle stays within true OHLCV`, formingOk);
  check(`${s.id}: finalized candles immutable`, immutableOk);
  check(`${s.id}: no future data in display stream`, leakOk);
  check(`${s.id}: history revealed at start`, hist >= 2 && hist < s.checkpointIndex);
}

// =====================================================================
// 2. TIMING: chunking invariance, pause, reset, speed, bounded catch-up
// =====================================================================
console.log("\n=== Timing ===");
for (const s of HOD_SCENARIOS) {
  const a = runToEnd(s, 1);
  const b = runToEnd(s, MAX_FRAME_TICKS);
  const c = runToEnd(s, DRILL_TICKS_PER_CANDLE);
  check(
    `${s.id}: event stream identical regardless of advance chunking`,
    eq(a.events, b.events) && eq(a.events, c.events)
  );
  check(
    `${s.id}: final state identical regardless of chunking`,
    a.sim.engine.index === b.sim.engine.index &&
      a.sim.engine.displayPrice === b.sim.engine.displayPrice &&
      eq(a.sim.prints, b.sim.prints) && eq(a.sim.book, b.sim.book)
  );

  // Pause = no advance calls; resume continues the identical stream.
  const p = new DrillSim(s);
  const streamP: SimEvent[] = [];
  streamP.push(...p.advance(137));
  const frozen = JSON.stringify({ b: p.book, p: p.prints, t: p.ticksElapsed, i: p.engine.index, px: p.engine.displayPrice });
  check(`${s.id}: advance(0) is a no-op (pause)`, p.advance(0).length === 0);
  check(
    `${s.id}: state frozen while paused`,
    JSON.stringify({ b: p.book, p: p.prints, t: p.ticksElapsed, i: p.engine.index, px: p.engine.displayPrice }) === frozen
  );
  let guard = 0;
  while (!p.atEnd && guard++ < 100000) streamP.push(...p.advance(41));
  check(`${s.id}: pause/resume run == uninterrupted run`, eq(streamP, a.events));

  // Reset (fresh sim) reproduces the exact initial state.
  const fresh = new DrillSim(s);
  const fresh2 = new DrillSim(s);
  check(
    `${s.id}: fresh sim initial state deterministic`,
    eq(fresh.book, fresh2.book) && eq(fresh.prints, fresh2.prints) &&
      fresh.engine.index === fresh2.engine.index && fresh.ticksElapsed === 0
  );

  // No events after the end; state stable.
  const extra = a.sim.advance(500);
  check(`${s.id}: no events after end`, extra.length === 0 && a.sim.ticksElapsed === (s.candles.length - historyCountFor(s)) * DRILL_TICKS_PER_CANDLE);
}

// SimClock: speed model + bounded catch-up.
{
  // One candle at 8x = 7.5s of wall time; at 1x = 60s. Same tick count.
  const ticksFor = (speed: number, frames: number, dtMs: number) => {
    const clock = new SimClock();
    let total = 0;
    let now = 0;
    clock.frame(0, speed); // anchor
    for (let i = 0; i < frames; i++) { now += dtMs; total += clock.frame(now, speed); }
    return total;
  };
  const at8 = ticksFor(8, 300, 25); // 7.5s
  const at1 = ticksFor(1, 2400, 25); // 60s
  check("clock: 8x forms one candle in 7.5s wall", Math.abs(at8 - DRILL_TICKS_PER_CANDLE) <= 1);
  check("clock: 1x forms one candle in 60s wall", Math.abs(at1 - DRILL_TICKS_PER_CANDLE) <= 1);
  check("clock: speed changes only pacing (same ticks per sim-minute)", Math.abs(at8 - at1) <= 1);

  // Stall: a 60s gap must not produce a burst — dt clamp + per-frame cap.
  const clock = new SimClock();
  clock.frame(0, 32);
  const afterStall = clock.frame(60_000, 32);
  check("clock: stall frame bounded by cap", afterStall <= MAX_FRAME_TICKS);
  check("clock: stall frame bounded by dt clamp", afterStall <= Math.ceil((MAX_FRAME_DT_MS / 1000) * 32 * (DRILL_TICKS_PER_CANDLE / 60)) + 1);
  const next = clock.frame(60_000 + 16, 32);
  check("clock: no catch-up burst after a stall", next <= 2);

  // Pause semantics at the clock: not feeding frames advances nothing.
  const c2 = new SimClock();
  c2.frame(1000, 8);
  check("clock: first frame only anchors", c2.frame(1000, 8) === 0);
}

// =====================================================================
// 3. LEVEL 2 & TIME & SALES
// =====================================================================
console.log("\n=== Level 2 & Time & Sales ===");
for (const s of HOD_SCENARIOS) {
  // Advance exactly one flow window at a time so each flow event can be
  // checked against the live price at its own moment.
  const sim = new DrillSim(s);
  let ladderOk = true, bracketOk = true, continuityOk = true, chronOk = true;
  let prevBook = sim.book;
  let prevPrintTs = -Infinity;
  const volByCandle = new Map<number, number>();
  let guard = 0;
  while (!sim.atEnd && guard++ < 100000) {
    const evs = sim.advance(TICKS_PER_FLOW_UPDATE);
    const price = sim.engine.displayPrice;
    for (const e of evs) {
      if (e.kind !== "flow") continue;
      const { bids, asks } = e.book;
      // Ladder: strictly ordered, unique prices, positive spread/sizes.
      for (let i = 1; i < 5; i++) {
        if (!(bids[i].price < bids[i - 1].price)) ladderOk = false;
        if (!(asks[i].price > asks[i - 1].price)) ladderOk = false;
      }
      const allPrices = [...bids, ...asks].map((l) => l.price);
      if (new Set(allPrices).size !== allPrices.length) ladderOk = false;
      if (!(asks[0].price > bids[0].price)) ladderOk = false;
      if (![...bids, ...asks].every((l) => l.size >= 1)) ladderOk = false;
      // Book brackets the actual last tick price.
      if (!(bids[0].price < price && price < asks[0].price)) bracketOk = false;
      // Continuity: when the mid moved ≤1¢ (the level's role in the
      // ladder is unchanged), a price-matched rung's size evolves by at
      // most the bounded step + shave (≤ ~46% by construction). Larger
      // mid moves re-anchor the ladder — a fixed price legitimately
      // changes role (deep rung → touch), as in a real book.
      if (prevBook) {
        const midC = Math.round(((bids[0].price + asks[0].price) / 2) * 100);
        const prevMidC = Math.round(((prevBook.bids[0].price + prevBook.asks[0].price) / 2) * 100);
        if (Math.abs(midC - prevMidC) <= 1) {
          const prevMap = new Map([...prevBook.bids, ...prevBook.asks].map((l) => [Math.round(l.price * 100), l.size]));
          for (const l of [...bids, ...asks]) {
            const prev = prevMap.get(Math.round(l.price * 100));
            if (prev != null && Math.abs(l.size - prev) / prev > 0.55) continuityOk = false;
          }
        }
      }
      prevBook = e.book;
      // Prints: chronological (non-decreasing) across the whole run.
      for (const pr of e.prints) {
        if (pr.timestamp < prevPrintTs) chronOk = false;
        prevPrintTs = pr.timestamp;
        volByCandle.set(e.candleIndex, (volByCandle.get(e.candleIndex) ?? 0) + pr.size);
      }
    }
  }
  check(`${s.id}: book ladder strictly ordered, unique prices`, ladderOk);
  check(`${s.id}: book brackets last tick price at every window`, bracketOk);
  check(`${s.id}: book sizes evolve bounded (≤55% per stable-role update)`, continuityOk);
  check(`${s.id}: print timestamps chronological`, chronOk);

  // Exact accounting: prints per candle sum to the candle's true volume.
  let acctOk = true;
  for (const [ci, sum] of volByCandle) {
    if (sum !== s.candles[ci].v) acctOk = false;
  }
  check(`${s.id}: print volume per candle == candle volume (exact)`, acctOk);
  check(`${s.id}: every live candle has prints accounted`, volByCandle.size === s.candles.length - historyCountFor(s));

  // Bounded history + prices on the path.
  check(`${s.id}: print buffer bounded`, sim.prints.length <= PRINT_BUFFER_MAX);
  const { events } = runToEnd(s, TICKS_PER_FLOW_UPDATE);
  let priceOk = true;
  for (const e of flowEvents(events)) {
    const c = s.candles[e.candleIndex];
    for (const pr of e.prints) {
      if (pr.price < c.l - 0.01 || pr.price > c.h + 0.01) priceOk = false;
    }
  }
  check(`${s.id}: print prices stay on the candle's traded path`, priceOk);
}

// =====================================================================
// 4. SCENARIOS: rules, HOD, fingerprints, reproducibility, blind surface
// =====================================================================
console.log("\n=== Scenarios ===");
{
  // HOD == max high strictly before the breakout candle.
  for (const s of HOD_SCENARIOS) {
    const breakoutAt = s.checkpointIndex - 1;
    const expected = Math.max(...s.candles.slice(0, breakoutAt).map((c) => c.h));
    check(`${s.id}: HOD is the pre-breakout max high`, s.hod === expected);
    check(`${s.id}: breakout candle trades above HOD`, s.candles[breakoutAt].h > s.hod);
  }

  // Fingerprints (measured 2026-10-14; thresholds express the semantics).
  const fp = (s: DrillScenario) => {
    const bi = s.checkpointIndex - 1;
    const bc = s.candles[bi];
    const pre = s.candles.slice(0, bi);
    const avgV = pre.reduce((a, c) => a + c.v, 0) / pre.length;
    return {
      volMult: bc.v / avgV,
      closePos: (bc.c - bc.o) / Math.max(1e-9, bc.h - bc.o),
      spike: bc.h / s.hod - 1,
      final: s.candles[s.candles.length - 1].c,
      postMinLow: Math.min(...s.candles.slice(bi + 1).map((c) => c.l)),
    };
  };
  const F = Object.fromEntries(HOD_SCENARIOS.map((s) => [s.classification, fp(s)]));
  check("clean: volume expands ≥1.7x", F.clean.volMult >= 1.7);
  check("clean: closes in top third of breakout range", F.clean.closePos >= 0.65);
  check("clean: holds above HOD to the end", F.clean.final > getScenario("hod-clean-001")!.hod && F.clean.postMinLow >= getScenario("hod-clean-001")!.hod * 0.998);
  check("weak: no volume expansion (<1.3x)", F.weak.volMult < 1.3);
  check("weak: weak close position (<0.6)", F.weak.closePos < 0.6);
  check("weak: fades after the break", F.weak.final < getScenario("hod-weak-001")!.candles[getScenario("hod-weak-001")!.checkpointIndex - 1].c);
  check("failed: climax volume ≥2.2x", F.failed.volMult >= 2.2);
  check("failed: rejection close (bottom third)", F.failed.closePos <= 0.35);
  check("failed: spike ≥2% above HOD", F.failed.spike >= 0.02);
  check("failed: trap completes — ends below HOD", F.failed.final < getScenario("hod-failed-001")!.hod);
  check("ambiguous: middling volume (0.9–1.6x)", F.ambiguous.volMult >= 0.9 && F.ambiguous.volMult <= 1.6);
  check("ambiguous: mid-range close (0.4–0.7)", F.ambiguous.closePos >= 0.4 && F.ambiguous.closePos <= 0.7);
  check(
    "scenarios genuinely distinct: strict volMult ordering failed>clean>ambiguous>weak",
    F.failed.volMult > F.clean.volMult && F.clean.volMult > F.ambiguous.volMult && F.ambiguous.volMult > F.weak.volMult
  );
  check(
    "scenarios genuinely distinct: strict closePos ordering clean>ambiguous>weak>failed",
    F.clean.closePos > F.ambiguous.closePos && F.ambiguous.closePos > F.weak.closePos && F.weak.closePos > F.failed.closePos
  );

  // Generator reproducibility from raw defs.
  const def = { candles: 9, drift: 0.001, volatility: 0.006, volBase: 8000, volRange: 4000, volMoveMult: 2_000_000 };
  const g1 = generateScenarioCandles(21001, 10, [def], { spikeAboveHod: 0.015, closePosition: 0.8, volMult: 3 }, 8);
  const g2 = generateScenarioCandles(21001, 10, [def], { spikeAboveHod: 0.015, closePosition: 0.8, volMult: 3 }, 8);
  check("candleGen: same seed → identical candles", eq(g1, g2));

  // Blind surface: nothing the UI consumes pre-answer (events, book,
  // prints) carries the classification or the flow behavior.
  for (const s of HOD_SCENARIOS) {
    const { events, sim } = runToEnd(s, DRILL_TICKS_PER_CANDLE);
    const surface = JSON.stringify({ events, book: sim.book, prints: sim.prints });
    check(
      `${s.id}: UI surface carries no classification/behavior leak`,
      !surface.includes(s.classification) && !surface.includes('"behavior"')
    );
  }

  // HOD state machine (revealed data only).
  const L = 10;
  const mk = (o: number, h: number, l: number, c: number) => ({ t: 0, o, h, l, c, v: 100 });
  check("hodState: far below = approaching", hodMarketState(L, [mk(9.5, 9.6, 9.4, 9.55)], null) === "approaching");
  check("hodState: just under level = testing", hodMarketState(L, [mk(9.9, 9.97, 9.85, 9.96)], null) === "testing");
  check("hodState: above, no close above yet = breaking", hodMarketState(L, [mk(9.9, 9.98, 9.85, 9.95)], mk(9.95, 10.08, 9.94, 10.05)) === "breaking");
  check("hodState: above with a close above = accepting", hodMarketState(L, [mk(9.95, 10.1, 9.9, 10.06)], mk(10.06, 10.12, 10.02, 10.09)) === "accepting");
  check("hodState: closed above then fell back = rejected", hodMarketState(L, [mk(9.95, 10.1, 9.9, 10.06), mk(10.06, 10.07, 9.9, 9.94)], null) === "rejected");
  check("hodState: wicked above, back below = rejected", hodMarketState(L, [mk(9.9, 9.98, 9.85, 9.95)], mk(9.95, 10.09, 9.9, 9.93)) === "rejected");
}

// =====================================================================
// 5. INTEGRATION: isolation, cycles, checkpoint, /replay regression
// =====================================================================
console.log("\n=== Integration ===");
{
  // Interleaved sims (scenario switching back & forth) match solo runs.
  const clean = getScenario("hod-clean-001")!;
  const failed = getScenario("hod-failed-001")!;
  const soloC = runToEnd(clean, 25).events;
  const soloF = runToEnd(failed, 25).events;
  const simC = new DrillSim(clean);
  const simF = new DrillSim(failed);
  const evC: SimEvent[] = [], evF: SimEvent[] = [];
  let guard = 0;
  while ((!simC.atEnd || !simF.atEnd) && guard++ < 100000) {
    evC.push(...simC.advance(25));
    evF.push(...simF.advance(25));
  }
  check("interleaved scenarios stay isolated (clean)", eq(evC, soloC));
  check("interleaved scenarios stay isolated (failed)", eq(evF, soloF));

  // Repeated start/advance/reset cycles are stable.
  let cyclesOk = true;
  for (let i = 0; i < 20; i++) {
    const s1 = new DrillSim(clean);
    s1.advance(37); s1.advance(0); s1.advance(53);
    const s2 = new DrillSim(clean);
    s2.advance(90);
    if (!eq(s1.book, s2.book) || s1.engine.displayPrice !== s2.engine.displayPrice) cyclesOk = false;
  }
  check("start/advance/reset cycles deterministic x20", cyclesOk);

  // Checkpoint bookkeeping: checkpoint flag rises exactly when the
  // checkpoint candle finalizes, never before.
  const s3 = new DrillSim(clean);
  let cpOk = true;
  let steps = 0;
  while (!s3.checkpointReached && steps++ < 100000) {
    s3.advance(1);
    if (s3.checkpointReached && s3.engine.index !== clean.checkpointIndex) cpOk = false;
  }
  check("checkpoint fires exactly at checkpoint candle finalize", cpOk && s3.engine.index === clean.checkpointIndex);

  // advanceToEnd (Skip to Result) drains deterministically.
  const d1 = new DrillSim(failed); d1.advanceToEnd();
  const d2 = runToEnd(failed, DRILL_TICKS_PER_CANDLE).sim;
  check("advanceToEnd == tick-by-tick end state", d1.engine.index === d2.engine.index && eq(d1.book, d2.book) && eq(d1.prints, d2.prints));

  // /replay regression: the shared engine's defaults are untouched and a
  // default (360-tick) engine finalizes to the exact scenario candles.
  check("engine default ticks/candle still 360", TICKS_PER_CANDLE === 360);
  const eng = new ReplayEngine(clean.candles, 100_000, 0);
  const seen: string[] = [];
  let g2 = 0;
  while (!eng.atEnd && g2++ < 100000) {
    const before = eng.index;
    eng.tick();
    if (eng.index !== before) seen.push(JSON.stringify(eng.currentCandle));
  }
  const expected = clean.candles.map((c) => JSON.stringify(c));
  check("default engine finalizes to exact candles (replay path)", eq(seen, expected));
}

console.log(`\n=== SIM RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
