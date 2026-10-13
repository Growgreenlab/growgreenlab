/**
 * journalAnalytics.test.ts — hand-computed fixtures for lib/journalAnalytics.
 * Run: npx tsx lib/journalAnalytics.test.ts
 * Every expected value below was calculated by hand from the fixture data.
 */
import {
  breakdown, riskMetrics, edgeInsights, dailyPnl, dailyBarLayout,
  etMinutesOfDay, sessionBucket, timeOfDayBucket, holdBucket, holdMinutes,
  type AnalyticsTrade,
} from "./journalAnalytics";
import { calcMetrics, calcRealTrade, groupFillsIntoTrades, fmtPnl, type RealFill, type RawFill } from "./journal";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`); }
}
function approx(name: string, actual: number | null, expected: number, eps = 1e-9) {
  check(`${name} (got ${actual}, want ${expected})`, actual != null && Math.abs(actual - expected) < eps);
}

let seq = 0;
function T(p: Partial<AnalyticsTrade>): AnalyticsTrade {
  return {
    key: `t${++seq}`, source: "real", ticker: "AAA", tradeDate: "2026-01-05",
    direction: "long", entryPrice: 10, exitPrice: 11, qty: 100,
    realizedPnl: 0, rMultiple: null, isOpen: false,
    setupTag: null, hodClass: null, followedPlan: null,
    emotionalTags: [], mistakes: [], entryTime: null, exitTime: null,
    stopLoss: null, initialRisk: null, ...p,
  };
}

/* ============ Set A: drawdown, streaks, R, ratios ============
 * Chronological P&L: +100, +50, −80, 0(BE), −20, +30 → net +80
 * Cumulative: 100, 150, 70, 70, 50, 80 → peak 150, worst trough 50 → DD $100
 * DD% = 100 / 150 = 66.67% (peak cumulative P&L convention)
 * Streaks: W W | L (BE skips) L | W → maxW 2, maxL 2, curW 1, curL 0
 * R values present: 1.0, 0.5, −0.8, 0, 2.5 → avgR 3.2/5 = 0.64
 * R buckets [<−1, −1..0, 0..1, 1..2, >2] = [0, 1, 2, 1, 1]
 * avgWin 60, |avgLoss| 50 → winLossRatio 1.2
 * Days: 01-05 +150 W, 01-06 −80 L, 01-07 +10 W → losing freq 1/3
 */
const A: AnalyticsTrade[] = [
  T({ tradeDate: "2026-01-05", realizedPnl: 100, rMultiple: 1.0 }),
  T({ tradeDate: "2026-01-05", realizedPnl: 50, rMultiple: 0.5 }),
  T({ tradeDate: "2026-01-06", realizedPnl: -80, rMultiple: -0.8 }),
  T({ tradeDate: "2026-01-06", realizedPnl: 0, rMultiple: 0 }),
  T({ tradeDate: "2026-01-07", realizedPnl: -20, rMultiple: null }),
  T({ tradeDate: "2026-01-07", realizedPnl: 30, rMultiple: 2.5 }),
];
const rmA = riskMetrics(A);
check("A netPnl via calcMetrics = 80", calcMetrics(A).netPnl === 80);
approx("A maxDrawdownUSD", rmA.maxDrawdownUSD, 100);
approx("A maxDrawdownPct", rmA.maxDrawdownPct, 200 / 3, 1e-6);
check("A maxWinStreak = 2", rmA.maxWinStreak === 2);
check("A currentWinStreak = 1", rmA.currentWinStreak === 1);
check("A maxLossStreak = 2 (breakeven does not break it)", rmA.maxLossStreak === 2);
check("A currentLossStreak = 0", rmA.currentLossStreak === 0);
approx("A avgR excludes null R", rmA.avgR, 0.64);
check("A tradesWithR = 5", rmA.tradesWithR === 5);
check("A rDistribution", JSON.stringify(rmA.rDistribution.map((b) => b.count)) === "[0,1,2,1,1]");
approx("A winLossRatio", rmA.winLossRatio, 1.2);
check("A tradingDays = 3", rmA.tradingDays === 3);
check("A losingDays = 1", rmA.losingDays === 1);
approx("A losingDayFrequency", rmA.losingDayFrequency, 100 / 3, 1e-6);
const srcRowsA = breakdown(A, "source");
check("A source breakdown has 1 row", srcRowsA.length === 1);
check("A source row netPnl = calcMetrics netPnl", srcRowsA[0].netPnl === calcMetrics(A).netPnl);
approx("A source winRate excludes breakeven (3/5 decided = 60%)", srcRowsA[0].winRate, 60);
check("A dailyPnl days", dailyPnl(A).length === 3 && dailyPnl(A)[0].pnl === 150 && dailyPnl(A)[1].pnl === -80 && dailyPnl(A)[2].pnl === 10);

/* ============ Set B: breakdowns, plan null separation, multi-tag ============
 * T1 +200 HOD, mistakes [Chased, Overtraded], emotions [FOMO], plan true
 * T2 −100 HOD, mistakes [Chased], emotions [FOMO, Impatience], plan false
 * T3 −50  EMA, no tags, plan null
 * T4 −20  setup null, mistakes [Held loser], emotions [Calm], plan false
 * Total net = +30
 */
const B: AnalyticsTrade[] = [
  T({ realizedPnl: 200, setupTag: "HOD breakout", mistakes: ["Chased price", "Overtraded"], emotionalTags: ["FOMO"], followedPlan: true, ticker: "AAA" }),
  T({ realizedPnl: -100, setupTag: "HOD breakout", mistakes: ["Chased price"], emotionalTags: ["FOMO", "Impatience"], followedPlan: false, ticker: "AAA" }),
  T({ realizedPnl: -50, setupTag: "EMA pullback", followedPlan: null, ticker: "BBB" }),
  T({ realizedPnl: -20, setupTag: null, mistakes: ["Held loser too long"], emotionalTags: ["Calm and disciplined"], followedPlan: false, ticker: "BBB" }),
];
check("B total net = 30", calcMetrics(B).netPnl === 30);
const setupB = breakdown(B, "setup");
const hodRow = setupB.find((r) => r.label === "HOD breakout")!;
check("B setup HOD count 2", hodRow.count === 2);
approx("B setup HOD netPnl", hodRow.netPnl, 100);
approx("B setup HOD expectancy", hodRow.expectancy, 50);
check("B setup rows sum to total net", setupB.reduce((s, r) => s + r.netPnl, 0) === 30);
check("B setup null → Not recorded row", setupB.some((r) => r.label === "Not recorded" && r.count === 1 && r.netPnl === -20));
const mistakeB = breakdown(B, "mistake");
check("B mistake multi-tag: Chased price counts both trades", mistakeB.find((r) => r.label === "Chased price")!.count === 2);
check("B mistake multi-tag: Overtraded counts T1 once", mistakeB.find((r) => r.label === "Overtraded")!.count === 1);
check("B mistake: untagged trade appears in no row", mistakeB.reduce((s, r) => s + r.count, 0) === 4); // 2+1+1 tag instances, T3 contributes 0
const planB = breakdown(B, "plan");
check("B plan rows ordered Followed/Not/Not recorded", planB.map((r) => r.label).join("|") === "Followed plan|Did not follow|Not recorded");
check("B plan null kept separate from false", planB.find((r) => r.label === "Not recorded")!.count === 1 && planB.find((r) => r.label === "Did not follow")!.count === 2);
check("B plan rows sum to total net", planB.reduce((s, r) => s + r.netPnl, 0) === 30);
const insB = edgeInsights(B);
check("B bestSetup = HOD breakout", insB.bestSetup.stat?.label === "HOD breakout");
check("B bestSetup smallSample flagged (n=2)", insB.bestSetup.smallSample === true && insB.bestSetup.sampleSize === 2);
check("B costliestMistake = Held loser too long", insB.costliestMistake.stat?.label === "Held loser too long" && insB.costliestMistake.stat?.netPnl === -20);
check("B worstEmotion = Impatience (−100)", insB.worstEmotion.stat?.label === "Impatience" && insB.worstEmotion.stat?.netPnl === -100);
check("B planAdherence followed net 200", insB.planAdherence.followed?.netPnl === 200);
check("B planAdherence notFollowed net −120, count 2", insB.planAdherence.notFollowed?.netPnl === -120 && insB.planAdherence.notFollowed?.count === 2);
check("B planAdherence notRecordedCount 1", insB.planAdherence.notRecordedCount === 1);

/* ============ Set C: zero losses → profit factor Infinity; no R → null ============ */
const C: AnalyticsTrade[] = [T({ realizedPnl: 10 }), T({ realizedPnl: 30 })];
const symC = breakdown(C, "symbol");
check("C profitFactor = Infinity with zero losses", symC[0].profitFactor === Infinity);
check("C avgR null when no R recorded", symC[0].avgR === null);
const rmC = riskMetrics(C);
check("C maxDrawdownUSD = 0", rmC.maxDrawdownUSD === 0);
check("C maxDrawdownPct null when no drawdown", rmC.maxDrawdownPct === null);
check("C riskMetrics avgR null, tradesWithR 0", rmC.avgR === null && rmC.tradesWithR === 0);
const insC = edgeInsights(C);
check("C bestSetup unavailable with reason (no tags)", insC.bestSetup.stat === null && typeof insC.bestSetup.reason === "string");

/* ============ Set D: ET session / time-of-day / hold buckets ============
 * January = EST (UTC−5), June = EDT (UTC−4). ISO instants are UTC.
 * D1 13:00Z Jan → 08:00 ET Premarket; exit 13:03Z → 3m hold → 1–5m
 * D2 13:00Z Jun → 09:00 ET Premarket (DST-aware)
 * D3 14:30Z Jan → 09:30 ET Regular/Open; exit 15:45Z → 75m → 1h+
 * D4 21:00Z Jan → 16:00 ET After hours
 * D5 no timestamps → Not recorded
 */
const D: AnalyticsTrade[] = [
  T({ entryTime: "2026-01-05T13:00:00.000Z", exitTime: "2026-01-05T13:03:00.000Z" }),
  T({ entryTime: "2026-06-01T13:00:00.000Z" }),
  T({ entryTime: "2026-01-05T14:30:00.000Z", exitTime: "2026-01-05T15:45:00.000Z" }),
  T({ entryTime: "2026-01-05T21:00:00.000Z" }),
  T({}),
];
check("D etMinutes D1 = 480", etMinutesOfDay(D[0].entryTime) === 480);
check("D etMinutes D2 = 540 (EDT)", etMinutesOfDay(D[1].entryTime) === 540);
check("D etMinutes D3 = 570", etMinutesOfDay(D[2].entryTime) === 570);
check("D etMinutes D4 = 960", etMinutesOfDay(D[3].entryTime) === 960);
check("D session buckets", sessionBucket(D[0]) === "Premarket" && sessionBucket(D[2]) === "Regular hours" && sessionBucket(D[4]) === "Not recorded");
check("D tod buckets", timeOfDayBucket(D[0]) === "Premarket" && timeOfDayBucket(D[2]) === "Open (9:30–10:30)" && timeOfDayBucket(D[3]) === "After hours");
check("D holdMinutes D1 = 3", holdMinutes(D[0]) === 3);
check("D hold buckets", holdBucket(D[0]) === "1–5m" && holdBucket(D[2]) === "1h+" && holdBucket(D[4]) === "Not recorded");
const holdD = breakdown(D, "hold");
check("D hold breakdown counts", holdD.find((r) => r.label === "1–5m")!.count === 1 && holdD.find((r) => r.label === "Not recorded")!.count === 3);

/* ============ Set E: trend windows ============
 * Latest date 2026-03-31. 30d current window 03-02..03-31: E1 +100.
 * Prior window 01-31..03-01: E2 −40. E3 (2025-12-01) is outside both.
 */
const E: AnalyticsTrade[] = [
  T({ tradeDate: "2026-03-15", realizedPnl: 100 }),
  T({ tradeDate: "2026-02-10", realizedPnl: -40 }),
  T({ tradeDate: "2025-12-01", realizedPnl: 999 }),
];
const insE = edgeInsights(E);
const t30 = insE.trends.find((w) => w.days === 30)!;
check("E 30d current {1, +100}", t30.current?.count === 1 && t30.current?.netPnl === 100);
check("E 30d prior {1, −40}", t30.prior?.count === 1 && t30.prior?.netPnl === -40);
approx("E 30d netPnlDelta", t30.netPnlDelta, 140);
approx("E 30d expectancyDelta", t30.expectancyDelta, 140);
const insShort = edgeInsights([T({ tradeDate: "2026-03-30", realizedPnl: 5 })]);
check("E insufficient history → prior null with reason", insShort.trends[0].prior === null && typeof insShort.trends[0].reason === "string");

/* ============ Set F: avgRiskPerTrade ============
 * F1 stop 9.5, entry 10, qty 100 → |10−9.5|×100 = 50 (initialRisk null)
 * F2 initialRisk 120 (no stop) → 120
 * F3 no stop, no initialRisk → excluded. Mean = 85 over 2 trades.
 */
const F: AnalyticsTrade[] = [
  T({ stopLoss: 9.5, entryPrice: 10, qty: 100 }),
  T({ initialRisk: 120 }),
  T({}),
];
const rmF = riskMetrics(F);
approx("F avgRiskPerTrade", rmF.avgRiskPerTrade, 85);
check("F tradesWithRisk = 2", rmF.tradesWithRisk === 2);

/* ============ Set G: stop-loss → R mapping (real trades) ============
 * calcRealTrade is the exact function the journal page runs on stored
 * journal_real_trades rows (stop_loss column → initialRisk → R). */
const fillsG: RealFill[] = [
  { id: "g1", side: "buy", qty: 100, price: 10, fees: 0, fill_time: "2026-10-09T14:00:00Z" },
  { id: "g2", side: "sell", qty: 100, price: 11, fees: 0, fill_time: "2026-10-09T15:00:00Z" },
];
const withStop = calcRealTrade(fillsG, "long", 9.5, null);
approx("G initialRisk with stop = 50", withStop.initialRisk, 50);
approx("G netRealized = 100", withStop.netRealized, 100);
approx("G rMultiple with stop = 2", withStop.rMultiple, 2);
const noStop = calcRealTrade(fillsG, "long", null, null);
check("G initialRisk null without stop", noStop.initialRisk === null);
check("G rMultiple null without stop (never invented)", noStop.rMultiple === null);

/* ============ Set H: simulator fills carry no stop (honest null R) ===
 * session_trades fills have no stop field at all, so grouped simulator
 * trades must keep rMultiple null rather than deriving one. */
const simFills: RawFill[] = [
  { id: "h1", session_id: "s1", side: "buy", qty: 100, price: 10, candle_index: 0, candle_time: "2026-10-09T13:30:00Z", realized_pnl: 0, created_at: "2026-10-09T13:30:00Z" },
  { id: "h2", session_id: "s1", side: "sell", qty: 100, price: 11, candle_index: 5, candle_time: "2026-10-09T13:35:00Z", realized_pnl: 100, created_at: "2026-10-09T13:35:00Z" },
];
const groupedH = groupFillsIntoTrades(simFills, { id: "s1", ticker: "VEEA", trade_date: "2026-10-09", source: "simulator" });
check("H one grouped sim trade", groupedH.length === 1);
check("H sim rMultiple is null (no stop stored on fills)", groupedH[0].rMultiple === null);
approx("H sim realizedPnl = 100", groupedH[0].realizedPnl, 100);

/* ============ Set I: imported real trade shape ======================
 * Broker-CSV imports carry fill timestamps but NO stop and NO Trade DNA
 * meta. Analytics must populate time buckets from the timestamps while
 * every annotation dimension honestly reports "Not recorded". */
const I: AnalyticsTrade[] = [
  T({ source: "real", tradeDate: "2026-10-09", realizedPnl: 25, entryTime: "2026-10-09T15:00:00Z", exitTime: "2026-10-09T15:20:00Z" }),
];
check("I plan breakdown = Not recorded", breakdown(I, "plan").length === 1 && breakdown(I, "plan")[0].label === "Not recorded");
check("I setup breakdown = Not recorded", breakdown(I, "setup").length === 1 && breakdown(I, "setup")[0].label === "Not recorded");
check("I hod breakdown = Not recorded", breakdown(I, "hodClass").length === 1 && breakdown(I, "hodClass")[0].label === "Not recorded");
check("I timeOfDay from fill_time = Morning", breakdown(I, "timeOfDay").length === 1 && breakdown(I, "timeOfDay")[0].label === "Morning (10:30–12:00)");
check("I session = Regular hours", breakdown(I, "session").length === 1 && breakdown(I, "session")[0].label === "Regular hours");
check("I tradesWithR = 0", riskMetrics(I).tradesWithR === 0);
check("I avgR null (not zero)", riskMetrics(I).avgR === null);
check("I bestSetup stat null when untagged", edgeInsights(I).bestSetup.stat === null);
check("I plan notRecordedCount = 1", edgeInsights(I).planAdherence.notRecordedCount === 1);

/* ============ Set J: trend delta uses UNROUNDED totals ===============
 * Reproduces the 2026-10-12 QA screenshot case: recent +$46.024, prior
 * +$4.786. Components display as +$46.02 / +$4.79 (naive difference
 * +$41.23), but the true delta 41.238 displays as +$41.24. The delta
 * MUST be computed from the unrounded sums — never "fixed" to match
 * subtraction of the rounded display values. */
const J: AnalyticsTrade[] = [
  T({ tradeDate: "2026-10-09", realizedPnl: 23.012 }),
  T({ tradeDate: "2026-10-10", realizedPnl: 23.012 }),
  T({ tradeDate: "2026-09-05", realizedPnl: 4.786 }),
];
const trendJ = edgeInsights(J).trends[0];
check("J window is 30d", trendJ.days === 30);
approx("J current netPnl unrounded", trendJ.current?.netPnl ?? null, 46.024);
approx("J prior netPnl unrounded", trendJ.prior?.netPnl ?? null, 4.786);
approx("J delta from unrounded sums", trendJ.netPnlDelta, 41.238);
check("J fmtPnl(current) = +$46.02", fmtPnl(trendJ.current!.netPnl) === "+$46.02");
check("J fmtPnl(prior) = +$4.79", fmtPnl(trendJ.prior!.netPnl) === "+$4.79");
check("J fmtPnl(delta) = +$41.24", fmtPnl(trendJ.netPnlDelta!) === "+$41.24");

/* ============ Set K: daily P&L aggregation + chart geometry =========
 * Regression for the 2026-10-13 production bug: with ONE trading day
 * the old geometry set bar width = chartWidth / dayCount, rendering a
 * single full-width solid slab. Aggregation itself was always correct. */
const aggK = dailyPnl([
  T({ tradeDate: "2026-10-09", realizedPnl: 5 }),
  T({ tradeDate: "2026-10-08", realizedPnl: 50 }),
  T({ tradeDate: "2026-10-08", realizedPnl: -20 }),
  T({ tradeDate: "2026-10-09", realizedPnl: -5 }),
]);
check("K aggregation: 2 days, sorted ascending", aggK.length === 2 && aggK[0].date === "2026-10-08" && aggK[1].date === "2026-10-09");
approx("K aggregation: same-day trades sum (50 − 20 = 30)", aggK[0].pnl, 30);
check("K aggregation: same-day count = 2", aggK[0].count === 2);
approx("K aggregation: zero-net day retained at 0", aggK[1].pnl, 0);
check("K aggregation: zero-net day count = 2", aggK[1].count === 2);

// Single day (the reported bug): one centered, width-capped bar.
const lay1 = dailyBarLayout([{ date: "2026-10-09", pnl: 2006.94, count: 3 }], 620, 150);
check("K single day: exactly one bar", lay1.bars.length === 1);
check("K single day: bar width capped at 48 (NOT ~618)", lay1.bars[0].w <= 48);
approx("K single day: bar centered (cx = 310)", lay1.bars[0].cx, 310);
approx("K single day: bar bottom sits on zero line", lay1.bars[0].y + lay1.bars[0].h, lay1.zeroY);

// Mixed signs + a zero day.
const lay3 = dailyBarLayout([
  { date: "2026-10-07", pnl: 100, count: 2 },
  { date: "2026-10-08", pnl: -50, count: 1 },
  { date: "2026-10-09", pnl: 0, count: 1 },
], 620, 150);
check("K mixed: signs classified", lay3.bars[0].sign === "pos" && lay3.bars[1].sign === "neg" && lay3.bars[2].sign === "zero");
approx("K mixed: positive bar rises to zero line", lay3.bars[0].y + lay3.bars[0].h, lay3.zeroY);
approx("K mixed: negative bar hangs from zero line", lay3.bars[1].y, lay3.zeroY);
approx("K mixed: negative height is half of max (50/100)", lay3.bars[1].h, lay3.bars[0].h / 2);
check("K mixed: zero day is a 2-unit tick straddling the line", lay3.bars[2].h === 2 && lay3.bars[2].y === lay3.zeroY - 1);
check("K mixed: visible gaps between bars", lay3.bars[1].x > lay3.bars[0].x + lay3.bars[0].w && lay3.bars[2].x > lay3.bars[1].x + lay3.bars[1].w);
check("K mixed: all bars inside the chart", lay3.bars.every((b) => b.x >= 0 && b.x + b.w <= 620));

// Many days: bars shrink with the slot and never touch.
const manyK = Array.from({ length: 40 }, (_, i) => ({ date: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, pnl: i % 2 === 0 ? 25 : -25, count: 1 }));
const lay40 = dailyBarLayout(manyK, 620, 150);
check("K 40 days: bar narrower than its slot", lay40.bars.every((b) => b.w < 620 / 40));
check("K 40 days: no overlapping bars", lay40.bars.every((b, i) => i === 0 || b.x >= lay40.bars[i - 1].x + lay40.bars[i - 1].w));

// Empty input: no bars, sane zero line.
const lay0 = dailyBarLayout([], 620, 150);
check("K empty: no bars", lay0.bars.length === 0);
approx("K empty: zeroY at plot middle (67)", lay0.zeroY, 67);

console.log(`journalAnalytics tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
