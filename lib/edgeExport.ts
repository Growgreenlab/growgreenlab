/**
 * edgeExport.ts — AI Edge Analysis Export: pure data layer.
 *
 * Builds ONE validated snapshot of the trader's journal data (filtered by
 * an explicit date range + trade source) and derives every export artifact
 * from it: trades.csv, analytics.json, the ChatGPT prompt and the README.
 * All performance math is REUSED from lib/journalAnalytics.ts (breakdown,
 * riskMetrics, dailyPnl, edgeInsights) and lib/journal.ts (calcMetrics,
 * perExitPnl, parseKeyLevels) — this module adds selection, identity,
 * serialization and honesty flags, never a second set of formulas.
 *
 * Honesty rules (Phase 1 plan §3):
 * - Missing data is exported as EMPTY (CSV) / null (JSON) and listed in
 *   metricsUnavailable — never substituted with 0, never invented.
 * - MAE/MFE, slippage, simulator original plans, per-trade Psychology
 *   Guard events and real-trade order types are NOT recorded by the
 *   platform and are flagged unavailable.
 * - JSON never contains Infinity/NaN: non-finite numbers serialize to
 *   null with a sibling "<field>Unbounded": true marker (profit factor
 *   with winners and zero losers is the known case).
 *
 * Trade identity: the journal's existing trade keys are stable —
 * real trades `real:<journal_real_trades.id>`, simulator trades
 * `<replay_sessions.id>:<sequence>`. Export IDs derive deterministically:
 * `TRADE-<uuid>` / `TRADE-<sessionUuid>-<seq>`.
 */
import {
  breakdown, riskMetrics, dailyPnl, edgeInsights, holdMinutes,
  type AnalyticsTrade, type BreakdownDimension,
} from "./journalAnalytics";
import {
  calcMetrics, perExitPnl, parseKeyLevels,
  type KeyLevel, type PlanChange, type RawFill, type RealFill, type RealTradeCalc,
} from "./journal";

export const EDGE_EXPORT_SCHEMA_VERSION = "1.0";

/* ================= inputs (structural mirrors of the journal page) ====== */

export interface ExportUnifiedInput {
  key: string;
  source: "simulator" | "real";
  ticker: string;
  tradeDate: string;
  direction: "long" | "short";
  entryPrice: number | null;
  exitPrice: number | null;
  qty: number;
  realizedPnl: number;
  isOpen: boolean;
  rMultiple: number | null;
}

export interface ExportMetaInput {
  trade_key: string;
  setup_tag: string | null;
  hod_class: string | null;
  exec_grade: string | null;
  entry_reasoning: string | null;
  exit_reasoning: string | null;
  followed_plan: boolean | null;
  confidence: number | null;
  emotional_tags: string[];
  mistakes: string[];
  notes: string | null;
  lessons: string | null;
  would_take_again: boolean | null;
  key_levels: KeyLevel[] | null;
  original_stop_loss: number | null;
  original_target: number | null;
  plan_history: PlanChange[] | null;
}

export interface ExportRealTradeInput {
  id: string;
  ticker: string;
  trade_date: string;
  direction: "long" | "short";
  strategy: string | null;
  status: "open" | "closed";
  stop_loss: number | null;
  target: number | null;
  float_shares: number | null;
  relative_volume: number | null;
  market_conditions: string | null;
  fills: RealFill[];
  calc: RealTradeCalc;
}

export interface ExportSimTradeInput {
  tradeKey: string;
  ticker: string;
  tradeDate: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  entryTime: string | null;
  exitTime: string | null;
  realizedPnl: number;
  rMultiple: number | null;
  fills: RawFill[];
}

export interface ExportSnapshotInput {
  unified: ExportUnifiedInput[];
  metas: Record<string, ExportMetaInput>;
  realTrades: ExportRealTradeInput[];
  simTrades: ExportSimTradeInput[];
}

/* ================= period selection & date ranges ======================= */

export type ExportPeriodMode = "daily" | "weekly" | "monthly" | "custom";
export type ExportSource = "real" | "simulator" | "all";

export interface ExportPeriodSelection {
  mode: ExportPeriodMode;
  /** YYYY-MM-DD anchor date for daily/weekly/monthly. */
  anchorDate: string;
  customStart?: string;
  customEnd?: string;
}

export interface ExportDateRange {
  /** Inclusive YYYY-MM-DD bounds, compared as date strings (the journal's
   *  own convention — no timezone shifting of trade dates). */
  start: string;
  end: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

/** Local today as YYYY-MM-DD (browser-local, matching the journal UI). */
export function todayLocalStr(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Resolve a period selection to an inclusive date range.
 * - daily:   the anchor date itself.
 * - weekly:  the Sunday-Saturday week containing the anchor (the journal
 *            UI's Week convention starts on Sunday).
 * - monthly: the calendar month containing the anchor.
 * - custom:  explicit inclusive start/end.
 * Throws a human-readable Error on invalid input — callers surface it.
 */
export function resolveExportRange(sel: ExportPeriodSelection): ExportDateRange {
  if (sel.mode === "custom") {
    const start = sel.customStart ?? "";
    const end = sel.customEnd ?? "";
    if (!isValidDateStr(start)) throw new Error("Custom range: pick a valid start date.");
    if (!isValidDateStr(end)) throw new Error("Custom range: pick a valid end date.");
    if (start > end) throw new Error("Custom range: the start date must be on or before the end date.");
    return { start, end };
  }
  const anchor = sel.anchorDate ?? "";
  if (!isValidDateStr(anchor)) throw new Error("Pick a valid date for the export period.");
  switch (sel.mode) {
    case "daily":
      return { start: anchor, end: anchor };
    case "weekly": {
      const start = addDays(anchor, -dayOfWeek(anchor));
      return { start, end: addDays(start, 6) };
    }
    case "monthly": {
      const [y, m] = anchor.split("-").map(Number);
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      return { start, end };
    }
  }
}

export function periodModeLabel(mode: ExportPeriodMode): string {
  return mode === "daily" ? "Daily" : mode === "weekly" ? "Weekly (Sunday-Saturday)" : mode === "monthly" ? "Monthly" : "Custom range";
}

export function sourceLabel(source: ExportSource): string {
  return source === "real" ? "Real Market" : source === "simulator" ? "Simulator" : "All Trades (Real Market + Simulator)";
}

export function formatRangeText(range: ExportDateRange, mode: ExportPeriodMode): string {
  return `${periodModeLabel(mode)}: ${range.start} to ${range.end} (inclusive)`;
}

/* ================= stable export IDs ==================================== */

/** Deterministic export ID from the journal's stable trade key. */
export function exportIdForTradeKey(tradeKey: string): string {
  if (tradeKey.startsWith("real:")) return `TRADE-${tradeKey.slice("real:".length)}`;
  const idx = tradeKey.lastIndexOf(":");
  if (idx > 0) return `TRADE-${tradeKey.slice(0, idx)}-${tradeKey.slice(idx + 1)}`;
  return `TRADE-${tradeKey}`;
}

/* ================= snapshot ============================================= */

export interface ExportFillDetail {
  qty: number;
  price: number;
  time: string | null;
  /** Gross realized P&L of this exit fill (FIFO) — exits only; null when
   *  the exit matched no entry (or for entry fills). */
  grossPnl: number | null;
}

export interface ExportTradeRecord {
  exportId: string;
  tradeKey: string;
  source: "real" | "simulator";
  symbol: string;
  tradeDate: string;
  direction: "long" | "short";
  status: "open" | "closed";
  entryTime: string | null;
  exitTime: string | null;
  /** Meta setup tag, falling back to the real trade's recorded strategy. */
  setup: string | null;
  strategy: string | null;
  avgEntry: number | null;
  avgExit: number | null;
  entryQty: number;
  entries: ExportFillDetail[];
  exits: ExportFillDetail[];
  /** Current recorded stop/target (real trades only). */
  stopLoss: number | null;
  target: number | null;
  /** Original planned stop/target — set-once plan preservation (real
   *  trades with a recorded plan; null when never recorded). */
  originalStopLoss: number | null;
  originalTarget: number | null;
  planHistory: PlanChange[];
  /** Total recorded fees. Real trades: sum of fill fees (recorded).
   *  Simulator: null — the simulator has no fee model (unknown, not 0). */
  fees: number | null;
  /** Gross realized P&L before fees (real trades). Simulator: null —
   *  the engine reports one P&L figure with no fee split. */
  grossRealized: number | null;
  /** Net realized P&L (after fees where fees exist). */
  realizedPnl: number;
  initialRisk: number | null;
  rMultiple: number | null;
  riskBasis: string;
  keyLevels: KeyLevel[];
  floatShares: number | null;
  relativeVolume: number | null;
  marketConditions: string | null;
  /* Trade DNA annotations (meta), nulls when never recorded */
  hodClass: string | null;
  execGrade: string | null;
  followedPlan: boolean | null;
  confidence: number | null;
  emotionalTags: string[];
  mistakes: string[];
  entryReasoning: string | null;
  exitReasoning: string | null;
  notes: string | null;
  lessons: string | null;
  wouldTakeAgain: boolean | null;
}

export interface ExportSnapshot {
  schemaVersion: string;
  generatedAt: string; // ISO instant
  periodMode: ExportPeriodMode;
  range: ExportDateRange;
  source: ExportSource;
  /** All selected trades (open + closed), deterministic order:
   *  tradeDate ascending, then exportId. */
  trades: ExportTradeRecord[];
  closedTrades: ExportTradeRecord[];
  openTrades: ExportTradeRecord[];
  /** Closed trades in the AnalyticsTrade shape — built with the exact
   *  join the journal page uses, so lib/journalAnalytics functions see
   *  identical inputs and exported metrics equal the Analytics UI. */
  analyticsTrades: AnalyticsTrade[];
  counts: {
    total: number; closed: number; open: number;
    real: number; simulator: number;
    wins: number; losses: number; breakevens: number;
  };
  warnings: string[];
}

function metaFields(meta: ExportMetaInput | undefined) {
  return {
    hodClass: meta?.hod_class ?? null,
    execGrade: meta?.exec_grade ?? null,
    followedPlan: meta?.followed_plan ?? null,
    confidence: meta?.confidence ?? null,
    emotionalTags: meta?.emotional_tags ?? [],
    mistakes: meta?.mistakes ?? [],
    entryReasoning: meta?.entry_reasoning ?? null,
    exitReasoning: meta?.exit_reasoning ?? null,
    notes: meta?.notes ?? null,
    lessons: meta?.lessons ?? null,
    wouldTakeAgain: meta?.would_take_again ?? null,
    keyLevels: parseKeyLevels(meta?.key_levels),
  };
}

export function buildExportSnapshot(
  input: ExportSnapshotInput,
  selection: { range: ExportDateRange; mode: ExportPeriodMode; source: ExportSource },
  generatedAt: Date = new Date(),
): ExportSnapshot {
  const { range, mode, source } = selection;
  const realByKey = new Map(input.realTrades.map((t) => [`real:${t.id}`, t]));
  const simByKey = new Map(input.simTrades.map((t) => [t.tradeKey, t]));

  // Source + range filter over the unified list, deduped by trade key:
  // in "All" a trade appears exactly once (its key is unique per source).
  const seen = new Set<string>();
  const selected: ExportUnifiedInput[] = [];
  for (const t of input.unified) {
    if (source !== "all" && t.source !== source) continue;
    if (t.tradeDate < range.start || t.tradeDate > range.end) continue;
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    selected.push(t);
  }

  const records: ExportTradeRecord[] = [];
  const analyticsTrades: AnalyticsTrade[] = [];

  for (const t of selected) {
    const meta = input.metas[t.key];
    const mf = metaFields(meta);
    let rec: ExportTradeRecord;
    let initialRisk: number | null = null;
    let stopForAnalytics: number | null = null;

    if (t.source === "real") {
      const rt = realByKey.get(t.key);
      const fills = rt?.fills ?? [];
      const isEntry = (f: RealFill) => (t.direction === "long" ? f.side === "buy" : f.side === "sell");
      const exitPnlById = new Map(perExitPnl(fills, t.direction).map((e) => [e.fillId, e.grossPnl]));
      const entries: ExportFillDetail[] = fills.filter(isEntry).map((f) => ({ qty: Number(f.qty), price: Number(f.price), time: f.fill_time, grossPnl: null }));
      const exits: ExportFillDetail[] = fills.filter((f) => !isEntry(f)).map((f) => ({
        qty: Number(f.qty), price: Number(f.price), time: f.fill_time,
        grossPnl: exitPnlById.get(f.id) ?? null,
      }));
      initialRisk = rt?.calc.initialRisk ?? null;
      stopForAnalytics = rt?.stop_loss ?? null;
      const hasOriginal = meta?.original_stop_loss != null;
      rec = {
        exportId: exportIdForTradeKey(t.key),
        tradeKey: t.key,
        source: "real",
        symbol: t.ticker,
        tradeDate: t.tradeDate,
        direction: t.direction,
        status: rt ? (rt.calc.isClosed ? "closed" : "open") : (t.isOpen ? "open" : "closed"),
        entryTime: entries.length > 0 ? entries[0].time : null,
        exitTime: exits.length > 0 ? exits[exits.length - 1].time : null,
        setup: meta?.setup_tag ?? rt?.strategy ?? null,
        strategy: rt?.strategy ?? null,
        avgEntry: rt?.calc.avgEntry ?? t.entryPrice,
        avgExit: rt?.calc.avgExit ?? null,
        entryQty: rt?.calc.entryQty ?? t.qty,
        entries, exits,
        stopLoss: rt?.stop_loss ?? null,
        target: rt?.target ?? null,
        originalStopLoss: meta?.original_stop_loss ?? null,
        originalTarget: meta?.original_target ?? null,
        planHistory: Array.isArray(meta?.plan_history) ? meta!.plan_history! : [],
        fees: rt ? rt.calc.totalFees : null,
        grossRealized: rt ? rt.calc.grossRealized : null,
        realizedPnl: t.realizedPnl,
        initialRisk,
        rMultiple: t.rMultiple,
        riskBasis: initialRisk != null
          ? hasOriginal
            ? "Initial risk = |average entry - ORIGINAL planned stop| x entry quantity; R = net realized P&L / initial risk."
            : "Initial risk = |average entry - recorded stop| x entry quantity (no separate original plan recorded); R = net realized P&L / initial risk."
          : "Unavailable - no recorded stop loss for this trade.",
        floatShares: rt?.float_shares ?? null,
        relativeVolume: rt?.relative_volume ?? null,
        marketConditions: rt?.market_conditions ?? null,
        ...mf,
      };
    } else {
      const g = simByKey.get(t.key);
      const fills = g?.fills ?? [];
      const isEntry = (f: RawFill) => (t.direction === "long" ? f.side === "buy" : f.side === "sell");
      const entries: ExportFillDetail[] = fills.filter(isEntry).map((f) => ({ qty: Number(f.qty), price: Number(f.price), time: f.candle_time, grossPnl: null }));
      const exits: ExportFillDetail[] = fills.filter((f) => !isEntry(f)).map((f) => ({
        qty: Number(f.qty), price: Number(f.price), time: f.candle_time,
        grossPnl: Number(f.realized_pnl || 0),
      }));
      rec = {
        exportId: exportIdForTradeKey(t.key),
        tradeKey: t.key,
        source: "simulator",
        symbol: t.ticker,
        tradeDate: t.tradeDate,
        direction: t.direction,
        status: "closed", // grouped simulator trades are closed position cycles
        entryTime: g?.entryTime ?? (entries.length > 0 ? entries[0].time : null),
        exitTime: g?.exitTime ?? (exits.length > 0 ? exits[exits.length - 1].time : null),
        setup: meta?.setup_tag ?? null,
        strategy: null,
        avgEntry: g?.entryPrice ?? t.entryPrice,
        avgExit: g?.exitPrice ?? t.exitPrice,
        entryQty: entries.reduce((s, e) => s + e.qty, 0) || t.qty,
        entries, exits,
        stopLoss: null,
        target: null,
        originalStopLoss: null,
        originalTarget: null,
        planHistory: [],
        fees: null,
        grossRealized: null,
        realizedPnl: t.realizedPnl,
        initialRisk: null,
        rMultiple: t.rMultiple,
        riskBasis: "Unavailable - simulator trades do not record a stop loss, so R cannot be calculated.",
        floatShares: null,
        relativeVolume: null,
        marketConditions: null,
        ...mf,
      };
    }
    records.push(rec);

    if (rec.status === "closed") {
      analyticsTrades.push({
        key: t.key, source: t.source, ticker: t.ticker, tradeDate: t.tradeDate,
        direction: t.direction, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
        qty: t.qty, realizedPnl: t.realizedPnl, rMultiple: t.rMultiple, isOpen: false,
        setupTag: meta?.setup_tag ?? null,
        hodClass: meta?.hod_class ?? null,
        followedPlan: meta?.followed_plan ?? null,
        emotionalTags: meta?.emotional_tags ?? [],
        mistakes: meta?.mistakes ?? [],
        entryTime: rec.entryTime, exitTime: rec.exitTime,
        stopLoss: stopForAnalytics, initialRisk,
        keyLevelType: mf.keyLevels[0]?.type ?? null,
        keyLevelInteraction: mf.keyLevels[0]?.interaction ?? null,
      });
    }
  }

  records.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.exportId.localeCompare(b.exportId));
  analyticsTrades.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.key.localeCompare(b.key));

  const closedTrades = records.filter((r) => r.status === "closed");
  const openTrades = records.filter((r) => r.status === "open");
  const wins = closedTrades.filter((r) => r.realizedPnl > 0).length;
  const losses = closedTrades.filter((r) => r.realizedPnl < 0).length;

  const warnings: string[] = [];
  const simCount = records.filter((r) => r.source === "simulator").length;
  if (simCount > 0) {
    warnings.push(`${simCount} simulator trade${simCount === 1 ? "" : "s"} included: simulator trades have no screenshots, no recorded fees, and no recorded original stop/target (platform limitation) - those fields are exported as unavailable, never invented.`);
  }
  const realNoOriginal = records.filter((r) => r.source === "real" && r.originalStopLoss == null).length;
  if (realNoOriginal > 0) {
    warnings.push(`${realNoOriginal} real trade${realNoOriginal === 1 ? "" : "s"} ha${realNoOriginal === 1 ? "s" : "ve"} no separately recorded ORIGINAL planned stop; where a stop exists, R is based on the recorded stop (see risk_basis per trade).`);
  }
  if (openTrades.length > 0) {
    warnings.push(`${openTrades.length} open trade${openTrades.length === 1 ? "" : "s"} included in trades.csv but excluded from performance analytics - only realized (closed) P&L is analyzed.`);
  }
  const unannotated = records.filter((r) => r.setup == null && r.hodClass == null && r.mistakes.length === 0 && r.emotionalTags.length === 0).length;
  if (records.length > 0 && unannotated > 0) {
    warnings.push(`${unannotated} of ${records.length} trades have no Trade DNA annotations (setup/HOD class/mistakes/emotions) - annotation-based breakdowns cover only the annotated trades.`);
  }
  if (records.length === 0) {
    warnings.push("No trades match the selected period and source. The package documents an empty selection - it does not substitute a different range.");
  }

  return {
    schemaVersion: EDGE_EXPORT_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    periodMode: mode,
    range,
    source,
    trades: records,
    closedTrades,
    openTrades,
    analyticsTrades,
    counts: {
      total: records.length,
      closed: closedTrades.length,
      open: openTrades.length,
      real: records.filter((r) => r.source === "real").length,
      simulator: simCount,
      wins, losses, breakevens: closedTrades.length - wins - losses,
    },
    warnings,
  };
}

/* ================= JSON sanitizing ====================================== */

/**
 * Deep-copy a value making it safe for JSON: non-finite numbers become
 * null; +Infinity/-Infinity additionally set a sibling "<key>Unbounded":
 * true marker on the containing object so the information "this metric
 * is unbounded" survives honestly instead of reading as missing.
 */
export function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    return null; // bare non-finite number (array element etc.)
  }
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value != null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number" && !Number.isFinite(v)) {
        out[k] = null;
        if (v === Infinity || v === -Infinity) out[`${k}Unbounded`] = true;
      } else {
        out[k] = sanitizeJsonValue(v);
      }
    }
    return out;
  }
  return value;
}

/* ================= cumulative / drawdown series (PDF charts) ============ */

export interface PnlSeriesPoint { date: string; dailyPnl: number; cumulative: number; drawdown: number }

/** Chronological cumulative realized P&L + drawdown (USD, <= 0) series
 *  from dailyPnl() — the same aggregation the Analytics UI charts.
 *  NOTE: this is a PER-DAY series; its drawdown trough can differ from
 *  riskMetrics().maxDrawdownUSD, which is calculated PER TRADE. Use
 *  tradeLevelDrawdownSeries() wherever the headline drawdown is shown. */
export function cumulativePnlSeries(snapshot: ExportSnapshot): PnlSeriesPoint[] {
  const days = dailyPnl(snapshot.analyticsTrades);
  let cum = 0, peak = 0;
  return days.map((d) => {
    cum += d.pnl;
    if (cum > peak) peak = cum;
    return { date: d.date, dailyPnl: d.pnl, cumulative: cum, drawdown: cum - peak };
  });
}

export interface TradeDrawdownPoint { date: string; tradeId: string; pnl: number; cumulative: number; drawdown: number }

/**
 * Per-trade cumulative realized P&L + drawdown (USD, <= 0) series, in
 * the SAME chronological order lib/journalAnalytics riskMetrics() uses
 * (tradeDate, then entry time, then key — mirroring its internal
 * chronological() sort). The trough of this series therefore equals
 * -riskMetrics().maxDrawdownUSD exactly: one source of truth for the
 * headline metric and any chart drawn next to it. A per-day series
 * hides intra-day drawdown (all of a day's trades collapse into one
 * point), which is why the PDF drawdown chart uses this series.
 */
export function tradeLevelDrawdownSeries(snapshot: ExportSnapshot): TradeDrawdownPoint[] {
  const sorted = [...snapshot.analyticsTrades].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate) ||
    (a.entryTime ?? "").localeCompare(b.entryTime ?? "") ||
    a.key.localeCompare(b.key));
  let cum = 0, peak = 0;
  return sorted.map((t) => {
    cum += t.realizedPnl;
    if (cum > peak) peak = cum;
    return { date: t.tradeDate, tradeId: exportIdForTradeKey(t.key), pnl: t.realizedPnl, cumulative: cum, drawdown: cum - peak };
  });
}

/* ================= screenshot manifest ================================== */

/**
 * Public (downloadable) projection of a manifest entry. The internal
 * entry carries the raw Supabase storage path — which contains the
 * account's UUID and internal object identifiers — and the journal's
 * internal trade key. NEITHER may be serialized into a downloadable
 * artifact: exports identify screenshots by stable trade ID,
 * package-relative file name and status only. Storage paths stay
 * internal to the application.
 */
export function publicScreenshotManifestEntry(e: ScreenshotManifestEntry): {
  tradeId: string; symbol: string; type: ScreenshotManifestEntry["type"];
  file: string | null; fileName: string | null;
  status: ScreenshotManifestEntry["status"]; capturedAt: string | null;
} {
  return {
    tradeId: e.tradeId,
    symbol: e.symbol,
    type: e.type,
    file: e.file,
    fileName: e.fileName,
    status: e.status,
    capturedAt: e.capturedAt,
  };
}

export interface ScreenshotManifestEntry {
  /** Stable export ID of the owning trade. */
  tradeId: string;
  tradeKey: string;
  symbol: string;
  /** The platform records no entry/exit/chart typing for screenshots —
   *  always "trade-screenshot" (Phase 1 decision 5). */
  type: "trade-screenshot";
  /** Supabase Storage path the bytes came from ("" when none). */
  storagePath: string;
  /** Path inside the ZIP ("screenshots/<file>") when bytes are included;
   *  null when the file is not in the package. */
  file: string | null;
  fileName: string | null;
  status: "listed" | "included" | "unavailable" | "not-included";
  /** Capture timestamp — storage listings used by the app do not expose
   *  one to the export, so this is null (unavailable, never invented). */
  capturedAt: string | null;
}

export interface ScreenshotCoverage {
  screenshotsRequested: boolean;
  realTrades: number;
  realTradesWithScreenshots: number;
  screenshotFiles: number;
  /** Export IDs of real trades with no screenshot in the package. */
  tradesMissingScreenshots: string[];
  /** Simulator trades never have screenshots (real trades only). */
  simulatorTrades: number;
  note: string;
}

function screenshotFileName(exportId: string, storagePath: string, n: number): string {
  const base = storagePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  return ext ? `${exportId}-shot-${n}.${ext}` : `${exportId}-shot-${n}`;
}

/**
 * Build the manifest from a storage listing (tradeKey → storage paths).
 * Pure: the package layer performs the listing/download and calls this.
 * Entries start as "listed"; the package layer flips them to "included"
 * (bytes fetched) or "unavailable" (fetch failed) before artifacts are
 * generated, so CSV/JSON/README always describe the final package.
 */
export function buildScreenshotManifest(
  snapshot: ExportSnapshot,
  listed: Map<string, string[]>,
): ScreenshotManifestEntry[] {
  const entries: ScreenshotManifestEntry[] = [];
  for (const rec of snapshot.trades) {
    if (rec.source !== "real") continue;
    const paths = [...new Set(listed.get(rec.tradeKey) ?? [])].sort();
    paths.forEach((storagePath, i) => {
      const fileName = screenshotFileName(rec.exportId, storagePath, i + 1);
      entries.push({
        tradeId: rec.exportId,
        tradeKey: rec.tradeKey,
        symbol: rec.symbol,
        type: "trade-screenshot",
        storagePath,
        file: `screenshots/${fileName}`,
        fileName,
        status: "listed",
        capturedAt: null,
      });
    });
  }
  return entries;
}

export function summarizeScreenshotCoverage(
  snapshot: ExportSnapshot,
  manifest: ScreenshotManifestEntry[],
  screenshotsRequested: boolean,
): ScreenshotCoverage {
  const realTrades = snapshot.trades.filter((r) => r.source === "real");
  const withShots = new Set(manifest.filter((e) => e.status === "included" || e.status === "listed").map((e) => e.tradeId));
  const missing = realTrades.filter((r) => !withShots.has(r.exportId)).map((r) => r.exportId);
  const files = manifest.filter((e) => e.status === "included").length;
  let note: string;
  if (!screenshotsRequested) {
    note = "Screenshots were not included in this package (the option was turned off). No images were fabricated or substituted.";
  } else if (realTrades.length === 0) {
    note = "No real-market trades in this selection - screenshots exist only for real-market trades, so none were available.";
  } else if (files === 0 && manifest.length === 0) {
    note = "No screenshots were available for the selected trades. Nothing was fabricated to fill the gap.";
  } else {
    note = `${files} screenshot file${files === 1 ? "" : "s"} included across ${withShots.size} real trade${withShots.size === 1 ? "" : "s"}; ${missing.length} real trade${missing.length === 1 ? "" : "s"} had no screenshot.`;
  }
  return {
    screenshotsRequested,
    realTrades: realTrades.length,
    realTradesWithScreenshots: withShots.size,
    screenshotFiles: files,
    tradesMissingScreenshots: missing,
    simulatorTrades: snapshot.counts.simulator,
    note,
  };
}

/* ================= trades.csv =========================================== */

export const CSV_COLUMNS = [
  "trade_id", "symbol", "source", "trade_date", "direction", "status",
  "entry_time", "exit_time", "timezone",
  "setup", "hod_class",
  "avg_entry_price", "total_shares_entered", "entry_fills", "entry_type",
  "avg_exit_price", "total_shares_exited", "exit_fills", "exit_reason",
  "stop_loss_current", "target_current", "original_stop_loss", "original_target",
  "plan_change_count", "plan_history",
  "initial_risk_usd", "r_multiple", "risk_basis",
  "fees_usd", "gross_realized_pnl_usd", "net_realized_pnl_usd",
  "key_levels", "float_shares", "relative_volume", "market_conditions",
  "exec_grade", "followed_plan", "confidence", "emotional_tags", "mistakes",
  "entry_reasoning", "exit_reasoning", "notes", "lessons", "would_take_again",
  "screenshot_files",
] as const;

/** CSV number: fixed decimals, trailing zeros trimmed; null → "". */
function csvNum(n: number | null | undefined, dp: number): string {
  if (n == null || !Number.isFinite(n)) return "";
  return String(Number(n.toFixed(dp)));
}

function csvEscape(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function fillsCell(fills: ExportFillDetail[], withPnl: boolean): string {
  return fills.map((f) => {
    let s = `${csvNum(f.qty, 4)}@${csvNum(f.price, 4)}`;
    if (withPnl && f.grossPnl != null) s += ` pnl=${f.grossPnl >= 0 ? "+" : ""}${csvNum(f.grossPnl, 2)}`;
    if (f.time) s += ` (${f.time})`;
    return s;
  }).join("; ");
}

function planHistoryCell(rec: ExportTradeRecord): string {
  return rec.planHistory
    .map((c) => `${c.field}: ${c.from == null ? "none" : csvNum(c.from, 4)} -> ${c.to == null ? "none" : csvNum(c.to, 4)} @ ${c.at}`)
    .join("; ");
}

function keyLevelsCell(rec: ExportTradeRecord): string {
  return rec.keyLevels
    .map((k) => `${csvNum(k.price, 4)} ${k.type}${k.interaction ? ` [${k.interaction}]` : ""}${k.notes ? ` "${k.notes}"` : ""}`)
    .join("; ");
}

/**
 * Serialize the snapshot to trades.csv (RFC-4180: CRLF rows, quotes
 * doubled, fields quoted when they contain comma/quote/newline).
 * Missing values are EMPTY fields — never zero-substituted. See README
 * in the package for per-column availability semantics.
 */
export function buildTradesCsv(snapshot: ExportSnapshot, manifest: ScreenshotManifestEntry[]): string {
  const shotsByTrade = new Map<string, string[]>();
  for (const e of manifest) {
    if (e.status !== "included" || !e.fileName) continue;
    const arr = shotsByTrade.get(e.tradeId) ?? [];
    arr.push(e.fileName);
    shotsByTrade.set(e.tradeId, arr);
  }
  const rows: string[] = [CSV_COLUMNS.join(",")];
  for (const rec of snapshot.trades) {
    const exitedQty = rec.exits.reduce((s, e) => s + e.qty, 0);
    const cells: string[] = [
      rec.exportId,
      rec.symbol,
      rec.source === "real" ? "Real Market" : "Simulator",
      rec.tradeDate,
      rec.direction,
      rec.status,
      rec.entryTime ?? "",
      rec.exitTime ?? "",
      "America/New_York",
      rec.setup ?? "",
      rec.hodClass ?? "",
      csvNum(rec.avgEntry, 4),
      csvNum(rec.entryQty, 4),
      fillsCell(rec.entries, false),
      "", // entry_type: not recorded by the platform (see README)
      csvNum(rec.avgExit, 4),
      exitedQty > 0 ? csvNum(exitedQty, 4) : "",
      fillsCell(rec.exits, true),
      rec.exitReasoning ?? "",
      csvNum(rec.stopLoss, 4),
      csvNum(rec.target, 4),
      csvNum(rec.originalStopLoss, 4),
      csvNum(rec.originalTarget, 4),
      String(rec.planHistory.length),
      planHistoryCell(rec),
      csvNum(rec.initialRisk, 2),
      csvNum(rec.rMultiple, 3),
      rec.riskBasis,
      csvNum(rec.fees, 2),
      csvNum(rec.grossRealized, 2),
      csvNum(rec.realizedPnl, 2),
      keyLevelsCell(rec),
      csvNum(rec.floatShares, 0),
      csvNum(rec.relativeVolume, 2),
      rec.marketConditions ?? "",
      rec.execGrade ?? "",
      rec.followedPlan == null ? "" : rec.followedPlan ? "yes" : "no",
      csvNum(rec.confidence, 0),
      rec.emotionalTags.join("; "),
      rec.mistakes.join("; "),
      rec.entryReasoning ?? "",
      rec.exitReasoning ?? "",
      rec.notes ?? "",
      rec.lessons ?? "",
      rec.wouldTakeAgain == null ? "" : rec.wouldTakeAgain ? "yes" : "no",
      (shotsByTrade.get(rec.exportId) ?? []).join("; "),
    ];
    rows.push(cells.map(csvEscape).join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

/* ================= analytics.json ======================================= */

/**
 * Display-rounding convention for the whole package, stated identically
 * in README.txt, analytics.json (metadata.rounding) and a Trading_Report
 * .pdf footnote so users can reconcile the artifacts themselves.
 */
export const ROUNDING_NOTE = "Rounding & reconciliation: per-trade amounts in trades.csv are rounded to cents for display. Totals in analytics.json and Trading_Report.pdf are calculated from full-precision values, so summing the displayed per-trade rows can differ from a reported total by a cent or two. That difference is a display-rounding effect, not an error.";

export const METRIC_DEFINITIONS: Record<string, string> = {
  winRate: "Wins / (wins + losses) x 100. Breakeven trades (realized P&L exactly 0) are excluded from the denominator - the journalAnalytics convention.",
  expectancy: "Net realized P&L / closed trade count (breakevens included) - the calcMetrics convention.",
  grossProfit: "Sum of the realized P&L of winning closed trades. 'Gross' means before offsetting winners against losers - it is NOT a pre-fee figure: every trade's realized P&L is its net P&L. For real trades that net P&L is after their recorded fees; for simulator trades it is the engine-reported P&L - the simulator has no fee model, so simulator P&L is fee-free and no simulator fees are ever invented. A mixed-source gross profit therefore combines fee-netted real P&L with fee-free simulator P&L.",
  grossLoss: "Sum of the realized P&L of losing closed trades, expressed as a positive amount. Same basis as grossProfit: net per-trade realized P&L (real trades net of recorded fees; simulator trades fee-free, no fee model).",
  profitFactor: "Gross profit / gross loss (see the grossProfit / grossLoss definitions). When there are winners and zero gross loss the value is unbounded: serialized as null with profitFactorUnbounded: true. Null when there are no winners and no losers.",
  avgR: "Mean R-multiple over trades with a recorded risk basis. Trades without a recorded stop are excluded, never counted as 0R.",
  medianR: "Median R-multiple over the same trades-with-R set as avgR.",
  rMultiple: "Net realized P&L / initial risk. Initial risk uses the ORIGINAL planned stop when one is recorded, otherwise the trade's recorded stop (see risk_basis in trades.csv).",
  maxDrawdownUSD: "Largest peak-to-trough decline of the cumulative realized P&L curve, in dollars. The curve is calculated PER TRADE (one step per closed trade, in chronological order) - the same per-trade basis as the Trading_Report.pdf drawdown chart, whose trough equals this figure. A per-day curve would hide drawdowns that occur and recover within a single day.",
  maxDrawdownPct: "Max drawdown as a percentage of the cumulative P&L peak that preceded it. The journal has no account-equity baseline, so this is NOT a percentage of account equity. Null when that peak was not positive.",
  winLossRatio: "Average win / average loss (absolute). Null when either side has no trades.",
  avgRiskPerTrade: "Mean initial risk in dollars over trades whose risk is known.",
};

export interface MetricsUnavailableEntry { key: string; label: string; reason: string }

export function metricsUnavailableList(snapshot: ExportSnapshot): MetricsUnavailableEntry[] {
  const list: MetricsUnavailableEntry[] = [
    { key: "maeMfe", label: "MAE / MFE (max adverse / favorable excursion)", reason: "Not computed anywhere in the platform - it would require per-trade candle history, which real-market trades do not have." },
    { key: "slippage", label: "Slippage", reason: "The platform has no execution-slippage model; no value is recorded per fill." },
    { key: "simulatorOriginalPlan", label: "Original planned stop/target for simulator trades", reason: "Simulator trades do not persist a planned stop/target, so their R and plan-adherence cannot be calculated. Exported as unavailable, never reconstructed." },
    { key: "simulatorFees", label: "Simulator fees", reason: "The simulator engine has no fee model. Simulator fees are unknown (empty in trades.csv), not zero." },
    { key: "entryOrderType", label: "Entry order type (market/limit) for real trades", reason: "Not recorded for real-market trades." },
    { key: "psychologyGuardEvents", label: "Psychology Guard events per trade", reason: "Guard lockouts are not stored as trade-linked records. Recorded emotional tags, mistakes and plan adherence ARE exported." },
    { key: "screenshotCaptureTimestamps", label: "Screenshot capture timestamps", reason: "The storage listing used by the app does not expose a capture time to the export; manifest capturedAt is null rather than invented." },
  ];
  const anyFloat = snapshot.trades.some((r) => r.floatShares != null);
  const anyRvol = snapshot.trades.some((r) => r.relativeVolume != null);
  if (!anyFloat || !anyRvol) {
    list.push({
      key: "floatRvol", label: "Float / relative volume",
      reason: `Recorded only when the trader entered it on a real trade.${!anyFloat ? " No selected trade has float recorded." : ""}${!anyRvol ? " No selected trade has relative volume recorded." : ""} Missing values are empty, never zero.`,
    });
  }
  return list;
}

const ALL_DIMENSIONS: BreakdownDimension[] = [
  "setup", "hodClass", "symbol", "mistake", "emotion", "plan",
  "source", "session", "timeOfDay", "hold", "side", "keyLevel", "interaction",
];

function breakdownForJson(trades: AnalyticsTrade[], dim: BreakdownDimension) {
  return breakdown(trades, dim).map((r) => ({
    label: r.label,
    count: r.count,
    wins: r.wins,
    losses: r.losses,
    breakevens: r.breakevens,
    winRate: r.winRate,
    netPnl: r.netPnl,
    grossProfit: r.grossProfit,
    grossLoss: r.grossLoss,
    avgWin: r.avgWin,
    avgLoss: r.avgLoss,
    avgR: r.avgR,
    expectancy: r.expectancy,
    profitFactor: r.profitFactor,
    avgHoldMinutes: r.avgHoldMinutes,
    tradeIds: r.trades.map((t) => exportIdForTradeKey(t.key)),
  }));
}

function overallBlock(snapshot: ExportSnapshot) {
  const closed = snapshot.closedTrades;
  const m = calcMetrics(closed.map((r) => ({ realizedPnl: r.realizedPnl })));
  const risk = riskMetrics(snapshot.analyticsTrades);
  const rs = snapshot.analyticsTrades.map((t) => t.rMultiple).filter((r): r is number => r != null && isFinite(r)).sort((a, b) => a - b);
  const medianR = rs.length === 0 ? null : rs.length % 2 === 1 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2;
  const decided = m.winners + m.losers;
  return {
    totalTrades: snapshot.counts.total,
    closedTrades: snapshot.counts.closed,
    openTrades: snapshot.counts.open,
    wins: m.winners,
    losses: m.losers,
    breakevens: m.breakeven,
    winRate: decided > 0 ? (m.winners / decided) * 100 : null,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    netRealizedPnl: m.netPnl,
    totalFeesRecorded: snapshot.closedTrades.reduce((s, r) => s + (r.fees ?? 0), 0),
    feesComplete: snapshot.closedTrades.every((r) => r.fees != null),
    avgWin: m.avgWin,
    avgLoss: m.avgLoss,
    winLossRatio: risk.winLossRatio,
    expectancy: m.expectancy,
    profitFactor: m.profitFactor,
    avgR: risk.avgR,
    medianR,
    tradesWithR: risk.tradesWithR,
    maxDrawdownUSD: risk.maxDrawdownUSD,
    maxDrawdownPct: risk.maxDrawdownPct,
    largestWin: m.largestWin,
    largestLoss: m.largestLoss,
    maxWinStreak: risk.maxWinStreak,
    maxLossStreak: risk.maxLossStreak,
    currentWinStreak: risk.currentWinStreak,
    currentLossStreak: risk.currentLossStreak,
    avgRiskPerTrade: risk.avgRiskPerTrade,
    tradesWithRisk: risk.tradesWithRisk,
    rDistribution: risk.rDistribution,
    tradingDays: risk.tradingDays,
    losingDays: risk.losingDays,
    losingDayFrequency: risk.losingDayFrequency,
  };
}

function perSourceBlock(snapshot: ExportSnapshot, src: "real" | "simulator") {
  const trades = snapshot.analyticsTrades.filter((t) => t.source === src);
  const closedRecs = snapshot.closedTrades.filter((r) => r.source === src);
  const m = calcMetrics(closedRecs.map((r) => ({ realizedPnl: r.realizedPnl })));
  const risk = riskMetrics(trades);
  return {
    closedTrades: closedRecs.length,
    openTrades: snapshot.openTrades.filter((r) => r.source === src).length,
    netRealizedPnl: m.netPnl,
    expectancy: m.expectancy,
    profitFactor: m.profitFactor,
    avgR: risk.avgR,
    maxDrawdownUSD: risk.maxDrawdownUSD,
    dailyPnl: dailyPnl(trades),
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayOfWeekBlock(snapshot: ExportSnapshot) {
  const map = new Map<string, { count: number; netPnl: number }>();
  for (const t of snapshot.analyticsTrades) {
    const day = WEEKDAYS[dayOfWeek(t.tradeDate)];
    const e = map.get(day) ?? { count: 0, netPnl: 0 };
    e.count++;
    e.netPnl += t.realizedPnl;
    map.set(day, e);
  }
  return WEEKDAYS.filter((d) => map.has(d)).map((d) => ({ day: d, ...map.get(d)! }));
}

/**
 * Build analytics.json as a plain (already sanitized) object.
 * Every metric comes from lib/journalAnalytics / lib/journal functions
 * run on the snapshot — identical inputs to the Analytics UI.
 */
export function buildAnalyticsJson(
  snapshot: ExportSnapshot,
  manifest: ScreenshotManifestEntry[],
  coverage: ScreenshotCoverage,
): Record<string, unknown> {
  const at = snapshot.analyticsTrades;
  const partialExitTrades = snapshot.closedTrades.filter((r) => r.exits.length > 1);
  const holds = at.map(holdMinutes).filter((h): h is number => h != null);
  const planChangeTrades = snapshot.trades.filter((r) => r.planHistory.length > 0);
  const missing = {
    tradesWithoutRecordedStop: snapshot.closedTrades.filter((r) => r.initialRisk == null).length,
    tradesWithoutOriginalPlan: snapshot.trades.filter((r) => r.source === "real" && r.originalStopLoss == null).length,
    tradesWithoutAnnotations: snapshot.trades.filter((r) => r.setup == null && r.hodClass == null && r.mistakes.length === 0 && r.emotionalTags.length === 0).length,
    tradesWithoutEntryTimestamp: snapshot.trades.filter((r) => r.entryTime == null).length,
    tradesWithoutKeyLevels: snapshot.trades.filter((r) => r.keyLevels.length === 0).length,
    realTradesWithoutScreenshots: coverage.tradesMissingScreenshots.length,
    openTradesExcludedFromAnalytics: snapshot.counts.open,
  };

  const doc = {
    metadata: {
      schemaVersion: snapshot.schemaVersion,
      generatedAt: snapshot.generatedAt,
      period: { mode: snapshot.periodMode, start: snapshot.range.start, end: snapshot.range.end, inclusive: true },
      timezone: "Trade dates are the journal's stored local date strings (YYYY-MM-DD) and are compared as strings, exactly like the journal UI. Session and time-of-day buckets interpret entry timestamps in America/New_York.",
      source: snapshot.source,
      sourceLabel: sourceLabel(snapshot.source),
      counts: snapshot.counts,
      dataSources: [
        "journal unified trade list (simulator position cycles from saved replay sessions; real trades from journal_real_trades + journal_real_fills)",
        "journal_trade_meta annotations (Trade DNA, key levels, original plan)",
        "Supabase Storage bucket journal-screenshots (owner-scoped, RLS)",
      ],
      metricsIncluded: [
        "overall performance", "breakdowns (setup, HOD class, symbol, mistake, emotion, plan, source, session, time of day, hold time, side, key level, interaction)",
        "risk metrics (drawdown, streaks, R distribution, average risk)", "daily P&L", "performance by day of week",
        "entry/exit and partial-exit summary", "Edge Finder (edgeInsights)", "per-source subtotals when All Trades is selected",
      ],
      metricsUnavailable: metricsUnavailableList(snapshot),
      missingDataSummary: missing,
      calculationDefinitions: METRIC_DEFINITIONS,
      rounding: ROUNDING_NOTE,
      // Privacy: only the public projection is serialized — raw storage
      // paths (account UUID, internal object ids) and internal trade
      // keys never enter a downloadable artifact.
      screenshotManifest: manifest.map(publicScreenshotManifestEntry),
      screenshotCoverage: coverage,
      edgeFinder: {
        available: true,
        implementation: "lib/journalAnalytics.ts edgeInsights() - the same function the journal Analytics tab renders.",
        smallSampleThreshold: 10,
        note: "Edge Finder results are historical associations inside this selection, not predictions and not a validated edge. Insights backed by fewer than 10 trades are flagged smallSample.",
      },
      warnings: snapshot.warnings,
    },
    overall: overallBlock(snapshot),
    perSource: snapshot.source === "all"
      ? {
          mixedSource: true,
          note: "Real Market and Simulator results are kept separate below. The combined overall block mixes both sources and must be read as mixed-source data. In the combined block, gross profit / gross loss are sums of winning / losing trades' realized (net) P&L on the basis defined under grossProfit / grossLoss in metadata.calculationDefinitions: real-trade P&L is net of recorded fees, while simulator P&L is fee-free because the simulator has no fee model.",
          real: perSourceBlock(snapshot, "real"),
          simulator: perSourceBlock(snapshot, "simulator"),
        }
      : null,
    breakdowns: Object.fromEntries(ALL_DIMENSIONS.map((d) => [d, breakdownForJson(at, d)])),
    dailyPnl: dailyPnl(at),
    performanceByDayOfWeek: dayOfWeekBlock(snapshot),
    entryExit: {
      partialExitTrades: partialExitTrades.length,
      partialExitNetPnl: partialExitTrades.reduce((s, r) => s + r.realizedPnl, 0),
      avgHoldMinutes: holds.length > 0 ? holds.reduce((s, h) => s + h, 0) / holds.length : null,
      tradesWithHoldData: holds.length,
      planChangesRecorded: planChangeTrades.reduce((s, r) => s + r.planHistory.length, 0),
      tradesWithPlanChanges: planChangeTrades.length,
      maeMfe: null,
      maeMfeNote: "Unavailable - see metadata.metricsUnavailable (maeMfe).",
    },
    riskPsychology: {
      riskMetrics: riskMetrics(at),
      planAdherence: edgeInsights(at).planAdherence,
      maxTradesInOneDay: dailyPnl(at).reduce((mx, d) => Math.max(mx, d.count), 0),
      note: "Overtrading/revenge patterns are only reported from recorded tags and counts - a mental state is never inferred from P&L alone.",
    },
    edgeFinder: edgeInsights(at),
    simulator: snapshot.counts.simulator > 0
      ? {
          available: true,
          trades: snapshot.counts.simulator,
          sessions: new Set(snapshot.trades.filter((r) => r.source === "simulator").map((r) => r.tradeKey.slice(0, r.tradeKey.lastIndexOf(":")))).size,
          netRealizedPnl: snapshot.closedTrades.filter((r) => r.source === "simulator").reduce((s, r) => s + r.realizedPnl, 0),
          note: "Simulator results are simulated replay outcomes, kept separate from real-market results everywhere in this package.",
        }
      : { available: false, reason: "No simulator trades in this selection." },
    tradesIndex: snapshot.trades.map((r) => ({
      tradeId: r.exportId,
      symbol: r.symbol,
      source: r.source === "real" ? "Real Market" : "Simulator",
      tradeDate: r.tradeDate,
      status: r.status,
      screenshots: manifest.filter((e) => e.tradeId === r.exportId && e.status === "included").map((e) => e.fileName),
    })),
  };
  return sanitizeJsonValue(doc) as Record<string, unknown>;
}

/* ================= ChatGPT_Prompt.txt =================================== */

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface PromptContext {
  pdfIncluded: boolean;
}

/**
 * The ChatGPT handoff prompt: the spec's analyst instructions, adapted to
 * THIS package — actual range, source, counts, coverage, and which data
 * is unavailable — so ChatGPT is told exactly what evidence it has.
 */
export function buildChatGptPrompt(
  snapshot: ExportSnapshot,
  coverage: ScreenshotCoverage,
  ctx: PromptContext,
): string {
  const overall = overallBlock(snapshot);
  const unavailable = metricsUnavailableList(snapshot);
  const files = [
    "trades.csv - one row per trade (raw evidence)",
    "analytics.json - Grow Green Lab's calculated metrics, breakdowns and Edge Finder output",
    ...(ctx.pdfIncluded ? ["Trading_Report.pdf - the visual summary report"] : []),
    "README.txt - package guide, column definitions and methodology",
    ...(coverage.screenshotFiles > 0 ? [`screenshots/ - ${coverage.screenshotFiles} trade screenshot(s), named by stable trade ID`] : []),
  ];
  return `You are analyzing my trading performance using a Grow Green Lab AI Edge Analysis package.

Use the included trades.csv, analytics.json${ctx.pdfIncluded ? ", Trading_Report.pdf" : ""} and screenshots to analyze my actual trading behavior and identify evidence-supported opportunities to improve my edge.

Do not assume that every supplied metric is correct without checking definitions and consistency. Where possible, reconcile raw trade records with aggregated analytics.

PACKAGE FACTS (generated by Grow Green Lab - treat these as the evidence boundary)
- Date range: ${formatRangeText(snapshot.range, snapshot.periodMode)}
- Trade source: ${sourceLabel(snapshot.source)}
- Trades included: ${snapshot.counts.total} total (${snapshot.counts.closed} closed, ${snapshot.counts.open} open) - ${snapshot.counts.real} Real Market, ${snapshot.counts.simulator} Simulator
- Closed-trade results: net realized P&L ${money(overall.netRealizedPnl)}, win rate ${overall.winRate == null ? "n/a" : overall.winRate.toFixed(1) + "%"}, expectancy ${money(overall.expectancy)} per trade, average R ${overall.avgR == null ? "n/a (no recorded stops)" : overall.avgR.toFixed(2) + "R over " + overall.tradesWithR + " trades with a recorded stop"}
- Screenshots: ${coverage.note}
- Files in this package:
${files.map((f) => `  * ${f}`).join("\n")}
- Data that is NOT available in this package (do not invent it): ${unavailable.map((u) => u.label).join("; ")}. Full reasons are in analytics.json under metadata.metricsUnavailable, and missing-data counts under metadata.missingDataSummary.
${snapshot.source === "all" ? "- This package mixes Real Market and Simulator trades. Keep them separate in your analysis; the combined figures are labeled mixed-source and must not be presented as real-money performance.\n" : ""}${snapshot.warnings.length > 0 ? `- Package warnings from Grow Green Lab:\n${snapshot.warnings.map((w) => `  * ${w}`).join("\n")}\n` : ""}
Follow these rules:

1. Begin with a concise summary of the date range, trade source, number of trades, and completeness of the evidence.
2. Identify the strongest and weakest strategies or setups using expectancy, average R, sample size, and consistency - not raw P&L alone.
3. Examine entry quality, exit decisions, stop-loss adherence, position sizing, partial exits, and original planned risk.
4. Analyze HOD breakout categories and key-level interactions where the supplied data supports them.
5. Compare Edge Finder findings with the trader's actual recorded performance.
6. Use screenshots as visual evidence when available. Reference the associated stable trade IDs and explain the observable evidence.
7. Identify recurring execution errors and distinguish directly recorded facts from interpretations.
8. Evaluate recorded psychology and risk-management patterns without diagnosing emotions that were not recorded.
9. Identify data-quality issues, missing screenshots, insufficient samples, and contradictory metrics.
10. Distinguish correlation from causation and historical association from a validated trading edge.
11. Avoid look-ahead bias and avoid using information that was unavailable at the time of a trade to justify its original decision.
12. Do not invent market data, float, relative volume, fills, trade notes, or missing values.
13. Prioritize a small number of high-impact, testable improvements.
14. Propose measurable experiments with explicit hypotheses, entry rules, exit rules, risk limits, and success criteria.
15. Explain what additional evidence would be needed to validate each hypothesis.

Organize your response as:

A. Executive summary
B. Strongest evidence-supported edges
C. Weakest setups and recurring losses
D. Entry and exit execution audit
E. Risk-management and psychology patterns
F. Key-level and Edge Finder validation
G. Screenshot-based trade reviews
H. Three highest-priority improvement opportunities
I. A measurable practice plan for the next trading period
J. Experiments to run and criteria for evaluating results
K. Data limitations and confidence assessment

For each important conclusion, provide the supporting trade count, relevant metrics, and trade IDs where available.

Separate high-confidence findings, preliminary observations, and untested hypotheses.

Do not promise profits or recommend increasing risk solely because a setup appears favorable. The objective is to improve the trader's process and test whether an edge exists, not to manufacture certainty.
`;
}

/* ================= README.txt =========================================== */

export interface ReadmeContext {
  pdfIncluded: boolean;
  pdfFailureNote: string | null;
  zipFileName: string;
}

const CSV_COLUMN_DOCS: [string, string][] = [
  ["trade_id", "Stable trade identifier (TRADE-<id>). The same trade always exports under the same ID; screenshot files and analytics tradeIds use it."],
  ["symbol", "Ticker symbol."],
  ["source", "Real Market or Simulator - from the journal's authoritative source field, never inferred."],
  ["trade_date", "Trade date (YYYY-MM-DD) as stored in the journal. Range filtering compares these date strings."],
  ["direction", "long or short."],
  ["status", "closed or open. Open trades are listed for completeness and excluded from performance analytics."],
  ["entry_time / exit_time", "ISO timestamps of the first entry fill / last exit fill, when recorded. Empty when unavailable."],
  ["timezone", "Session and time-of-day analytics interpret timestamps in America/New_York."],
  ["setup", "Trade DNA setup tag; for real trades without a tag, the trade's recorded strategy. Empty when neither exists."],
  ["hod_class", "Recorded HOD breakout classification (clean/weak/failed/anticipation). Empty when not recorded."],
  ["avg_entry_price", "Weighted average entry price across entry fills."],
  ["total_shares_entered", "Total entry quantity."],
  ["entry_fills", "Individual entry fills as qty@price (ISO time). Semicolon-separated."],
  ["entry_type", "UNAVAILABLE - order type (market/limit) is not recorded for real trades; always empty. Never inferred."],
  ["avg_exit_price", "FIFO-matched weighted average exit price (real trades); weighted average of exit fills (simulator). Empty when nothing has exited."],
  ["total_shares_exited", "Total exited quantity (FIFO-matched for real trades)."],
  ["exit_fills", "Individual exit fills as qty@price pnl=+X.XX (ISO time) - pnl is that exit's gross FIFO realized P&L (before fees) for real trades, and the simulator engine's recorded per-fill realized P&L for simulator trades."],
  ["exit_reason", "Recorded exit reasoning from Trade Review (same value as exit_reasoning). Empty when not recorded."],
  ["stop_loss_current / target_current", "The trade's currently recorded stop loss / target (real trades). Empty for simulator trades and when never set."],
  ["original_stop_loss / original_target", "The ORIGINAL planned stop/target, preserved set-once by the journal (plan changes never overwrite these). Empty when no plan was ever recorded - never reconstructed."],
  ["plan_change_count / plan_history", "Number of recorded stop/target changes and the change log (field: from -> to @ timestamp)."],
  ["initial_risk_usd", "Initial risk in dollars: |average entry - original planned stop (or recorded stop when no original exists)| x entry quantity. Empty when no stop is recorded."],
  ["r_multiple", "Net realized P&L / initial risk. Empty when initial risk is unavailable - a missing R is never exported as 0."],
  ["risk_basis", "Plain-language statement of exactly how this trade's R was (or could not be) calculated."],
  ["fees_usd", "Total recorded fees (real trades, summed from fills). EMPTY for simulator trades: the simulator has no fee model, so fees are unknown - not zero."],
  ["gross_realized_pnl_usd", "Gross realized P&L before fees (real trades). Empty for simulator trades (no fee split exists)."],
  ["net_realized_pnl_usd", "Net realized P&L - the figure all analytics use. For simulator trades this is the engine-reported P&L."],
  ["key_levels", "Recorded key levels as price Type [interaction] \"notes\", semicolon-separated."],
  ["float_shares / relative_volume", "Only when the trader recorded them on a real trade. Empty means not recorded - never zero, never fetched from an external source."],
  ["market_conditions", "Free-text market conditions recorded on the real trade. Empty when not recorded."],
  ["exec_grade / followed_plan / confidence", "Trade DNA execution grade (A-D), whether the plan was followed (yes/no), and confidence (1-5), as recorded in Trade Review. Empty when not recorded."],
  ["emotional_tags / mistakes", "Recorded Trade DNA tags, semicolon-separated. Empty means none recorded - no emotion or mistake is ever inferred from P&L."],
  ["entry_reasoning / exit_reasoning / notes / lessons", "The trader's own recorded words from Trade Review."],
  ["would_take_again", "Recorded yes/no from Trade Review. Empty when not recorded."],
  ["screenshot_files", "Screenshot file names included in this package for this trade (see screenshots/ and screenshots-manifest.json). Empty when the trade has no included screenshot."],
];

export function buildReadme(
  snapshot: ExportSnapshot,
  coverage: ScreenshotCoverage,
  manifest: ScreenshotManifestEntry[],
  ctx: ReadmeContext,
): string {
  const unavailable = metricsUnavailableList(snapshot);
  const includedFiles = [
    "trades.csv",
    "analytics.json",
    ...(ctx.pdfIncluded ? ["Trading_Report.pdf"] : []),
    "ChatGPT_Prompt.txt",
    "README.txt (this file)",
    "screenshots-manifest.json",
    ...(coverage.screenshotFiles > 0 ? [`screenshots/ (${coverage.screenshotFiles} image file${coverage.screenshotFiles === 1 ? "" : "s"})`] : []),
  ];
  const lines: string[] = [
    "GROW GREEN LAB - AI EDGE ANALYSIS PACKAGE",
    "==========================================",
    "",
    "PURPOSE",
    "This package exports your own Grow Green Lab journal evidence - trades, calculated analytics, Edge Finder output and trade screenshots - in a form you can hand to ChatGPT (or any analyst) for an evidence-based review of your trading edge.",
    "Grow Green Lab calculated the evidence. The AI interprets it. Nothing was sent anywhere automatically: you downloaded this ZIP and you choose what to upload.",
    "",
    "PACKAGE FACTS",
    `- Generated: ${snapshot.generatedAt}`,
    `- Export schema version: ${snapshot.schemaVersion}`,
    `- ZIP file: ${ctx.zipFileName}`,
    `- Date range: ${formatRangeText(snapshot.range, snapshot.periodMode)}`,
    "- Timezone: trade dates are the journal's stored date strings; session/time-of-day analytics use America/New_York.",
    `- Trade source: ${sourceLabel(snapshot.source)}`,
    `- Trades: ${snapshot.counts.total} total (${snapshot.counts.closed} closed, ${snapshot.counts.open} open) - ${snapshot.counts.real} Real Market, ${snapshot.counts.simulator} Simulator`,
    `- Screenshots: ${coverage.note}`,
    ...(ctx.pdfFailureNote ? [`- PDF: ${ctx.pdfFailureNote}`] : []),
    ...(snapshot.source === "all" ? ["- MIXED SOURCE: this package contains both Real Market and Simulator trades. Per-source results are kept separate in analytics.json (perSource); combined figures are labeled mixed-source."] : []),
    "",
    "FILE INVENTORY",
    ...includedFiles.map((f) => `- ${f}`),
    "",
    "TRADES.CSV - COLUMN DEFINITIONS",
    "One row per trade. Missing values are EMPTY fields - the platform never substitutes zero for missing data and never invents values.",
    ...CSV_COLUMN_DOCS.map(([c, d]) => `- ${c}: ${d}`),
    "",
    "ANALYTICS.JSON - SCHEMA AND METRIC DEFINITIONS",
    "Top-level sections: metadata (selection, counts, definitions, missing-data summary, screenshot manifest, Edge Finder configuration), overall, perSource (only when All Trades is selected), breakdowns (13 dimensions), dailyPnl, performanceByDayOfWeek, entryExit, riskPsychology, edgeFinder, simulator, tradesIndex.",
    "All metrics are computed by the same functions the journal Analytics tab uses (lib/journalAnalytics.ts + lib/journal.ts), on the same trade set, so the export and the UI agree.",
    ...Object.entries(METRIC_DEFINITIONS).map(([k, v]) => `- ${k}: ${v}`),
    "Non-finite values: JSON cannot represent unbounded numbers. An unbounded metric (e.g. profit factor with winners and no losers) is serialized as null with a sibling \"<metric>Unbounded\": true flag.",
    "",
    "ROUNDING & RECONCILIATION",
    ROUNDING_NOTE,
    "",
    "SCREENSHOT MANIFEST",
    "screenshots-manifest.json lists every screenshot considered for this package: owning stable trade ID, symbol, package-relative file name, and status (included / unavailable). The same manifest is embedded in analytics.json (metadata.screenshotManifest).",
    "PRIVACY: raw storage paths are intentionally NOT included anywhere in this package. Storage paths contain the account's internal identifiers (account UUID and internal object names), so they stay inside the application; screenshots are identified only by stable trade ID and package-relative file name.",
    "Screenshots are typed \"trade-screenshot\": the platform does not record whether a screenshot was taken at entry, exit, or review, and the export does not guess from file names.",
    coverage.note,
    ...(manifest.length === 0 ? ["No screenshot entries were recorded for this package."] : []),
    "",
    "MISSING DATA AND KNOWN LIMITATIONS",
    ...unavailable.map((u) => `- ${u.label}: ${u.reason}`),
    ...snapshot.warnings.map((w) => `- ${w}`),
    "",
    "RECOMMENDED CHATGPT WORKFLOW",
    "1. Open ChatGPT and start a new conversation.",
    "2. Attach the files from this package (trades.csv, analytics.json, Trading_Report.pdf if present, and the screenshots). If your plan limits attachments, prioritize analytics.json + trades.csv + screenshots.",
    "3. Paste the full contents of ChatGPT_Prompt.txt as your message and send.",
    "4. Treat the response as hypotheses about your process, not financial advice. The prompt instructs the analyst to separate high-confidence findings from untested hypotheses and to cite trade counts and trade IDs.",
    "ChatGPT has no access to your live Grow Green Lab account or to any data outside this package. Anything not in these files does not exist for the analysis.",
    "",
    "PRIVACY WARNING",
    "This package contains your personal trading history, journal notes and screenshots. Review the contents before sharing it anywhere. It contains no passwords, authentication tokens, or account credentials, and screenshots are your own (the export only ever reads your own data under your signed-in session). Do not post this package publicly.",
    "",
  ];
  return lines.join("\n");
}
