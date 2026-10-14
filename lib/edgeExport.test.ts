/**
 * edgeExport.test.ts — tests for the AI Edge Analysis Export data layer.
 * Run: npx tsx lib/edgeExport.test.ts
 *
 * Fixtures mirror how app/journal/page.tsx builds its state: real-trade
 * calc via calcRealTrade with the meta original stop (page convention),
 * simulator trades via groupFillsIntoTrades, unified rows as the page's
 * useMemo builds them.
 */
import { calcRealTrade, groupFillsIntoTrades, type GroupedTrade, type RawFill, type RealFill } from "./journal";
import { riskMetrics } from "./journalAnalytics";
import {
  buildAnalyticsJson, buildExportSnapshot, buildReadme, buildScreenshotManifest, buildTradesCsv,
  cumulativePnlSeries, exportIdForTradeKey, resolveExportRange, summarizeScreenshotCoverage,
  tradeLevelDrawdownSeries, ROUNDING_NOTE,
  type ExportMetaInput, type ExportRealTradeInput, type ExportSnapshotInput, type ExportUnifiedInput,
} from "./edgeExport";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}
function approx(name: string, actual: number | null | undefined, expected: number, eps = 1e-9) {
  check(`${name} (got ${actual}, want ${expected})`, actual != null && Math.abs(actual - expected) < eps);
}

/* ---------------- RFC-4180 parser (test-only) ---------------- */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  const s = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/* ================= range resolution ================= */
{
  const d = resolveExportRange({ mode: "daily", anchorDate: "2026-10-13" });
  check("daily range", d.start === "2026-10-13" && d.end === "2026-10-13");
  // Wednesday 2026-10-14 -> Sunday 2026-10-11 .. Saturday 2026-10-17
  const w = resolveExportRange({ mode: "weekly", anchorDate: "2026-10-14" });
  check("weekly Wed anchor", w.start === "2026-10-11" && w.end === "2026-10-17");
  const wSun = resolveExportRange({ mode: "weekly", anchorDate: "2026-10-11" });
  check("weekly Sunday anchor starts same day", wSun.start === "2026-10-11" && wSun.end === "2026-10-17");
  const wSat = resolveExportRange({ mode: "weekly", anchorDate: "2026-10-17" });
  check("weekly Saturday anchor", wSat.start === "2026-10-11" && wSat.end === "2026-10-17");
  const mLeap = resolveExportRange({ mode: "monthly", anchorDate: "2028-02-15" });
  check("monthly Feb leap year", mLeap.start === "2028-02-01" && mLeap.end === "2028-02-29");
  const mPlain = resolveExportRange({ mode: "monthly", anchorDate: "2026-02-10" });
  check("monthly Feb non-leap", mPlain.start === "2026-02-01" && mPlain.end === "2026-02-28");
  const mDec = resolveExportRange({ mode: "monthly", anchorDate: "2026-12-25" });
  check("monthly December", mDec.start === "2026-12-01" && mDec.end === "2026-12-31");
  const cust = resolveExportRange({ mode: "custom", anchorDate: "2026-10-13", customStart: "2026-10-03", customEnd: "2026-10-09" });
  check("custom range", cust.start === "2026-10-03" && cust.end === "2026-10-09");
  let threw = false;
  try { resolveExportRange({ mode: "custom", anchorDate: "2026-10-13", customStart: "2026-10-09", customEnd: "2026-10-03" }); } catch { threw = true; }
  check("custom start>end throws", threw);
  threw = false;
  try { resolveExportRange({ mode: "daily", anchorDate: "2026-02-30" }); } catch { threw = true; }
  check("impossible date throws", threw);
}

/* ================= stable IDs ================= */
check("real export id", exportIdForTradeKey("real:abc-123") === "TRADE-abc-123");
check("sim export id", exportIdForTradeKey("sess-uuid:3") === "TRADE-sess-uuid-3");

/* ================= fixtures ================= */
const R1_ID = "11111111-1111-1111-1111-111111111111";
const R2_ID = "22222222-2222-2222-2222-222222222222";
const R3_ID = "33333333-3333-3333-3333-333333333333";
const S1_SESSION = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const S2_SESSION = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function rf(id: string, side: "buy" | "sell", qty: number, price: number, fees: number, t: string): RealFill {
  return { id, side, qty, price, fees, fill_time: t };
}

const r1Fills: RealFill[] = [
  rf("r1f1", "buy", 100, 2.00, 0.50, "2026-10-13T13:45:00.000Z"),
  rf("r1f2", "sell", 40, 2.50, 0.20, "2026-10-13T14:15:00.000Z"),
  rf("r1f3", "sell", 60, 2.40, 0.30, "2026-10-13T14:30:00.000Z"),
];
const r1Meta: ExportMetaInput = {
  trade_key: `real:${R1_ID}`, setup_tag: "HOD breakout", hod_class: "clean", exec_grade: "B",
  entry_reasoning: "Break over HOD, said \"go, now\"\nsecond line", exit_reasoning: "Scaled out",
  followed_plan: true, confidence: 4, emotional_tags: ["Calm and disciplined"], mistakes: [],
  notes: "Note, with comma", lessons: null, would_take_again: true,
  key_levels: [{ price: 2.60, type: "Resistance", interaction: "Resistance rejection", notes: "QA level" }],
  original_stop_loss: 1.90, original_target: 2.60,
  plan_history: [{ at: "2026-10-13T15:00:00.000Z", field: "stop_loss", from: 1.90, to: 1.85 }],
};
const r1Calc = calcRealTrade(r1Fills, "long", r1Meta.original_stop_loss ?? 1.85, r1Meta.original_target ?? 2.60);
const r1: ExportRealTradeInput = {
  id: R1_ID, ticker: "TEST", trade_date: "2026-10-13", direction: "long", strategy: null,
  status: "closed", stop_loss: 1.85, target: 2.60, float_shares: 1200000, relative_volume: 3.5,
  market_conditions: "Choppy open", fills: r1Fills, calc: r1Calc,
};

const r2Fills: RealFill[] = [rf("r2f1", "buy", 100, 3.00, 0, "2026-10-12T13:45:00.000Z"), rf("r2f2", "sell", 100, 2.50, 0, "2026-10-12T15:00:00.000Z")];
const r2Calc = calcRealTrade(r2Fills, "long", null, null);
const r2: ExportRealTradeInput = {
  id: R2_ID, ticker: "MNDR", trade_date: "2026-10-12", direction: "long", strategy: "HOD breakout",
  status: "closed", stop_loss: null, target: null, float_shares: null, relative_volume: null,
  market_conditions: null, fills: r2Fills, calc: r2Calc,
};

const r3Fills: RealFill[] = [rf("r3f1", "buy", 50, 1.20, 0, "2026-10-13T16:00:00.000Z")];
const r3Calc = calcRealTrade(r3Fills, "long", null, null);
const r3: ExportRealTradeInput = {
  id: R3_ID, ticker: "OPEN", trade_date: "2026-10-13", direction: "long", strategy: null,
  status: "open", stop_loss: null, target: null, float_shares: null, relative_volume: null,
  market_conditions: null, fills: r3Fills, calc: r3Calc,
};

function sf(id: string, session: string, side: "buy" | "sell", qty: number, price: number, idx: number, pnl: number, t: string): RawFill {
  return { id, session_id: session, side, qty, price, candle_index: idx, candle_time: t, realized_pnl: pnl, created_at: t };
}
const s1Grouped: GroupedTrade[] = groupFillsIntoTrades([
  sf("s1f1", S1_SESSION, "buy", 100, 5.00, 0, 0, "2026-10-13T13:35:00.000Z"),
  sf("s1f2", S1_SESSION, "sell", 100, 6.00, 5, 100, "2026-10-13T13:40:00.000Z"),
], { id: S1_SESSION, ticker: "SIMX", trade_date: "2026-10-13", source: "twelvedata" });
const s2Grouped: GroupedTrade[] = groupFillsIntoTrades([
  sf("s2f1", S2_SESSION, "buy", 100, 2.00, 0, 0, "2026-10-13T14:00:00.000Z"),
  sf("s2f2", S2_SESSION, "sell", 100, 1.50, 3, -50, "2026-10-13T14:05:00.000Z"),
], { id: S2_SESSION, ticker: "SIMY", trade_date: "2026-10-13", source: "sample" });
check("fixture sim trades grouped", s1Grouped.length === 1 && s2Grouped.length === 1);

function simUnified(g: GroupedTrade): ExportUnifiedInput {
  return { key: g.tradeKey, source: "simulator", ticker: g.ticker, tradeDate: g.tradeDate, direction: g.direction, entryPrice: g.entryPrice, exitPrice: g.exitPrice, qty: g.qty, realizedPnl: g.realizedPnl, isOpen: false, rMultiple: g.rMultiple };
}
function realUnified(rt: ExportRealTradeInput): ExportUnifiedInput {
  return { key: `real:${rt.id}`, source: "real", ticker: rt.ticker, tradeDate: rt.trade_date, direction: rt.direction, entryPrice: rt.calc.avgEntry, exitPrice: null, qty: rt.calc.entryQty, realizedPnl: rt.calc.netRealized, isOpen: !rt.calc.isClosed, rMultiple: rt.calc.rMultiple };
}

const input: ExportSnapshotInput = {
  unified: [realUnified(r1), realUnified(r2), realUnified(r3), simUnified(s1Grouped[0]), simUnified(s2Grouped[0])],
  metas: { [`real:${R1_ID}`]: r1Meta },
  realTrades: [r1, r2, r3],
  simTrades: [s1Grouped[0], s2Grouped[0]],
};
const RANGE = { start: "2026-10-01", end: "2026-10-31" };

/* ================= snapshot: counts, dedupe, sources ================= */
{
  const snap = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" });
  check("all: total 5", snap.counts.total === 5);
  check("all: closed 4 / open 1", snap.counts.closed === 4 && snap.counts.open === 1);
  check("all: real 3 / sim 2", snap.counts.real === 3 && snap.counts.simulator === 2);
  check("all: wins 2 / losses 2", snap.counts.wins === 2 && snap.counts.losses === 2);
  check("analytics trades = closed only", snap.analyticsTrades.length === 4);

  const dup = buildExportSnapshot({ ...input, unified: [...input.unified, input.unified[0]] }, { range: RANGE, mode: "custom", source: "all" });
  check("duplicate unified key deduped", dup.counts.total === 5);

  const realOnly = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "real" });
  check("real only: 3 trades, all real", realOnly.counts.total === 3 && realOnly.trades.every((t) => t.source === "real"));
  const simOnly = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "simulator" });
  check("sim only: 2 trades, all sim", simOnly.counts.total === 2 && simOnly.trades.every((t) => t.source === "simulator"));

  // Boundary inclusion: range exactly 2026-10-12..2026-10-12 catches only R2
  const one = buildExportSnapshot(input, { range: { start: "2026-10-12", end: "2026-10-12" }, mode: "custom", source: "all" });
  check("boundary day includes only that day's trades", one.counts.total === 1 && one.trades[0].symbol === "MNDR");
  const edges = buildExportSnapshot(input, { range: { start: "2026-10-12", end: "2026-10-13" }, mode: "custom", source: "all" });
  check("both boundary days inclusive", edges.counts.total === 5);
  const none = buildExportSnapshot(input, { range: { start: "2026-10-14", end: "2026-10-20" }, mode: "custom", source: "all" });
  check("outside range excluded", none.counts.total === 0 && none.warnings.length > 0);
}

/* ================= partial exits + original-plan R ================= */
{
  const snap = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" });
  const rec = snap.trades.find((t) => t.exportId === `TRADE-${R1_ID}`)!;
  check("R1 has 2 exits", rec.exits.length === 2);
  approx("R1 exit 1 gross +20", rec.exits[0].grossPnl, 20);
  approx("R1 exit 2 gross +24", rec.exits[1].grossPnl, 24);
  approx("R1 per-exit sum = gross realized", rec.exits.reduce((s, e) => s + (e.grossPnl ?? 0), 0), r1Calc.grossRealized);
  approx("R1 fees recorded 1.00", rec.fees, 1.00);
  approx("R1 net realized 43", rec.realizedPnl, 43);
  // R must use the ORIGINAL stop 1.90 (|2.00-1.90| x 100 = $10), not the current 1.85 ($15)
  approx("R1 initial risk from ORIGINAL stop", rec.initialRisk, 10);
  approx("R1 R multiple 4.3", rec.rMultiple, 4.3);
  approx("R1 original stop preserved", rec.originalStopLoss, 1.90);
  approx("R1 current stop is 1.85", rec.stopLoss, 1.85);
  check("R1 plan history 1 change", rec.planHistory.length === 1);
  check("R1 key level parsed", rec.keyLevels.length === 1 && rec.keyLevels[0].type === "Resistance");

  const rec2 = snap.trades.find((t) => t.exportId === `TRADE-${R2_ID}`)!;
  check("R2 no stop -> no risk, no R (not zero)", rec2.initialRisk === null && rec2.rMultiple === null);
  check("R2 strategy used as setup fallback", rec2.setup === "HOD breakout");

  const sim = snap.trades.find((t) => t.source === "simulator" && t.symbol === "SIMX")!;
  check("sim fees unknown (null)", sim.fees === null);
  check("sim originals unavailable (null)", sim.originalStopLoss === null && sim.originalTarget === null);
  approx("sim exit pnl from engine fills", sim.exits[0].grossPnl, 100);
}

/* ================= CSV ================= */
{
  const snap = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" });
  const csv = buildTradesCsv(snap, []);
  const rows = parseCsv(csv);
  check("csv header + 5 rows", rows.length === 6);
  check("csv header starts with trade_id", rows[0][0] === "trade_id");
  const col = (name: string) => rows[0].indexOf(name);
  const r1row = rows.find((r) => r[0] === `TRADE-${R1_ID}`)!;
  check("csv R1 present", !!r1row);
  check("csv escaping round-trips quotes/commas/newlines", r1row[col("entry_reasoning")] === r1Meta.entry_reasoning);
  check("csv notes with comma round-trips", r1row[col("notes")] === "Note, with comma");
  check("csv R1 fees cell", r1row[col("fees_usd")] === "1");
  check("csv R1 net pnl cell", r1row[col("net_realized_pnl_usd")] === "43");
  check("csv R1 original stop cell", r1row[col("original_stop_loss")] === "1.9");
  check("csv R1 exit fills carry per-exit pnl", r1row[col("exit_fills")].includes("pnl=+20") && r1row[col("exit_fills")].includes("pnl=+24"));
  const simRow = rows.find((r) => r[2] === "Simulator")!;
  check("csv sim fees cell EMPTY (unknown, not 0)", simRow[col("fees_usd")] === "");
  check("csv sim gross cell EMPTY (no fee split)", simRow[col("gross_realized_pnl_usd")] === "");
  const openRow = rows.find((r) => r[0] === `TRADE-${R3_ID}`)!;
  check("csv open trade status open", openRow[col("status")] === "open");
}

/* ================= analytics.json ================= */
{
  const snap = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" });
  const coverage = summarizeScreenshotCoverage(snap, [], true);
  const doc = buildAnalyticsJson(snap, [], coverage) as any;
  check("json counts", doc.metadata.counts.total === 5 && doc.metadata.counts.closed === 4);
  approx("json overall net = 43", doc.overall.netRealizedPnl, 43);
  approx("json win rate 50 (breakevens excl.)", doc.overall.winRate, 50);
  check("json perSource present for All", doc.perSource?.mixedSource === true);
  approx("json perSource real net = -7", doc.perSource.real.netRealizedPnl, -7);
  approx("json perSource sim net = 50", doc.perSource.simulator.netRealizedPnl, 50);
  check("json breakdowns has 13 dims", Object.keys(doc.breakdowns).length === 13);
  const setupRows = doc.breakdowns.setup as any[];
  const hodRow = setupRows.find((r) => r.label === "HOD breakout");
  check("json setup breakdown sums to closed count", setupRows.reduce((s, r) => s + r.count, 0) === 4 && !!hodRow);
  check("json edgeFinder present", !!doc.edgeFinder && typeof doc.edgeFinder.totalTrades === "number");
  check("json metricsUnavailable lists maeMfe", (doc.metadata.metricsUnavailable as any[]).some((u) => u.key === "maeMfe"));
  check("json tradesIndex ids match snapshot", (doc.tradesIndex as any[]).length === 5 && (doc.tradesIndex as any[]).every((t) => snap.trades.some((r) => r.exportId === t.tradeId)));
  check("json dailyPnl covers 2 days", (doc.dailyPnl as any[]).length === 2);
}

/* ================= JSON finiteness (winners only) ================= */
{
  const winnersOnly: ExportSnapshotInput = { unified: [realUnified(r1)], metas: { [`real:${R1_ID}`]: r1Meta }, realTrades: [r1], simTrades: [] };
  const snap = buildExportSnapshot(winnersOnly, { range: RANGE, mode: "custom", source: "real" });
  const doc = buildAnalyticsJson(snap, [], summarizeScreenshotCoverage(snap, [], false)) as any;
  check("winners-only profit factor -> null + unbounded flag", doc.overall.profitFactor === null && doc.overall.profitFactorUnbounded === true);
  const str = JSON.stringify(doc);
  check("json string contains no Infinity/NaN tokens", !/Infinity|NaN/.test(str));
  const parsed = JSON.parse(str);
  check("json round-trips through JSON.parse", parsed.metadata.schemaVersion === "1.0");
}

/* ================= screenshot manifest + coverage ================= */
{
  const snap = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" });
  const none = summarizeScreenshotCoverage(snap, buildScreenshotManifest(snap, new Map()), true);
  check("no screenshots: coverage files 0", none.screenshotFiles === 0 && none.realTradesWithScreenshots === 0);
  check("no screenshots: all 3 real trades missing", none.tradesMissingScreenshots.length === 3);
  check("no screenshots: sim trades not counted missing", none.simulatorTrades === 2);

  const listed = new Map<string, string[]>([
    [`real:${R1_ID}`, [`user-x/real_${R1_ID}/uuid1-shot.png`, `user-x/real_${R1_ID}/uuid2-chart.jpg`]],
  ]);
  const manifest = buildScreenshotManifest(snap, listed);
  check("manifest entries for listed trade", manifest.length === 2);
  check("manifest file names stable", manifest[0].fileName === `TRADE-${R1_ID}-shot-1.png` && manifest[1].fileName === `TRADE-${R1_ID}-shot-2.jpg`);
  check("manifest type is trade-screenshot", manifest.every((e) => e.type === "trade-screenshot"));
  check("manifest capturedAt null (unavailable)", manifest.every((e) => e.capturedAt === null));
  manifest[0].status = "included";
  const cov = summarizeScreenshotCoverage(snap, manifest, true);
  check("coverage: 1 file across 1 trade, 2 real missing", cov.screenshotFiles === 1 && cov.realTradesWithScreenshots === 1 && cov.tradesMissingScreenshots.length === 2);
}

/* ================= cumulative / drawdown series ================= */
{
  const mkSim = (session: string, date: string, pnl: number): { u: ExportUnifiedInput; g: GroupedTrade } => {
    const g = groupFillsIntoTrades([
      sf(`${session}f1`, session, "buy", 100, 1.00, 0, 0, `${date}T14:00:00.000Z`),
      sf(`${session}f2`, session, "sell", 100, 1.00 + pnl / 100, 1, pnl, `${date}T14:05:00.000Z`),
    ], { id: session, ticker: "SER", trade_date: date, source: "sample" })[0];
    return { u: simUnified(g), g };
  };
  const a = mkSim("cccccccc-cccc-cccc-cccc-ccccccccccc1", "2026-10-05", 100);
  const b = mkSim("cccccccc-cccc-cccc-cccc-ccccccccccc2", "2026-10-06", -150);
  const cc = mkSim("cccccccc-cccc-cccc-cccc-ccccccccccc3", "2026-10-07", 50);
  const snap = buildExportSnapshot(
    { unified: [a.u, b.u, cc.u], metas: {}, realTrades: [], simTrades: [a.g, b.g, cc.g] },
    { range: { start: "2026-10-01", end: "2026-10-31" }, mode: "custom", source: "simulator" },
  );
  const series = cumulativePnlSeries(snap);
  check("series has 3 points", series.length === 3);
  approx("series cumulative ends at net 0", series[2].cumulative, 0);
  approx("series drawdown trough -150", Math.min(...series.map((p) => p.drawdown)), -150);
  approx("riskMetrics maxDrawdownUSD matches series", riskMetrics(snap.analyticsTrades).maxDrawdownUSD, 150);
}

/* ================= large export (500 trades) ================= */
{
  const unified: ExportUnifiedInput[] = [];
  const sims: GroupedTrade[] = [];
  for (let i = 0; i < 500; i++) {
    const session = `dddddddd-dddd-dddd-dddd-${String(i).padStart(12, "0")}`;
    const date = `2026-10-${String((i % 28) + 1).padStart(2, "0")}`;
    const g = groupFillsIntoTrades([
      sf(`${session}f1`, session, "buy", 100, 2.00, 0, 0, `${date}T14:00:00.000Z`),
      sf(`${session}f2`, session, "sell", 100, i % 3 === 0 ? 1.90 : 2.10, 1, i % 3 === 0 ? -10 : 10, `${date}T14:05:00.000Z`),
    ], { id: session, ticker: "BIG", trade_date: date, source: "sample" })[0];
    sims.push(g);
    unified.push(simUnified(g));
  }
  const snap = buildExportSnapshot({ unified, metas: {}, realTrades: [], simTrades: sims }, { range: RANGE, mode: "custom", source: "all" });
  check("large: 500 trades in snapshot", snap.counts.total === 500);
  const rows = parseCsv(buildTradesCsv(snap, []));
  check("large: csv has 501 rows", rows.length === 501);
  const doc = buildAnalyticsJson(snap, [], summarizeScreenshotCoverage(snap, [], false)) as any;
  check("large: json tradesIndex 500", (doc.tradesIndex as any[]).length === 500);
  check("large: json parses", !!JSON.parse(JSON.stringify(doc)));
}

/* ============ Issue 1 regression: drawdown basis consistency ============
 * The PDF headline max drawdown comes from riskMetrics() (PER TRADE).
 * The PDF drawdown chart must plot the same per-trade series — the old
 * per-day series hid intra-day drawdowns (user ZIP: headline $5.01,
 * chart $0.00). These fixtures FAIL against the daily series. */
{
  const mkDd = (session: string, date: string, pnl: number, tIn: string, tOut: string) => groupFillsIntoTrades([
    sf(`${session}f1`, session, "buy", 100, 1.00, 0, 0, tIn),
    sf(`${session}f2`, session, "sell", 100, 1.00 + pnl / 100, 1, pnl, tOut),
  ], { id: session, ticker: "DD", trade_date: date, source: "sample" })[0];

  // All trades on ONE day: +10, -7, +2. Per-trade DD = 7; per-day = 0.
  const d1 = mkDd("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01", "2026-10-13", 10, "2026-10-13T14:00:00.000Z", "2026-10-13T14:05:00.000Z");
  const d2 = mkDd("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee02", "2026-10-13", -7, "2026-10-13T14:10:00.000Z", "2026-10-13T14:15:00.000Z");
  const d3 = mkDd("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee03", "2026-10-13", 2, "2026-10-13T14:20:00.000Z", "2026-10-13T14:25:00.000Z");
  const snapD = buildExportSnapshot(
    { unified: [simUnified(d1), simUnified(d2), simUnified(d3)], metas: {}, realTrades: [], simTrades: [d1, d2, d3] },
    { range: RANGE, mode: "custom", source: "simulator" });
  const rmD = riskMetrics(snapD.analyticsTrades);
  approx("dd same-day: headline maxDrawdownUSD = 7", rmD.maxDrawdownUSD, 7);
  const tlD = tradeLevelDrawdownSeries(snapD);
  check("dd same-day: trade-level series has one point per trade", tlD.length === 3);
  approx("dd same-day: trade-level trough == -maxDrawdownUSD", Math.min(...tlD.map((p) => p.drawdown)), -rmD.maxDrawdownUSD);
  approx("dd same-day: per-day series trough is 0 (the fixed bug)", Math.min(...cumulativePnlSeries(snapD).map((p) => p.drawdown)), 0);

  // Multi-day: day1 +20; day2 -15 then +10. Per-trade DD = 15; per-day = 5.
  // Unified rows are deliberately scrambled — ordering must come from
  // tradeDate + entry time (the riskMetrics chronological order).
  const m1 = mkDd("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee11", "2026-10-12", 20, "2026-10-12T14:00:00.000Z", "2026-10-12T14:05:00.000Z");
  const m2 = mkDd("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee12", "2026-10-13", -15, "2026-10-13T14:00:00.000Z", "2026-10-13T14:05:00.000Z");
  const m3 = mkDd("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee13", "2026-10-13", 10, "2026-10-13T15:00:00.000Z", "2026-10-13T15:05:00.000Z");
  const snapM = buildExportSnapshot(
    { unified: [simUnified(m3), simUnified(m1), simUnified(m2)], metas: {}, realTrades: [], simTrades: [m1, m2, m3] },
    { range: RANGE, mode: "custom", source: "simulator" });
  const rmM = riskMetrics(snapM.analyticsTrades);
  approx("dd multi-day: headline maxDrawdownUSD = 15", rmM.maxDrawdownUSD, 15);
  approx("dd multi-day: trade-level trough == -15", Math.min(...tradeLevelDrawdownSeries(snapM).map((p) => p.drawdown)), -rmM.maxDrawdownUSD);
  approx("dd multi-day: per-day trough is only -5 (different basis)", Math.min(...cumulativePnlSeries(snapM).map((p) => p.drawdown)), -5);
  const docM = buildAnalyticsJson(snapM, [], summarizeScreenshotCoverage(snapM, [], false)) as any;
  approx("dd multi-day: json maxDrawdownUSD matches riskMetrics", docM.overall.maxDrawdownUSD, rmM.maxDrawdownUSD);
  check("dd: json definition states the per-trade basis", String(docM.metadata.calculationDefinitions.maxDrawdownUSD).includes("PER TRADE"));
}

/* ============ Issue 2 regression: P&L reconciliation ==================
 * CSV rows are cent-rounded for display; aggregates use full precision
 * (the platform convention — aggregates must NOT change). Three trades
 * of 10.004 produce a designed 1-cent display difference, and the
 * rounding convention must be documented in JSON + README (+ PDF,
 * covered in the package suite). */
{
  const pnlU = (key: string, v: number): ExportUnifiedInput => ({
    key, source: "simulator", ticker: "RND", tradeDate: "2026-10-13", direction: "long",
    entryPrice: 1, exitPrice: 1, qty: 1, realizedPnl: v, isOpen: false, rMultiple: null,
  });
  const snapR = buildExportSnapshot(
    { unified: [pnlU("rsess:1", 10.004), pnlU("rsess:2", 10.004), pnlU("rsess:3", 10.004)], metas: {}, realTrades: [], simTrades: [] },
    { range: RANGE, mode: "custom", source: "all" });
  const rowsR = parseCsv(buildTradesCsv(snapR, []));
  const netIdx = rowsR[0].indexOf("net_realized_pnl_usd");
  const csvSum = rowsR.slice(1).reduce((s, r) => s + Number(r[netIdx]), 0);
  approx("rounding: displayed CSV rows sum to 30.00", csvSum, 30);
  const docR = buildAnalyticsJson(snapR, [], summarizeScreenshotCoverage(snapR, [], false)) as any;
  approx("rounding: JSON total keeps full precision (30.012)", docR.overall.netRealizedPnl, 30.012, 1e-9);
  check("rounding: displayed-sum gap bounded by 1c per trade", Math.abs(csvSum - docR.overall.netRealizedPnl) <= 0.01 * 3 + 1e-9);
  check("rounding: JSON total renders as $30.01 (the PDF figure)", Number(docR.overall.netRealizedPnl).toFixed(2) === "30.01" && csvSum.toFixed(2) === "30.00");
  check("rounding: note present in JSON metadata", docR.metadata.rounding === ROUNDING_NOTE);
  const readmeR = buildReadme(snapR, summarizeScreenshotCoverage(snapR, [], false), [], { pdfIncluded: true, pdfFailureNote: null, zipFileName: "growgreen-ai-edge-2026-10-31.zip" });
  check("rounding: note present in README", readmeR.includes("ROUNDING & RECONCILIATION") && readmeR.includes(ROUNDING_NOTE));
}

/* ============ Issue 4 regression: gross profit/loss definitions =======
 * grossProfit/grossLoss are sums of winning/losing trades' realized
 * (NET) P&L — NOT pre-fee figures. Main fixture: R1 real +43 net (after
 * $1 recorded fees on $44 gross), SIMX sim +100 (fee-free), MNDR real
 * -50, SIMY sim -50. */
{
  const snap = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" });
  const doc = buildAnalyticsJson(snap, [], summarizeScreenshotCoverage(snap, [], false)) as any;
  approx("gross mixed: grossProfit = 143 (sum of winning NET pnl)", doc.overall.grossProfit, 143);
  approx("gross mixed: grossLoss = 100 (|sum of losing NET pnl|)", doc.overall.grossLoss, 100);
  const gpDef = String(doc.metadata.calculationDefinitions.grossProfit ?? "");
  check("gross mixed: definition states net basis + sim fee caveat", gpDef.includes("NOT a pre-fee figure") && gpDef.includes("fee-free") && gpDef.includes("no simulator fees are ever invented"));
  check("gross mixed: grossLoss definition present", String(doc.metadata.calculationDefinitions.grossLoss ?? "").includes("Same basis as grossProfit"));
  check("gross mixed: perSource note carries the fee basis", String(doc.perSource.note).includes("fee-free"));
  const readme = buildReadme(snap, summarizeScreenshotCoverage(snap, [], false), [], { pdfIncluded: true, pdfFailureNote: null, zipFileName: "x.zip" });
  check("gross mixed: README carries the definitions", readme.includes("- grossProfit:") && readme.includes("NOT a pre-fee figure"));

  const simOnly = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "simulator" });
  const docS = buildAnalyticsJson(simOnly, [], summarizeScreenshotCoverage(simOnly, [], false)) as any;
  approx("gross sim-only: grossProfit 100", docS.overall.grossProfit, 100);
  approx("gross sim-only: grossLoss 50", docS.overall.grossLoss, 50);
  check("gross sim-only: definitions still read correctly", String(docS.metadata.calculationDefinitions.grossProfit).includes("fee-free"));

  const realOnly = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "real" });
  const docRl = buildAnalyticsJson(realOnly, [], summarizeScreenshotCoverage(realOnly, [], false)) as any;
  approx("gross real-only: grossProfit 43 (net of recorded fees)", docRl.overall.grossProfit, 43);
  approx("gross real-only: grossLoss 50", docRl.overall.grossLoss, 50);
}

/* ============ Issue 3 regression: manifest privacy ====================
 * The internal manifest entry keeps the raw storage path (the package
 * layer needs it to fetch bytes), but NOTHING downloadable may contain
 * it — nor the account UUID inside it, nor internal object names. */
{
  const FAKE_UUID = "123e4567-e89b-12d3-a456-426614174000";
  const snap = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" });
  const listed = new Map<string, string[]>([[`real:${R1_ID}`, [`${FAKE_UUID}/real_${R1_ID}/cafef00d-internal.png`]]]);
  const manifest = buildScreenshotManifest(snap, listed);
  manifest[0].status = "included";
  check("privacy: internal entry retains path for app use", manifest[0].storagePath.includes(FAKE_UUID));
  const doc = buildAnalyticsJson(snap, manifest, summarizeScreenshotCoverage(snap, manifest, true)) as any;
  const pub = doc.metadata.screenshotManifest[0];
  check("privacy: public entry keeps tradeId/file/status/symbol", pub.tradeId === `TRADE-${R1_ID}` && pub.file === `screenshots/TRADE-${R1_ID}-shot-1.png` && pub.status === "included" && pub.symbol === "TEST");
  check("privacy: public entry has NO storagePath / tradeKey", !("storagePath" in pub) && !("tradeKey" in pub));
  const docStr = JSON.stringify(doc);
  check("privacy: account UUID nowhere in analytics.json", !docStr.includes(FAKE_UUID));
  check("privacy: internal object name nowhere in analytics.json", !docStr.includes("cafef00d-internal"));
  check("privacy: no storagePath key anywhere in analytics.json", !docStr.includes("storagePath"));
  check("privacy: tradesIndex carries no raw tradeKey", (doc.tradesIndex as any[]).every((t) => !("tradeKey" in t)));
  const readme = buildReadme(snap, summarizeScreenshotCoverage(snap, manifest, true), manifest, { pdfIncluded: true, pdfFailureNote: null, zipFileName: "x.zip" });
  check("privacy: README states paths are intentionally excluded", readme.includes("intentionally NOT included"));
  check("privacy: README leaks no UUID / object name", !readme.includes(FAKE_UUID) && !readme.includes("cafef00d-internal"));
}

console.log(`edgeExport tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
