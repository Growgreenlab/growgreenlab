/**
 * journalAnalytics.test.ts — hand-computed fixtures for lib/journalAnalytics.
 * Run: npx tsx lib/journalAnalytics.test.ts
 * Every expected value below was calculated by hand from the fixture data.
 */
import {
  breakdown, riskMetrics, edgeInsights, dailyPnl,
  etMinutesOfDay, sessionBucket, timeOfDayBucket, holdBucket, holdMinutes,
  type AnalyticsTrade,
} from "./journalAnalytics";
import { calcMetrics } from "./journal";

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

console.log(`journalAnalytics tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
