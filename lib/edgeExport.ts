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
  breakdown, riskMetrics, dailyPnl, edgeInsights, holdMinutes, isDailyReplayTrade,
  type AnalyticsTrade, type BreakdownDimension,
} from "./journalAnalytics";
import {
  calcMetrics, perExitPnl, parseKeyLevels,
  type KeyLevel, type PlanChange, type RawFill, type RealFill, type RealTradeCalc,
} from "./journal";
import { describeDrEvent, type DrEvent } from "./dailyReplayEvents";
import type { DrTradeEvidence } from "./drTradeEvidence";
import { resolveRepresentative, type RepresentativeSource } from "./drRepresentative";
import {
  strategyVersionLabel, type Strategy, type StrategyVersion,
} from "./strategies";

/**
 * Export schema version. 2.0 (Daily Replay Strategy & AI Edge Export):
 * additive over 1.0 — trades.csv keeps its original columns first, in
 * order, with four Daily Replay columns appended; analytics.json gains
 * a dailyReplay block plus strategy / strategyVersion breakdowns;
 * decision_timeline.csv and strategy.json are new files, present only
 * when Daily Replay trades are in the selection. A 1.0 consumer
 * reading a 2.0 package sees the same fields it always did.
 */
export const EDGE_EXPORT_SCHEMA_VERSION = "2.0";

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
  /** Daily Replay linkage (simulator-class trades only): the raw
   *  session source and owning attempt id, when this trade came from
   *  a Daily Replay attempt. */
  sessionSource?: string | null;
  attemptId?: string | null;
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

/** A daily_replay_attempts row joined with its dataset identity. */
export interface ExportDrAttemptInput {
  id: string;
  sessionId: string | null;
  strategyVersionId: string | null;
  status: string;
  startIndex: number | null;
  createdAt: string | null;
  finishedAt: string | null;
  ticker: string | null;
  tradeDate: string | null;
}

/** One daily_replay_events row: database id + the recorder event. */
export interface ExportDrEventInput {
  id: string;
  attemptId: string;
  event: DrEvent;
}

export interface ExportSnapshotInput {
  unified: ExportUnifiedInput[];
  metas: Record<string, ExportMetaInput>;
  realTrades: ExportRealTradeInput[];
  simTrades: ExportSimTradeInput[];
  /* --- Daily Replay (all optional; absent = pre-feature journal) --- */
  drAttempts?: ExportDrAttemptInput[];
  /** Per-trade plan evidence derived by lib/drTradeEvidence. */
  drEvidence?: Map<string, DrTradeEvidence>;
  drEvents?: ExportDrEventInput[];
  /** attemptId -> (event seq -> owning tradeKey | null), from the
   *  same derivation — used to attribute timeline rows to trades. */
  drEventTradeKeys?: Map<string, Map<number, string | null>>;
  strategies?: Strategy[];
  strategyVersions?: StrategyVersion[];
  /** Finalized Daily Replay trades only: tradeKey -> { draftKey,
   *  autoCapture } for trades that were born as per-cycle drafts
   *  (plan §2.4 + Representative plan §2.2). The draft key unions the
   *  draft-key screenshot prefix in the package layer; autoCapture is
   *  the draft row's recorded capture outcomes, the input to
   *  representative resolution (lib/drRepresentative.ts). */
  drDraftKeys?: Map<string, { draftKey: string; autoCapture: Record<string, unknown> }>;
  /** Finalized Daily Replay drafts the journal could NOT verify into
   *  a journal row from the attempt's recorded events (anchor
   *  reconciliation failed), so their trades are withheld from the
   *  journal and from every export. Since the 2026-10-18 workflow
   *  fix, a finalized draft on an ACTIVE attempt is normally INCLUDED
   *  as a pre-completion unified trade — this list is only the
   *  unverifiable remainder. The journal page computes it from its
   *  already-loaded drafts + attempts; the export panel only
   *  COMMUNICATES the count via computeDrExportHints (a named
   *  notice), never includes the trades. */
  drWithheldFinalizedDrafts?: { attemptId: string; strategyVersionId: string | null }[];
}

/* ================= period selection & date ranges ======================= */

export type ExportPeriodMode = "daily" | "weekly" | "monthly" | "custom";
export type ExportSource = "real" | "simulator" | "daily_replay" | "all";

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

/** A full export selection (period + source) in the panel's own
 *  state shape, derived from the journal page's current filters. */
export interface JournalScopedSelection {
  mode: ExportPeriodMode;
  anchorDate: string;
  customStart: string;
  customEnd: string;
  source: ExportSource;
}

/**
 * Map the journal page's current source filter + period preset to
 * the export panel's selection, so the Analytics tab's export counts
 * describe the SAME eligible set the user is looking at (2026-10-18
 * consistency fix: the panel previously defaulted to All sources /
 * current month regardless of the page's Daily Replay filter, so
 * Analytics appeared to count 11 closed trades while the journal
 * showed the 1 finalized trade in scope). The resolved range equals
 * the page filter's range under each preset's own semantics:
 * today = today; week = the Sunday-start week (the page's Week);
 * month = the calendar month; 30d / 90d / ytd = start..today;
 * all = unbounded, represented by an epoch floor start.
 * The user can still re-scope the panel afterwards; the page
 * re-syncs it whenever the page filters change.
 */
export function exportSelectionFromJournal(
  sourceFilter: string,
  period: string,
  today: string,
): JournalScopedSelection {
  const source: ExportSource =
    sourceFilter === "real" ? "real"
    : sourceFilter === "simulator" ? "simulator"
    : sourceFilter === "daily_replay" ? "daily_replay"
    : "all";
  const base = { anchorDate: today, customStart: today, customEnd: today, source };
  switch (period) {
    case "today": return { ...base, mode: "daily" };
    case "week": return { ...base, mode: "weekly" };
    case "month": return { ...base, mode: "monthly" };
    case "30d": return { ...base, mode: "custom", customStart: addDays(today, -30) };
    case "90d": return { ...base, mode: "custom", customStart: addDays(today, -90) };
    case "ytd": return { ...base, mode: "custom", customStart: `${today.slice(0, 4)}-01-01` };
    case "all":
    default: return { ...base, mode: "custom", customStart: "1970-01-01" };
  }
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
  return source === "real" ? "Real Market"
    : source === "simulator" ? "Simulator"
    : source === "daily_replay" ? "Daily Replay / Backtest"
    : "All Trades (Real Market + Simulator + Daily Replay)";
}

/** The one Daily Replay predicate over unified export inputs. */
export function isDrUnified(t: Pick<ExportUnifiedInput, "source" | "sessionSource" | "attemptId">): boolean {
  return isDailyReplayTrade({ source: t.source, sessionSource: t.sessionSource ?? null, attemptId: t.attemptId ?? null });
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
  /* --- Daily Replay linkage (null/false for real + Trade Lab trades) --- */
  /** True when this trade came from a Daily Replay attempt. */
  isDailyReplay: boolean;
  /** The session's raw source string ('daily_replay' for new DR
   *  completions; 'twelvedata' for DR attempts completed before
   *  source marking — the attempt link is the authority). */
  sessionSource: string | null;
  attemptId: string | null;
  strategyId: string | null;
  strategyVersionId: string | null;
  strategyName: string | null;
  strategyVersion: number | null;
  strategyLabel: string | null;
  /* --- Chart-context anchors (Representative plan §5 S1.2) --- */
  /** Candle index of the first entry fill / last exit fill, from the
   *  grouped fills (simulator-class trades; fills carry candle_index).
   *  Null for real trades (no candle data is stored for them) and when
   *  the fills carry none. Used ONLY to slice the session's stored
   *  candles into chart_context.csv sections — never guessed. */
  entryCandleIndex: number | null;
  exitCandleIndex: number | null;
}

/** The Daily Replay subset of a snapshot: only the attempts,
 *  strategies, versions, events and evidence the SELECTED trades
 *  touch — an export never carries unselected attempts. */
export interface ExportDrSubset {
  attempts: ExportDrAttemptInput[];
  strategies: Strategy[];
  versions: StrategyVersion[];
  events: ExportDrEventInput[];
  evidence: Map<string, DrTradeEvidence>;
  eventTradeKeys: Map<string, Map<number, string | null>>;
  /** tradeKey -> { draftKey, autoCapture } for the SELECTED trades
   *  that have a draft (same Map pattern as eventTradeKeys). */
  draftInfoByTradeKey: Map<string, { draftKey: string; autoCapture: Record<string, unknown> }>;
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
    /** Subset of `simulator`: trades that came from Daily Replay. */
    dailyReplay: number;
    wins: number; losses: number; breakevens: number;
  };
  /** Daily Replay subset, or null when no DR trade is selected. */
  dailyReplay: ExportDrSubset | null;
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

export interface ExportSelection {
  range: ExportDateRange;
  mode: ExportPeriodMode;
  source: ExportSource;
  /** Export-panel-only narrowing (decision: attempt-level selection
   *  lives here, never in the journal's own filters). */
  strategyId?: string | null;
  strategyVersionId?: string | null;
  attemptId?: string | null;
}

export function buildExportSnapshot(
  input: ExportSnapshotInput,
  selection: ExportSelection,
  generatedAt: Date = new Date(),
): ExportSnapshot {
  const { range, mode, source } = selection;
  const realByKey = new Map(input.realTrades.map((t) => [`real:${t.id}`, t]));
  const simByKey = new Map(input.simTrades.map((t) => [t.tradeKey, t]));
  const attemptById = new Map((input.drAttempts ?? []).map((a) => [a.id, a]));
  const versionById = new Map((input.strategyVersions ?? []).map((v) => [v.id, v]));
  const strategyById = new Map((input.strategies ?? []).map((s) => [s.id, s]));

  // Resolve a unified trade's strategy chain (attempt -> version ->
  // strategy). Null when any link is missing — never guessed.
  const chainOf = (t: ExportUnifiedInput) => {
    const attempt = t.attemptId ? attemptById.get(t.attemptId) : undefined;
    const version = attempt?.strategyVersionId ? versionById.get(attempt.strategyVersionId) : undefined;
    const strategy = version ? strategyById.get(version.strategyId) : undefined;
    return { attempt, version, strategy };
  };

  // Source + range filter over the unified list, deduped by trade key:
  // in "All" a trade appears exactly once (its key is unique per source).
  const seen = new Set<string>();
  const selected: ExportUnifiedInput[] = [];
  for (const t of input.unified) {
    if (source === "daily_replay") {
      if (!isDrUnified(t)) continue;
    } else if (source !== "all" && t.source !== source) continue;
    if (t.tradeDate < range.start || t.tradeDate > range.end) continue;
    if (selection.attemptId && t.attemptId !== selection.attemptId) continue;
    if (selection.strategyVersionId || selection.strategyId) {
      const { version } = chainOf(t);
      if (selection.strategyVersionId && version?.id !== selection.strategyVersionId) continue;
      if (selection.strategyId && version?.strategyId !== selection.strategyId) continue;
    }
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
        isDailyReplay: false,
        sessionSource: null,
        attemptId: null,
        strategyId: null,
        strategyVersionId: null,
        strategyName: null,
        strategyVersion: null,
        strategyLabel: null,
        entryCandleIndex: null,
        exitCandleIndex: null,
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
      const isDr = isDrUnified(t);
      const ev = isDr ? input.drEvidence?.get(t.key) : undefined;
      const chain = isDr ? chainOf(t) : { attempt: undefined, version: undefined, strategy: undefined };
      if (isDr && ev) {
        initialRisk = ev.initialRisk;
        stopForAnalytics = ev.stopLoss;
      }
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
        strategy: isDr ? (chain.strategy?.name ?? null) : null,
        avgEntry: g?.entryPrice ?? t.entryPrice,
        avgExit: g?.exitPrice ?? t.exitPrice,
        entryQty: entries.reduce((s, e) => s + e.qty, 0) || t.qty,
        entries, exits,
        // Daily Replay trades carry their plan from the attempt's
        // recorded evidence; Trade Lab simulator trades keep the
        // long-standing nulls (nothing is reconstructed for them).
        stopLoss: ev ? ev.stopLoss : null,
        target: ev ? ev.target : null,
        originalStopLoss: ev ? ev.originalStopLoss : null,
        originalTarget: ev ? ev.originalTarget : null,
        planHistory: ev ? ev.planHistory : [],
        fees: null,
        grossRealized: null,
        realizedPnl: t.realizedPnl,
        initialRisk: ev ? ev.initialRisk : null,
        rMultiple: ev ? ev.rMultiple : t.rMultiple,
        riskBasis: ev
          ? ev.riskBasis
          : isDr
            ? "Unavailable - Daily Replay plan evidence could not be derived for this trade (its attempt events were unavailable or did not reconcile), so R cannot be calculated. Never reconstructed."
            : "Unavailable - simulator trades do not record a stop loss, so R cannot be calculated.",
        floatShares: null,
        relativeVolume: null,
        marketConditions: null,
        isDailyReplay: isDr,
        sessionSource: t.sessionSource ?? null,
        attemptId: t.attemptId ?? null,
        strategyId: chain.strategy?.id ?? null,
        strategyVersionId: chain.version?.id ?? null,
        strategyName: chain.strategy?.name ?? null,
        strategyVersion: chain.version?.version ?? null,
        strategyLabel: chain.strategy
          ? strategyVersionLabel(chain.strategy.name, chain.version?.version ?? null)
          : null,
        entryCandleIndex: fills.find(isEntry)?.candle_index ?? null,
        exitCandleIndex: fills.filter((f) => !isEntry(f)).slice(-1)[0]?.candle_index ?? null,
        ...mf,
      };
    }
    records.push(rec);

    if (rec.status === "closed") {
      analyticsTrades.push({
        key: t.key, source: t.source, ticker: t.ticker, tradeDate: t.tradeDate,
        direction: t.direction, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
        qty: t.qty, realizedPnl: t.realizedPnl, rMultiple: rec.rMultiple, isOpen: false,
        setupTag: meta?.setup_tag ?? null,
        hodClass: meta?.hod_class ?? null,
        followedPlan: meta?.followed_plan ?? null,
        emotionalTags: meta?.emotional_tags ?? [],
        mistakes: meta?.mistakes ?? [],
        entryTime: rec.entryTime, exitTime: rec.exitTime,
        stopLoss: stopForAnalytics, initialRisk,
        keyLevelType: mf.keyLevels[0]?.type ?? null,
        keyLevelInteraction: mf.keyLevels[0]?.interaction ?? null,
        sessionSource: rec.sessionSource,
        attemptId: rec.attemptId,
        strategyId: rec.strategyId,
        strategyVersionId: rec.strategyVersionId,
        strategyName: rec.strategyName,
        strategyVersionLabel: rec.strategyLabel,
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
  const drCount = records.filter((r) => r.isDailyReplay).length;
  const tlSimCount = simCount - drCount;
  if (tlSimCount > 0) {
    warnings.push(`${tlSimCount} simulator trade${tlSimCount === 1 ? "" : "s"} included: simulator trades have no screenshots, no recorded fees, and no recorded original stop/target (platform limitation) - those fields are exported as unavailable, never invented.`);
  }
  if (drCount > 0) {
    warnings.push(`${drCount} Daily Replay backtest trade${drCount === 1 ? "" : "s"} included: Daily Replay is a historical simulation, not live trading and not a guarantee of future performance. It has no fee or slippage model (fees export as unavailable, never invented). Original plan and R come only from risk snapshots recorded at entry - trades without one export R as unavailable.`);
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

  /* Daily Replay subset: exactly the attempts / strategies / versions
   * / events / evidence the selected DR trades touch. */
  let dailyReplay: ExportDrSubset | null = null;
  if (drCount > 0) {
    const attemptIds = new Set(records.filter((r) => r.isDailyReplay && r.attemptId).map((r) => r.attemptId!));
    const attempts = (input.drAttempts ?? []).filter((a) => attemptIds.has(a.id));
    const versionIds = new Set<string>();
    for (const a of attempts) if (a.strategyVersionId) versionIds.add(a.strategyVersionId);
    for (const r of records) if (r.strategyVersionId) versionIds.add(r.strategyVersionId);
    const versions = (input.strategyVersions ?? []).filter((v) => versionIds.has(v.id));
    const strategyIds = new Set(versions.map((v) => v.strategyId));
    const strategies = (input.strategies ?? []).filter((s) => strategyIds.has(s.id));
    const events = (input.drEvents ?? []).filter((e) => attemptIds.has(e.attemptId));
    const evidence = new Map<string, DrTradeEvidence>();
    for (const r of records) {
      const e = input.drEvidence?.get(r.tradeKey);
      if (e) evidence.set(r.tradeKey, e);
    }
    const eventTradeKeys = new Map<string, Map<number, string | null>>();
    for (const id of attemptIds) {
      const m = input.drEventTradeKeys?.get(id);
      if (m) eventTradeKeys.set(id, m);
    }
    const draftInfoByTradeKey = new Map<string, { draftKey: string; autoCapture: Record<string, unknown> }>();
    for (const r of records) {
      if (!r.isDailyReplay) continue;
      const info = input.drDraftKeys?.get(r.tradeKey);
      if (info) draftInfoByTradeKey.set(r.tradeKey, info);
    }
    dailyReplay = { attempts, strategies, versions, events, evidence, eventTradeKeys, draftInfoByTradeKey };
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
      dailyReplay: drCount,
      wins, losses, breakevens: closedTrades.length - wins - losses,
    },
    dailyReplay,
    warnings,
  };
}

/* ================= export hints (invisible DR trades, named) ============ */

export interface DrExportHints {
  /** Finalized Daily Replay drafts whose trades were WITHHELD from
   *  the journal because their recorded events could not be
   *  reconciled with the draft's anchors — named so the absence is
   *  never silent. (Finalized drafts on active attempts are otherwise
   *  INCLUDED as pre-completion trades since the 2026-10-18 fix.) */
  withheldFinalizedDrafts: number;
  /** Daily Replay trades (pre- or post-completion) excluded ONLY by
   *  the date range — the remedy is widening the range. */
  outOfRangeDrTrades: number;
}

/**
 * Why a Daily Replay trade the user KNOWS exists (they finalized its
 * draft, or it sits in their journal) is absent from this export
 * selection — named as counts, so the panel can say so instead of
 * silently reporting "Eligible trades: 0". Mirrors buildExportSnapshot's
 * source rule and panel narrowing exactly; the range is the one filter
 * inverted (for out-of-range) or irrelevant (for withheld drafts,
 * which have no trade at any range). Communication only: this function
 * never feeds the snapshot, and ineligible trades stay ineligible.
 */
export function computeDrExportHints(
  input: ExportSnapshotInput,
  selection: ExportSelection,
): DrExportHints {
  const none: DrExportHints = { withheldFinalizedDrafts: 0, outOfRangeDrTrades: 0 };
  // Daily Replay trades ride the "all" / "simulator" / "daily_replay"
  // sources; a real-only selection can never include them.
  if (selection.source === "real") return none;
  const { range } = selection;
  const attemptById = new Map((input.drAttempts ?? []).map((a) => [a.id, a]));
  const versionById = new Map((input.strategyVersions ?? []).map((v) => [v.id, v]));
  const passesNarrowing = (attemptId: string | null, versionId: string | null): boolean => {
    if (selection.attemptId && attemptId !== selection.attemptId) return false;
    if (selection.strategyVersionId || selection.strategyId) {
      const version = versionId ? versionById.get(versionId) : undefined;
      if (selection.strategyVersionId && version?.id !== selection.strategyVersionId) return false;
      if (selection.strategyId && version?.strategyId !== selection.strategyId) return false;
    }
    return true;
  };

  let withheldFinalizedDrafts = 0;
  for (const p of input.drWithheldFinalizedDrafts ?? []) {
    if (passesNarrowing(p.attemptId, p.strategyVersionId)) withheldFinalizedDrafts++;
  }

  let outOfRangeDrTrades = 0;
  for (const t of input.unified) {
    if (!isDrUnified(t)) continue;
    if (t.tradeDate >= range.start && t.tradeDate <= range.end) continue; // in range — not this hint
    const attempt = t.attemptId ? attemptById.get(t.attemptId) : undefined;
    if (passesNarrowing(t.attemptId ?? null, attempt?.strategyVersionId ?? null)) outOfRangeDrTrades++;
  }

  return { withheldFinalizedDrafts, outOfRangeDrTrades };
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
  role: ScreenshotManifestEntry["role"];
  representativeSource: ScreenshotManifestEntry["representativeSource"];
  candleIndex: number | null;
  candleTime: string | null;
} {
  return {
    tradeId: e.tradeId,
    symbol: e.symbol,
    type: e.type,
    file: e.file,
    fileName: e.fileName,
    status: e.status,
    capturedAt: e.capturedAt,
    role: e.role,
    representativeSource: e.representativeSource,
    candleIndex: e.candleIndex,
    candleTime: e.candleTime,
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
  /* --- Representative role (Representative plan §5 S1.2, additive) --- */
  /** "representative" for the ONE image a Daily Replay trade
   *  contributes to the package; "attachment" for everything else
   *  (all real-trade images, and DR images that stay in the journal —
   *  those are listed with status "not-included", never dropped
   *  silently). */
  role: "representative" | "attachment";
  /** How the representative was resolved (lib/drRepresentative.ts);
   *  null for attachments and for DR trades with no representative. */
  representativeSource: RepresentativeSource | null;
  /** Candle index the representative is anchored to, from the draft
   *  record — null when unknown (never inferred from a file name). */
  candleIndex: number | null;
  /** The representative candle's period start (ISO), derived by the
   *  package layer from the session's stored candles by index;
   *  null when the candles were unavailable. */
  candleTime: string | null;
}

export interface ScreenshotCoverage {
  screenshotsRequested: boolean;
  realTrades: number;
  realTradesWithScreenshots: number;
  screenshotFiles: number;
  /** Export IDs of screenshot-eligible trades (real + Daily Replay)
   *  with no screenshot in the package. */
  tradesMissingScreenshots: string[];
  /** Trade Lab simulator trades never have screenshots. Daily Replay
   *  trades DO (journal-attached screenshots, like real trades). */
  simulatorTrades: number;
  /** Daily Replay trades in the selection (screenshot-eligible). */
  dailyReplayTrades: number;
  /** Daily Replay trades whose representative resolved to a listed
   *  image (Representative plan §5 S1.2). */
  dailyReplayTradesWithRepresentative: number;
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
 *
 * Daily Replay trades (Representative plan §5 S1.2): exactly ONE image
 * per trade is downloadable — the resolved representative
 * (lib/drRepresentative.ts). Every other listed DR image stays a
 * manifest row with status "not-included" and file null: listed and
 * explained, never silently dropped, and never substituted for a failed
 * representative (a failed download becomes "unavailable" + a warning).
 * Real trades are unchanged: every listed image is a downloadable
 * attachment.
 */
export function buildScreenshotManifest(
  snapshot: ExportSnapshot,
  listed: Map<string, string[]>,
  userId?: string,
): ScreenshotManifestEntry[] {
  const entries: ScreenshotManifestEntry[] = [];
  for (const rec of snapshot.trades) {
    // Real trades and Daily Replay trades can carry journal-attached
    // screenshots; Trade Lab simulator trades remain excluded.
    if (rec.source !== "real" && !rec.isDailyReplay) continue;
    const paths = [...new Set(listed.get(rec.tradeKey) ?? [])].sort();
    if (rec.isDailyReplay) {
      const info = snapshot.dailyReplay?.draftInfoByTradeKey.get(rec.tradeKey);
      // Owner id: explicit when the caller has it (the package layer),
      // else derived from the listing itself — every listed path for
      // this trade sits under the owner's own first segment by
      // construction of the storage list calls.
      const owner = userId ?? (paths.length > 0 ? paths[0].split("/")[0] : null);
      const resolution = owner
        ? resolveRepresentative({
            autoCapture: info?.autoCapture,
            listedPaths: paths,
            draftKey: info?.draftKey ?? null,
            finalizedTradeKey: rec.tradeKey,
            userId: owner,
          })
        : null;
      paths.forEach((storagePath, i) => {
        if (resolution && storagePath === resolution.path) {
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
            role: "representative",
            representativeSource: resolution.source,
            candleIndex: resolution.candleIndex,
            candleTime: null,
          });
        } else {
          entries.push({
            tradeId: rec.exportId,
            tradeKey: rec.tradeKey,
            symbol: rec.symbol,
            type: "trade-screenshot",
            storagePath,
            file: null,
            fileName: null,
            status: "not-included",
            capturedAt: null,
            role: "attachment",
            representativeSource: null,
            candleIndex: null,
            candleTime: null,
          });
        }
      });
      continue;
    }
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
        role: "attachment",
        representativeSource: null,
        candleIndex: null,
        candleTime: null,
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
  const drTrades = snapshot.trades.filter((r) => r.isDailyReplay);
  const eligible = [...realTrades, ...drTrades];
  const realIds = new Set(realTrades.map((r) => r.exportId));
  const withShots = new Set(manifest.filter((e) => e.status === "included" || e.status === "listed").map((e) => e.tradeId));
  const missing = eligible.filter((r) => !withShots.has(r.exportId)).map((r) => r.exportId);
  const files = manifest.filter((e) => e.status === "included").length;
  // Representative plan §5 S1.2: a DR trade that HAS images but no
  // resolvable representative is a different fact from "no screenshot"
  // — it had no representative screenshot.
  const drIds = new Set(drTrades.map((r) => r.exportId));
  const drWithRep = new Set(manifest.filter((e) => e.role === "representative" && (e.status === "included" || e.status === "listed")).map((e) => e.tradeId));
  const drNoRep = drTrades.filter((r) => manifest.some((e) => e.tradeId === r.exportId) && !drWithRep.has(r.exportId)).length;
  let note: string;
  if (!screenshotsRequested) {
    note = "Screenshots were not included in this package (the option was turned off). No images were fabricated or substituted.";
  } else if (eligible.length === 0) {
    note = "No real-market or Daily Replay trades in this selection - screenshots exist only for real-market and Daily Replay trades, so none were available.";
  } else if (files === 0 && manifest.length === 0) {
    note = "No screenshots were available for the selected trades. Nothing was fabricated to fill the gap.";
  } else {
    note = `${files} screenshot file${files === 1 ? "" : "s"} included across ${withShots.size} trade${withShots.size === 1 ? "" : "s"}; ${missing.length} trade${missing.length === 1 ? "" : "s"} had no screenshot.`;
    if (drNoRep > 0) {
      note += ` ${drNoRep} Daily Replay trade${drNoRep === 1 ? "" : "s"} had no representative screenshot — its other images are listed in the manifest as not-included and were not exported.`;
    }
  }
  return {
    screenshotsRequested,
    realTrades: realTrades.length,
    realTradesWithScreenshots: [...withShots].filter((id) => realIds.has(id)).length,
    screenshotFiles: files,
    tradesMissingScreenshots: missing,
    simulatorTrades: snapshot.counts.simulator - snapshot.counts.dailyReplay,
    dailyReplayTrades: drTrades.length,
    dailyReplayTradesWithRepresentative: [...drWithRep].filter((id) => drIds.has(id)).length,
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
  // Schema 2.0 appends — the original 46 columns above keep their
  // order and meaning; these four are Daily Replay linkage.
  "daily_replay_attempt_id", "strategy_name", "strategy_version", "strategy_version_id",
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
      rec.source === "real" ? "Real Market" : rec.isDailyReplay ? "Daily Replay / Backtest" : "Simulator",
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
      rec.attemptId ?? "",
      rec.strategyName ?? rec.strategy ?? "",
      rec.strategyVersion != null ? String(rec.strategyVersion) : "",
      rec.strategyVersionId ?? "",
    ];
    rows.push(cells.map(csvEscape).join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

/* ================= decision_timeline.csv + strategy.json (2.0) ======== */

/** Deterministic JSON: object keys sorted recursively, so the same
 *  stored payload serializes byte-identically on every export. */
export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`).join(",")}}`;
}

export const DECISION_TIMELINE_COLUMNS = [
  "trade_id", "attempt_id", "event_id", "seq", "type",
  "market_time", "wall_time", "candle_index", "description", "payload_json",
] as const;

/**
 * decision_timeline.csv — the selected attempts' Decision Timeline
 * events, one row per event, attributed to the trade whose position
 * cycle contains the event (empty trade_id for attempt-level events
 * and for cycles still open at completion). Both clocks are exported
 * as separate columns and never mixed: market_time is the historical
 * candle time (Eastern session), wall_time is when the trader acted.
 * payload_json is the event payload verbatim (stable key order), so
 * nothing the recorder captured is lost in this rendering.
 */
export function buildDecisionTimelineCsv(snapshot: ExportSnapshot): string {
  const rows: string[] = [DECISION_TIMELINE_COLUMNS.join(",")];
  const dr = snapshot.dailyReplay;
  if (!dr) return rows.join("\r\n") + "\r\n";
  const exportIdByKey = new Map(snapshot.trades.map((r) => [r.tradeKey, r.exportId]));
  // Finalized-only filtering (plan §7.5(i)): the export contains
  // finalized trades only, so timeline rows follow the same rule —
  // a row assigned to a trade that is NOT in this snapshot is
  // dropped; attempt-level rows (no owning trade) are kept only when
  // the attempt has at least one included trade; attempts with no
  // included trade contribute zero rows.
  const includedKeys = new Set(snapshot.trades.map((r) => r.tradeKey));
  const attemptsWithIncluded = new Set(
    snapshot.trades.map((r) => r.attemptId).filter((id): id is string => !!id),
  );
  const attempts = [...dr.attempts].sort((a, b) =>
    (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id));
  for (const attempt of attempts) {
    if (!attemptsWithIncluded.has(attempt.id)) continue;
    const events = dr.events
      .filter((e) => e.attemptId === attempt.id)
      .sort((a, b) => a.event.seq - b.event.seq);
    const assignment = dr.eventTradeKeys.get(attempt.id);
    for (const { id, event } of events) {
      const tradeKey = assignment?.get(event.seq) ?? null;
      if (tradeKey !== null && !includedKeys.has(tradeKey)) continue;
      const cells = [
        tradeKey ? (exportIdByKey.get(tradeKey) ?? "") : "",
        attempt.id,
        id,
        String(event.seq),
        event.type,
        event.marketTs != null ? new Date(event.marketTs).toISOString() : "",
        new Date(event.wallTs).toISOString(),
        event.marketIdx != null ? String(event.marketIdx) : "",
        describeDrEvent(event),
        stableJsonStringify(event.payload),
      ];
      rows.push(cells.map(csvEscape).join(","));
    }
  }
  return rows.join("\r\n") + "\r\n";
}

/**
 * strategy.json — the strategies and immutable versions REFERENCED by
 * the selected attempts (never the trader's whole library), each
 * version carrying the attempts that were bound to it. These are the
 * recorded rules as written before the attempts ran; an AI reviewer
 * compares execution against them — it must never rewrite them.
 */
export function buildStrategyJson(snapshot: ExportSnapshot): Record<string, unknown> | null {
  const dr = snapshot.dailyReplay;
  if (!dr) return null;
  const versionById = new Map(dr.versions.map((v) => [v.id, v]));
  const doc = {
    schemaVersion: snapshot.schemaVersion,
    note: "Strategy versions are immutable records of the rules in force when each attempt was locked. If analysis suggests a rule change, it is a hypothesis for a NEW version - never an edit to these.",
    strategies: dr.strategies.map((s) => ({
      id: s.id,
      name: s.name,
      notes: s.notes,
      archived: s.archivedAt != null,
      archivedAt: s.archivedAt,
      versions: dr.versions
        .filter((v) => v.strategyId === s.id)
        .sort((a, b) => a.version - b.version)
        .map((v) => ({
          id: v.id,
          version: v.version,
          setupType: v.setupType,
          entryRules: v.entryRules,
          stopRules: v.stopRules,
          targetRules: v.targetRules,
          exitRules: v.exitRules,
          marketFilters: v.marketFilters,
          notes: v.notes,
          createdAt: v.createdAt,
          attemptIds: dr.attempts.filter((a) => a.strategyVersionId === v.id).map((a) => a.id),
        })),
    })),
    unversionedAttemptIds: dr.attempts.filter((a) => !a.strategyVersionId || !versionById.has(a.strategyVersionId)).map((a) => a.id),
  };
  return sanitizeJsonValue(doc) as Record<string, unknown>;
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
  const hasTradeLabSim = snapshot.trades.some((r) => r.source === "simulator" && !r.isDailyReplay);
  const drTrades = snapshot.trades.filter((r) => r.isDailyReplay);
  const drWithoutR = drTrades.filter((r) => r.rMultiple == null);
  const list: MetricsUnavailableEntry[] = [
    { key: "maeMfe", label: "MAE / MFE (max adverse / favorable excursion)", reason: "Not computed anywhere in the platform - it would require per-trade candle history, which real-market trades do not have." },
    { key: "slippage", label: "Slippage", reason: "The platform has no execution-slippage model; no value is recorded per fill." },
    // Scoped to Trade Lab simulator trades: Daily Replay trades DO
    // carry an original plan (from the recorded risk snapshot), so
    // this entry appears only when Trade Lab trades are selected.
    ...(hasTradeLabSim ? [{ key: "simulatorOriginalPlan", label: "Original planned stop/target for Trade Lab simulator trades", reason: "Trade Lab simulator trades do not persist a planned stop/target, so their R and plan-adherence cannot be calculated. Exported as unavailable, never reconstructed. (Daily Replay trades are different: their original plan comes from the risk snapshot recorded at entry.)" }] : []),
    ...(drWithoutR.length > 0 ? [{ key: "dailyReplayRiskUnavailable", label: `R for ${drWithoutR.length} Daily Replay trade${drWithoutR.length === 1 ? "" : "s"}`, reason: "These Daily Replay trades have no valid risk snapshot recorded at entry (see risk_basis per trade in trades.csv), so their initial risk and R are unavailable. Never reconstructed." }] : []),
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
  "strategy", "strategyVersion",
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

function perSourceBlock(snapshot: ExportSnapshot, src: "real" | "simulator" | "daily_replay") {
  // Daily Replay trades are simulator-CLASS records, but their
  // subtotal is always computed separately — the "simulator" subtotal
  // covers Trade Lab trades only, so the three subtotals partition
  // the selection exactly.
  const match = (t: { source: string; sessionSource: string | null; attemptId: string | null; isDailyReplay?: boolean }) =>
    src === "daily_replay"
      ? isDailyReplayTrade({ source: t.source as "simulator" | "real", sessionSource: t.sessionSource, attemptId: t.attemptId })
      : src === "simulator"
        ? t.source === "simulator" && !isDailyReplayTrade({ source: t.source as "simulator" | "real", sessionSource: t.sessionSource, attemptId: t.attemptId })
        : t.source === "real";
  const trades = snapshot.analyticsTrades.filter(match);
  const closedRecs = snapshot.closedTrades.filter(match);
  const m = calcMetrics(closedRecs.map((r) => ({ realizedPnl: r.realizedPnl })));
  const risk = riskMetrics(trades);
  return {
    closedTrades: closedRecs.length,
    openTrades: snapshot.openTrades.filter(match).length,
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
 * The analytics.json Daily Replay block: per-attempt results for the
 * attempts the selection touches, with the strategy version each
 * attempt was bound to at lock time. Sample sizes are stated, never
 * dressed up — an attempt count is evidence quantity, not proof.
 */
function dailyReplayBlock(snapshot: ExportSnapshot): Record<string, unknown> {
  const dr = snapshot.dailyReplay;
  if (!dr) return { available: false, reason: "No Daily Replay trades in this selection." };
  const recs = snapshot.trades.filter((r) => r.isDailyReplay);
  const versionById = new Map(dr.versions.map((v) => [v.id, v]));
  const strategyById = new Map(dr.strategies.map((s) => [s.id, s]));
  const attempts = dr.attempts.map((a) => {
    const trades = recs.filter((r) => r.attemptId === a.id);
    const version = a.strategyVersionId ? versionById.get(a.strategyVersionId) : undefined;
    const strategy = version ? strategyById.get(version.strategyId) : undefined;
    const rs = trades.map((t) => t.rMultiple).filter((r): r is number => r != null && isFinite(r));
    const lifecycle = dr.events.some((e) => e.attemptId === a.id && e.event.type === "session_resumed")
      ? "completed-after-resume" : "completed";
    return {
      attemptId: a.id,
      sessionLinked: a.sessionId != null,
      ticker: a.ticker,
      tradeDate: a.tradeDate,
      status: a.status,
      lifecycle,
      strategy: strategy && version
        ? {
            strategyId: strategy.id, name: strategy.name,
            versionId: version.id, version: version.version,
            label: strategyVersionLabel(strategy.name, version.version),
            setupType: version.setupType,
            archived: strategy.archivedAt != null,
          }
        : null,
      trades: trades.length,
      tradeIds: trades.map((t) => t.exportId),
      realizedPnl: trades.reduce((s, t) => s + t.realizedPnl, 0),
      tradesWithR: rs.length,
      avgR: rs.length > 0 ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
    };
  });
  return {
    available: true,
    note: "Daily Replay is a historical simulation (backtest): results describe what would have happened on the recorded historical days, are not live trading results, and are not a guarantee of future performance. Only completed attempts with closed trades appear here - abandoned attempts and positions left open are not performance evidence.",
    attemptsInSelection: attempts.length,
    strategiesReferenced: [...new Set(attempts.map((a) => a.strategy?.strategyId).filter(Boolean))].length,
    tradesWithRiskSnapshot: recs.filter((r) => r.initialRisk != null).length,
    tradesWithoutRiskSnapshot: recs.filter((r) => r.initialRisk == null).length,
    attempts,
  };
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
      timezone: "Trade dates are the journal's stored local date strings (YYYY-MM-DD) and are compared as strings, exactly like the journal UI. Session and time-of-day buckets interpret entry timestamps in America/New_York."
        + (snapshot.dailyReplay ? " Daily Replay decision_timeline.csv carries TWO clocks that are never mixed: market_time is the historical candle time (Eastern), wall_time is the real time the trader acted." : ""),
      source: snapshot.source,
      sourceLabel: sourceLabel(snapshot.source),
      counts: snapshot.counts,
      dataSources: [
        "journal unified trade list (simulator position cycles from saved replay sessions; real trades from journal_real_trades + journal_real_fills)",
        "journal_trade_meta annotations (Trade DNA, key levels, original plan)",
        "Supabase Storage bucket journal-screenshots (owner-scoped, RLS)",
        ...(snapshot.dailyReplay ? [
          "daily_replay_attempts + daily_replay_events (the append-only Decision Timeline: original plan and R derive from risk_snapshot events recorded at entry, never reconstructed)",
          "strategies + strategy_versions (immutable strategy definitions; attempts are bound to a version at lock time)",
          "All Daily Replay rows are read through the owner's own signed-in session - owner RLS is the only access path (the app has no API routes for this data).",
        ] : []),
      ],
      metricsIncluded: [
        "overall performance", "breakdowns (setup, HOD class, symbol, mistake, emotion, plan, source, session, time of day, hold time, side, key level, interaction, strategy, strategy version)",
        "risk metrics (drawdown, streaks, R distribution, average risk)", "daily P&L", "performance by day of week",
        "entry/exit and partial-exit summary", "Edge Finder (edgeInsights)", "per-source subtotals when All Trades is selected",
        ...(snapshot.dailyReplay ? ["Daily Replay block (attempts, bound strategies, per-attempt results)"] : []),
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
          note: "Real Market, Simulator and Daily Replay results are kept separate below. The combined overall block mixes all sources and must be read as mixed-source data. In the combined block, gross profit / gross loss are sums of winning / losing trades' realized (net) P&L on the basis defined under grossProfit / grossLoss in metadata.calculationDefinitions: real-trade P&L is net of recorded fees, while simulator and Daily Replay P&L is fee-free because neither has a fee model.",
          real: perSourceBlock(snapshot, "real"),
          simulator: perSourceBlock(snapshot, "simulator"),
          ...(snapshot.counts.dailyReplay > 0 ? { dailyReplay: perSourceBlock(snapshot, "daily_replay") } : {}),
        }
      : null,
    dailyReplay: dailyReplayBlock(snapshot),
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
    simulator: snapshot.counts.simulator - snapshot.counts.dailyReplay > 0
      ? {
          available: true,
          trades: snapshot.counts.simulator - snapshot.counts.dailyReplay,
          sessions: new Set(snapshot.trades.filter((r) => r.source === "simulator" && !r.isDailyReplay).map((r) => r.tradeKey.slice(0, r.tradeKey.lastIndexOf(":")))).size,
          netRealizedPnl: snapshot.closedTrades.filter((r) => r.source === "simulator" && !r.isDailyReplay).reduce((s, r) => s + r.realizedPnl, 0),
          note: "Simulator results are simulated replay outcomes, kept separate from real-market results everywhere in this package. Daily Replay trades have their own block (dailyReplay) and are not counted here.",
        }
      : { available: false, reason: "No Trade Lab simulator trades in this selection." },
    tradesIndex: snapshot.trades.map((r) => ({
      tradeId: r.exportId,
      symbol: r.symbol,
      source: r.source === "real" ? "Real Market" : r.isDailyReplay ? "Daily Replay / Backtest" : "Simulator",
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
  /** Whether decision_timeline.csv is actually in this package (the
   *  panel toggle) — the prompt lists only files that exist. */
  timelineIncluded?: boolean;
  /** Whether chart_context.csv is actually in this package
   *  (Representative plan §5 S1.2) — the chart-analysis section and
   *  the file list appear only when the evidence exists. */
  chartContextIncluded?: boolean;
  /** Whether at least one Daily Replay representative screenshot is
   *  included in this package. */
  representativeIncluded?: boolean;
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
  const hasDr = snapshot.dailyReplay != null;
  const files = [
    "trades.csv - one row per trade (raw evidence)",
    "analytics.json - Grow Green Lab's calculated metrics, breakdowns and Edge Finder output",
    ...(ctx.pdfIncluded ? ["Trading_Report.pdf - the visual summary report"] : []),
    "README.txt - package guide, column definitions and methodology",
    ...(hasDr ? [
      ...(ctx.timelineIncluded === false ? [] : ["decision_timeline.csv - the Daily Replay Decision Timeline: every recorded decision event for the included attempts, with both market time (historical, Eastern) and wall-clock time (when the trader acted)"]),
      "strategy.json - the immutable strategy versions the included attempts were bound to, exactly as recorded before they ran",
      ...(ctx.chartContextIncluded ? ["chart_context.csv - per-trade historical OHLCV for the included Daily Replay trades, sectioned at the entry candle: entry_context holds ONLY the candles completed before the entry candle, entry_candle_final is the entry candle's final OHLCV (it was still forming at the fill), and post_entry_development holds the candles while the position was open. Entry judgments may use entry_context only - see the chart-analysis section below."] : []),
    ] : []),
    ...(coverage.screenshotFiles > 0 ? [`screenshots/ - ${coverage.screenshotFiles} trade screenshot(s), named by stable trade ID`] : []),
  ];
  return `You are analyzing my trading performance using a Grow Green Lab AI Edge Analysis package.

Use the included trades.csv, analytics.json${ctx.pdfIncluded ? ", Trading_Report.pdf" : ""} and screenshots to analyze my actual trading behavior and identify evidence-supported opportunities to improve my edge.

Do not assume that every supplied metric is correct without checking definitions and consistency. Where possible, reconcile raw trade records with aggregated analytics.

PACKAGE FACTS (generated by Grow Green Lab - treat these as the evidence boundary)
- Date range: ${formatRangeText(snapshot.range, snapshot.periodMode)}
- Trade source: ${sourceLabel(snapshot.source)}
- Trades included: ${snapshot.counts.total} total (${snapshot.counts.closed} closed, ${snapshot.counts.open} open) - ${snapshot.counts.real} Real Market, ${snapshot.counts.simulator - snapshot.counts.dailyReplay} Simulator, ${snapshot.counts.dailyReplay} Daily Replay / Backtest
- Closed-trade results: net realized P&L ${money(overall.netRealizedPnl)}, win rate ${overall.winRate == null ? "n/a" : overall.winRate.toFixed(1) + "%"}, expectancy ${money(overall.expectancy)} per trade, average R ${overall.avgR == null ? "n/a (no recorded stops)" : overall.avgR.toFixed(2) + "R over " + overall.tradesWithR + " trades with a recorded stop"}
- Screenshots: ${coverage.note}
- Files in this package:
${files.map((f) => `  * ${f}`).join("\n")}
- Data that is NOT available in this package (do not invent it): ${unavailable.map((u) => u.label).join("; ")}. Full reasons are in analytics.json under metadata.metricsUnavailable, and missing-data counts under metadata.missingDataSummary.
- Daily Replay trades in this export are FINALIZED trades only — unfinalized drafts are excluded by design and never appear in any file in this package.
- Daily Replay screenshots: each Daily Replay trade contributes ONE representative screenshot (see screenshots-manifest.json for its recorded source and candle). An auto-captured representative shows the chart as staged at the entry fill; the entry candle was still forming when it was captured. The trade's other screenshots stay in the journal and are listed in the manifest as not-included.
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
${hasDr ? `
DAILY REPLAY & STRATEGY EVIDENCE (this package includes Daily Replay backtest trades, decision_timeline.csv and strategy.json):

16. Evaluate the QUALITY and QUANTITY of the evidence behind every conclusion: state the sample size (attempts and trades per strategy version) next to each claim. A version tested on a handful of attempts is a small sample, not a proven edge.
17. Separate STRATEGY quality from EXECUTION quality: compare each trade against its bound strategy version's recorded rules (strategy.json) and its Decision Timeline (decision_timeline.csv). A sound strategy executed poorly and a weak strategy executed well are different findings - say which you found, with trade IDs.
18. Address overfitting, survivorship and selection limits explicitly: only completed attempts and closed trades are exported (abandoned attempts and open positions are not performance evidence), the trader chose which days and tickers to replay, and the results cover only the market regimes present on those historical days.
19. Present every proposed rule change as a HYPOTHESIS, and attach to each hypothesis a SEPARATE validation test: what would be replayed, on what data, over how many attempts, and what result would confirm or refute it.
20. Do not claim statistical significance without an adequate sample and a stated basis. When the evidence cannot support a conclusion, say so plainly instead of filling the gap.
21. NEVER modify, rewrite or "improve" a strategy version: versions are immutable records. Propose changes only as a NEW version the trader can create and test - your output must not present an edited version as if it were the recorded one.
22. Daily Replay results are historical simulations (backtests), not live trading results and not a guarantee of future performance. In decision_timeline.csv, market_time is the historical candle time (Eastern) and wall_time is when the trader actually acted - never mix the two clocks.
` : ""}${(ctx.chartContextIncluded || ctx.representativeIncluded) ? `
REPRESENTATIVE SCREENSHOT & CHART ANALYSIS (a supplement to the rules above, not a continuation of them — it applies only to Daily Replay trades with a representative screenshot and/or rows in chart_context.csv):

- Observations first: state only what is directly visible in the representative screenshot or directly readable from chart_context.csv — price location versus the prior candles, candle sizes, the volume pattern.
- Interpretations second, separately labelled, each tied to the observation it rests on. Never present an interpretation as a recorded fact.
- For each such trade, use chart_context.csv's entry_context (the candles completed BEFORE the entry candle) together with the representative screenshot to assess: the trend structure before the entry (higher highs/higher lows versus lower highs/lower lows) and any consolidation; whether the entry was at, near, or away from the session high (HOD) and prior resistance; whether a breakout had formed on completed candles or was only anticipated on a still-forming candle; whether volume expanded into the entry relative to the prior completed candles; and whether the entry supported the trader's stated setup (trades.csv setup + entry_reasoning) or contradicted it. Classify any HOD breakout as clean, weak, or failed ONLY from completed pre-entry candles and the screenshot. End with one verdict per trade: the pre-entry structure SUPPORTED the stated setup, CONTRADICTED it, or the evidence is INSUFFICIENT — citing the candle times you relied on.
- No-hindsight rule: judge the entry decision ONLY from entry_context and the representative image. entry_candle_final is the entry candle's FINAL OHLCV — the candle was still forming at the fill, so its final values were not known at entry. post_entry_development may be discussed only as post-entry development (what happened while the position was open), never as evidence for or against the entry decision itself.
- No invented levels: do not state support, resistance, VWAP, EMA or any other level unless it is visible in the screenshot or derivable from the supplied OHLCV. If a level cannot be verified from the supplied evidence, say so instead of estimating one.
- Missing evidence: if a trade has no representative screenshot or no chart_context.csv rows, say the chart analysis is unavailable for that trade instead of reconstructing the chart from price summaries.
` : ""}
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
  /** Whether decision_timeline.csv is actually in this package. */
  timelineIncluded?: boolean;
  /** Whether chart_context.csv is actually in this package
   *  (Representative plan §5 S1.2). */
  chartContextIncluded?: boolean;
}

const CSV_COLUMN_DOCS: [string, string][] = [
  ["trade_id", "Stable trade identifier (TRADE-<id>). The same trade always exports under the same ID; screenshot files and analytics tradeIds use it."],
  ["symbol", "Ticker symbol."],
  ["source", "Real Market, Simulator, or Daily Replay / Backtest - from the journal's authoritative source fields (session source + attempt link), never inferred."],
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
  ["stop_loss_current / target_current", "The trade's stop loss / target in force at close (real trades; for Daily Replay trades, the levels in force when the position closed, from the attempt's recorded bracket events). Empty for Trade Lab simulator trades and when never set."],
  ["original_stop_loss / original_target", "The ORIGINAL planned stop/target: for real trades, preserved set-once by the journal (plan changes never overwrite these); for Daily Replay trades, the levels captured by the risk snapshot recorded at the first entry fill. Empty when no plan was ever recorded - never reconstructed."],
  ["plan_change_count / plan_history", "Number of recorded stop/target changes and the change log (field: from -> to @ timestamp). For Daily Replay trades these are the recorded bracket adjustments made while the position was open."],
  ["initial_risk_usd", "Initial risk in dollars. Real trades: |average entry - original planned stop (or recorded stop when no original exists)| x entry quantity. Daily Replay trades: the planned risk recorded by the risk snapshot at the first entry fill (first-fill quantity basis - see risk_basis). Empty when no valid risk figure was recorded."],
  ["r_multiple", "Net realized P&L / initial risk. Empty when initial risk is unavailable - a missing R is never exported as 0."],
  ["risk_basis", "Plain-language statement of exactly how this trade's R was (or could not be) calculated."],
  ["fees_usd", "Total recorded fees (real trades, summed from fills). EMPTY for simulator and Daily Replay trades: neither has a fee model, so fees are unknown - not zero."],
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
  ["daily_replay_attempt_id", "Schema 2.0: the Daily Replay attempt that produced this trade. Empty for real and Trade Lab simulator trades. Joins to decision_timeline.csv (attempt_id) and strategy.json."],
  ["strategy_name", "Schema 2.0: name of the strategy the trade's attempt was bound to at lock time. For real trades this is the trade's recorded strategy text. Empty when no strategy was recorded."],
  ["strategy_version", "Schema 2.0: the immutable strategy VERSION number the attempt was bound to (e.g. 2 means version 2). Empty when the attempt recorded no strategy version."],
  ["strategy_version_id", "Schema 2.0: stable ID of that strategy version - joins to strategy.json. Empty when no version was bound."],
];

export function buildReadme(
  snapshot: ExportSnapshot,
  coverage: ScreenshotCoverage,
  manifest: ScreenshotManifestEntry[],
  ctx: ReadmeContext,
): string {
  const unavailable = metricsUnavailableList(snapshot);
  const hasDr = snapshot.dailyReplay != null;
  const includedFiles = [
    "trades.csv",
    "analytics.json",
    ...(ctx.pdfIncluded ? ["Trading_Report.pdf"] : []),
    "ChatGPT_Prompt.txt",
    "README.txt (this file)",
    "screenshots-manifest.json",
    ...(hasDr ? [...(ctx.timelineIncluded === false ? [] : ["decision_timeline.csv"]), "strategy.json", ...(ctx.chartContextIncluded ? ["chart_context.csv"] : [])] : []),
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
    `- Trades: ${snapshot.counts.total} total (${snapshot.counts.closed} closed, ${snapshot.counts.open} open) - ${snapshot.counts.real} Real Market, ${snapshot.counts.simulator - snapshot.counts.dailyReplay} Simulator, ${snapshot.counts.dailyReplay} Daily Replay / Backtest`,
    `- Screenshots: ${coverage.note}`,
    ...(ctx.pdfFailureNote ? [`- PDF: ${ctx.pdfFailureNote}`] : []),
    ...(snapshot.source === "all" ? ["- MIXED SOURCE: this package contains both Real Market and Simulator trades. Per-source results are kept separate in analytics.json (perSource); combined figures are labeled mixed-source."] : []),
    "",
    "FILE INVENTORY",
    ...includedFiles.map((f) => `- ${f}`),
    "",
    "SCHEMA 2.0 - WHAT CHANGED (COMPATIBILITY)",
    "Schema 2.0 extends the 1.0 package additively; nothing a 1.0 reader relies on was removed or redefined:",
    "- trades.csv keeps its original 46 columns first, in the same order, with four Daily Replay columns appended (daily_replay_attempt_id, strategy_name, strategy_version, strategy_version_id). The source column can now also read \"Daily Replay / Backtest\".",
    "- analytics.json gains a dailyReplay block (per-attempt results and bound strategies) and two new breakdown dimensions (strategy, strategyVersion). counts gains a dailyReplay field (a subset of simulator, its coarse class).",
    "- decision_timeline.csv and strategy.json are new files, present only when Daily Replay trades are in the selection.",
    "- Daily Replay trades can now carry screenshots (journal-attached, like real trades) and recorded original plans (from the risk snapshot at entry). Trade Lab simulator trades are unchanged: no screenshots, no original plan, R unavailable.",
    "- Representative screenshots (additive within schema 2.0): each Daily Replay trade contributes ONE representative screenshot — its recorded entry-time capture, or one the trader explicitly selected — identified in screenshots-manifest.json by role, representativeSource, candleIndex and candleTime. The trade's other screenshots stay in the journal and are listed in the manifest as not-included. chart_context.csv (when present) carries the trade's stored OHLCV sectioned at the entry candle: entry_context (candles completed before the entry), entry_candle_final (the entry candle's final OHLCV, finalized after the fill) and post_entry_development (candles while the position was open).",
    ...(hasDr ? [
      "",
      "DAILY REPLAY IN THIS PACKAGE",
      "Daily Replay trades are BACKTESTS: historical simulations over recorded market days. They are not live trading results and not a guarantee of future performance.",
      "- Identity: every Daily Replay trade carries its attempt ID (trades.csv daily_replay_attempt_id) and, when one was bound at lock time, its strategy name + immutable version. Attempts locked without a strategy honestly show none.",
      "- Original plan + R: derived ONLY from the risk snapshot recorded at the first entry fill of each position (plus the bracket adjustments recorded while it was open). Trades whose cycle has no valid snapshot export R as unavailable - it is never reconstructed after the fact.",
      "- Fees: Daily Replay has no fee or slippage model. fees_usd is empty (unknown), never zero.",
      "- decision_timeline.csv: one row per recorded event for the included attempts. trade_id attributes an event to the trade whose position cycle contains it (empty for attempt-level events and for a position still open at completion). market_time is the historical candle time (Eastern); wall_time is the real time the action happened. The two clocks are never mixed. payload_json is the recorded payload verbatim.",
      "- strategy.json: only the strategies/versions the included attempts reference, with the attempt IDs bound to each version. Versions are immutable - a suggested rule change is a hypothesis for a NEW version, never an edit.",
    ] : []),
    "",
    "TRADES.CSV - COLUMN DEFINITIONS",
    "One row per trade. Missing values are EMPTY fields - the platform never substitutes zero for missing data and never invents values.",
    ...CSV_COLUMN_DOCS.map(([c, d]) => `- ${c}: ${d}`),
    "",
    "ANALYTICS.JSON - SCHEMA AND METRIC DEFINITIONS",
    "Top-level sections: metadata (selection, counts, definitions, missing-data summary, screenshot manifest, Edge Finder configuration), overall, perSource (only when All Trades is selected), dailyReplay (per-attempt results; unavailable flag when no Daily Replay trades are selected), breakdowns (15 dimensions), dailyPnl, performanceByDayOfWeek, entryExit, riskPsychology, edgeFinder, simulator, tradesIndex.",
    "All metrics are computed by the same functions the journal Analytics tab uses (lib/journalAnalytics.ts + lib/journal.ts), on the same trade set, so the export and the UI agree.",
    ...Object.entries(METRIC_DEFINITIONS).map(([k, v]) => `- ${k}: ${v}`),
    "Non-finite values: JSON cannot represent unbounded numbers. An unbounded metric (e.g. profit factor with winners and no losers) is serialized as null with a sibling \"<metric>Unbounded\": true flag.",
    "",
    "ROUNDING & RECONCILIATION",
    ROUNDING_NOTE,
    "",
    "SCREENSHOT MANIFEST",
    "screenshots-manifest.json lists every screenshot considered for this package: owning stable trade ID, symbol, package-relative file name, and status (included / unavailable / not-included). The same manifest is embedded in analytics.json (metadata.screenshotManifest).",
    "PRIVACY: raw storage paths are intentionally NOT included anywhere in this package. Storage paths contain the account's internal identifiers (account UUID and internal object names), so they stay inside the application; screenshots are identified only by stable trade ID and package-relative file name.",
    "Screenshots are typed \"trade-screenshot\": the platform does not record whether a screenshot was taken at entry, exit, or review, and the export does not guess from file names. Exception (schema 2.0 representative data): for Daily Replay trades the manifest records the representative image's role, source and candle index from the draft record; non-representative attachments remain untyped.",
    coverage.note,
    ...(manifest.length === 0 ? ["No screenshot entries were recorded for this package."] : []),
    "",
    "MISSING DATA AND KNOWN LIMITATIONS",
    "- Daily Replay trades in this export are FINALIZED trades only — unfinalized drafts are excluded by design and never appear in any file in this package.",
    "- Daily Replay representative screenshots: an auto-captured representative shows the chart as staged at the entry fill; the entry candle was still forming when captured. A user-selected representative is labelled user_selected in the manifest and may have been captured at review time — the prompt separates entry-time evidence from later images.",
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
