/**
 * journalAnalytics.ts — Trade DNA analytics for the Trade Journal (Batch A).
 *
 * Pure, framework-free functions over an enriched, already-filtered list of
 * CLOSED trades. The journal page builds AnalyticsTrade rows by joining its
 * UnifiedTrade list with journal_trade_meta annotations and the underlying
 * simulator/real trade records, so every number here is computed from exactly
 * the same filtered set the Overview uses — breakdown net P&L always sums to
 * calcMetrics().netPnl for the same selection.
 *
 * Definitions (kept consistent across every function in this file):
 * - A trade is a WIN when realizedPnl > 0, a LOSS when < 0, BREAKEVEN when = 0.
 * - Win rate = wins / (wins + losses). BREAKEVEN TRADES ARE EXCLUDED from the
 *   win-rate denominator. NOTE: lib/journal.ts calcMetrics() instead divides
 *   by all closed trades (breakevens included) — the two win rates differ
 *   only when breakeven trades exist. Net P&L, expectancy (netPnl / count,
 *   count includes breakevens) and profit factor agree exactly with
 *   calcMetrics() either way.
 * - Profit factor = grossProfit / grossLoss; Infinity when there are winners
 *   and zero losers; null when there are no winners and no losers.
 * - avgR excludes trades whose rMultiple is null (unknown risk) — a missing R
 *   is never treated as 0R.
 * - Session / time-of-day are derived from the trade's entry timestamp
 *   interpreted in America/New_York. Timestamps are stored as ISO instants:
 *   simulator candle_time is the UTC instant of the Eastern market time, and
 *   broker fill_time is parsed from the broker export. The ET wall clock is
 *   recovered with Intl in the America/New_York zone, so DST is handled.
 *   Trades without an entry timestamp fall into a "Not recorded" bucket for
 *   the time-based dimensions — they are never guessed.
 */

export interface AnalyticsTrade {
  key: string;
  source: "simulator" | "real";
  ticker: string;
  /** YYYY-MM-DD as stored in the journal (date-string comparisons only). */
  tradeDate: string;
  direction: "long" | "short";
  entryPrice: number | null;
  exitPrice: number | null;
  qty: number;
  realizedPnl: number;
  rMultiple: number | null;
  isOpen: boolean;
  /* --- enrichment (annotations + underlying records) --- */
  setupTag: string | null;
  hodClass: string | null;
  followedPlan: boolean | null;
  emotionalTags: string[];
  mistakes: string[];
  /** ISO instant of the first entry fill, when known. */
  entryTime: string | null;
  /** ISO instant of the last exit fill, when known. */
  exitTime: string | null;
  stopLoss: number | null;
  /** |entry − stop| × qty in dollars, when known (real trades). */
  initialRisk: number | null;
}

export type BreakdownDimension =
  | "setup" | "hodClass" | "symbol" | "mistake" | "emotion" | "plan"
  | "source" | "session" | "timeOfDay" | "hold" | "side";

export interface BreakdownRow {
  key: string;
  label: string;
  /** Underlying trades (drill-down). For multi-tag dimensions a trade can
   *  appear in several rows; for single-value dimensions rows partition the
   *  input set exactly. */
  trades: AnalyticsTrade[];
  count: number;
  wins: number;
  losses: number;
  breakevens: number;
  /** wins / (wins + losses) — breakevens excluded; null when no W or L. */
  winRate: number | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** Mean of non-null rMultiple; null when no trade in the row has an R. */
  avgR: number | null;
  /** netPnl / count (count includes breakevens — matches calcMetrics). */
  expectancy: number | null;
  profitFactor: number | null;
  /** Mean holding time over trades with both entry and exit timestamps. */
  avgHoldMinutes: number | null;
}

/* ---------------- time helpers (America/New_York) ---------------- */

const etClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

/** Minutes after midnight ET for an ISO instant; null when unparseable. */
export function etMinutesOfDay(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = etClock.formatToParts(d);
  let hh = 0, mm = 0;
  for (const p of parts) {
    if (p.type === "hour") hh = Number(p.value) % 24; // "24" at midnight in some ICU versions
    if (p.type === "minute") mm = Number(p.value);
  }
  return hh * 60 + mm;
}

/** Holding time in minutes; null when either timestamp is missing/invalid. */
export function holdMinutes(t: AnalyticsTrade): number | null {
  if (!t.entryTime || !t.exitTime) return null;
  const a = new Date(t.entryTime).getTime();
  const b = new Date(t.exitTime).getTime();
  if (isNaN(a) || isNaN(b) || b < a) return null;
  return (b - a) / 60000;
}

const OPEN_MIN = 9 * 60 + 30; // 09:30 ET

export function sessionBucket(t: AnalyticsTrade): string {
  const m = etMinutesOfDay(t.entryTime);
  if (m == null) return "Not recorded";
  return m < OPEN_MIN ? "Premarket" : "Regular hours";
}

export function timeOfDayBucket(t: AnalyticsTrade): string {
  const m = etMinutesOfDay(t.entryTime);
  if (m == null) return "Not recorded";
  if (m < OPEN_MIN) return "Premarket";
  if (m < 10 * 60 + 30) return "Open (9:30–10:30)";
  if (m < 12 * 60) return "Morning (10:30–12:00)";
  if (m < 14 * 60) return "Midday (12:00–14:00)";
  if (m < 16 * 60) return "Afternoon (14:00–16:00)";
  return "After hours";
}

export function holdBucket(t: AnalyticsTrade): string {
  const h = holdMinutes(t);
  if (h == null) return "Not recorded";
  if (h < 1) return "<1m";
  if (h < 5) return "1–5m";
  if (h < 15) return "5–15m";
  if (h < 60) return "15–60m";
  return "1h+";
}

/* ---------------- breakdown ---------------- */

const ORDINAL_ORDER: Partial<Record<BreakdownDimension, string[]>> = {
  plan: ["Followed plan", "Did not follow", "Not recorded"],
  session: ["Premarket", "Regular hours", "Not recorded"],
  timeOfDay: ["Premarket", "Open (9:30–10:30)", "Morning (10:30–12:00)", "Midday (12:00–14:00)", "Afternoon (14:00–16:00)", "After hours", "Not recorded"],
  hold: ["<1m", "1–5m", "5–15m", "15–60m", "1h+", "Not recorded"],
  side: ["Long", "Short"],
  source: ["Simulator", "Real Market"],
};

/** Bucket labels for a trade under a dimension. Multi-tag dimensions
 *  (mistake, emotion) return one label per tag — the trade is counted under
 *  EACH of its tags; a trade with no tags appears in no row. All other
 *  dimensions return exactly one label (missing data → "Not recorded"). */
function bucketLabels(t: AnalyticsTrade, dim: BreakdownDimension): string[] {
  switch (dim) {
    case "setup": return [t.setupTag ?? "Not recorded"];
    case "hodClass": return [t.hodClass ? t.hodClass[0].toUpperCase() + t.hodClass.slice(1) : "Not recorded"];
    case "symbol": return [t.ticker];
    case "mistake": return [...t.mistakes];
    case "emotion": return [...t.emotionalTags];
    case "plan": return [t.followedPlan == null ? "Not recorded" : t.followedPlan ? "Followed plan" : "Did not follow"];
    case "source": return [t.source === "real" ? "Real Market" : "Simulator"];
    case "session": return [sessionBucket(t)];
    case "timeOfDay": return [timeOfDayBucket(t)];
    case "hold": return [holdBucket(t)];
    case "side": return [t.direction === "long" ? "Long" : "Short"];
  }
}

function summarize(label: string, rows: AnalyticsTrade[]): BreakdownRow {
  const winners = rows.filter((t) => t.realizedPnl > 0);
  const losers = rows.filter((t) => t.realizedPnl < 0);
  const breakevens = rows.length - winners.length - losers.length;
  const grossProfit = winners.reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.realizedPnl, 0));
  const netPnl = grossProfit - grossLoss;
  const rs = rows.map((t) => t.rMultiple).filter((r): r is number => r != null && isFinite(r));
  const holds = rows.map(holdMinutes).filter((h): h is number => h != null);
  const decided = winners.length + losers.length;
  return {
    key: label,
    label,
    trades: rows,
    count: rows.length,
    wins: winners.length,
    losses: losers.length,
    breakevens,
    winRate: decided > 0 ? (winners.length / decided) * 100 : null,
    netPnl,
    grossProfit,
    grossLoss,
    avgWin: winners.length > 0 ? grossProfit / winners.length : null,
    avgLoss: losers.length > 0 ? -(grossLoss / losers.length) : null,
    avgR: rs.length > 0 ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
    expectancy: rows.length > 0 ? netPnl / rows.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    avgHoldMinutes: holds.length > 0 ? holds.reduce((s, h) => s + h, 0) / holds.length : null,
  };
}

export function breakdown(trades: AnalyticsTrade[], dim: BreakdownDimension): BreakdownRow[] {
  const map = new Map<string, AnalyticsTrade[]>();
  for (const t of trades) {
    for (const label of bucketLabels(t, dim)) {
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(t);
    }
  }
  const rows = [...map.entries()].map(([label, rows]) => summarize(label, rows));
  const order = ORDINAL_ORDER[dim];
  if (order) {
    rows.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  } else {
    rows.sort((a, b) => b.netPnl - a.netPnl || b.count - a.count);
  }
  return rows;
}

/* ---------------- risk & consistency ---------------- */

export interface RiskMetrics {
  totalTrades: number;
  /** Largest peak-to-trough decline of the chronological cumulative
   *  realized P&L curve, in dollars. */
  maxDrawdownUSD: number;
  /** maxDrawdownUSD ÷ the cumulative P&L peak that preceded the trough,
   *  as a percentage. The journal has no account-equity baseline, so this
   *  is relative to the peak cumulative realized P&L value (NOT account
   *  equity). Null when that peak was ≤ 0 (percentage is meaningless). */
  maxDrawdownPct: number | null;
  currentWinStreak: number;
  maxWinStreak: number;
  currentLossStreak: number;
  maxLossStreak: number;
  /** Mean of non-null rMultiple; null when no trade has an R. */
  avgR: number | null;
  tradesWithR: number;
  /** Counts per R bucket: [<−1, −1..0, 0..1, 1..2, >2]. Boundaries are
   *  lower-inclusive: −1 ≤ r < 0, 0 ≤ r < 1, 1 ≤ r < 2, r ≥ 2. */
  rDistribution: { label: string; count: number }[];
  /** Mean initial risk $ over trades where risk is known
   *  (initialRisk, else |entry − stop| × qty). Null when none are known. */
  avgRiskPerTrade: number | null;
  tradesWithRisk: number;
  /** avgWin / |avgLoss|; null when either side is missing. */
  winLossRatio: number | null;
  tradingDays: number;
  losingDays: number;
  /** losingDays / tradingDays as a percentage; null when no trades. */
  losingDayFrequency: number | null;
}

/** Chronological order for equity-curve math: tradeDate, then entry time. */
function chronological(trades: AnalyticsTrade[]): AnalyticsTrade[] {
  return [...trades].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate) ||
    (a.entryTime ?? "").localeCompare(b.entryTime ?? "") ||
    a.key.localeCompare(b.key)
  );
}

export function riskPerTrade(t: AnalyticsTrade): number | null {
  if (t.initialRisk != null && t.initialRisk > 0) return t.initialRisk;
  if (t.stopLoss != null && t.entryPrice != null && t.qty > 0) {
    const r = Math.abs(t.entryPrice - t.stopLoss) * t.qty;
    return r > 0 ? r : null;
  }
  return null;
}

export function riskMetrics(trades: AnalyticsTrade[]): RiskMetrics {
  const sorted = chronological(trades);

  // Drawdown on the cumulative realized P&L curve.
  let cum = 0, peak = 0, maxDd = 0, peakAtMaxDd = 0;
  for (const t of sorted) {
    cum += t.realizedPnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) { maxDd = dd; peakAtMaxDd = peak; }
  }
  const maxDrawdownPct = maxDd > 0 && peakAtMaxDd > 0 ? (maxDd / peakAtMaxDd) * 100 : null;

  // Streaks. A breakeven trade neither extends nor breaks a streak:
  // it is skipped entirely, so a streak runs through breakevens.
  let curW = 0, curL = 0, maxW = 0, maxL = 0;
  for (const t of sorted) {
    if (t.realizedPnl > 0) { curW++; curL = 0; if (curW > maxW) maxW = curW; }
    else if (t.realizedPnl < 0) { curL++; curW = 0; if (curL > maxL) maxL = curL; }
    // breakeven: no change
  }

  const rs = trades.map((t) => t.rMultiple).filter((r): r is number => r != null && isFinite(r));
  const rBuckets: { label: string; test: (r: number) => boolean }[] = [
    { label: "<−1R", test: (r) => r < -1 },
    { label: "−1R to 0", test: (r) => r >= -1 && r < 0 },
    { label: "0 to 1R", test: (r) => r >= 0 && r < 1 },
    { label: "1R to 2R", test: (r) => r >= 1 && r < 2 },
    { label: ">2R", test: (r) => r >= 2 },
  ];
  const rDistribution = rBuckets.map((b) => ({ label: b.label, count: rs.filter(b.test).length }));

  const risks = trades.map(riskPerTrade).filter((r): r is number => r != null);

  const winners = trades.filter((t) => t.realizedPnl > 0);
  const losers = trades.filter((t) => t.realizedPnl < 0);
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.realizedPnl, 0) / winners.length : null;
  const avgLossAbs = losers.length > 0 ? Math.abs(losers.reduce((s, t) => s + t.realizedPnl, 0)) / losers.length : null;

  const byDayMap = new Map<string, number>();
  for (const t of trades) byDayMap.set(t.tradeDate, (byDayMap.get(t.tradeDate) ?? 0) + t.realizedPnl);
  const dayPnls = [...byDayMap.values()];
  const losingDays = dayPnls.filter((p) => p < 0).length;

  return {
    totalTrades: trades.length,
    maxDrawdownUSD: maxDd,
    maxDrawdownPct,
    currentWinStreak: curW,
    maxWinStreak: maxW,
    currentLossStreak: curL,
    maxLossStreak: maxL,
    avgR: rs.length > 0 ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
    tradesWithR: rs.length,
    rDistribution,
    avgRiskPerTrade: risks.length > 0 ? risks.reduce((s, r) => s + r, 0) / risks.length : null,
    tradesWithRisk: risks.length,
    winLossRatio: avgWin != null && avgLossAbs != null && avgLossAbs > 0 ? avgWin / avgLossAbs : null,
    tradingDays: dayPnls.length,
    losingDays,
    losingDayFrequency: dayPnls.length > 0 ? (losingDays / dayPnls.length) * 100 : null,
  };
}

/** Daily realized P&L, chronological — input for the daily bars chart. */
export function dailyPnl(trades: AnalyticsTrade[]): { date: string; pnl: number; count: number }[] {
  const map = new Map<string, { pnl: number; count: number }>();
  for (const t of trades) {
    const e = map.get(t.tradeDate) ?? { pnl: 0, count: 0 };
    e.pnl += t.realizedPnl;
    e.count++;
    map.set(t.tradeDate, e);
  }
  return [...map.entries()]
    .map(([date, v]) => ({ date, pnl: v.pnl, count: v.count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------------- edge finder ---------------- */

export interface InsightStat {
  label: string;
  count: number;
  netPnl: number;
  expectancy: number | null;
  avgR: number | null;
  winRate: number | null;
}

export interface Insight {
  stat: InsightStat | null;
  /** Number of trades backing this insight. */
  sampleSize: number;
  /** True when sampleSize < 10 — interpret with care, never a verdict. */
  smallSample: boolean;
  /** Why the insight is unavailable, when stat is null. */
  reason: string | null;
}

export interface TrendWindow {
  days: number;
  current: { count: number; netPnl: number; expectancy: number | null } | null;
  prior: { count: number; netPnl: number; expectancy: number | null } | null;
  netPnlDelta: number | null;
  expectancyDelta: number | null;
  reason: string | null;
}

export interface EdgeInsights {
  totalTrades: number;
  bestSetup: Insight;
  bestHodClass: Insight;
  costliestMistake: Insight;
  worstEmotion: Insight;
  bestTimeWindow: Insight;
  planAdherence: {
    followed: InsightStat | null;
    notFollowed: InsightStat | null;
    notRecordedCount: number;
  };
  trends: TrendWindow[];
}

const SMALL_SAMPLE = 10;
const HOD_SETUP_TAGS = ["Clean breakout", "Weak breakout", "Failed breakout", "Anticipation"];

function toStat(r: BreakdownRow): InsightStat {
  return { label: r.label, count: r.count, netPnl: r.netPnl, expectancy: r.expectancy, avgR: r.avgR, winRate: r.winRate };
}

function pickInsight(rows: BreakdownRow[], mode: "maxExpectancy" | "minNetPnl", emptyReason: string): Insight {
  const usable = rows.filter((r) => r.count > 0);
  if (usable.length === 0) return { stat: null, sampleSize: 0, smallSample: true, reason: emptyReason };
  const best = usable.reduce((acc, r) => {
    if (mode === "maxExpectancy") {
      const a = acc.expectancy ?? -Infinity, b = r.expectancy ?? -Infinity;
      return b > a || (b === a && r.count > acc.count) ? r : acc;
    }
    return r.netPnl < acc.netPnl || (r.netPnl === acc.netPnl && r.count > acc.count) ? r : acc;
  });
  return { stat: toStat(best), sampleSize: best.count, smallSample: best.count < SMALL_SAMPLE, reason: null };
}

function shiftDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return dt.toISOString().slice(0, 10);
}

function windowStats(ts: AnalyticsTrade[]): { count: number; netPnl: number; expectancy: number | null } {
  const netPnl = ts.reduce((s, t) => s + t.realizedPnl, 0);
  return { count: ts.length, netPnl, expectancy: ts.length > 0 ? netPnl / ts.length : null };
}

function trendWindow(trades: AnalyticsTrade[], days: number): TrendWindow {
  if (trades.length === 0) {
    return { days, current: null, prior: null, netPnlDelta: null, expectancyDelta: null, reason: "No trades in the current selection." };
  }
  // Windows are anchored to the most recent trade date in the selection
  // (deterministic; not to "today", which would drift for historical data).
  const end = trades.reduce((max, t) => (t.tradeDate > max ? t.tradeDate : max), trades[0].tradeDate);
  const curStart = shiftDateStr(end, -(days - 1));
  const priorStart = shiftDateStr(end, -(2 * days - 1));
  const priorEnd = shiftDateStr(end, -days);
  const current = windowStats(trades.filter((t) => t.tradeDate >= curStart && t.tradeDate <= end));
  const priorTrades = trades.filter((t) => t.tradeDate >= priorStart && t.tradeDate <= priorEnd);
  if (priorTrades.length === 0) {
    return {
      days, current, prior: null, netPnlDelta: null, expectancyDelta: null,
      reason: `No trades in the prior ${days}-day window to compare against.`,
    };
  }
  const prior = windowStats(priorTrades);
  return {
    days,
    current,
    prior,
    netPnlDelta: current.netPnl - prior.netPnl,
    expectancyDelta: current.expectancy != null && prior.expectancy != null ? current.expectancy - prior.expectancy : null,
    reason: null,
  };
}

export function edgeInsights(trades: AnalyticsTrade[]): EdgeInsights {
  const setupRows = breakdown(trades, "setup");
  const bestSetup = pickInsight(
    setupRows.filter((r) => r.label !== "Not recorded"),
    "maxExpectancy",
    "No trades have a setup tag yet — tag trades in Trade Review."
  );

  // HOD classification: prefer the dedicated hod_class annotation; fall
  // back to the HOD setup tags (Clean/Weak/Failed/Anticipation) when no
  // trade carries a hod_class.
  const hodRows = breakdown(trades, "hodClass").filter((r) => r.label !== "Not recorded");
  let bestHodClass: Insight;
  if (hodRows.length > 0) {
    bestHodClass = pickInsight(hodRows, "maxExpectancy", "No HOD classifications recorded.");
  } else {
    bestHodClass = pickInsight(
      setupRows.filter((r) => HOD_SETUP_TAGS.includes(r.label)),
      "maxExpectancy",
      "No HOD classifications recorded yet — set HOD Class or a breakout setup tag in Trade Review."
    );
  }

  const costliestMistake = pickInsight(
    breakdown(trades, "mistake"),
    "minNetPnl",
    "No mistake tags recorded yet — tag mistakes in Trade Review."
  );
  const worstEmotion = pickInsight(
    breakdown(trades, "emotion"),
    "minNetPnl",
    "No emotion tags recorded yet — tag emotional state in Trade Review."
  );
  const bestTimeWindow = pickInsight(
    breakdown(trades, "timeOfDay").filter((r) => r.label !== "Not recorded"),
    "maxExpectancy",
    "Entry timestamps are not available for these trades."
  );

  const planRows = breakdown(trades, "plan");
  const planRow = (label: string) => planRows.find((r) => r.label === label) ?? null;
  const followedRow = planRow("Followed plan");
  const notFollowedRow = planRow("Did not follow");
  const notRecordedRow = planRow("Not recorded");

  return {
    totalTrades: trades.length,
    bestSetup,
    bestHodClass,
    costliestMistake,
    worstEmotion,
    bestTimeWindow,
    planAdherence: {
      followed: followedRow ? toStat(followedRow) : null,
      notFollowed: notFollowedRow ? toStat(notFollowedRow) : null,
      notRecordedCount: notRecordedRow ? notRecordedRow.count : 0,
    },
    trends: [30, 60, 90].map((d) => trendWindow(trades, d)),
  };
}
