/**
 * candleAccuracy.test.ts — regression suite for the Candle Accuracy Audit.
 * Run: npx tsx lib/candleAccuracy.test.ts
 *
 * Proves the source-of-truth contract: Twelve Data OHLCV in == finalized
 * candles out == chart bars out, at every replay speed / drive pattern.
 * The renderer is exercised through the PRODUCTION planner (lib/chartPush)
 * against a mock series with Lightweight Charts setData/update semantics.
 */
import { ReplayEngine, TICKS_PER_CANDLE } from "./engine";
import type { Candle, Fill } from "./types";
import { parseTwelveDataResponse } from "./marketData.twelve";
import { parseCsv, candlesToCsv } from "./marketData.csv";
import { etToUtcMs, aggregateCandles } from "./marketData";
import { planBarPush, type BarPushState } from "./chartPush";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`); }
}
const eqC = (a: Candle, b: Candle) =>
  a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;

/* ---------------- Fixtures ---------------- */
const DATE = "2026-10-12";
const RAW: Array<[string, number, number, number, number, number]> = [
  ["09:30", 4.2, 4.26, 4.17, 4.24, 52000], // ordinary
  ["09:31", 4.24, 4.61, 4.22, 4.28, 88000], // long upper wick
  ["09:32", 4.28, 4.31, 3.94, 4.27, 91000], // long lower wick
  ["09:33", 4.27, 4.55, 4.26, 4.53, 210000], // strong momentum
  ["09:34", 4.53, 5.28, 4.52, 5.21, 540000], // HOD breakout spike
  ["09:35", 5.21, 5.33, 5.02, 5.05, 610000], // failed breakout
  ["09:36", 4.71, 4.78, 4.55, 4.6, 300000], // gap down
  ["09:37", 4.6, 4.64, 4.56, 4.6, 45000], // doji
  ["09:38", 4.6, 4.6, 4.6, 4.6, 0], // flat / halt-like, zero volume
  ["09:39", 4.6, 4.63, 4.58, 4.61, 0], // ranged, zero volume
  ["09:40", 4.61, 4.7, 4.59, 4.68, 9800000], // huge volume
  ["09:41", 4.95, 5.02, 4.9, 4.98, 150000], // gap up
];
const SRC: Candle[] = RAW.map(([hm, o, h, l, c, v]) => ({ t: etToUtcMs(DATE, hm), o, h, l, c, v }));

/* ---------------- 1. Loader fidelity ---------------- */
{
  const tdJson = {
    status: "ok",
    values: [...RAW].reverse().map(([time, o, h, l, c, v]) => ({
      datetime: `${DATE} ${time}:00`,
      open: String(o), high: String(h), low: String(l), close: String(c), volume: String(v),
    })),
  };
  const loaded = parseTwelveDataResponse(tdJson);
  check("TD loader: count preserved", loaded.length === SRC.length);
  check("TD loader: every candle exact (OHLCV + t)", loaded.every((c, i) => eqC(c, SRC[i])));
  const round = parseCsv(candlesToCsv(SRC));
  check("CSV round-trip: every candle exact", round.length === SRC.length && round.every((c, i) => eqC(c, SRC[i])));
}

/* ---------------- 2. Formation invariants, tick by tick ---------------- */
{
  const eng = new ReplayEngine(structuredClone(SRC), 100_000, 0);
  let violations = 0;
  let prevH = -Infinity, prevL = Infinity, curT = -1;
  let ticksSeen = 0;
  while (!eng.atEnd) {
    eng.tick();
    ticksSeen++;
    const dc = eng.displayCandles;
    const forming = dc[dc.length - 1];
    const src = SRC[dc.length - 1];
    if (eng.index + 1 === dc.length - 1 + 1 && dc.length === eng.index + 2) {
      // last element is the forming candle for SRC[dc.length-1]
      if (forming.t !== curT) { curT = forming.t; prevH = -Infinity; prevL = Infinity; }
      if (forming.o !== src.o) violations++;
      if (forming.h < prevH || forming.l > prevL) violations++; // monotone extremes
      if (forming.h > src.h || forming.l < src.l) violations++; // never escapes source range
      if (forming.h < Math.max(forming.o, forming.c)) violations++;
      if (forming.l > Math.min(forming.o, forming.c)) violations++;
      if (eng.displayPrice < src.l || eng.displayPrice > src.h) violations++;
      if (forming.v < 0 || forming.v > src.v) violations++;
      prevH = forming.h; prevL = forming.l;
    }
  }
  check(`formation invariants held at every tick (${ticksSeen} ticks)`, violations === 0);
  check("total ticks == candles * TICKS_PER_CANDLE", ticksSeen === SRC.length * TICKS_PER_CANDLE);
  check("finalized == source exactly (tick-by-tick drive)", eng.revealed.every((c, i) => eqC(c, SRC[i])));
}

/* ---------------- 3. Finalized equality across drive patterns ---------------- */
function driveFinal(pattern: "batch7" | "batch60" | "jitter" | "step" | "mixed"): Candle[] {
  const eng = new ReplayEngine(structuredClone(SRC), 100_000, 0);
  let jstate = 7;
  const jrand = () => { jstate = (Math.imul(jstate, 1103515245) + 12345) & 0x7fffffff; return jstate / 0x7fffffff; };
  let guard = 0;
  while (!eng.atEnd && guard++ < 100000) {
    if (pattern === "step") { eng.step(); continue; }
    if (pattern === "mixed") {
      for (let i = 0; i < 37; i++) eng.tick();
      eng.step();
      for (let i = 0; i < 5; i++) eng.tick();
      continue;
    }
    const b = pattern === "batch7" ? 7 : pattern === "batch60" ? 60 : 1 + Math.floor(jrand() * 60);
    let ran = 0;
    while (!eng.atEnd && ran < b) { eng.tick(); ran++; }
  }
  return eng.revealed;
}
for (const p of ["batch7", "batch60", "jitter", "step", "mixed"] as const) {
  const fin = driveFinal(p);
  check(`finalized == source exactly (pattern ${p})`, fin.length === SRC.length && fin.every((c, i) => eqC(c, SRC[i])));
}

/* ---------------- 4. Determinism (refresh / replay again) ---------------- */
{
  const run = () => {
    const eng = new ReplayEngine(structuredClone(SRC), 100_000, 0);
    const prices: number[] = [];
    while (!eng.atEnd) { eng.tick(); prices.push(eng.displayPrice); }
    return { prices, fin: eng.revealed };
  };
  const r1 = run();
  const r2 = run();
  check("determinism: identical tick price sequences across fresh engines",
    r1.prices.length === r2.prices.length && r1.prices.every((p, i) => p === r2.prices[i]));
  check("determinism: identical finalized candles", r1.fin.every((c, i) => eqC(c, r2.fin[i])));
  // reset() then re-drive (the page's Restart path) must reproduce the run
  const eng = new ReplayEngine(structuredClone(SRC), 100_000, 0);
  while (!eng.atEnd) eng.tick();
  eng.reset();
  const prices3: number[] = [];
  while (!eng.atEnd) { eng.tick(); prices3.push(eng.displayPrice); }
  check("determinism after reset(): identical prices + finalized",
    prices3.every((p, i) => p === r1.prices[i]) && eng.revealed.every((c, i) => eqC(c, SRC[i])));
}

/* ---------------- 5. Fill consistency across drive patterns ---------------- */
{
  const script = (useSteps: boolean): Fill[] => {
    const eng = new ReplayEngine(structuredClone(SRC), 100_000, 0);
    // Candles 0..3: plain advance (step() drains ticks == tick-by-tick path).
    for (let k = 0; k < 4; k++) {
      if (useSteps) eng.step();
      else for (let i = 0; i < TICKS_PER_CANDLE; i++) eng.tick();
    }
    // Candle 4 (breakout): tick in; buy 100 at tick 10; set brackets.
    for (let i = 0; i < 10; i++) eng.tick();
    eng.buy(100);
    eng.setBrackets(4.4, 5.25); // SL below entry zone, TP inside the spike range
    // Candle 4 rest + candle 5 (failed breakout): brackets may fire per tick.
    while (eng.index < 5) eng.tick();
    // Candle 6: if still holding, sell half at tick 5; then run to the end.
    for (let i = 0; i < 5; i++) eng.tick();
    if (eng.positionQty > 0) eng.sell(50);
    while (!eng.atEnd) eng.tick();
    if (eng.positionQty > 0) eng.sell(eng.positionQty);
    return eng.fills;
  };
  const sig = (fs: Fill[]) => fs.map((f) => [f.side, f.qty, f.price, f.candleIndex, f.time, f.realizedPnl, f.note ?? ""].join("|")).join(";");
  const a = script(false);
  const b = script(true);
  check("fills: at least the scripted buy executed", a.length >= 1 && a[0].side === "buy");
  check("fills identical tick-driven vs step-driven", sig(a) === sig(b));
  const eng = new ReplayEngine(structuredClone(SRC), 100_000, 0);
  while (!eng.atEnd) eng.tick();
  eng.reset();
  check("fills replay after reset reproduces", sig(script(false)) === sig(a));
}

/* ---------------- 6. Renderer: production planner vs mock LWC series ---------------- */
class MockSeries {
  bars = new Map<number, Candle>();
  setData(cs: Candle[]) { this.bars = new Map(cs.map((c) => [Math.floor(c.t / 1000), { ...c }])); }
  update(c: Candle) {
    const key = Math.floor(c.t / 1000);
    const last = [...this.bars.keys()].pop();
    if (last !== undefined && key < last) throw new Error("update() went backwards in time");
    this.bars.set(key, { ...c });
  }
}
function renderAll(snapshots: Candle[][]): MockSeries {
  const s = new MockSeries();
  let state: BarPushState | null = null;
  for (const snap of snapshots) {
    const plan = planBarPush(state, "sess", snap.length);
    if (!plan) continue;
    if (plan.mode === "full") s.setData(snap.slice(0, plan.n));
    else for (let i = plan.from; i < plan.n; i++) s.update(snap[i]);
    state = plan.state;
  }
  return s;
}
function snapshotsFor(pattern: "tick1" | "batch7" | "jitter" | "step" | "batch181"): Candle[][] {
  const eng = new ReplayEngine(structuredClone(SRC), 100_000, 0);
  const snaps: Candle[][] = [eng.displayCandles.map((c) => ({ ...c }))];
  let jstate = 42;
  const jrand = () => { jstate = (Math.imul(jstate, 1103515245) + 12345) & 0x7fffffff; return jstate / 0x7fffffff; };
  let guard = 0;
  while (!eng.atEnd && guard++ < 100000) {
    if (pattern === "step") { eng.step(); snaps.push(eng.displayCandles.map((c) => ({ ...c }))); continue; }
    const b = pattern === "tick1" ? 1 : pattern === "batch7" ? 7 : pattern === "batch181" ? 181 : 1 + Math.floor(jrand() * 60);
    let ran = 0;
    while (!eng.atEnd && ran < b) { eng.tick(); ran++; }
    snaps.push(eng.displayCandles.map((c) => ({ ...c })));
  }
  return snaps;
}
for (const p of ["tick1", "batch7", "jitter", "step", "batch181"] as const) {
  const series = renderAll(snapshotsFor(p));
  const shown = [...series.bars.values()];
  check(`renderer (planned push): final bars == source (pattern ${p})`,
    shown.length === SRC.length && shown.every((c, i) => eqC(c, SRC[i])));
}
{ // higher-timeframe: aggregated snapshots through the same planner
  const snaps1m = snapshotsFor("jitter");
  const snaps5m = snaps1m.map((s) => aggregateCandles(s, 5));
  const series = renderAll(snaps5m);
  const shown = [...series.bars.values()];
  const want = aggregateCandles(SRC, 5);
  check("renderer (planned push, 5m): final bars == aggregation of source 1m",
    shown.length === want.length && shown.every((c, i) => eqC(c, want[i])));
}

/* ---------------- 7. planBarPush unit edges ---------------- */
{
  check("planner: first push is full", planBarPush(null, "s", 5)?.mode === "full");
  check("planner: session change is full", planBarPush({ key: "a", n: 5 }, "b", 5)?.mode === "full");
  check("planner: shrink is full", planBarPush({ key: "s", n: 9 }, "s", 4)?.mode === "full");
  const same = planBarPush({ key: "s", n: 5 }, "s", 5);
  check("planner: same length updates only last bar", same?.mode === "updates" && same.from === 4);
  const grew = planBarPush({ key: "s", n: 5 }, "s", 6);
  check("planner: growth re-pushes previously-last bar first", grew?.mode === "updates" && grew.from === 4);
  const grew3 = planBarPush({ key: "s", n: 5 }, "s", 8);
  check("planner: multi-bar growth still starts at prev.n - 1", grew3?.mode === "updates" && grew3.from === 4);
  check("planner: empty input is a no-op", planBarPush(null, "s", 0) === null);
}

/* ---------------- 8. Aggregation: completed periods ---------------- */
{
  const eng = new ReplayEngine(structuredClone(SRC), 100_000, 0);
  for (let i = 0; i < 5 * TICKS_PER_CANDLE; i++) eng.tick(); // finalize candles 0..4
  const aggDisplay = aggregateCandles(eng.displayCandles, 5);
  const aggSource = aggregateCandles(SRC, 5);
  check("aggregation: first completed 5m period from display == from source",
    aggDisplay.length >= 1 && eqC(aggDisplay[0], aggSource[0]));
  while (!eng.atEnd) eng.tick();
  const allD = aggregateCandles(eng.displayCandles, 5);
  check("aggregation: all periods from final display == from source",
    allD.length === aggSource.length && allD.every((c, i) => eqC(c, aggSource[i])));
  // hand-check one period: 09:35-09:39 -> O=5.21 H=5.33 L=4.55 C=4.61 V=sum
  const p2 = aggSource[1];
  check("aggregation: hand-computed period 2 (09:35-09:39)",
    p2.o === 5.21 && p2.h === 5.33 && p2.l === 4.55 && p2.c === 4.61 &&
    p2.v === 610000 + 300000 + 45000 + 0 + 0);
}

/* ---------------- 9. DST boundaries ---------------- */
{
  const utcH = (date: string) => new Date(etToUtcMs(date, "09:30")).getUTCHours();
  check("DST: Fri 2026-03-06 (EST) 09:30 ET = 14:30Z", utcH("2026-03-06") === 14);
  check("DST: Mon 2026-03-09 (EDT) 09:30 ET = 13:30Z", utcH("2026-03-09") === 13);
  check("DST: Fri 2026-10-30 (EDT) 09:30 ET = 13:30Z", utcH("2026-10-30") === 13);
  check("DST: Mon 2026-11-02 (EST) 09:30 ET = 14:30Z", utcH("2026-11-02") === 14);
  check("fixture candles are exactly 60s apart", SRC.every((c, i) => i === 0 || c.t - SRC[i - 1].t === 60000));
}

/* ---------------- 10. displayCandles flag fidelity ---------------- */
{
  const synSrc = SRC.slice(0, 3).map((c) => ({ ...c, syn: true }));
  const eng = new ReplayEngine(synSrc, 100_000, 0);
  const dc = eng.displayCandles;
  check("displayCandles: forming candle preserves source syn flag", dc[dc.length - 1].syn === true);
}
console.log(`\ncandleAccuracy: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
