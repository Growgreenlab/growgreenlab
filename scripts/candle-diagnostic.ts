/**
 * candle-diagnostic.ts — Candle Accuracy Audit harness (NOT shipped in the app).
 * Run: npx tsx scripts/candle-diagnostic.ts
 *
 * Compares, per timestamp:
 *   A. Source OHLCV fixtures (the "original Twelve Data" values)
 *   B. Loader output (parseTwelveDataResponse on a recorded-format TD JSON,
 *      plus the CSV round-trip path)
 *   C. The live forming candle sampled at every render point
 *   D. The engine's finalized candles (revealed)
 *   E. What the CHART actually ends up displaying, by replaying the render
 *      snapshots through (1) a faithful copy of LwcChart's current push
 *      logic ("legacy") and (2) the extracted lib/chartPush planner ("fixed")
 *      against a mock series with Lightweight Charts setData/update
 *      semantics (update() replaces the bar at the same timestamp).
 *
 * Every number printed is computed from the fixtures below — no impressions.
 */
import { ReplayEngine, TICKS_PER_CANDLE } from "../lib/engine";
import type { Candle } from "../lib/types";
import { parseTwelveDataResponse } from "../lib/marketData.twelve";
import { parseCsv, candlesToCsv } from "../lib/marketData.csv";
import { etToUtcMs, aggregateCandles } from "../lib/marketData";
import { planBarPush, type BarPushState } from "../lib/chartPush";

/* ---------------- Fixtures (source of truth "A") ----------------
 * Shape set required by the audit brief, ET 2026-10-12 from 09:30.
 * Candle 5 mirrors the MNDR complaint shape (spike high 5.28 — the
 * Twelve Data value; Webull showed 5.330 for the same minute, which is
 * an upstream provider difference, not something this harness can fix). */
const DATE = "2026-10-12";
const RAW: Array<[string, number, number, number, number, number]> = [
  // hh:mm        o      h      l      c      v
  ["09:30", 4.2, 4.26, 4.17, 4.24, 52000], // ordinary
  ["09:31", 4.24, 4.61, 4.22, 4.28, 88000], // long upper wick
  ["09:32", 4.28, 4.31, 3.94, 4.27, 91000], // long lower wick
  ["09:33", 4.27, 4.55, 4.26, 4.53, 210000], // strong momentum
  ["09:34", 4.53, 5.28, 4.52, 5.21, 540000], // HOD breakout spike
  ["09:35", 5.21, 5.33, 5.02, 5.05, 610000], // failed breakout: high wick, weak close
  ["09:36", 4.71, 4.78, 4.55, 4.6, 300000], // gap down (prev close 5.05 -> open 4.71)
  ["09:37", 4.6, 4.64, 4.56, 4.6, 45000], // doji (o == c)
  ["09:38", 4.6, 4.6, 4.6, 4.6, 0], // flat / halt-like, zero volume
  ["09:39", 4.6, 4.63, 4.58, 4.61, 0], // ranged but zero volume
  ["09:40", 4.61, 4.7, 4.59, 4.68, 9800000], // huge volume
  ["09:41", 4.95, 5.02, 4.9, 4.98, 150000], // gap up (prev close 4.68 -> open 4.95)
];
const A: Candle[] = RAW.map(([hm, o, h, l, c, v]) => ({ t: etToUtcMs(DATE, hm), o, h, l, c, v }));

/* ---------------- helpers ---------------- */
interface Diff { t: number; dO: number; dH: number; dL: number; dC: number; dV: number }
function diffCandles(x: Candle, y: Candle): Diff {
  return { t: x.t, dO: x.o - y.o, dH: x.h - y.h, dL: x.l - y.l, dC: x.c - y.c, dV: x.v - y.v };
}
const isZero = (d: Diff) => d.dO === 0 && d.dH === 0 && d.dL === 0 && d.dC === 0 && d.dV === 0;
const hm = (t: number) => {
  const d = new Date(t + 4 * 3600_000); // EDT fixture date: show ET wall time via UTC+4 shift
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
function worst(diffs: Diff[]): string {
  if (diffs.length === 0) return "no candles";
  const m = (k: keyof Diff) => Math.max(...diffs.map((d) => Math.abs(d[k] as number)));
  return `max|dO|=${m("dO").toFixed(4)} max|dH|=${m("dH").toFixed(4)} max|dL|=${m("dL").toFixed(4)} max|dC|=${m("dC").toFixed(4)} max|dV|=${m("dV")}`;
}

/* ---------------- B: loader checks ---------------- */
console.log("=== B vs A: Twelve Data loader ===");
const tdJson = {
  status: "ok",
  values: [...RAW].reverse().map(([time, o, h, l, c, v]) => ({
    datetime: `${DATE} ${time}:00`,
    open: String(o), high: String(h), low: String(l), close: String(c), volume: String(v),
  })),
};
const B = parseTwelveDataResponse(tdJson);
const bDiffs = A.map((a, i) => diffCandles(B[i], a));
console.log(`candles: A=${A.length} B=${B.length}; zero-diff: ${bDiffs.every(isZero)}; ${worst(bDiffs)}`);
console.log(`timestamps strictly ascending & equal: ${B.every((b, i) => b.t === A[i].t)}`);

console.log("\n=== B vs A: CSV round-trip (candlesToCsv -> parseCsv) ===");
const csvBack = parseCsv(candlesToCsv(A));
const csvDiffs = A.map((a, i) => diffCandles(csvBack[i], a));
console.log(`candles: ${csvBack.length}; zero-diff: ${csvDiffs.every(isZero)}; ${worst(csvDiffs)}`);
console.log(`(process TZ=${process.env.TZ ?? "(system)"}; export format carries an explicit Z, so the round-trip is TZ-safe.)`);

/* ---------------- Mock LWC series + push planners ---------------- */
interface Bar { time: number; o: number; h: number; l: number; c: number; v: number }
class MockSeries {
  bars = new Map<number, Bar>();
  setData(bars: Bar[]) { this.bars = new Map(bars.map((b) => [b.time, { ...b }])); }
  update(b: Bar) {
    const last = [...this.bars.keys()].pop();
    if (last !== undefined && b.time < last) throw new Error("update() with older time (LWC would throw)");
    this.bars.set(b.time, { ...b });
  }
}
/** Faithful copy of LwcChart's push logic as of main 0c17b6a (the "before"). */
function legacyPush(series: MockSeries, state: { key: string; n: number } | null, key: string, candles: Candle[]) {
  const n = candles.length;
  if (n === 0) return state;
  const toBar = (c: Candle): Bar => ({ time: Math.floor(c.t / 1000), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  const prev = state;
  if (!prev || prev.key !== key || n < prev.n) {
    series.setData(candles.slice(0, n).map(toBar));
    return { key, n };
  } else if (n === prev.n) {
    series.update(toBar(candles[n - 1]));
    return prev;
  } else {
    for (let i = prev.n; i < n; i++) series.update(toBar(candles[i]));
    return { key, n };
  }
}
/** The extracted production planner (lib/chartPush) — the "after". */
function plannedPush(series: MockSeries, state: BarPushState | null, key: string, candles: Candle[]) {
  const plan = planBarPush(state, key, candles.length);
  if (!plan) return state;
  const toBar = (c: Candle): Bar => ({ time: Math.floor(c.t / 1000), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  if (plan.mode === "full") series.setData(candles.slice(0, plan.n).map(toBar));
  else for (let i = plan.from; i < plan.n; i++) series.update(toBar(candles[i]));
  return plan.state;
}

/* ---------------- Drive patterns ----------------
 * A "render snapshot" is eng.displayCandles captured at the same points the
 * page re-renders: once at load, then after each batch of ticks (the page
 * batches ticks per 50ms timer fire: ~1 tick at 1x, ~2-3 at 8x, up to 60
 * when catching up; step() drains a whole candle between renders). */
interface DriveResult {
  snapshots: Candle[][];
  finalized: Candle[]; // engine.revealed at end (D)
  formingViolations: string[];
  lastFormingRender: Map<number, Candle>; // per candle t: last forming values the chart was offered
}
function drive(pattern: "tick1" | "batch3" | "batch7" | "batch60" | "step" | "mixed" | "batch181" | "jitter"): DriveResult {
  const eng = new ReplayEngine(structuredClone(A), 100_000, 0);
  const snapshots: Candle[][] = [];
  const violations: string[] = [];
  const lastFormingRender = new Map<number, Candle>();
  let prevForming: { t: number; h: number; l: number } | null = null;

  const snap = () => {
    const dc = eng.displayCandles.map((c) => ({ ...c }));
    snapshots.push(dc);
    const src = A;
    // C-layer invariant sampling on the forming candle (last element when it is not yet finalized)
    const idx = eng.index; // last finalized index
    if (dc.length === idx + 2) {
      const f = dc[dc.length - 1];
      const s = src[dc.length - 1];
      lastFormingRender.set(f.t, f);
      if (f.o !== s.o) violations.push(`${hm(f.t)}: forming o ${f.o} != source o ${s.o}`);
      if (f.h < f.o || f.h < f.c || f.l > f.o || f.l > f.c) violations.push(`${hm(f.t)}: h/l do not contain o/c`);
      if (f.h > s.h || f.l < s.l) violations.push(`${hm(f.t)}: forming escaped source range [${s.l},${s.h}] -> [${f.l},${f.h}]`);
      if (prevForming && prevForming.t === f.t) {
        if (f.h < prevForming.h) violations.push(`${hm(f.t)}: forming h decreased ${prevForming.h} -> ${f.h}`);
        if (f.l > prevForming.l) violations.push(`${hm(f.t)}: forming l increased ${prevForming.l} -> ${f.l}`);
      }
      prevForming = { t: f.t, h: f.h, l: f.l };
    }
  };

  snap(); // initial render at load (forming pos = -1)
  const batch = pattern === "tick1" ? 1 : pattern === "batch3" ? 3 : pattern === "batch7" ? 7 : pattern === "batch60" ? 60 : pattern === "batch181" ? 181 : Infinity;
  // "jitter": production-faithful — the page's 50ms deadline timer runs a
  // varying number of ticks per fire (speed + jitter + throttling), seeded
  // here for reproducibility. Batch sizes 1..60 (the driver's per-fire cap).
  let jstate = 42;
  const jrand = () => { jstate = (Math.imul(jstate, 1103515245) + 12345) & 0x7fffffff; return jstate / 0x7fffffff; };
  let guard = 0;
  while (!eng.atEnd && guard++ < 100000) {
    if (pattern === "step") { eng.step(); snap(); continue; }
    if (pattern === "mixed") {
      // some ticks, a step (seek), "pause" (no-op), more ticks — in tick-space, outcomes must not change
      for (let i = 0; i < 37; i++) eng.tick();
      snap();
      eng.step();
      snap();
      for (let i = 0; i < 5; i++) eng.tick();
      snap();
      continue;
    }
    const b = pattern === "jitter" ? 1 + Math.floor(jrand() * 60) : batch;
    let ran = 0;
    while (!eng.atEnd && ran < b) { eng.tick(); ran++; }
    snap();
  }
  return { snapshots, finalized: eng.revealed.map((c) => ({ ...c })), formingViolations: violations, lastFormingRender };
}

const PATTERNS = ["tick1", "batch3", "batch7", "batch60", "step", "mixed", "batch181", "jitter"] as const;
for (const p of PATTERNS) {
  const r = drive(p);
  const dDiffs = A.map((a, i) => diffCandles(r.finalized[i], a));
  console.log(`\n=== Pattern ${p}: D (engine finalized) vs A ===`);
  console.log(`zero-diff: ${dDiffs.every(isZero)}; ${worst(dDiffs)}`);
  console.log(`C-layer forming invariant violations: ${r.formingViolations.length}${r.formingViolations.length ? " -> " + r.formingViolations.slice(0, 3).join(" | ") : ""}`);

  for (const [label, push] of [["legacy", legacyPush], ["planned", plannedPush]] as const) {
    const series = new MockSeries();
    let state: never = null as never;
    for (const s of r.snapshots) state = push(series, state, "sess", s) as never;
    const shown = [...series.bars.values()];
    const eDiffs = A.map((a, i) => {
      const b = shown[i];
      return diffCandles({ t: a.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }, a);
    });
    const bad = eDiffs.filter((d) => !isZero(d));
    console.log(`E (${label} push) vs A: zero-diff: ${bad.length === 0}; differing candles: ${bad.length}/${A.length}; ${worst(eDiffs)}`);
    for (const d of bad.slice(0, 4)) {
      console.log(`   ${hm(d.t)}: dO=${d.dO.toFixed(4)} dH=${d.dH.toFixed(4)} dL=${d.dL.toFixed(4)} dC=${d.dC.toFixed(4)} dV=${d.dV}`);
    }
    const wick = bad.find((d) => d.dH !== 0 || d.dL !== 0);
    if (wick) console.log(`   WICK miss example ${hm(wick.t)}: dH=${wick.dH.toFixed(4)} dL=${wick.dL.toFixed(4)} (displayed wick shorter than source)`);
  }
}

/* ---------------- Aggregation: completed 5m periods ---------------- */
console.log("\n=== Aggregation (5m) of source vs of display snapshots ===");
const engAgg = new ReplayEngine(structuredClone(A), 100_000, 0);
while (!engAgg.atEnd) engAgg.tick();
const aggFromDisplay = aggregateCandles(engAgg.displayCandles, 5);
const aggFromSource = aggregateCandles(A, 5);
// Last period may still contain the final candle only; compare all periods except possibly the final live one.
const aggDiffs = aggFromSource.map((s, i) => diffCandles(aggFromDisplay[i], s));
console.log(`periods: ${aggFromSource.length}; zero-diff: ${aggDiffs.every(isZero)}; ${worst(aggDiffs)}`);

/* ---------------- displayCandles syn-flag fidelity ---------------- */
{
  const synCandles: Candle[] = A.slice(0, 3).map((c) => ({ ...c, syn: true }));
  const e = new ReplayEngine(synCandles, 100_000, 0);
  const dc = e.displayCandles;
  const formingShown = dc[dc.length - 1];
  console.log(`\n=== displayCandles syn flag: source forming candle syn=true -> displayed syn=${(formingShown as Candle).syn ?? false} ===`);
}

/* ---------------- DST / timestamp alignment ---------------- */
console.log("\n=== parseEtDateTime DST alignment (09:30 ET) ===");
for (const [date, expectUtcH] of [["2026-03-06", 14], ["2026-03-09", 13], ["2026-10-30", 13], ["2026-11-02", 14]] as const) {
  const t = etToUtcMs(date, "09:30");
  const utcH = new Date(t).getUTCHours();
  console.log(`${date} 09:30 ET -> ${new Date(t).toISOString()} (expect ${expectUtcH}:30Z) ${utcH === expectUtcH ? "OK" : "MISMATCH"}`);
}
console.log(`fixture spacing: all 60000ms apart: ${A.every((c, i) => i === 0 || c.t - A[i - 1].t === 60000)}`);
console.log(`\n(TICKS_PER_CANDLE = ${TICKS_PER_CANDLE}) Diagnostic complete.`);
