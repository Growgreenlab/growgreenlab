/**
 * edgeExport.test.ts — tests for the AI Edge Analysis Export data layer.
 * Run: npx tsx lib/edgeExport.test.ts
 *
 * Fixtures mirror how app/journal/page.tsx builds its state: real-trade
 * calc via calcRealTrade with the meta original stop (page convention),
 * simulator trades via groupFillsIntoTrades, unified rows as the page's
 * useMemo builds them.
 */
import { createHash } from "node:crypto";
import { calcRealTrade, groupFillsIntoTrades, type GroupedTrade, type RawFill, type RealFill } from "./journal";
import { riskMetrics } from "./journalAnalytics";
import { deriveDrEvidence, splitCyclesByGeneration } from "./drTradeEvidence";
import { buildPreCompletionTrade, groupedTradeFromDraftAnchors, type DrDraftRow } from "./drDrafts";
import type { DrEvent, DrEventType } from "./dailyReplayEvents";
import { mapStrategyRow, mapStrategyVersionRow } from "./strategies";
import {
  buildAnalyticsJson, buildChatGptPrompt, buildDecisionTimelineCsv, buildExportSnapshot, buildReadme,
  buildScreenshotManifest, buildStrategyJson, buildTradesCsv, computeDrExportHints, CSV_COLUMNS,
  cumulativePnlSeries, exportIdForTradeKey, exportSelectionFromJournal, resolveExportRange, summarizeScreenshotCoverage,
  tradeLevelDrawdownSeries, ROUNDING_NOTE,
  type ExportDrAttemptInput, type ExportDrEventInput, type ExportMetaInput,
  type ExportRealTradeInput, type ExportSnapshotInput, type ExportUnifiedInput,
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

/* ============ journal-scope -> export selection mapping ============
 * Regression for the 2026-10-18 Analytics divergence: the export
 * panel defaulted to All sources / current month while the journal
 * was filtered to Daily Replay, so Analytics counted every closed
 * trade in the month (11) while the journal showed the 1 eligible
 * trade in scope. The mapped selection must resolve to exactly the
 * page filter's range for every preset. Today = Sunday 2026-10-18. */
{
  const T = "2026-10-18";
  const rng = (sf: string, p: string) => resolveExportRange(exportSelectionFromJournal(sf, p, T));
  check("scope source mapping (all/simulator/real/daily_replay)",
    exportSelectionFromJournal("all", "all", T).source === "all"
    && exportSelectionFromJournal("simulator", "all", T).source === "simulator"
    && exportSelectionFromJournal("real", "all", T).source === "real"
    && exportSelectionFromJournal("daily_replay", "all", T).source === "daily_replay");
  const t = rng("daily_replay", "today");
  check("scope today -> [today, today]", t.start === "2026-10-18" && t.end === "2026-10-18");
  const w = rng("all", "week");
  check("scope week -> Sunday..Saturday of this week", w.start === "2026-10-18" && w.end === "2026-10-24");
  const m = rng("all", "month");
  check("scope month -> calendar month", m.start === "2026-10-01" && m.end === "2026-10-31");
  const d30 = rng("all", "30d");
  check("scope 30d -> [today-30, today]", d30.start === "2026-09-18" && d30.end === "2026-10-18");
  const d90 = rng("all", "90d");
  check("scope 90d -> [today-90, today]", d90.start === "2026-07-20" && d90.end === "2026-10-18");
  const y = rng("all", "ytd");
  check("scope ytd -> [Jan 1, today]", y.start === "2026-01-01" && y.end === "2026-10-18");
  const a = rng("daily_replay", "all");
  check("scope all -> [epoch floor, today] (unbounded past)", a.start === "1970-01-01" && a.end === "2026-10-18");
  check("scope unknown period falls back to all", exportSelectionFromJournal("all", "bogus", T).mode === "custom");
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
  check("json breakdowns has 18 dims", Object.keys(doc.breakdowns).length === 18);
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
  check("json round-trips through JSON.parse", parsed.metadata.schemaVersion === "2.0");
}

/* ================= screenshot manifest + coverage ================= */
{
  const snap = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" });
  const none = summarizeScreenshotCoverage(snap, buildScreenshotManifest(snap, new Map()), true);
  check("no screenshots: coverage files 0", none.screenshotFiles === 0 && none.realTradesWithScreenshots === 0);
  check("no screenshots: all 3 real trades missing", none.tradesMissingScreenshots.length === 3);
  check("no screenshots: sim trades not counted missing", none.simulatorTrades === 2);

  const listed = new Map<string, { path: string; createdAt: string | null }[]>([
    [`real:${R1_ID}`, [
      { path: `user-x/real_${R1_ID}/uuid1-shot.png`, createdAt: "2026-10-13T14:00:00.000Z" },
      { path: `user-x/real_${R1_ID}/uuid2-chart.jpg`, createdAt: "2026-10-13T14:05:00.000Z" },
    ]],
  ]);
  const manifest = buildScreenshotManifest(snap, listed);
  check("manifest entries for listed trade", manifest.length === 2);
  check("manifest file names stable", manifest[0].fileName === `TRADE-${R1_ID}-shot-1.png` && manifest[1].fileName === `TRADE-${R1_ID}-shot-2.jpg`);
  check("manifest type is trade-screenshot", manifest.every((e) => e.type === "trade-screenshot"));
  check("manifest recordedAt plumbed from the storage listing (§G 1c)",
    manifest[0].recordedAt === "2026-10-13T14:00:00.000Z" && manifest[1].recordedAt === "2026-10-13T14:05:00.000Z");
  check("manifest real-trade rows are manual attachments (§G 1b)",
    manifest.every((e) => e.role === "attachment" && e.captureKind === "manual"));
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
  const listed = new Map<string, { path: string; createdAt: string | null }[]>([[`real:${R1_ID}`, [{ path: `${FAKE_UUID}/real_${R1_ID}/cafef00d-internal.png`, createdAt: "2026-10-13T14:00:00.000Z" }]]]);
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

/* ================= schema 2.0: Daily Replay strategies ================= */
{
  const DR_SESSION = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const DR_SESSION2 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const ATT1 = "a1111111-1111-4111-8111-111111111111";
  const ATT2 = "a2222222-2222-4222-8222-222222222222";
  const STRAT = "51111111-1111-4111-8111-111111111111";
  const VER2 = "52122222-2222-4222-8222-222222222222";

  const drGrouped = groupFillsIntoTrades([
    sf("d1f1", DR_SESSION, "buy", 100, 10.00, 5, 0, "2026-10-15T13:35:00.000Z"),
    sf("d1f2", DR_SESSION, "sell", 100, 11.00, 9, 100, "2026-10-15T13:39:00.000Z"),
  ], { id: DR_SESSION, ticker: "DRCO", trade_date: "2026-10-15", source: "daily_replay" });
  const dr2Grouped = groupFillsIntoTrades([
    sf("d2f1", DR_SESSION2, "buy", 50, 4.00, 3, 0, "2026-10-15T14:03:00.000Z"),
    sf("d2f2", DR_SESSION2, "sell", 50, 3.60, 7, -20, "2026-10-15T14:07:00.000Z"),
  ], { id: DR_SESSION2, ticker: "DRTWO", trade_date: "2026-10-15", source: "daily_replay" });

  let dseq = 0;
  const dev = (type: DrEventType, payload: Record<string, unknown> = {}, idx = 0): DrEvent =>
    ({ seq: ++dseq, type, wallTs: 1760600000000 + dseq * 5000, marketIdx: idx, marketTs: 1760544000000 + idx * 60000, payload });
  const att1Events: DrEvent[] = [
    dev("attempt_created", { ticker: "DRCO" }), dev("session_started"),
    dev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    dev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    dev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    dev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "target", unrealizedPnl: 0 }, 9),
    dev("session_completed", {}, 10),
  ];
  const derived1 = deriveDrEvidence({ attemptId: ATT1, trades: drGrouped, events: att1Events });
  const evidence = new Map(derived1.byTradeKey);
  // ATT2's trade has NO risk snapshot -> evidence with nulls (honest).
  const derived2 = deriveDrEvidence({
    attemptId: ATT2, trades: dr2Grouped,
    events: [
      { seq: 1, type: "order_filled", wallTs: 1760600100000, marketIdx: 3, marketTs: 1760544180000, payload: { side: "buy", qty: 50, price: 4, candleIndex: 3 } },
      { seq: 2, type: "order_filled", wallTs: 1760600200000, marketIdx: 7, marketTs: 1760544420000, payload: { side: "sell", qty: 50, price: 3.6, candleIndex: 7 } },
      { seq: 3, type: "position_closed", wallTs: 1760600200000, marketIdx: 7, marketTs: 1760544420000, payload: { qty: 50, price: 3.6, realizedPnl: -20, sessionRealized: -20, reason: "manual", unrealizedPnl: 0 } },
    ],
  });
  for (const [k, v] of derived2.byTradeKey) evidence.set(k, v);

  const strategy = mapStrategyRow({ id: STRAT, user_id: "u", name: "HOD Breakout", notes: null, archived_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
  const version2 = mapStrategyVersionRow({ id: VER2, strategy_id: STRAT, user_id: "u", version: 2, setup_type: "hod_breakout", entry_rules: "Break of HOD on volume", stop_rules: "Below VWAP", target_rules: "2R", exit_rules: null, market_filters: {}, notes: null, created_at: "2026-10-02T00:00:00Z" });
  const attempts: ExportDrAttemptInput[] = [
    { id: ATT1, sessionId: DR_SESSION, strategyVersionId: VER2, status: "finished", startIndex: 4, createdAt: "2026-10-16T16:00:00Z", finishedAt: "2026-10-16T16:30:00Z", ticker: "DRCO", tradeDate: "2026-10-15" },
    { id: ATT2, sessionId: DR_SESSION2, strategyVersionId: null, status: "finished", startIndex: 2, createdAt: "2026-10-16T17:00:00Z", finishedAt: "2026-10-16T17:20:00Z", ticker: "DRTWO", tradeDate: "2026-10-15" },
  ];
  const drEvents: ExportDrEventInput[] = att1Events.map((event, i) => ({ id: `ev-${i + 1}`, attemptId: ATT1, event }));
  const eventTradeKeys = new Map([[ATT1, derived1.eventTradeKey], [ATT2, derived2.eventTradeKey]]);

  const drU = (g: GroupedTrade, att: string): ExportUnifiedInput => ({
    ...simUnified(g), sessionSource: "daily_replay", attemptId: att,
    rMultiple: evidence.get(g.tradeKey)?.rMultiple ?? null,
  });
  const drInput: ExportSnapshotInput = {
    unified: [realUnified(r1), simUnified(s1Grouped[0]), drU(drGrouped[0], ATT1), drU(dr2Grouped[0], ATT2)],
    metas: { [`real:${R1_ID}`]: r1Meta },
    realTrades: [r1],
    simTrades: [s1Grouped[0], drGrouped[0], dr2Grouped[0]],
    drAttempts: attempts, drEvidence: evidence, drEvents, drEventTradeKeys: eventTradeKeys,
    strategies: [strategy], strategyVersions: [version2],
  };
  const range2 = { start: "2026-10-01", end: "2026-10-31" };

  /* --- source selection --- */
  const drOnly = buildExportSnapshot(drInput, { range: range2, mode: "custom", source: "daily_replay" });
  check("2.0 dr-only: exactly the 2 DR trades", drOnly.counts.total === 2 && drOnly.counts.dailyReplay === 2);
  check("2.0 dr-only: coarse simulator count includes DR", drOnly.counts.simulator === 2);
  const allSnap = buildExportSnapshot(drInput, { range: range2, mode: "custom", source: "all" });
  check("2.0 all: counts partition (4 total, 1 real, 3 sim-class, 2 DR)",
    allSnap.counts.total === 4 && allSnap.counts.real === 1 && allSnap.counts.simulator === 3 && allSnap.counts.dailyReplay === 2);
  const simSnap = buildExportSnapshot(drInput, { range: range2, mode: "custom", source: "simulator" });
  check("2.0 simulator source still includes DR (coarse class)", simSnap.counts.total === 3 && simSnap.counts.dailyReplay === 2);

  /* --- record population --- */
  const rec1 = drOnly.trades.find((t) => t.tradeKey === drGrouped[0].tradeKey)!;
  check("2.0 DR record flagged", rec1.isDailyReplay === true && rec1.attemptId === ATT1);
  approx("2.0 DR original stop from snapshot", rec1.originalStopLoss, 9.5);
  approx("2.0 DR original target from snapshot", rec1.originalTarget, 11);
  approx("2.0 DR initialRisk from snapshot", rec1.initialRisk, 50);
  approx("2.0 DR R = 100/50 = 2", rec1.rMultiple, 2);
  check("2.0 DR strategy chain resolved", rec1.strategyName === "HOD Breakout" && rec1.strategyVersion === 2 && rec1.strategyLabel === "HOD Breakout · v2" && rec1.strategyVersionId === VER2);
  check("2.0 DR eventsStatus is recorded when evidence derived (§G 3c)", rec1.eventsStatus === "recorded");
  const rec2 = drOnly.trades.find((t) => t.tradeKey === dr2Grouped[0].tradeKey)!;
  check("2.0 DR without snapshot: plan fields null, R null", rec2.originalStopLoss === null && rec2.initialRisk === null && rec2.rMultiple === null);
  check("2.0 DR without snapshot but WITH events: status recorded, not missing (§G 3c)",
    rec2.eventsStatus === "recorded");
  check("2.0 DR without snapshot: basis explains", rec2.riskBasis.includes("no risk snapshot"));
  check("2.0 DR without strategy: label fields null", rec2.strategyName === null && rec2.strategyVersionId === null);
  const tlRec = allSnap.trades.find((t) => t.tradeKey === s1Grouped[0].tradeKey)!;
  check("2.0 Trade Lab sim untouched (nulls + old basis)", tlRec.originalStopLoss === null && tlRec.rMultiple === null && tlRec.isDailyReplay === false && tlRec.riskBasis.includes("simulator trades do not record a stop loss"));

  /* --- strategy / version / attempt selection (export panel only) --- */
  const byVersion = buildExportSnapshot(drInput, { range: range2, mode: "custom", source: "all", strategyVersionId: VER2 });
  check("2.0 version filter: only ATT1's trade", byVersion.counts.total === 1 && byVersion.trades[0].attemptId === ATT1);
  const byStrategy = buildExportSnapshot(drInput, { range: range2, mode: "custom", source: "all", strategyId: STRAT });
  check("2.0 strategy filter: only the bound attempt's trade", byStrategy.counts.total === 1);
  const byAttempt = buildExportSnapshot(drInput, { range: range2, mode: "custom", source: "all", attemptId: ATT2 });
  check("2.0 attempt filter: only ATT2's trade", byAttempt.counts.total === 1 && byAttempt.trades[0].attemptId === ATT2);

  /* --- CSV: original 46 keep order; 2.0 appends follow --- */
  check("2.0 CSV has 58 columns", CSV_COLUMNS.length === 58);
  check("2.0 CSV appended columns", CSV_COLUMNS.slice(46, 50).join("|") === "daily_replay_attempt_id|strategy_name|strategy_version|strategy_version_id");
  check("annotation CSV appends follow", CSV_COLUMNS.slice(50, 54).join("|") === "strategy_traded_id|strategy_traded|setup_class|setup_class_label");
  check("export-fixes CSV appends come last (§G 3c/3d/3g)", CSV_COLUMNS.slice(54).join("|") === "strategy_custom_label|entry_trigger|events_status|setup_class_origin");
  const manifest0 = buildScreenshotManifest(drOnly, new Map());
  const csvRows = parseCsv(buildTradesCsv(drOnly, manifest0));
  check("2.0 CSV header arity 58", csvRows[0].length === 58);
  const cIdx = (n: string) => csvRows[0].indexOf(n);
  const drRow = csvRows.find((r) => r[cIdx("daily_replay_attempt_id")] === ATT1)!;
  check("2.0 CSV DR source cell", drRow[cIdx("source")] === "Daily Replay / Backtest");
  check("2.0 CSV DR events_status cell (§G 3c)", drRow[cIdx("events_status")] === "recorded");
  check("2.0 CSV DR strategy cells", drRow[cIdx("strategy_name")] === "HOD Breakout" && drRow[cIdx("strategy_version")] === "2" && drRow[cIdx("strategy_version_id")] === VER2);
  check("2.0 CSV DR original stop exported", drRow[cIdx("original_stop_loss")] === "9.5" && drRow[cIdx("r_multiple")] === "2");

  /* --- strategy annotation (2026-10-18): additive, never backfilled --- */
  const STRAT_SUP = "strat-sup";
  const supStrategy = mapStrategyRow({ id: STRAT_SUP, user_id: "u", name: "Support Bounce", notes: null, archived_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", classification_family: "support" });
  const annMeta: ExportMetaInput = {
    ...r1Meta,
    strategy_id: STRAT_SUP, setup_class: "strong_support_reaction",
    strategy_custom_label: "Desk support plan", entry_trigger: "Reversal candle at support",
  };
  const annInput: ExportSnapshotInput = {
    unified: [realUnified(r1)], metas: { [`real:${R1_ID}`]: annMeta },
    realTrades: [r1], simTrades: [], strategies: [supStrategy], strategyVersions: [],
  };
  const annSnap = buildExportSnapshot(annInput, { range: RANGE, mode: "custom", source: "all" });
  const annRec = annSnap.trades[0];
  check("annotation: record carries ID + resolved name + slug + label",
    annRec.strategyTradedId === STRAT_SUP && annRec.strategyTradedName === "Support Bounce"
    && annRec.setupClass === "strong_support_reaction" && annRec.setupClassLabel === "Strong Support Reaction"
    && annRec.entryTrigger === "Reversal candle at support");
  check("annotation: analytics trade carries the annotation",
    annSnap.analyticsTrades[0].tradedStrategyId === STRAT_SUP && annSnap.analyticsTrades[0].tradedStrategyName === "Support Bounce"
    && annSnap.analyticsTrades[0].setupClass === "strong_support_reaction" && annSnap.analyticsTrades[0].execGrade === "B");
  const annCsv = parseCsv(buildTradesCsv(annSnap, buildScreenshotManifest(annSnap, new Map())));
  const aIdx = (n: string) => annCsv[0].indexOf(n);
  const annRow = annCsv[1];
  check("annotation: CSV cells carry ID/name/slug/label",
    annRow[aIdx("strategy_traded_id")] === STRAT_SUP && annRow[aIdx("strategy_traded")] === "Support Bounce"
    && annRow[aIdx("setup_class")] === "strong_support_reaction" && annRow[aIdx("setup_class_label")] === "Strong Support Reaction");
  check("annotation: CSV binding columns untouched (real trade has none)",
    annRow[aIdx("strategy_name")] === "" && annRow[aIdx("strategy_version_id")] === "");
  const annDoc = buildAnalyticsJson(annSnap, [], summarizeScreenshotCoverage(annSnap, [], false)) as any;
  check("annotation: analytics.json strategyTraded breakdown groups by annotation",
    annDoc.breakdowns.strategyTraded.some((r: any) => r.label === "Support Bounce" && r.count === 1));
  check("annotation: analytics.json setupClass breakdown uses the effective label",
    annDoc.breakdowns.setupClass.some((r: any) => r.label === "Strong Support Reaction" && r.count === 1));
  check("annotation: breakdown rows expose R sample count + drawdown",
    annDoc.breakdowns.strategyTraded.every((r: any) => typeof r.avgRSampleCount === "number" && typeof r.maxDrawdownUSD === "number"));
  check("annotation: tradesIndex carries the annotation",
    annDoc.tradesIndex[0].strategyTradedId === STRAT_SUP && annDoc.tradesIndex[0].setupClassLabel === "Strong Support Reaction");
  // §G 3d: the two recorded fields that used to be dropped are now
  // serialized in BOTH artifacts; §G 3g: the label's origin is
  // flagged as recorded (it came from setup_class, not the coalesce).
  check("annotation: CSV carries strategy_custom_label + entry_trigger (§G 3d)",
    annRow[aIdx("strategy_custom_label")] === "Desk support plan" && annRow[aIdx("entry_trigger")] === "Reversal candle at support");
  check("annotation: tradesIndex carries custom label + trigger + origin (§G 3d/3g)",
    annDoc.tradesIndex[0].strategyCustomLabel === "Desk support plan"
    && annDoc.tradesIndex[0].entryTrigger === "Reversal candle at support"
    && annDoc.tradesIndex[0].setupClassOrigin === "recorded");
  check("annotation: setupClass breakdown row carries provenance counts (§G 3g)",
    annDoc.breakdowns.setupClass.every((r: any) => typeof r.recordedCount === "number" && typeof r.legacyHodCount === "number")
    && annDoc.breakdowns.setupClass.find((r: any) => r.label === "Strong Support Reaction")?.recordedCount === 1);
  // Backward compatibility: the SAME trade without annotation fields
  // exports the new cells empty — except setup_class_label, which
  // honestly reflects the legacy hod_class via the read coalesce.
  const baseSnap = buildExportSnapshot(
    { unified: [realUnified(r1)], metas: { [`real:${R1_ID}`]: r1Meta }, realTrades: [r1], simTrades: [] },
    { range: RANGE, mode: "custom", source: "all" },
  );
  const baseCsv = parseCsv(buildTradesCsv(baseSnap, buildScreenshotManifest(baseSnap, new Map())));
  const bIdx = (n: string) => baseCsv[0].indexOf(n);
  check("annotation: unannotated trade exports empty ID/name/slug",
    baseCsv[1][bIdx("strategy_traded_id")] === "" && baseCsv[1][bIdx("strategy_traded")] === "" && baseCsv[1][bIdx("setup_class")] === "");
  check("annotation: legacy hod_class still labels via coalesce (no data invented)",
    baseCsv[1][bIdx("setup_class_label")] === "Clean Breakout" && baseSnap.trades[0].strategyTradedId === null);
  check("annotation: coalesced label's origin is flagged legacy_hod (§G 3g)",
    baseCsv[1][bIdx("setup_class_origin")] === "legacy_hod" && baseSnap.trades[0].setupClassOrigin === "legacy_hod");
  const baseDoc = buildAnalyticsJson(baseSnap, [], summarizeScreenshotCoverage(baseSnap, [], false)) as any;
  check("annotation: tradesIndex flags the coalesce origin (§G 3g)",
    baseDoc.tradesIndex[0].setupClassOrigin === "legacy_hod"
    && baseDoc.breakdowns.setupClass.find((r: any) => r.label === "Clean Breakout")?.legacyHodCount === 1);

  /* --- screenshots: DR eligible, Trade Lab excluded --- */
  const listed = new Map([
    [drGrouped[0].tradeKey, [{ path: "u/dr/shot1.png", createdAt: "2026-10-16T16:00:00.000Z" }]],
    [s1Grouped[0].tradeKey, [{ path: "u/tl/shot.png", createdAt: "2026-10-16T16:00:00.000Z" }]],
  ]);
  const manAll = buildScreenshotManifest(allSnap, listed);
  check("2.0 manifest includes DR trade screenshots", manAll.some((e) => e.tradeKey === drGrouped[0].tradeKey));
  check("2.0 manifest still excludes Trade Lab sim", !manAll.some((e) => e.tradeKey === s1Grouped[0].tradeKey));
  const cov = summarizeScreenshotCoverage(allSnap, manAll.map((e) => ({ ...e, status: "included" as const })), true);
  check("2.0 coverage counts DR trades eligible", cov.dailyReplayTrades === 2 && cov.simulatorTrades === 1);

  /* --- decision_timeline.csv --- */
  const timeline = buildDecisionTimelineCsv(drOnly);
  const tRows = parseCsv(timeline);
  check("2.0 timeline header", tRows[0].join(",") === "trade_id,attempt_id,event_id,seq,type,market_time,wall_time,candle_index,description,payload_json");
  check("2.0 timeline one row per event", tRows.length === 1 + att1Events.length);
  const fillRow = tRows.find((r) => r[4] === "order_filled")!;
  check("2.0 timeline fill attributed to the trade", fillRow[0] === rec1.exportId && fillRow[1] === ATT1 && fillRow[2] === "ev-3");
  const lifeRow = tRows.find((r) => r[4] === "attempt_created")!;
  check("2.0 timeline lifecycle event has empty trade_id", lifeRow[0] === "");
  const payloadBack = JSON.parse(fillRow[9]);
  check("2.0 timeline payload_json lossless", payloadBack.side === "buy" && payloadBack.qty === 100 && payloadBack.candleIndex === 5);
  check("2.0 timeline deterministic (byte-identical rebuild)", buildDecisionTimelineCsv(drOnly) === timeline);
  check("2.0 timeline carries both clocks", fillRow[5].length > 0 && fillRow[6].length > 0 && fillRow[5] !== fillRow[6]);

  /* --- strategy.json --- */
  const sj = buildStrategyJson(drOnly) as any;
  check("2.0 strategy.json present", sj != null && Array.isArray(sj.strategies));
  check("2.0 strategy.json version + attempts", sj.strategies[0].name === "HOD Breakout" && sj.strategies[0].versions[0].version === 2 && sj.strategies[0].versions[0].attemptIds.join() === ATT1);
  check("2.0 strategy.json unbound attempt listed", (sj.unversionedAttemptIds as string[]).includes(ATT2));
  check("2.0 strategy.json null without DR", buildStrategyJson(simSnap.counts.dailyReplay === 0 ? buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" }) : drOnly) === null || simSnap.counts.dailyReplay > 0);

  /* --- analytics.json DR block + subtotals --- */
  const doc = buildAnalyticsJson(allSnap, [], summarizeScreenshotCoverage(allSnap, [], true)) as any;
  check("2.0 analytics dailyReplay block available", doc.dailyReplay.available === true && doc.dailyReplay.attemptsInSelection === 2);
  const att1Block = (doc.dailyReplay.attempts as any[]).find((a) => a.attemptId === ATT1);
  check("2.0 analytics attempt block: strategy + R", att1Block.strategy.label === "HOD Breakout · v2" && att1Block.avgR === 2 && att1Block.realizedPnl === 100);
  check("2.0 perSource partitions include dailyReplay", doc.perSource.dailyReplay.closedTrades === 2 && doc.perSource.simulator.closedTrades === 1 && doc.perSource.real.closedTrades === 1);
  check("2.0 source breakdown has Daily Replay bucket",
    (doc.breakdowns.source as any[]).some((r) => r.label === "Daily Replay" && r.count === 2));
  check("2.0 strategy breakdown present", (doc.breakdowns.strategy as any[]).some((r) => r.label === "HOD Breakout" && r.count === 1));
  check("2.0 strategyTraded is annotation-only: bound DR trade is Not recorded there (§G 3e)",
    (doc.breakdowns.strategyTraded as any[]).every((r) => r.label === "Not recorded")
    && (doc.breakdowns.strategyTraded as any[])[0].count === 4);
  check("2.0 attempt block carries timeframe + event count (§G 2a/3c)",
    att1Block.timeframeMinutes === null && att1Block.eventsRecorded === att1Events.length && att1Block.lifecycle === "completed");
  check("2.0 schema version", doc.metadata.schemaVersion === "2.0" && allSnap.schemaVersion === "2.0");

  /* --- prompt + README DR content --- */
  const prompt = buildChatGptPrompt(drOnly, summarizeScreenshotCoverage(drOnly, [], true), { pdfIncluded: false });
  check("2.0 prompt has DR directives", prompt.includes("Separate STRATEGY quality from EXECUTION quality") && prompt.includes("NEVER modify, rewrite"));
  check("2.0 prompt lists new files", prompt.includes("decision_timeline.csv") && prompt.includes("strategy.json"));
  check("2.0 prompt states backtest nature", prompt.includes("historical simulations (backtests)"));
  const promptPlain = buildChatGptPrompt(buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" }), summarizeScreenshotCoverage(drOnly, [], true), { pdfIncluded: false });
  check("2.0 prompt without DR has no DR block", !promptPlain.includes("DAILY REPLAY & STRATEGY EVIDENCE"));
  const readme = buildReadme(drOnly, summarizeScreenshotCoverage(drOnly, [], true), [], { pdfIncluded: false, pdfFailureNote: null, zipFileName: "x.zip" });
  check("2.0 README documents 2.0 compatibility", readme.includes("SCHEMA 2.0 - WHAT CHANGED"));
  check("2.0 README backtest disclaimer", readme.includes("BACKTESTS: historical simulations"));
  check("2.0 README documents R rule", readme.includes("risk snapshot recorded at the first entry fill"));
}

/* ============ Phase D/E: timeline finalized-only filtering + draft keys ==
 * One attempt (ATTX) with TWO cycles / two trades, plus a second
 * attempt (ATTY) with one trade. A snapshot whose unified omits
 * ATTX trade 2 must produce a decision_timeline.csv with trade 1's
 * cycle events + ATTX lifecycle rows, NONE of trade 2's cycle event
 * seqs, and correct trade_id cells; a snapshot omitting ALL of an
 * attempt's trades contributes zero rows for that attempt. */
{
  const SESSX = "ffffffff-ffff-ffff-ffff-fffffffffff1";
  const SESSY = "ffffffff-ffff-ffff-ffff-fffffffffff2";
  const ATTX = "b1111111-1111-4111-8111-111111111111";
  const ATTY = "b2222222-2222-4222-8222-222222222222";

  const xGrouped: GroupedTrade[] = groupFillsIntoTrades([
    sf("x1f1", SESSX, "buy", 100, 10.00, 5, 0, "2026-10-15T13:35:00.000Z"),
    sf("x1f2", SESSX, "sell", 100, 11.00, 9, 100, "2026-10-15T13:39:00.000Z"),
    sf("x2f1", SESSX, "buy", 50, 20.00, 12, 0, "2026-10-15T13:42:00.000Z"),
    sf("x2f2", SESSX, "sell", 50, 19.00, 16, -50, "2026-10-15T13:46:00.000Z"),
  ], { id: SESSX, ticker: "DRX", trade_date: "2026-10-15", source: "daily_replay" });
  check("phaseDE fixture: ATTX groups into 2 trades", xGrouped.length === 2);
  const yGrouped: GroupedTrade[] = groupFillsIntoTrades([
    sf("y1f1", SESSY, "buy", 10, 5.00, 2, 0, "2026-10-15T14:02:00.000Z"),
    sf("y1f2", SESSY, "sell", 10, 6.00, 4, 10, "2026-10-15T14:04:00.000Z"),
  ], { id: SESSY, ticker: "DRY", trade_date: "2026-10-15", source: "daily_replay" });

  // ATTX events — seqs are significant to the assertions below:
  // 1 attempt_created, 2 session_started, 3-6 cycle 1, 7-10 cycle 2,
  // 11 session_completed.
  let xs = 0;
  const xev = (type: DrEventType, payload: Record<string, unknown> = {}, idx = 0): DrEvent =>
    ({ seq: ++xs, type, wallTs: 1760601000000 + xs * 5000, marketIdx: idx, marketTs: 1760544000000 + idx * 60000, payload });
  const attXEvents: DrEvent[] = [
    xev("attempt_created", { ticker: "DRX" }),
    xev("session_started"),
    xev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    xev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    xev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    xev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "target", unrealizedPnl: 0 }, 9),
    xev("order_filled", { side: "buy", qty: 50, price: 20, candleIndex: 12 }, 12),
    xev("risk_snapshot", { entry: 20, qty: 50, stopLoss: 19, takeProfit: 22, plannedRisk: 50, rewardRisk: 2 }, 12),
    xev("order_filled", { side: "sell", qty: 50, price: 19, candleIndex: 16 }, 16),
    xev("position_closed", { qty: 50, price: 19, realizedPnl: -50, sessionRealized: 50, reason: "stop-loss", unrealizedPnl: 0 }, 16),
    xev("session_completed", {}, 17),
  ];
  const cycle2Seqs = new Set([7, 8, 9, 10]);
  let ys = 0;
  const yev = (type: DrEventType, payload: Record<string, unknown> = {}, idx = 0): DrEvent =>
    ({ seq: ++ys, type, wallTs: 1760602000000 + ys * 5000, marketIdx: idx, marketTs: 1760544000000 + idx * 60000, payload });
  const attYEvents: DrEvent[] = [
    yev("attempt_created", { ticker: "DRY" }),
    yev("order_filled", { side: "buy", qty: 10, price: 5, candleIndex: 2 }, 2),
    yev("risk_snapshot", { entry: 5, qty: 10, stopLoss: 4.5, takeProfit: 6, plannedRisk: 5, rewardRisk: 2 }, 2),
    yev("order_filled", { side: "sell", qty: 10, price: 6, candleIndex: 4 }, 4),
    yev("position_closed", { qty: 10, price: 6, realizedPnl: 10, sessionRealized: 10, reason: "target", unrealizedPnl: 0 }, 4),
  ];

  const derivedX = deriveDrEvidence({ attemptId: ATTX, trades: xGrouped, events: attXEvents });
  const derivedY = deriveDrEvidence({ attemptId: ATTY, trades: yGrouped, events: attYEvents });
  const evidenceDE = new Map([...derivedX.byTradeKey, ...derivedY.byTradeKey]);
  const drU2 = (g: GroupedTrade, att: string): ExportUnifiedInput => ({
    ...simUnified(g), sessionSource: "daily_replay", attemptId: att,
    rMultiple: evidenceDE.get(g.tradeKey)?.rMultiple ?? null,
  });
  const inputDE: ExportSnapshotInput = {
    unified: [drU2(xGrouped[0], ATTX), drU2(xGrouped[1], ATTX), drU2(yGrouped[0], ATTY)],
    metas: {},
    realTrades: [],
    simTrades: [...xGrouped, ...yGrouped],
    drAttempts: [
      { id: ATTX, sessionId: SESSX, strategyVersionId: null, status: "finished", startIndex: 4, createdAt: "2026-10-16T16:00:00Z", finishedAt: "2026-10-16T16:30:00Z", ticker: "DRX", tradeDate: "2026-10-15" },
      { id: ATTY, sessionId: SESSY, strategyVersionId: null, status: "finished", startIndex: 1, createdAt: "2026-10-16T17:00:00Z", finishedAt: "2026-10-16T17:20:00Z", ticker: "DRY", tradeDate: "2026-10-15" },
    ],
    drEvidence: evidenceDE,
    drEvents: [
      ...attXEvents.map((event, i) => ({ id: `xev-${i + 1}`, attemptId: ATTX, event })),
      ...attYEvents.map((event, i) => ({ id: `yev-${i + 1}`, attemptId: ATTY, event })),
    ],
    drEventTradeKeys: new Map([[ATTX, derivedX.eventTradeKey], [ATTY, derivedY.eventTradeKey]]),
    strategies: [], strategyVersions: [],
    drDraftKeys: new Map([
      [xGrouped[0].tradeKey, { draftKey: `dr:${ATTX}:g0:c1`, autoCapture: {} }],
      [xGrouped[1].tradeKey, { draftKey: `dr:${ATTX}:g0:c2`, autoCapture: {} }],
    ]),
  };
  const rangeDE = { start: "2026-10-01", end: "2026-10-31" };

  const fullDE = buildExportSnapshot(inputDE, { range: rangeDE, mode: "custom", source: "daily_replay" });
  check("phaseDE full: 3 DR trades", fullDE.counts.total === 3 && fullDE.counts.dailyReplay === 3);
  check("phaseDE draftInfoByTradeKey carried onto the DR block",
    fullDE.dailyReplay?.draftInfoByTradeKey.get(xGrouped[0].tradeKey)?.draftKey === `dr:${ATTX}:g0:c1`
    && fullDE.dailyReplay?.draftInfoByTradeKey.get(xGrouped[1].tradeKey)?.draftKey === `dr:${ATTX}:g0:c2`);
  const fullRows = parseCsv(buildDecisionTimelineCsv(fullDE));
  check("phaseDE full timeline: every event of both attempts present",
    fullRows.length === 1 + attXEvents.length + attYEvents.length);

  // Second snapshot: unified omits ATTX trade 2 (the unfinalized cycle).
  const omitDE = buildExportSnapshot(
    { ...inputDE, unified: [drU2(xGrouped[0], ATTX), drU2(yGrouped[0], ATTY)] },
    { range: rangeDE, mode: "custom", source: "daily_replay" },
  );
  check("phaseDE omit: snapshot has 2 trades", omitDE.counts.total === 2);
  const omitRows = parseCsv(buildDecisionTimelineCsv(omitDE)).slice(1);
  const omitX = omitRows.filter((r) => r[1] === ATTX);
  check("phaseDE omit: ATTX rows are trade-1 cycle + lifecycle only (7 rows)", omitX.length === 7);
  check("phaseDE omit: NONE of trade 2's cycle event seqs present",
    omitX.every((r) => !cycle2Seqs.has(Number(r[3]))));
  check("phaseDE omit: trade-1 cycle rows carry trade 1's export id",
    omitX.filter((r) => r[0] !== "").every((r) => r[0] === exportIdForTradeKey(xGrouped[0].tradeKey))
    && omitX.some((r) => r[0] === exportIdForTradeKey(xGrouped[0].tradeKey)));
  check("phaseDE omit: lifecycle rows kept with empty trade_id",
    omitX.some((r) => r[4] === "attempt_created" && r[0] === "")
    && omitX.some((r) => r[4] === "session_completed" && r[0] === ""));
  check("phaseDE omit: ATTY rows untouched", omitRows.filter((r) => r[1] === ATTY).length === attYEvents.length);

  // Third snapshot: ALL of ATTX's trades omitted -> zero ATTX rows.
  const noneDE = buildExportSnapshot(
    { ...inputDE, unified: [drU2(yGrouped[0], ATTY)] },
    { range: rangeDE, mode: "custom", source: "daily_replay" },
  );
  const noneRows = parseCsv(buildDecisionTimelineCsv(noneDE)).slice(1);
  check("phaseDE all-omitted attempt: zero rows for it", noneRows.filter((r) => r[1] === ATTX).length === 0);
  check("phaseDE all-omitted attempt: other attempt still exports", noneRows.filter((r) => r[1] === ATTY).length === attYEvents.length);

  /* --- README / prompt finalized-only + screenshot-timing notes --- */
  const covDE = summarizeScreenshotCoverage(fullDE, [], true);
  const readmeDE = buildReadme(fullDE, covDE, [], { pdfIncluded: false, pdfFailureNote: null, zipFileName: "x.zip" });
  check("phaseDE README states finalized-only", readmeDE.includes("Daily Replay trades in this export are FINALIZED trades only — unfinalized drafts are excluded by design and never appear in any file in this package."));
  check("phaseDE README states representative timing", readmeDE.includes("Daily Replay representative screenshots: an auto-captured representative shows the chart as staged at the entry fill; the entry candle was still forming when captured."));
  const promptDE = buildChatGptPrompt(fullDE, covDE, { pdfIncluded: false });
  check("phaseDE prompt states finalized-only", promptDE.includes("Daily Replay trades in this export are FINALIZED trades only — unfinalized drafts are excluded by design and never appear in any file in this package."));
  check("phaseDE prompt states all-included screenshots (§G 1a)", promptDE.includes("Daily Replay screenshots: EVERY available screenshot of each Daily Replay trade is included"));
  check("phaseDE schema version stays 2.0", fullDE.schemaVersion === "2.0");
}

/* ================= Representative screenshots + chart prompt
 * (Representative plan §6.2, updated by the 2026-10-18 export fixes,
 * audit §G Group 1): ALL images are now included (the
 * representative-only download limit is retired); the representative
 * survives as a flagged role, both captures carry their candle
 * indices + capture kinds, recordedAt is plumbed from the listing,
 * and propagation into trades.csv / analytics.json covers every
 * included file. Rules 1–22 byte-identity vs the pinned pre-Stage-1
 * hashes is unchanged and still asserted below. ================= */
{
  const RSESS = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const RATT = "b2222222-2222-4222-8222-222222222222";
  const RUSER = "user-00000000-0000-0000-0000-000000000001";
  const RDRAFT = `dr:${RATT}:g0:c1`;
  const RDSEG = `dr_${RATT}_g0_c1`;
  const RFSEG = `${RSESS}_1`;
  const R_ENTRY = `${RUSER}/${RDSEG}/auto-entry-c6.png`;
  const R_EXIT = `${RUSER}/${RDSEG}/auto-exit-c10.png`;
  const R_MANUAL = `${RUSER}/${RDSEG}/manual.png`;
  const R_REVIEW = `${RUSER}/${RFSEG}/review.png`;
  const rsf = (id: string, side: "buy" | "sell", qty: number, price: number, idx: number, pnl: number, t: string): RawFill =>
    ({ id, session_id: RSESS, side, qty, price, candle_index: idx, candle_time: t, realized_pnl: pnl, created_at: t });
  const rGrouped0 = groupFillsIntoTrades([
    rsf("rx1", "buy", 100, 10, 5, 0, "2026-10-15T13:35:00.000Z"),
    rsf("rx2", "sell", 100, 11, 9, 100, "2026-10-15T13:39:00.000Z"),
  ], { id: RSESS, ticker: "REPR", trade_date: "2026-10-15", source: "daily_replay" })[0];
  const rGrouped: GroupedTrade = { ...rGrouped0, tradeKey: `${RSESS}:1`, sessionId: RSESS, fills: rGrouped0.fills.map((f) => ({ ...f, session_id: RSESS })) };
  const rEvents: DrEvent[] = [
    { seq: 1, type: "order_filled", wallTs: 1760600000000, marketIdx: 5, marketTs: 1760544300000, payload: { side: "buy", qty: 100, price: 10, candleIndex: 5 } },
    { seq: 2, type: "risk_snapshot", wallTs: 1760600001000, marketIdx: 5, marketTs: 1760544300000, payload: { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 } },
    { seq: 3, type: "order_filled", wallTs: 1760600100000, marketIdx: 9, marketTs: 1760544540000, payload: { side: "sell", qty: 100, price: 11, candleIndex: 9 } },
    { seq: 4, type: "position_closed", wallTs: 1760600100000, marketIdx: 9, marketTs: 1760544540000, payload: { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "target", unrealizedPnl: 0 } },
  ];
  const rDerived = deriveDrEvidence({ attemptId: RATT, trades: [rGrouped], events: rEvents });
  const mkSnap = (autoCapture: Record<string, unknown>) => buildExportSnapshot({
    unified: [{
      key: rGrouped.tradeKey, source: "simulator", ticker: "REPR", tradeDate: "2026-10-15",
      direction: "long", entryPrice: 10, exitPrice: 11, qty: 100, realizedPnl: 100, isOpen: false,
      rMultiple: 2, sessionSource: "daily_replay", attemptId: RATT,
    }],
    metas: {}, realTrades: [], simTrades: [rGrouped],
    drAttempts: [{ id: RATT, sessionId: RSESS, strategyVersionId: null, status: "finished", startIndex: 4, createdAt: "2026-10-16T16:00:00Z", finishedAt: "2026-10-16T16:30:00Z", ticker: "REPR", tradeDate: "2026-10-15" }],
    drEvidence: rDerived.byTradeKey,
    drEvents: rEvents.map((event, i) => ({ id: `rev-${i + 1}`, attemptId: RATT, event })),
    drEventTradeKeys: new Map([[RATT, rDerived.eventTradeKey]]),
    strategies: [], strategyVersions: [],
    drDraftKeys: new Map([[rGrouped.tradeKey, { draftKey: RDRAFT, autoCapture }]]),
  }, { range: { start: "2026-10-01", end: "2026-10-31" }, mode: "custom", source: "daily_replay" });
  const bothCaptured = {
    entry: { path: R_ENTRY, candleIndex: 5, status: "captured" },
    exit: { path: R_EXIT, candleIndex: 9, status: "captured" },
  };
  const listedAll = new Map([[rGrouped.tradeKey, [
    { path: R_ENTRY, createdAt: "2026-10-16T16:05:00.000Z" },
    { path: R_EXIT, createdAt: "2026-10-16T16:09:00.000Z" },
    { path: R_MANUAL, createdAt: "2026-10-16T16:20:00.000Z" },
    { path: R_REVIEW, createdAt: "2026-10-16T16:25:00.000Z" },
  ]]]);

  const snapR = mkSnap(bothCaptured);
  check("rep: record carries fill candle indices", snapR.trades[0].entryCandleIndex === 5 && snapR.trades[0].exitCandleIndex === 9);

  const manR = buildScreenshotManifest(snapR, listedAll, RUSER);
  check("rep: manifest lists ALL FOUR images (none silently dropped)", manR.length === 4);
  const repEntries = manR.filter((e) => e.role === "representative");
  check("rep: exactly ONE representative — the entry capture", repEntries.length === 1 && repEntries[0].storagePath === R_ENTRY);
  check("rep: representative is downloadable (listed + file set)", repEntries[0].status === "listed" && repEntries[0].file !== null);
  check("rep: representative source/candle recorded", repEntries[0].representativeSource === "auto_entry" && repEntries[0].candleIndex === 5);
  check("rep: DR images live under trade_evidence/<trade ID>/ (§G 1e)",
    repEntries[0].file === `trade_evidence/${snapR.trades[0].exportId}/${repEntries[0].fileName}`);
  check("rep: representative recordedAt plumbed (§G 1c)", repEntries[0].recordedAt === "2026-10-16T16:05:00.000Z");
  const exitEntry = manR.find((e) => e.storagePath === R_EXIT)!;
  check("rep: exit capture is INCLUDED with role/kind/candle/recordedAt (§G 1a/1b/1c)",
    exitEntry.role === "exit" && exitEntry.captureKind === "auto_exit" && exitEntry.candleIndex === 9
    && exitEntry.status === "listed" && exitEntry.file !== null && exitEntry.recordedAt === "2026-10-16T16:09:00.000Z");
  check("rep: manual + review images are included manual attachments",
    manR.filter((e) => e.role === "attachment").length === 2
    && manR.filter((e) => e.role === "attachment").every((e) => e.captureKind === "manual" && e.candleIndex === null && e.status === "listed" && e.file !== null));
  check("rep: NO not-included rows remain (§G 1a)", manR.every((e) => e.status !== "not-included"));

  // All-included propagation: flip every entry to included (as the
  // package does after download) and rebuild artifacts.
  for (const e of manR) e.status = "included";
  const csvRows = parseCsv(buildTradesCsv(snapR, manR));
  const shotCol = CSV_COLUMNS.indexOf("screenshot_files");
  const drRow = csvRows.find((r) => r[1] === "REPR");
  check("rep: trades.csv names ALL FOUR included files",
    drRow !== undefined && drRow[shotCol] === manR.map((e) => e.fileName).join("; "));
  const docR2 = buildAnalyticsJson(snapR, manR, summarizeScreenshotCoverage(snapR, manR, true)) as any;
  check("rep: analytics tradesIndex lists ALL FOUR files",
    JSON.stringify(docR2.tradesIndex[0].screenshots) === JSON.stringify(manR.map((e) => e.fileName)));
  check("rep: analytics public manifest carries role/kind/candle/recordedAt",
    docR2.metadata.screenshotManifest.some((e: any) => e.role === "representative" && e.representativeSource === "auto_entry" && e.candleIndex === 5 && e.captureKind === "auto_entry" && e.recordedAt === "2026-10-16T16:05:00.000Z")
    && docR2.metadata.screenshotManifest.some((e: any) => e.role === "exit" && e.candleIndex === 9)
    && docR2.metadata.screenshotManifest.filter((e: any) => e.status === "not-included").length === 0);
  check("rep: public manifest never leaks storage paths",
    docR2.metadata.screenshotManifest.every((e: any) => !("storagePath" in e) && !("tradeKey" in e)));
  const covR = summarizeScreenshotCoverage(snapR, manR, true);
  check("rep: coverage counts all files + the representative", covR.dailyReplayTradesWithRepresentative === 1 && covR.screenshotFiles === 4);

  // User selection wins over the entry default.
  const snapSel = mkSnap({ ...bothCaptured, representative: { path: R_EXIT, selectedAt: "2026-10-17T00:00:00.000Z" } });
  const manSel = buildScreenshotManifest(snapSel, listedAll, RUSER);
  check("rep: user-selected exit becomes the representative",
    manSel.filter((e) => e.role === "representative").length === 1
    && manSel.find((e) => e.role === "representative")?.storagePath === R_EXIT
    && manSel.find((e) => e.role === "representative")?.representativeSource === "user_selected"
    && manSel.find((e) => e.role === "representative")?.candleIndex === 9);
  check("rep: the entry capture stays included as role entry when not selected",
    manSel.find((e) => e.storagePath === R_ENTRY)?.role === "entry"
    && manSel.find((e) => e.storagePath === R_ENTRY)?.status === "listed");

  // Entry failed -> no representative at all; images still included,
  // coverage says so plainly.
  const snapNone = mkSnap({ entry: { status: "failed" }, exit: { path: R_EXIT, candleIndex: 9, status: "captured" } });
  const manNone = buildScreenshotManifest(snapNone, listedAll, RUSER);
  check("rep: entry failed + exit captured -> NO representative, all still included",
    manNone.every((e) => e.role !== "representative" && e.status === "listed")
    && manNone.find((e) => e.storagePath === R_EXIT)?.role === "exit");
  const covNone = summarizeScreenshotCoverage(snapNone, manNone, true);
  check("rep: coverage note says 'had no representative screenshot'", covNone.note.includes("had no representative screenshot"));

  /* ---- prompt: rules 1–22 byte-identity + new section ---- */
  const promptR = buildChatGptPrompt(snapR, covR, { pdfIncluded: false, chartContextIncluded: true, representativeIncluded: true });
  const aStart = promptR.indexOf("1. Begin with a concise summary");
  const aEnd = promptR.indexOf("validate each hypothesis.") + "validate each hypothesis.".length;
  check("prompt: rules 1-15 byte-identical to the pinned pre-Stage-1 hash",
    createHash("sha256").update(promptR.slice(aStart, aEnd)).digest("hex") === "7e28fe0cf4f9173dfbf7f70c5ef6e48d01c5b3f8358615ab43d7b451c16dd49e");
  const bStart = promptR.indexOf("16. Evaluate the QUALITY");
  const bEnd = promptR.indexOf("never mix the two clocks.") + "never mix the two clocks.".length;
  check("prompt: rules 16-22 byte-identical to the pinned pre-Stage-1 hash",
    createHash("sha256").update(promptR.slice(bStart, bEnd)).digest("hex") === "2a0f704fb18a4e5e5723d4cbdf0dc0db2a462c60b6953a85dacdc92ac61b9e27");
  check("prompt: chart-analysis section present (unnumbered supplement)",
    promptR.includes("REPRESENTATIVE SCREENSHOT & CHART ANALYSIS") && promptR.includes("not a continuation of them"));
  check("prompt: section separates observations from interpretations",
    promptR.includes("Observations first") && promptR.includes("Interpretations second"));
  check("prompt: section carries the no-hindsight rule",
    promptR.includes("No-hindsight rule") && promptR.includes("judge the entry decision ONLY from entry_context"));
  check("prompt: section covers structure checklist + verdict",
    promptR.includes("higher highs/higher lows") && promptR.includes("consolidation") && promptR.includes("HOD")
    && promptR.includes("SUPPORTED the stated setup") && promptR.includes("clean, weak, failed, or anticipation"));
  check("prompt: section forbids invented levels + requires missing-evidence honesty",
    promptR.includes("No invented levels") && promptR.includes("Missing evidence"));
  check("prompt: files list names chart_context.csv with its sections",
    promptR.includes("chart_context.csv - per-trade historical OHLCV") && promptR.includes("post_entry_development"));
  /* Group 4 (outside-span only): the permitted prompt completions —
   * manifest in the file list, read-first directive, ZIP guidance,
   * P&L basis fact, anticipation + supplied VWAP/EMA + citations in
   * the appended chart section. The pinned spans above are untouched. */
  check("prompt: file list names screenshots-manifest.json (Group 4)",
    promptR.includes("screenshots-manifest.json - every screenshot in this package mapped"));
  check("prompt: read-README-and-manifest-first directive (Group 4)",
    promptR.includes("Read README.txt and screenshots-manifest.json FIRST"));
  check("prompt: ZIP-cannot-be-opened guidance (Group 4)",
    promptR.includes("cannot open the ZIP archive itself"));
  check("prompt: P&L basis fact (§G 3b)", promptR.includes("P&L basis: Real Market P&L is net of its recorded fees") && promptR.includes("never describe it as net of fees"));
  check("prompt: provenance fact (§G 3g)", promptR.includes("setup_class_origin") && promptR.includes("legacy_hod"));
  check("prompt: chart section names anticipation (Group 4)",
    promptR.includes("clean, weak, failed, or anticipation"));
  check("prompt: chart section uses the supplied VWAP/EMA columns (Group 4)",
    promptR.includes("vwap_typical_approx") && promptR.includes("ema_fast_9"));
  check("prompt: chart section requires precise citations (Group 4)",
    promptR.includes("Cite your evidence precisely"));
  const promptNoCtx = buildChatGptPrompt(snapR, covR, { pdfIncluded: false });
  check("prompt: section omitted when no chart context and no representative",
    !promptNoCtx.includes("REPRESENTATIVE SCREENSHOT & CHART ANALYSIS") && !promptNoCtx.includes("chart_context.csv - per-trade"));

  /* ---- README: chart context inventory + schema note ---- */
  const readmeR = buildReadme(snapR, covR, manR, { pdfIncluded: false, pdfFailureNote: null, zipFileName: "x.zip", chartContextIncluded: true });
  check("readme: inventory lists chart_context.csv when included", readmeR.split("\n").some((l) => l === "- chart_context.csv"));
  check("readme: schema note describes representative + sections",
    readmeR.includes("Representative screenshots (additive within schema 2.0)") && readmeR.includes("entry_candle_final"));
  const readmeNoCtx = buildReadme(snapR, covR, manR, { pdfIncluded: false, pdfFailureNote: null, zipFileName: "x.zip" });
  check("readme: chart_context.csv absent from inventory when not included", !readmeNoCtx.split("\n").some((l) => l === "- chart_context.csv"));
}

/* ============ export hints: invisible DR trades, named ============
 * History: the 2026-10-17 report was a finalized draft on an
 * UNCOMPLETED attempt being invisible everywhere (case B) — at the
 * time that was by design (materialization at completion) and the
 * hint named it. The 2026-10-18 workflow fix SUPERSEDES that rule:
 * a finalized draft's trade is now journal-visible immediately as a
 * pre-completion unified row, so case B no longer exists as an
 * invisibility cause (see the pre-completion block below). The two
 * causes that remain must still be NAMED by computeDrExportHints,
 * never silently folded into an "Eligible trades: 0":
 *  (W) a finalized draft whose cycle could NOT be reconciled with
 *      its recorded anchors — the row is withheld, never fabricated;
 *  (C) a DR trade (pre- or post-completion) exists but its tradeDate
 *      is outside the selected range.
 * The hints are communication only: eligibility itself never changes. */
{
  const H_SESSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const H_ATT_DONE = "a3333333-3333-4333-8333-333333333333";
  const H_ATT_WITHHELD = "a4444444-4444-4444-8444-444444444444";
  const hGrouped = groupFillsIntoTrades([
    sf("h1f1", H_SESSION, "buy", 100, 20.00, 97, 0, "2026-10-18T15:37:00.000Z"),
    sf("h1f2", H_SESSION, "sell", 100, 20.10, 97, 10, "2026-10-18T15:37:30.000Z"),
  ], { id: H_SESSION, ticker: "HODX", trade_date: "2026-10-18", source: "daily_replay" });
  const hDoneAttempt: ExportDrAttemptInput = {
    id: H_ATT_DONE, sessionId: H_SESSION, strategyVersionId: null, status: "finished",
    startIndex: 90, createdAt: "2026-10-17T20:00:00Z", finishedAt: "2026-10-17T20:30:00Z",
    ticker: "HODX", tradeDate: "2026-10-18",
  };
  const hInput: ExportSnapshotInput = {
    unified: [{ ...simUnified(hGrouped[0]), sessionSource: "daily_replay", attemptId: H_ATT_DONE }],
    metas: {},
    realTrades: [],
    simTrades: [hGrouped[0]],
    drAttempts: [hDoneAttempt],
    // A finalized draft the journal could not verify into a row
    // (anchor reconciliation failed): withheld, and named here.
    drWithheldFinalizedDrafts: [{ attemptId: H_ATT_WITHHELD, strategyVersionId: null }],
  };
  const oct17 = { start: "2026-10-17", end: "2026-10-17" };

  // DR source + Oct 17 (the completed trade is dated Oct 18) → 0
  // eligible, with BOTH absence causes named.
  const hSnap0 = buildExportSnapshot(hInput, { range: oct17, mode: "daily", source: "daily_replay" });
  check("hints repro: panel state is eligible 0", hSnap0.counts.total === 0 && hSnap0.counts.dailyReplay === 0);
  const hHints0 = computeDrExportHints(hInput, { range: oct17, mode: "daily", source: "daily_replay" });
  check("hints repro: withheld finalized draft named (case W)", hHints0.withheldFinalizedDrafts === 1);
  check("hints repro: out-of-range DR trade named (case C)", hHints0.outOfRangeDrTrades === 1);

  // Widening the range includes the completed trade (case C resolved)
  // but must NOT pretend the withheld draft became eligible.
  const wide = { start: "2026-10-17", end: "2026-10-18" };
  const hSnap1 = buildExportSnapshot(hInput, { range: wide, mode: "custom", source: "daily_replay" });
  check("hints: widened range includes the completed DR trade", hSnap1.counts.dailyReplay === 1);
  const hHints1 = computeDrExportHints(hInput, { range: wide, mode: "custom", source: "daily_replay" });
  check("hints: widened range clears the range hint", hHints1.outOfRangeDrTrades === 0);
  check("hints: widened range keeps the withheld hint", hHints1.withheldFinalizedDrafts === 1);

  // Source scoping: a Real-Market-only export never shows DR hints.
  const hHintsReal = computeDrExportHints(hInput, { range: oct17, mode: "daily", source: "real" });
  check("hints: real-only source suppresses both hints", hHintsReal.withheldFinalizedDrafts === 0 && hHintsReal.outOfRangeDrTrades === 0);
  // DR trades ride the coarse simulator class + All: hints apply there.
  const hHintsSim = computeDrExportHints(hInput, { range: oct17, mode: "daily", source: "simulator" });
  check("hints: simulator source shows both hints", hHintsSim.withheldFinalizedDrafts === 1 && hHintsSim.outOfRangeDrTrades === 1);
  const hHintsAll = computeDrExportHints(hInput, { range: oct17, mode: "daily", source: "all" });
  check("hints: all source shows both hints", hHintsAll.withheldFinalizedDrafts === 1 && hHintsAll.outOfRangeDrTrades === 1);

  // Attempt narrowing applies to both hints (panel-only narrowing).
  const hHintsNarrowWithheld = computeDrExportHints(hInput, { range: oct17, mode: "daily", source: "daily_replay", attemptId: H_ATT_WITHHELD });
  check("hints: attempt narrowing to the withheld attempt keeps its hint", hHintsNarrowWithheld.withheldFinalizedDrafts === 1 && hHintsNarrowWithheld.outOfRangeDrTrades === 0);
  const hHintsNarrowDone = computeDrExportHints(hInput, { range: oct17, mode: "daily", source: "daily_replay", attemptId: H_ATT_DONE });
  check("hints: attempt narrowing to the completed attempt drops the withheld hint", hHintsNarrowDone.withheldFinalizedDrafts === 0 && hHintsNarrowDone.outOfRangeDrTrades === 1);

  // Pre-feature inputs (no withheld field) and in-range trades: no hints.
  const hHintsLegacy = computeDrExportHints({ ...hInput, drWithheldFinalizedDrafts: undefined }, { range: wide, mode: "custom", source: "daily_replay" });
  check("hints: absent withheld field + in-range trade = no hints", hHintsLegacy.withheldFinalizedDrafts === 0 && hHintsLegacy.outOfRangeDrTrades === 0);
}

/* ============ pre-completion finalized trades (2026-10-18) ============
 * The journal now builds a unified row for a FINALIZED draft on an
 * ACTIVE attempt (lib/drDrafts.buildPreCompletionTrade, keyed by the
 * draft key). The export must treat it exactly like a completed DR
 * trade: counted, in trades.csv, its timeline rows attributed, and
 * strategy.json listing its (unclassified) attempt as unversioned. */
{
  const P_ATT = "a5555555-5555-4555-8555-555555555555";
  const P_DRAFT_KEY = `dr:${P_ATT}:g0:c1`;
  const P_BASE = 1760620800000; // 2026-10-16T13:20:00Z — candle period starts
  let pseq = 0;
  const pev = (type: DrEventType, payload: Record<string, unknown> = {}, idx = 0): DrEvent =>
    ({ seq: ++pseq, type, wallTs: P_BASE + pseq * 5000, marketIdx: idx, marketTs: P_BASE + idx * 60000, payload });
  const pEvents: DrEvent[] = [
    pev("attempt_created", { ticker: "PRECO", startingBalance: 100000 }),
    pev("session_started"),
    pev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    pev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    pev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    pev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "target", unrealizedPnl: 0 }, 9),
  ];
  const pDraft: DrDraftRow = {
    id: "d5555555-5555-4555-8555-555555555555", userId: "u1", draftKey: P_DRAFT_KEY, attemptId: P_ATT,
    resetGeneration: 0, cycleIndex: 1, status: "finalized",
    firstFillCandleIndex: 5, firstFillPrice: 10, firstFillQty: 100,
    closeFillCandleIndex: 9, realizedPnl: 100,
    eventFirstSeq: 3, eventLastSeq: 6, autoCapture: {}, finalizedSessionId: null,
    finalizedTradeKey: null, finalizedAt: "2026-10-16T14:00:00Z", createdAt: "2026-10-16T13:29:00Z",
    updatedAt: "2026-10-16T14:00:00Z",
  };
  const { cycles, lastGeneration } = splitCyclesByGeneration(pEvents);
  const pCycle = cycles.find((c) => c.generation === lastGeneration && c.cycleIndex === 1)!;
  const pTrade = buildPreCompletionTrade(pDraft, pCycle, { ticker: "PRECO", tradeDate: "2026-10-16" });
  check("pre-completion: row builds from events + anchors", pTrade != null);
  check("pre-completion: row keys off the DRAFT key, no session", pTrade?.tradeKey === P_DRAFT_KEY && pTrade?.sessionId === "");
  check("pre-completion: row values (entry 10, exit 11, qty 100, P&L 100)",
    pTrade?.entryPrice === 10 && pTrade?.exitPrice === 11 && pTrade?.qty === 100 && pTrade?.realizedPnl === 100);
  const pDerived = deriveDrEvidence({ attemptId: P_ATT, trades: pTrade ? [pTrade] : [], events: pEvents });
  const pEvidence = pTrade ? pDerived.byTradeKey.get(pTrade.tradeKey) : undefined;
  check("pre-completion: evidence pairs the draft-key row (R = 100/50 = 2)", pEvidence?.rMultiple === 2);
  const pAttempt: ExportDrAttemptInput = {
    id: P_ATT, sessionId: null, strategyVersionId: null, status: "active",
    startIndex: 4, createdAt: "2026-10-16T13:25:00Z", finishedAt: null,
    ticker: "PRECO", tradeDate: "2026-10-16",
  };
  const pUnified: ExportUnifiedInput = {
    key: P_DRAFT_KEY, source: "simulator", ticker: "PRECO", tradeDate: "2026-10-16",
    direction: "long", entryPrice: 10, exitPrice: 11, qty: 100, realizedPnl: 100,
    isOpen: false, rMultiple: pEvidence?.rMultiple ?? null,
    sessionSource: "daily_replay", attemptId: P_ATT,
  };
  const pInput: ExportSnapshotInput = {
    unified: [pUnified],
    metas: {},
    realTrades: [],
    simTrades: pTrade ? [pTrade] : [],
    drAttempts: [pAttempt],
    drEvidence: pDerived.byTradeKey,
    drEvents: pEvents.map((event, i) => ({ id: `pev-${i + 1}`, attemptId: P_ATT, event })),
    drEventTradeKeys: new Map([[P_ATT, pDerived.eventTradeKey]]),
    drDraftKeys: new Map([[P_DRAFT_KEY, { draftKey: P_DRAFT_KEY, autoCapture: {} }]]),
  };
  const pSnap = buildExportSnapshot(pInput, { range: { start: "2026-10-16", end: "2026-10-16" }, mode: "daily", source: "daily_replay" });
  check("pre-completion: export counts the trade (eligible 1, DR 1)", pSnap.counts.total === 1 && pSnap.counts.dailyReplay === 1);
  const pRec = pSnap.trades[0];
  check("pre-completion: record is DR with R from evidence", pRec?.isDailyReplay === true && pRec?.rMultiple === 2 && pRec?.attemptId === P_ATT);
  const pCsv = buildTradesCsv(pSnap, []);
  check("pre-completion: trades.csv carries the row", pCsv.split("\r\n").filter((l) => l.includes("PRECO")).length === 1);
  const pTimeline = buildDecisionTimelineCsv(pSnap);
  check("pre-completion: decision_timeline.csv carries the trade's events",
    pTimeline.includes("risk_snapshot") && pTimeline.includes("position_closed"));
  const pStrategy = buildStrategyJson(pSnap) as { unversionedAttemptIds?: string[] } | null;
  check("pre-completion: strategy.json lists the unclassified attempt as unversioned",
    Array.isArray(pStrategy?.unversionedAttemptIds) && pStrategy!.unversionedAttemptIds!.includes(P_ATT));
  const pHints = computeDrExportHints(pInput, { range: { start: "2026-10-16", end: "2026-10-16" }, mode: "daily", source: "daily_replay" });
  check("pre-completion: no withheld/out-of-range hints for the included trade",
    pHints.withheldFinalizedDrafts === 0 && pHints.outOfRangeDrTrades === 0);
  const pHintsOut = computeDrExportHints(pInput, { range: { start: "2026-10-17", end: "2026-10-17" }, mode: "daily", source: "daily_replay" });
  check("pre-completion: out-of-range hint covers pre-completion trades too", pHintsOut.outOfRangeDrTrades === 1);
}

/* ============ §G 3a: real-trade fees honesty ============
 * A trade whose fills carry NO fee data (null at runtime — e.g. an
 * import with no fee column) exports fees EMPTY (unknown), exactly
 * like the simulator treatment; a trade whose fills record fees of 0
 * exports 0.00 — the two states must never be conflated. */
{
  const noFeeFills = [
    { id: "nf1", side: "buy", qty: 100, price: 2.00, fees: null, fill_time: "2026-10-13T13:45:00.000Z" },
    { id: "nf2", side: "sell", qty: 100, price: 2.50, fees: null, fill_time: "2026-10-13T14:15:00.000Z" },
  ] as unknown as RealFill[];
  const nfCalc = calcRealTrade(noFeeFills, "long", null, null);
  check("fees: calc flags no fee data recorded", nfCalc.feesRecorded === false && nfCalc.totalFees === 0);
  const nfTrade: ExportRealTradeInput = {
    id: "66666666-6666-4666-8666-666666666666", ticker: "NOFEE", trade_date: "2026-10-13", direction: "long", strategy: null,
    status: "closed", stop_loss: null, target: null, float_shares: null, relative_volume: null,
    market_conditions: null, fills: noFeeFills, calc: nfCalc,
  };
  const nfSnap = buildExportSnapshot(
    { unified: [realUnified(nfTrade)], metas: {}, realTrades: [nfTrade], simTrades: [] },
    { range: RANGE, mode: "custom", source: "real" });
  check("fees: unrecorded fees export as null, NOT 0 (§G 3a)", nfSnap.trades[0].fees === null);
  const nfRows = parseCsv(buildTradesCsv(nfSnap, []));
  check("fees: CSV fees_usd EMPTY for unrecorded (§G 3a)", nfRows[1][nfRows[0].indexOf("fees_usd")] === "");
  const nfDoc = buildAnalyticsJson(nfSnap, [], summarizeScreenshotCoverage(nfSnap, [], false)) as any;
  check("fees: unavailability named in metricsUnavailable (§G 3a)",
    (nfDoc.metadata.metricsUnavailable as any[]).some((u) => u.key === "realTradeFeesUnknown"));
  check("fees: feesComplete false when a closed trade's fees are unknown",
    nfDoc.overall.feesComplete === false);

  const zeroCalc = calcRealTrade(r2Fills, "long", null, null);
  check("fees: recorded zeros ARE fee data", zeroCalc.feesRecorded === true && zeroCalc.totalFees === 0);
  const zeroSnap = buildExportSnapshot(input, { range: RANGE, mode: "custom", source: "all" });
  const zeroRec = zeroSnap.trades.find((t) => t.exportId === `TRADE-${R2_ID}`)!;
  check("fees: recorded-zero trade still exports 0 (unchanged)", zeroRec.fees === 0);
}

/* ============ §G 3c: recording-problem marker ============
 * A finalized DR trade on a ZERO-EVENT attempt: the export must say
 * events_missing (a recording problem) in trades.csv + analytics,
 * must NOT assert "no valid risk snapshot recorded at entry" for it,
 * and the attempt block must disclose eventsRecorded 0. A trade on
 * an attempt WITH events but no evidence entry is unreconciled. */
{
  const Z_ATT = "a6666666-6666-4666-8666-666666666666";
  const Z_SESS = "66666666-6666-4666-8666-666666666666";
  const zGrouped = groupFillsIntoTrades([
    sf("z1", Z_SESS, "buy", 100, 10.00, 5, 0, "2026-10-15T13:35:00.000Z"),
    sf("z2", Z_SESS, "sell", 100, 9.50, 9, -50, "2026-10-15T13:39:00.000Z"),
  ], { id: Z_SESS, ticker: "ZLOSS", trade_date: "2026-10-15", source: "daily_replay" });
  const zInput: ExportSnapshotInput = {
    unified: [{ ...simUnified(zGrouped[0]), sessionSource: "daily_replay", attemptId: Z_ATT, rMultiple: null }],
    metas: {}, realTrades: [], simTrades: zGrouped,
    drAttempts: [{ id: Z_ATT, sessionId: Z_SESS, strategyVersionId: null, status: "finished", startIndex: 4, createdAt: "2026-10-16T16:00:00Z", finishedAt: "2026-10-16T16:30:00Z", ticker: "ZLOSS", tradeDate: "2026-10-15" }],
    drEvidence: new Map(),
    drEvents: [],
    drEventTradeKeys: new Map(),
    strategies: [], strategyVersions: [],
  };
  const zSnap = buildExportSnapshot(zInput, { range: RANGE, mode: "custom", source: "daily_replay" });
  const zRec = zSnap.trades[0];
  check("events: zero-event trade is events_missing (§G 3c)", zRec.eventsStatus === "events_missing");
  check("events: risk basis names the recording problem, not a missing snapshot",
    zRec.riskBasis.includes("recording problem") && !zRec.riskBasis.includes("no risk snapshot was recorded"));
  check("events: R stays unavailable (never reconstructed)", zRec.rMultiple === null && zRec.initialRisk === null);
  check("events: snapshot warning names events_missing",
    zSnap.warnings.some((w) => w.includes("events_status = events_missing")));
  const zRows = parseCsv(buildTradesCsv(zSnap, []));
  check("events: CSV events_status cell (§G 3c)", zRows[1][zRows[0].indexOf("events_status")] === "events_missing");
  const zDoc = buildAnalyticsJson(zSnap, [], summarizeScreenshotCoverage(zSnap, [], true)) as any;
  check("events: tradesIndex carries eventsStatus (§G 3c)", zDoc.tradesIndex[0].eventsStatus === "events_missing");
  check("events: metricsUnavailable splits the cause (§G 3c)",
    (zDoc.metadata.metricsUnavailable as any[]).some((u) => u.key === "dailyReplayEventsMissing")
    && !(zDoc.metadata.metricsUnavailable as any[]).some((u) => u.key === "dailyReplayRiskUnavailable"));
  const zAttempt = (zDoc.dailyReplay.attempts as any[])[0];
  check("events: attempt block discloses 0 events + events-missing lifecycle (§G 3c)",
    zAttempt.eventsRecorded === 0 && zAttempt.lifecycle === "events-missing");
  const zTimeline = buildDecisionTimelineCsv(zSnap);
  check("events: timeline for a zero-event attempt is header-only (0 rows disclosed via the attempt block)",
    parseCsv(zTimeline).length === 1);

  // Same trade, but the attempt HAS events and no evidence entry.
  const zInput2: ExportSnapshotInput = {
    ...zInput,
    drEvents: [{ id: "zev-1", attemptId: Z_ATT, event: { seq: 1, type: "attempt_created", wallTs: 1760600000000, marketIdx: 4, marketTs: 1760544000000, payload: { ticker: "ZLOSS" } } }],
  };
  const zSnap2 = buildExportSnapshot(zInput2, { range: RANGE, mode: "custom", source: "daily_replay" });
  check("events: events present but no evidence -> events_unreconciled (§G 3c)",
    zSnap2.trades[0].eventsStatus === "events_unreconciled");
}

/* ============ §G 3f: setup fallback alignment ============
 * A real trade with a recorded strategy but no meta setup tag: the
 * CSV setup cell uses the strategy fallback; the analytics setup
 * breakdown must group it under the SAME value. */
{
  const onlyR2 = buildExportSnapshot(
    { unified: [realUnified(r2)], metas: {}, realTrades: [r2], simTrades: [] },
    { range: RANGE, mode: "custom", source: "real" });
  const docF = buildAnalyticsJson(onlyR2, [], summarizeScreenshotCoverage(onlyR2, [], false)) as any;
  check("setup: analytics breakdown uses the resolved setup (matches CSV) (§G 3f)",
    (docF.breakdowns.setup as any[]).some((r) => r.label === "HOD breakout" && r.count === 1));
}

/* ============ §G 3h: implied-fill marker (draft anchors) ============ */
{
  const A_ATT = "a7777777-7777-4777-8777-777777777777";
  const A_DRAFT_KEY = `dr:${A_ATT}:g0:c1`;
  const aDraft: DrDraftRow = {
    id: "d7777777-7777-4777-8777-777777777777", userId: "u1", draftKey: A_DRAFT_KEY, attemptId: A_ATT,
    resetGeneration: 0, cycleIndex: 1, status: "finalized",
    firstFillCandleIndex: 5, firstFillPrice: 10, firstFillQty: 100,
    closeFillCandleIndex: 9, realizedPnl: 100,
    eventFirstSeq: 3, eventLastSeq: 6, autoCapture: {}, finalizedSessionId: null,
    finalizedTradeKey: null, finalizedAt: "2026-10-16T14:00:00Z", createdAt: "2026-10-16T13:29:00Z",
    updatedAt: "2026-10-16T14:00:00Z",
  };
  const aTrade = groupedTradeFromDraftAnchors(aDraft, { ticker: "ANCH", tradeDate: "2026-10-16" });
  check("anchors: builder flags the trade anchors-derived (§G 3h)", aTrade?.anchorsDerived === true);
  const aInput: ExportSnapshotInput = {
    unified: [{
      key: A_DRAFT_KEY, source: "simulator", ticker: "ANCH", tradeDate: "2026-10-16",
      direction: "long", entryPrice: 10, exitPrice: 11, qty: 100, realizedPnl: 100,
      isOpen: false, rMultiple: null, sessionSource: "daily_replay", attemptId: A_ATT,
    }],
    metas: {}, realTrades: [], simTrades: aTrade ? [aTrade] : [],
    drAttempts: [{ id: A_ATT, sessionId: null, strategyVersionId: null, status: "active", startIndex: 4, createdAt: "2026-10-16T13:25:00Z", finishedAt: null, ticker: "ANCH", tradeDate: "2026-10-16" }],
    drEvents: [],
  };
  const aSnap = buildExportSnapshot(aInput, { range: RANGE, mode: "custom", source: "daily_replay" });
  check("anchors: record carries the flag + implied exit fill (§G 3h)",
    aSnap.trades[0].anchorsDerived === true && aSnap.trades[0].exits[0].implied === true);
  const aRows = parseCsv(buildTradesCsv(aSnap, []));
  check("anchors: CSV exit fill labelled implied (§G 3h)",
    aRows[1][aRows[0].indexOf("exit_fills")].includes("(implied from recorded P&L)"));
  check("anchors: snapshot warning discloses the anchors rebuild (§G 3h)",
    aSnap.warnings.some((w) => w.includes("rebuilt from the finalized draft's recorded anchors")));
  check("anchors: zero-event anchors trade is also events_missing (§G 3c+3h)",
    aSnap.trades[0].eventsStatus === "events_missing");
}

console.log(`edgeExport tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
