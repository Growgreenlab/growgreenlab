/**
 * candle-parity.ts — Candle Parity Investigation harness (NOT shipped in the app).
 *
 * Run:
 *   npx tsx scripts/candle-parity.ts                 # built-in datasets
 *   npx tsx scripts/candle-parity.ts --csv <path>    # a real session exported
 *                                                    # from the app (Download CSV)
 *
 * What it does, for a session treated as "loader output" (layer B):
 *   1. SESSION COMPOSITION — counts, ET buckets, first/last timestamps, gap
 *      analysis against the 390-minute regular-session grid (09:30–15:59 ET),
 *      duplicate / out-of-order detection, syn-flag census. This is the
 *      section that reconciles totals like "382 candles".
 *   2. LAYER COMPARISON — B -> engine finalized (layer D) under several drive
 *      patterns (tick-by-tick, batch 7, jittered batches, step, mixed), and
 *      B -> chart-delivered bars (layer E) by replaying render snapshots
 *      through the PRODUCTION push planner (lib/chartPush) against a mock
 *      Lightweight Charts series. Per-candle O/H/L/C/V diffs + mismatch counts.
 *   3. WEBULL REFERENCE — compares the session against the ONLY Webull values
 *      legitimately available: the ones the user read off his own Webull
 *      screenshot (MNDR 2026-10-12, 10:02 ET candle: L 3.150, C 3.260,
 *      Vol 794,651; O/H not legible -> never compared; day-high marker 5.330
 *      as printed at the ~10:24 spike in his photo). These are reference
 *      points, not ground truth for the whole tape.
 *
 * Without --csv, the built-in datasets are (a) the 12-candle audit fixture
 * set and (b) a SYNTHETIC 382-candle gapped regular session (deterministic
 * random walk on the full 390-minute grid with 8 minutes removed) used only
 * to exercise composition/reconciliation math at realistic scale. Neither
 * says anything about the real MNDR tape — that requires the user's export.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ReplayEngine } from "../lib/engine";
import type { Candle } from "../lib/types";
import { parseCsv } from "../lib/marketData.csv";
import { etToUtcMs, formatEtTime } from "../lib/marketData";
import { planBarPush, type BarPushState } from "../lib/chartPush";

/* ------------------------------------------------------------------ */
/* Args                                                                */
/* ------------------------------------------------------------------ */
const args = process.argv.slice(2);
const csvPath = args.includes("--csv") ? args[args.indexOf("--csv") + 1] : null;
const auditOut = args.includes("--audit-out") ? args[args.indexOf("--audit-out") + 1] : null;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const etDate = (t: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(t));
const etHm = (t: number) => formatEtTime(t);
const etMins = (t: number) => {
  const [h, m] = etHm(t).split(":").map(Number);
  return h * 60 + m;
};
interface Diff { dO: number; dH: number; dL: number; dC: number; dV: number }
const diff = (x: Candle, y: Candle): Diff => ({ dO: x.o - y.o, dH: x.h - y.h, dL: x.l - y.l, dC: x.c - y.c, dV: x.v - y.v });
const isZero = (d: Diff) => d.dO === 0 && d.dH === 0 && d.dL === 0 && d.dC === 0 && d.dV === 0;
const f4 = (n: number) => (Object.is(n, -0) ? 0 : n).toFixed(4);

/* ------------------------------------------------------------------ */
/* 1. Session composition                                              */
/* ------------------------------------------------------------------ */
function composition(cs: Candle[], label: string) {
  console.log(`\n######## SESSION COMPOSITION — ${label} ########`);
  console.log(`total candles: ${cs.length}`);
  console.log(`syn-flagged: ${cs.filter((c) => c.syn).length}`);
  if (cs.length === 0) { console.log("(empty)"); return; }
  console.log(`first: ${etDate(cs[0].t)} ${etHm(cs[0].t)} ET   last: ${etDate(cs[cs.length - 1].t)} ${etHm(cs[cs.length - 1].t)} ET`);
  const pre = cs.filter((c) => etMins(c.t) < 9 * 60 + 30);
  const reg = cs.filter((c) => etMins(c.t) >= 9 * 60 + 30 && etMins(c.t) < 16 * 60);
  const aft = cs.filter((c) => etMins(c.t) >= 16 * 60);
  console.log(`buckets (ET): premarket <09:30 = ${pre.length} | regular 09:30–15:59 = ${reg.length} | >=16:00 = ${aft.length}`);

  let dups = 0, outOfOrder = 0;
  for (let i = 1; i < cs.length; i++) {
    if (cs[i].t === cs[i - 1].t) dups++;
    if (cs[i].t < cs[i - 1].t) outOfOrder++;
  }
  console.log(`duplicate timestamps: ${dups} | out-of-order pairs: ${outOfOrder}`);

  // Gap analysis over consecutive bars (any session segment).
  const gaps: Array<{ after: string; missingMinutes: number }> = [];
  for (let i = 1; i < cs.length; i++) {
    const deltaMin = Math.round((cs[i].t - cs[i - 1].t) / 60000);
    if (deltaMin > 1) gaps.push({ after: `${etDate(cs[i - 1].t)} ${etHm(cs[i - 1].t)}`, missingMinutes: deltaMin - 1 });
  }
  const totalMissing = gaps.reduce((s, g) => s + g.missingMinutes, 0);
  console.log(`gaps > 1 minute: ${gaps.length} (total missing minutes inside the tape: ${totalMissing})`);
  for (const g of gaps.slice(0, 25)) console.log(`   gap after ${g.after} ET: ${g.missingMinutes} missing minute(s)`);
  if (gaps.length > 25) console.log(`   … and ${gaps.length - 25} more`);

  // Reconciliation against the 390-minute regular grid (single-date sessions).
  const date = etDate(cs[0].t);
  const grid = new Set<number>();
  for (let m = 9 * 60 + 30; m < 16 * 60; m++) grid.add(etToUtcMs(date, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`));
  const regTimes = new Set(reg.map((c) => c.t));
  const missingFromGrid = [...grid].filter((t) => !regTimes.has(t));
  console.log(`regular-grid reconciliation (${date}): grid=390 | regular bars present=${reg.length} | grid minutes with NO bar=${missingFromGrid.length}`);
  console.log(`   => total ${cs.length} = ${pre.length} pre + ${reg.length} reg + ${aft.length} after-hours; if regular-only, ${cs.length} = 390 - ${missingFromGrid.length}`);
  if (missingFromGrid.length > 0 && missingFromGrid.length <= 40) {
    console.log(`   grid minutes missing a bar: ${missingFromGrid.map((t) => etHm(t)).join(", ")}`);
  }

  // FULL-WINDOW reconciliation — no assumption that 390 is "expected".
  // The fetch window is 04:00–16:00 ET = 720 minutes; the provider returns
  // only minutes that have trades. Every candle in the assembled session
  // must be accounted for as: real premarket + real regular + synthetic.
  const synBars = cs.filter((c) => c.syn);
  const realBars = cs.filter((c) => !c.syn);
  const realPre = realBars.filter((c) => etMins(c.t) < 9 * 60 + 30 && etDate(c.t) === date);
  const realReg = realBars.filter((c) => etMins(c.t) >= 9 * 60 + 30 && etMins(c.t) < 16 * 60 && etDate(c.t) === date);
  const range = (arr: Candle[]) => (arr.length ? `${etHm(arr[0].t)}–${etHm(arr[arr.length - 1].t)} ET` : "—");
  console.log(`full-window reconciliation (fetch window 04:00–16:00 ET = 720 min, ${date}):`);
  console.log(`   real premarket bars: ${realPre.length} (${range(realPre)}) of 330 window minutes -> ${330 - realPre.length} premarket minutes with no bar`);
  console.log(`   real regular bars:   ${realReg.length} (${range(realReg)}) of 390 window minutes -> ${390 - realReg.length} regular minutes with no bar`);
  console.log(`   synthetic bridge:    ${synBars.length} (${range(synBars)})  [current code adds NONE to provider loads — bridge removed in 239c271]`);
  console.log(`   TOTAL accounted: ${realPre.length} + ${realReg.length} + ${synBars.length} = ${realPre.length + realReg.length + synBars.length} (session total ${cs.length}; any remainder = bars outside the ${date} window)`);

  // Synthetic-overlap detector: a syn candle sharing a timestamp with a
  // real candle is the double-application failure mode.
  const realTs = new Set(realBars.map((c) => c.t));
  const overlaps = synBars.filter((c) => realTs.has(c.t));
  console.log(`synthetic candles overlapping real provider timestamps: ${overlaps.length}${overlaps.length ? " -> " + overlaps.map((c) => etHm(c.t)).join(", ") : ""}`);
}

/* ------------------------------------------------------------------ */
/* 1b. Timestamp-by-timestamp audit export + replay-number mapping     */
/* ------------------------------------------------------------------ */
function sessionClass(t: number): string {
  const m = etMins(t);
  return m < 9 * 60 + 30 ? "premarket" : m < 16 * 60 ? "regular" : "after-hours";
}
function auditExport(cs: Candle[], label: string) {
  // Full drive so every candle has an engine-finalized and a chart-delivered
  // counterpart to trace against its loader row.
  const { finalized, delivered } = runPattern(cs, "jitter");
  const deliveredByTime = new Map(delivered.map((c) => [c.t, c]));
  const seen = new Set<number>();
  const rows = cs.map((c, i) => {
    const dup = seen.has(c.t);
    seen.add(c.t);
    const gapAfter = i + 1 < cs.length ? Math.max(0, Math.round((cs[i + 1].t - c.t) / 60000) - 1) : 0;
    const fin = finalized[i];
    const del = deliveredByTime.get(c.t);
    const flags: string[] = [];
    if (dup) flags.push("DUPLICATE_TS");
    if (c.syn && cs.some((o) => !o.syn && o.t === c.t)) flags.push("SYN_OVERLAP");
    if (gapAfter > 0) flags.push(`GAP_AFTER_${gapAfter}MIN`);
    return {
      index: i,
      // ReplayControls renders "Candle {eng.index + 2}" with eng.index = last
      // finalized index, i.e. the display number of the FORMING candle whose
      // 0-based array index is (display - 1). Row i is what the counter calls
      // candle (i + 1) while it forms.
      replayCandleNumber: i + 1,
      timestampUtc: new Date(c.t).toISOString(),
      timeEt: etHm(c.t),
      source: c.syn ? "synthetic-bridge" : "provider",
      sessionClass: sessionClass(c.t),
      o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
      gapAfterMinutes: gapAfter,
      engineFinalizedMatches: !!fin && isZero(diff(fin, c)),
      chartDeliveredMatches: !!del && isZero(diff(del, c)),
      flags: flags.join(";"),
    };
  });

  console.log(`\n######## REPLAY-NUMBER MAPPING — ${label} ########`);
  console.log(`rule (from components/ReplayControls.tsx): display "Candle N / total" <=> array index N-1 (the forming candle's 1-based position); total = candles.length = ${cs.length}`);
  for (const probe of [1, 2, 48, cs.length]) {
    const r = rows[probe - 1];
    if (r) console.log(`   "Candle ${probe} / ${cs.length}" -> index ${r.index} -> ${r.timeEt} ET (${r.sessionClass}, ${r.source})`);
  }
  const badTrace = rows.filter((r) => !r.engineFinalizedMatches || !r.chartDeliveredMatches);
  console.log(`trace integrity: rows where engine-finalized != loader OR chart-delivered != loader: ${badTrace.length}/${rows.length}`);

  if (auditOut) {
    if (auditOut.endsWith(".json")) {
      writeFileSync(auditOut, JSON.stringify({ label, generatedFrom: "candle-parity session audit", rows }, null, 2));
    } else {
      const head = "index,replay_candle_number,timestamp_utc,time_et,source,session_class,o,h,l,c,v,gap_after_minutes,engine_finalized_matches,chart_delivered_matches,flags";
      const body = rows.map((r) => [r.index, r.replayCandleNumber, r.timestampUtc, r.timeEt, r.source, r.sessionClass, r.o, r.h, r.l, r.c, r.v, r.gapAfterMinutes, r.engineFinalizedMatches, r.chartDeliveredMatches, r.flags].join(",")).join("\n");
      writeFileSync(auditOut, `${head}\n${body}\n`);
    }
    console.log(`audit artifact written: ${auditOut} (${rows.length} rows)`);
  } else {
    console.log("(pass --audit-out <file.csv|file.json> to write the per-candle audit artifact)");
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 2. Layer comparison: B -> engine finalized (D) -> chart bars (E)    */
/* ------------------------------------------------------------------ */
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
type Pattern = "tick1" | "batch7" | "jitter" | "step" | "mixed";
function runPattern(B: Candle[], pattern: Pattern): { finalized: Candle[]; delivered: Candle[] } {
  const eng = new ReplayEngine(structuredClone(B), 100_000, 0);
  const series = new MockSeries();
  let state: BarPushState | null = null;
  const snap = () => {
    const dc = eng.displayCandles.map((c) => ({ ...c }));
    const plan = planBarPush(state, "sess", dc.length);
    if (!plan) return;
    if (plan.mode === "full") series.setData(dc.slice(0, plan.n));
    else for (let i = plan.from; i < plan.n; i++) series.update(dc[i]);
    state = plan.state;
  };
  let jstate = 99;
  const jrand = () => { jstate = (Math.imul(jstate, 1103515245) + 12345) & 0x7fffffff; return jstate / 0x7fffffff; };
  snap();
  let guard = 0;
  while (!eng.atEnd && guard++ < 200000) {
    if (pattern === "step") { eng.step(); snap(); continue; }
    if (pattern === "mixed") {
      for (let i = 0; i < 37 && !eng.atEnd; i++) eng.tick();
      snap();
      eng.step(); snap();
      for (let i = 0; i < 5 && !eng.atEnd; i++) eng.tick();
      snap();
      continue;
    }
    const b = pattern === "tick1" ? 1 : pattern === "batch7" ? 7 : 1 + Math.floor(jrand() * 60);
    let ran = 0;
    while (!eng.atEnd && ran < b) { eng.tick(); ran++; }
    snap();
  }
  return { finalized: eng.revealed.map((c) => ({ ...c })), delivered: [...series.bars.values()] };
}
function layers(B: Candle[], label: string) {
  console.log(`\n######## LAYER COMPARISON — ${label} ########`);
  for (const p of ["tick1", "batch7", "jitter", "step", "mixed"] as Pattern[]) {
    const { finalized, delivered } = runPattern(B, p);
    const dBad = B.filter((b, i) => !finalized[i] || !isZero(diff(finalized[i], b)));
    const eBad = B.filter((b, i) => !delivered[i] || !isZero(diff(delivered[i], b)));
    console.log(`pattern ${p.padEnd(7)}: D(engine) vs B mismatches: ${dBad.length}/${B.length} | E(chart) vs B mismatches: ${eBad.length}/${B.length} | delivered bars: ${delivered.length}`);
    for (const b of dBad.slice(0, 3)) {
      const d = diff(finalized[B.indexOf(b)], b);
      console.log(`   D-mismatch ${etHm(b.t)}: dO=${f4(d.dO)} dH=${f4(d.dH)} dL=${f4(d.dL)} dC=${f4(d.dC)} dV=${d.dV}`);
    }
    for (const b of eBad.slice(0, 3)) {
      const d = diff(delivered[B.indexOf(b)], b);
      console.log(`   E-mismatch ${etHm(b.t)}: dO=${f4(d.dO)} dH=${f4(d.dH)} dL=${f4(d.dL)} dC=${f4(d.dC)} dV=${d.dV}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Webull reference (USER-SUPPLIED from his Webull screenshot)      */
/* ------------------------------------------------------------------ */
const WEBULL_REF = {
  symbol: "MNDR",
  date: "2026-10-12",
  candleEt: "10:02",
  low: 3.15,
  close: 3.26,
  volume: 794651,
  // open / high: NOT legible in the photo -> intentionally absent, never compared.
  dayHighMarker: 5.33, // marker at the ~10:24 spike in the same photo
  markerWindowEndEt: "10:35",
};
function webullReference(B: Candle[]) {
  console.log(`\n######## WEBULL REFERENCE (user-supplied, screenshot) ########`);
  const matchesSymbolDate = etDate(B[0]?.t ?? 0) === WEBULL_REF.date;
  if (!matchesSymbolDate) {
    console.log(`session date is ${B[0] ? etDate(B[0].t) : "?"} — the Webull reference is for ${WEBULL_REF.date}; skipped (not the same session).`);
    return;
  }
  const idx = B.findIndex((c) => etHm(c.t) === WEBULL_REF.candleEt);
  if (idx === -1) {
    console.log(`no ${WEBULL_REF.candleEt} ET candle in this session -> TIMESTAMP MISMATCH candidate: the minute Webull shows has no bar in the loader output.`);
  } else {
    const c = B[idx];
    console.log(`${WEBULL_REF.candleEt} ET candle (index ${idx}):`);
    console.log(`   loader  L=${c.l} C=${c.c} V=${c.v}  (O=${c.o} H=${c.h} — Webull O/H not legible, not compared)`);
    console.log(`   Webull  L=${WEBULL_REF.low} C=${WEBULL_REF.close} V=${WEBULL_REF.volume}`);
    console.log(`   diffs   dL=${f4(c.l - WEBULL_REF.low)} dC=${f4(c.c - WEBULL_REF.close)} dV=${c.v - WEBULL_REF.volume}`);
    console.log(`   => if nonzero, this divergence exists in the LOADER INPUT itself (provider layer): every downstream layer provably reproduces the loader values (see LAYER COMPARISON).`);
  }
  const winEnd = etToUtcMs(WEBULL_REF.date, WEBULL_REF.markerWindowEndEt);
  const winBars = B.filter((c) => c.t <= winEnd);
  const maxH = Math.max(...winBars.map((c) => c.h));
  const fullMaxH = Math.max(...B.map((c) => c.h));
  console.log(`day-high marker: Webull ${WEBULL_REF.dayHighMarker} (at the ~10:24 spike) | loader max H through ${WEBULL_REF.markerWindowEndEt} ET = ${maxH} | loader full-session max H = ${fullMaxH}`);
}

/* ------------------------------------------------------------------ */
/* Datasets                                                            */
/* ------------------------------------------------------------------ */
function fixtureSession(): Candle[] {
  const RAW: Array<[string, number, number, number, number, number]> = [
    ["09:30", 4.2, 4.26, 4.17, 4.24, 52000], ["09:31", 4.24, 4.61, 4.22, 4.28, 88000],
    ["09:32", 4.28, 4.31, 3.94, 4.27, 91000], ["09:33", 4.27, 4.55, 4.26, 4.53, 210000],
    ["09:34", 4.53, 5.28, 4.52, 5.21, 540000], ["09:35", 5.21, 5.33, 5.02, 5.05, 610000],
    ["09:36", 4.71, 4.78, 4.55, 4.6, 300000], ["09:37", 4.6, 4.64, 4.56, 4.6, 45000],
    ["09:38", 4.6, 4.6, 4.6, 4.6, 0], ["09:39", 4.6, 4.63, 4.58, 4.61, 0],
    ["09:40", 4.61, 4.7, 4.59, 4.68, 9800000], ["09:41", 4.95, 5.02, 4.9, 4.98, 150000],
  ];
  return RAW.map(([hm, o, h, l, c, v]) => ({ t: etToUtcMs("2026-10-12", hm), o, h, l, c, v }));
}
/** Synthetic 382-bar regular session: full 390-min grid minus 8 minutes. */
function gappedSession(): Candle[] {
  const date = "2026-10-12";
  let s = 1234567;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const drop = new Set([3, 57, 58, 121, 200, 244, 245, 389]); // 8 missing minutes (incl. one 2-min and one tail gap)
  const out: Candle[] = [];
  let price = 2.59;
  for (let m = 0; m < 390; m++) {
    if (drop.has(m)) continue;
    const mins = 9 * 60 + 30 + m;
    const hhmm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    const o = price;
    const c = Math.max(0.2, o * (1 + (rnd() - 0.48) * 0.02));
    const h = Math.max(o, c) * (1 + rnd() * 0.004);
    const l = Math.min(o, c) * (1 - rnd() * 0.004);
    out.push({ t: etToUtcMs(date, hhmm), o, h, l, c, v: Math.round(50000 + rnd() * 900000) });
    price = c;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
if (csvPath) {
  const text = readFileSync(csvPath, "utf8");
  const B = parseCsv(text);
  console.log(`Loaded ${B.length} candles from ${csvPath} (app CSV export format, parsed by the app's own parseCsv).`);
  console.log("NOTE: the app's Download CSV applies stripSynthetic(), so an exported session can only");
  console.log("contain provider bars — every row classifies as source=provider by construction.");
  composition(B, `CSV: ${csvPath}`);
  layers(B, `CSV: ${csvPath}`);
  auditExport(B, `CSV: ${csvPath}`);
  webullReference(B);
} else {
  console.log("No --csv supplied: running built-in datasets. These validate the pipeline and the");
  console.log("composition math ONLY — they cannot say anything about the real MNDR tape.");
  const F = fixtureSession();
  composition(F, "fixture session (12 candles)");
  layers(F, "fixture session");
  const G = gappedSession();
  composition(G, "SYNTHETIC gapped regular session (382 bars, values invented for pipeline testing)");
  layers(G, "synthetic gapped session");
  auditExport(G, "synthetic gapped session");
  // Detector self-check: plant the exact failure mode the user fears — syn
  // candles double-applied over real ones — and show the audit catches it.
  const overlapDemo: Candle[] = [
    { t: etToUtcMs("2026-10-12", "09:28"), o: 2.5, h: 2.55, l: 2.48, c: 2.52, v: 1000, syn: true },
    { t: etToUtcMs("2026-10-12", "09:29"), o: 2.52, h: 2.56, l: 2.5, c: 2.54, v: 1100, syn: true },
    { t: etToUtcMs("2026-10-12", "09:29"), o: 2.54, h: 2.6, l: 2.51, c: 2.59, v: 50000 },
    { t: etToUtcMs("2026-10-12", "09:30"), o: 2.59, h: 2.65, l: 2.3, c: 2.45, v: 900000 },
  ];
  composition(overlapDemo, "SELF-CHECK: planted synthetic-overlap session (detector must fire)");
  console.log(`\n######## WEBULL REFERENCE ########`);
  console.log("Skipped for built-in datasets (they are not the real MNDR session). Supply the real export:");
  console.log("  npx tsx scripts/candle-parity.ts --csv <MNDR-2026-10-12.csv>");
}
console.log("\nParity diagnostic complete.");
