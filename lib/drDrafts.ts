/**
 * drDrafts.ts — per-cycle durable drafts for Daily Replay trades.
 *
 * A draft is a thin index + status layer over data that already
 * exists: identity, lifecycle status, and reconciliation anchors for
 * one closed position cycle of one attempt. Fills, timeline, plan
 * evidence and R are never stored here — they keep being DERIVED by
 * the shipped modules from the attempt's events (pre-completion) or
 * the session's fills (post-completion).
 *
 * Identity (plan §2, option b): a draft is born before any journal
 * session exists, so its key is attempt-scoped:
 *   dr:{attempt_id}:g{reset_generation}:c{cycle_index}
 * where cycle_index is the 1-based close order WITHIN its reset
 * generation (see splitCyclesByGeneration in lib/drTradeEvidence.ts —
 * the one shared cycle splitter; a session_reset wipes engine fills,
 * so only final-generation cycles can ever map to journal trades and
 * earlier-generation drafts become "superseded", never finalizable).
 * At attempt completion the reconciler records the draft's
 * finalized_session_id + finalized_trade_key ({session_id}:{seq});
 * the session-scoped key stays canonical for the journal.
 *
 * Finalization (plan §3, AMENDED by the 2026-10-18 workflow fix at
 * the user's explicit direction): finalize is a durable FLAG on the
 * draft row only — it never writes journal rows. A FINALIZED draft's
 * trade is journal-visible IMMEDIATELY, even while its attempt is
 * still active: the journal builds a pre-completion row from the
 * attempt's events + the draft's anchors (buildPreCompletionTrade
 * below), keyed by the draft key. When the attempt completes, the
 * session-sourced canonical row REPLACES the pre-completion row (the
 * journal builds pre-completion rows only for attempts with no
 * session, so the two can never coexist) and computeDrExclusions
 * keeps encoding the post-completion read-side rule: a completed
 * attempt's cycle trade is visible iff no draft row exists
 * (legacy/pre-feature attempts, unchanged) OR its draft is
 * finalized.
 *
 * Writer durability (plan §4.4): upsertDraft is FIRST-WRITE-WINS for
 * anchors and status. It inserts with ignoreDuplicates on the
 * (attempt_id, reset_generation, cycle_index) unique key and then
 * reads the row back; if the row already existed, nothing is
 * overwritten — the anchors are immutable facts of the close and a
 * re-delivered close from a stale writer must never un-finalize a
 * draft or rewrite its anchors. The one mutable payload after first
 * write is auto_capture, patched separately through
 * updateDraftAutoCapture (auto-capture outcomes land after the draft
 * row itself). The `preserveStatus` option on upsertDraft is accepted
 * for call-site clarity; the first-write-wins flow preserves status
 * unconditionally, so the option changes nothing today.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DrEvent } from "./dailyReplayEvents";
import { parseQuotaError, quotaMessage } from "./entitlements";
import type { GroupedTrade, RawFill } from "./journal";
import {
  splitCyclesByGeneration,
  verifyCycleTradePair,
  type DrCycleInfo,
} from "./drTradeEvidence";

export type DrDraftStatus = "draft" | "finalized" | "superseded";

export interface DrDraftRow {
  id: string;
  userId: string;
  attemptId: string;
  resetGeneration: number;
  cycleIndex: number;
  draftKey: string;
  status: DrDraftStatus;
  firstFillCandleIndex: number;
  firstFillPrice: number;
  firstFillQty: number;
  closeFillCandleIndex: number;
  realizedPnl: number;
  eventFirstSeq: number;
  eventLastSeq: number;
  autoCapture: Record<string, unknown>;
  finalizedSessionId: string | null;
  finalizedTradeKey: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The snake_case upsert payload (no id / user_id / created_at). */
export interface DrDraftPayload {
  attempt_id: string;
  reset_generation: number;
  cycle_index: number;
  draft_key: string;
  status: DrDraftStatus;
  first_fill_candle_index: number;
  first_fill_price: number;
  first_fill_qty: number;
  close_fill_candle_index: number;
  realized_pnl: number;
  event_first_seq: number;
  event_last_seq: number;
  auto_capture: Record<string, unknown>;
}

const TABLE = "daily_replay_trade_drafts";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Map a raw daily_replay_trade_drafts row (snake_case) to DrDraftRow. */
export function mapDraftRow(r: Record<string, unknown>): DrDraftRow {
  const status = r.status === "finalized" || r.status === "superseded" ? r.status : "draft";
  return {
    id: String(r.id ?? ""),
    userId: String(r.user_id ?? ""),
    attemptId: String(r.attempt_id ?? ""),
    resetGeneration: num(r.reset_generation),
    cycleIndex: num(r.cycle_index),
    draftKey: String(r.draft_key ?? ""),
    status,
    firstFillCandleIndex: num(r.first_fill_candle_index),
    firstFillPrice: num(r.first_fill_price),
    firstFillQty: num(r.first_fill_qty),
    closeFillCandleIndex: num(r.close_fill_candle_index),
    realizedPnl: num(r.realized_pnl),
    eventFirstSeq: num(r.event_first_seq),
    eventLastSeq: num(r.event_last_seq),
    autoCapture:
      r.auto_capture && typeof r.auto_capture === "object" && !Array.isArray(r.auto_capture)
        ? (r.auto_capture as Record<string, unknown>)
        : {},
    finalizedSessionId: strOrNull(r.finalized_session_id),
    finalizedTradeKey: strOrNull(r.finalized_trade_key),
    finalizedAt: strOrNull(r.finalized_at),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

export function draftKeyFor(attemptId: string, generation: number, cycleIndex: number): string {
  return `dr:${attemptId}:g${generation}:c${cycleIndex}`;
}

/**
 * Build the upsert payload for one CLOSED cycle. The status is
 * "superseded" when the cycle belongs to an earlier generation than
 * the stream's last (its fills were wiped by a reset and will never
 * reach session_trades), otherwise "draft".
 */
export function buildDraftPayload(
  attemptId: string,
  cycle: DrCycleInfo,
  lastGeneration: number,
): DrDraftPayload {
  const ff = cycle.firstFill;
  const close = cycle.closeEvent;
  if (!ff || !close) {
    throw new Error("buildDraftPayload: cycle is not closed (no first fill or no position_closed event)");
  }
  // The closing fill is the cycle's last order_filled event: the
  // recorder emits order_filled (sell) immediately before
  // position_closed for that same fill.
  let closingFill: DrEvent | null = null;
  for (const e of cycle.events) if (e.type === "order_filled") closingFill = e;
  const closeCandle =
    close.marketIdx ?? (closingFill ? num(closingFill.payload.candleIndex) : 0);
  return {
    attempt_id: attemptId,
    reset_generation: cycle.generation,
    cycle_index: cycle.cycleIndex,
    draft_key: draftKeyFor(attemptId, cycle.generation, cycle.cycleIndex),
    status: cycle.generation < lastGeneration ? "superseded" : "draft",
    first_fill_candle_index: num(ff.payload.candleIndex),
    first_fill_price: num(ff.payload.price),
    first_fill_qty: num(ff.payload.qty),
    close_fill_candle_index: closeCandle,
    realized_pnl: cycle.realizedSum,
    event_first_seq: cycle.events[0].seq,
    event_last_seq: close.seq,
    auto_capture: {},
  };
}

/** Every closed cycle of the stream, in close order, as payloads. */
export function draftsForAttempt(attemptId: string, events: DrEvent[]): DrDraftPayload[] {
  const { cycles, lastGeneration } = splitCyclesByGeneration(events);
  return cycles
    .filter((c) => c.closed)
    .map((c) => buildDraftPayload(attemptId, c, lastGeneration));
}

/** The last closed cycle in the stream (the live writer's trigger). */
export function latestClosedCycle(events: DrEvent[]): DrCycleInfo | null {
  const { cycles } = splitCyclesByGeneration(events);
  for (let i = cycles.length - 1; i >= 0; i--) {
    if (cycles[i].closed) return cycles[i];
  }
  return null;
}

/* ================= Reconciliation (completion-time) ================= */

export interface ReconcileMapping {
  /** Existing draft row id; "" when the mapping targets a draft that
   *  `creates` will insert — resolve it by draftKey after insert. */
  draftId: string | null;
  draftKey: string;
  finalizedSessionId: string;
  finalizedTradeKey: string;
}

export interface ReconcilePlan {
  mappings: ReconcileMapping[];
  creates: DrDraftPayload[];
  supersedeDraftIds: string[];
}

/**
 * Pure reconciler: given an attempt's events, its grouped journal
 * trades (post-completion), and its current draft rows, compute the
 * writes that link final-generation drafts to their journal trades.
 * Idempotent — running it over the post-state yields an empty plan.
 *
 * Rules: final-generation closed cycles pair ordinally with trades;
 * a pair maps ONLY when verifyCycleTradePair passes (anchors agree);
 * the mapping target is the existing draft for that (generation,
 * cycleIndex), written only when its finalized_trade_key is
 * null/different; when no such draft exists, allowCreate permits a
 * create (a plain "draft" payload) plus a mapping keyed by draftKey;
 * drafts of earlier generations still in "draft" status are listed
 * for superseding.
 */
export function reconcileDrafts(input: {
  attemptId: string;
  sessionId: string;
  events: DrEvent[];
  trades: GroupedTrade[];
  drafts: DrDraftRow[];
  allowCreate: boolean;
}): ReconcilePlan {
  const { attemptId, sessionId, trades, drafts, allowCreate } = input;
  const { cycles, lastGeneration } = splitCyclesByGeneration(input.events);
  const finalCycles = cycles.filter((c) => c.closed && c.generation === lastGeneration);
  const own = drafts.filter((d) => d.attemptId === attemptId);

  const mappings: ReconcileMapping[] = [];
  const creates: DrDraftPayload[] = [];

  const pairs = Math.min(finalCycles.length, trades.length);
  for (let i = 0; i < pairs; i++) {
    const cycle = finalCycles[i];
    const trade = trades[i];
    if (!verifyCycleTradePair(cycle, trade)) continue;
    const existing = own.find(
      (d) => d.resetGeneration === lastGeneration && d.cycleIndex === cycle.cycleIndex,
    );
    if (existing) {
      if (existing.finalizedTradeKey !== trade.tradeKey || existing.finalizedSessionId !== sessionId) {
        mappings.push({
          draftId: existing.id,
          draftKey: existing.draftKey,
          finalizedSessionId: sessionId,
          finalizedTradeKey: trade.tradeKey,
        });
      }
    } else if (allowCreate) {
      const payload = buildDraftPayload(attemptId, cycle, lastGeneration);
      creates.push(payload);
      mappings.push({
        draftId: "",
        draftKey: payload.draft_key,
        finalizedSessionId: sessionId,
        finalizedTradeKey: trade.tradeKey,
      });
    }
  }

  const supersedeDraftIds = own
    .filter((d) => d.resetGeneration < lastGeneration && d.status === "draft")
    .map((d) => d.id);

  return { mappings, creates, supersedeDraftIds };
}

/* ================= Journal read-side exclusion ================= */

/**
 * Which journal trades the unified list must EXCLUDE because their
 * Daily Replay draft is still unfinalized ("draft"). A trade matches
 * its draft by finalized_trade_key first (the durable link), else by
 * (attempt, final generation, cycle sequence) — the same coordinates
 * the draft was born with. Finalized drafts, superseded drafts (they
 * belong to earlier generations and never match a final-generation
 * trade by coordinates), trades with no attempt, and trades of an
 * attempt with NO drafts at all (pre-drafts-era legacy) are included.
 *
 * MISSING-DRAFT RULE (quota gap fix, 2026-10-19): when the attempt
 * HAS drafts but this cycle matches none of them, the cycle's draft
 * row was never created — its insert was refused (the daily-quota
 * trigger raises on cycles past the free daily cap, so every cycle
 * after the cap on a busy day is born draft-less) or the best-effort
 * writer failed silently. Completion (dr_complete_attempt) consumes
 * no quota by design, so such a trade used to become a journal entry
 * at completion with NO monthly_entry ever consumed and no draft to
 * finalize — the free monthly wall could never fire for it. Under
 * the finalization-gates-visibility rule it is therefore excluded
 * like any unfinalized cycle until a draft exists and is finalized;
 * the completion/journal reconcile passes create the missing draft
 * (allowCreate for attempts that have drafts), so the trade reaches
 * Needs Review, finalizes through the quota trigger, and only then
 * appears — counted exactly once, at finalize.
 */
export function computeDrExclusions(input: {
  trades: { tradeKey: string; attemptId: string | null }[];
  drafts: DrDraftRow[];
  resetCounts: Map<string, number>;
}): Set<string> {
  const excluded = new Set<string>();
  const byAttempt = new Map<string, DrDraftRow[]>();
  for (const d of input.drafts) {
    if (!byAttempt.has(d.attemptId)) byAttempt.set(d.attemptId, []);
    byAttempt.get(d.attemptId)!.push(d);
  }
  for (const t of input.trades) {
    if (!t.attemptId) continue;
    const rows = byAttempt.get(t.attemptId);
    if (!rows || rows.length === 0) continue;
    let matched = rows.find((d) => d.finalizedTradeKey === t.tradeKey) ?? null;
    if (!matched) {
      const seq = Number.parseInt(t.tradeKey.slice(t.tradeKey.lastIndexOf(":") + 1), 10);
      if (!Number.isFinite(seq)) continue;
      const finalGen = input.resetCounts.get(t.attemptId) ?? 0;
      matched =
        rows.find((d) => d.resetGeneration === finalGen && d.cycleIndex === seq) ?? null;
    }
    if (matched && matched.status === "draft") excluded.add(t.tradeKey);
    // Missing-draft rule (see header): the attempt lives in the
    // drafts era (it has draft rows) but this cycle has none — its
    // draft insert was refused or lost, so it is NOT finalized and
    // must not surface as an (uncounted) journal entry. Excluded
    // until the reconcile passes create its draft and the user
    // finalizes it through the quota trigger.
    if (!matched) excluded.add(t.tradeKey);
  }
  return excluded;
}

/* ================= Draft list counts ================= */

/**
 * The ONE aggregation behind the drafts card header and the journal's
 * "Daily Replay Drafts" source chip. The card lists EVERY draft row
 * (open, finalized, superseded), so `total` is always the list length
 * — the two surfaces can never disagree with the list again (the
 * reported defect: header/chip counted only status="draft", rendering
 * one finalized draft as "0 drafts" above a list of one). The
 * unfinalized remainder is exposed separately as `toReview` and is
 * labeled as such in the UI, never used as the headline count.
 * `isSupersededDisplay` is the caller's display-status derivation (a
 * stored-"draft" row from a pre-reset generation of a finished attempt
 * displays as superseded), keeping display truth in one place.
 */
export interface DraftListCounts {
  total: number;
  toReview: number;
  finalized: number;
  superseded: number;
}

export function draftListCounts(
  drafts: DrDraftRow[],
  isSupersededDisplay: (d: DrDraftRow) => boolean,
): DraftListCounts {
  let toReview = 0;
  let finalized = 0;
  let superseded = 0;
  for (const d of drafts) {
    if (isSupersededDisplay(d)) { superseded++; continue; }
    if (d.status === "finalized") finalized++;
    else if (d.status === "draft") toReview++;
  }
  return { total: drafts.length, toReview, finalized, superseded };
}

/* ================= DB helpers (thin, owner-RLS) ================= */

/**
 * Insert a draft if new; NEVER overwrite an existing row (see the
 * header note: first-write-wins for anchors + status). Returns the
 * resulting row, read back by its unique key.
 */
export async function upsertDraft(
  client: SupabaseClient,
  userId: string,
  payload: DrDraftPayload,
  opts?: { preserveStatus?: boolean },
): Promise<{ data: DrDraftRow | null; error: unknown }> {
  void opts; // first-write-wins preserves status unconditionally
  const { error } = await client.from(TABLE).upsert(
    { ...payload, user_id: userId, updated_at: new Date().toISOString() },
    { onConflict: "attempt_id,reset_generation,cycle_index", ignoreDuplicates: true },
  );
  if (error) return { data: null, error };
  const { data, error: readError } = await client
    .from(TABLE)
    .select("*")
    .eq("attempt_id", payload.attempt_id)
    .eq("reset_generation", payload.reset_generation)
    .eq("cycle_index", payload.cycle_index)
    .maybeSingle();
  if (readError || !data) return { data: null, error: readError ?? null };
  return { data: mapDraftRow(data as Record<string, unknown>), error: null };
}

/** Patch ONLY auto_capture (+ updated_at) on an existing draft. */
export async function updateDraftAutoCapture(
  client: SupabaseClient,
  draftId: string,
  autoCapture: Record<string, unknown>,
): Promise<{ error: unknown }> {
  const { error } = await client
    .from(TABLE)
    .update({ auto_capture: autoCapture, updated_at: new Date().toISOString() })
    .eq("id", draftId);
  return { error: error ?? null };
}

export async function fetchDraftsForAttempts(
  client: SupabaseClient,
  attemptIds: string[],
): Promise<DrDraftRow[]> {
  if (attemptIds.length === 0) return [];
  const { data, error } = await client
    .from(TABLE)
    .select("*")
    .in("attempt_id", attemptIds)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapDraftRow);
}

/** The caller's drafts (owner RLS scopes the result), newest first. */
export async function fetchDraftsForUser(client: SupabaseClient): Promise<DrDraftRow[]> {
  const { data, error } = await client
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapDraftRow);
}

/** Finalize one draft. Guarded on status='draft', so a repeat call
 *  affects 0 rows — returns the affected-row count. Other errors
 *  keep the historical swallow-to-0 behavior, EXCEPT a subscription
 *  quota rejection (subscriptions-v1 finalize trigger): that one
 *  THROWS a user-readable Error so every finalize surface can show
 *  the limit + upgrade message instead of a false "did not land". */
export async function finalizeDraft(client: SupabaseClient, draftId: string): Promise<number> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from(TABLE)
    .update({ status: "finalized", finalized_at: now, updated_at: now })
    .eq("id", draftId)
    .eq("status", "draft")
    .select();
  if (error) {
    const q = parseQuotaError(error);
    if (q) throw new Error(quotaMessage(q));
    return 0;
  }
  if (!data) return 0;
  return (data as unknown[]).length;
}

/** Supersede one draft (same status guard as finalize). */
export async function supersedeDraft(client: SupabaseClient, draftId: string): Promise<number> {
  const { data, error } = await client
    .from(TABLE)
    .update({ status: "superseded", updated_at: new Date().toISOString() })
    .eq("id", draftId)
    .eq("status", "draft")
    .select();
  if (error || !data) return 0;
  return (data as unknown[]).length;
}

/**
 * Record a draft's finalized session/trade link. `draftKeyOrId` is a
 * draft_key when it starts with "dr:" and a row id otherwise. Only
 * writes where finalized_trade_key is still null — a recorded link is
 * never rewritten. Returns the affected-row count.
 */
export async function writeDraftMapping(
  client: SupabaseClient,
  draftKeyOrId: string,
  sessionId: string,
  tradeKey: string,
): Promise<number> {
  const byKey = draftKeyOrId.startsWith("dr:");
  const { data, error } = await client
    .from(TABLE)
    .update({
      finalized_session_id: sessionId,
      finalized_trade_key: tradeKey,
      updated_at: new Date().toISOString(),
    })
    .is("finalized_trade_key", null)
    .eq(byKey ? "draft_key" : "id", draftKeyOrId)
    .select();
  if (error || !data) return 0;
  return (data as unknown[]).length;
}

/* ================================================================== */
/* Pre-completion journal rows (finalized ⇒ visible, 2026-10-18)      */
/* ================================================================== */

/** Tolerances for reconciling a cycle against its draft's recorded
 *  anchors — the same cent-level slack verifyCycleTradePair uses for
 *  the post-completion pairing (REALIZED_EPS there). */
const ANCHOR_PRICE_EPS = 0.011;
const ANCHOR_PNL_EPS = 0.011;

/**
 * Build a journal GroupedTrade for one CLOSED cycle purely from its
 * recorded events — the pre-completion twin of groupFillsIntoTrades.
 * Fills come from the cycle's order_filled events in seq order; a
 * sell fill's realized_pnl is the realizedPnl of the exit event the
 * recorder emits immediately after that fill (partial_exit /
 * position_closed — the same pairing buildDraftPayload relies on).
 * Entry/exit are qty-weighted averages and realizedPnl is the
 * cycle's recorded realized sum, exactly the conventions the
 * session-sourced rows use. sessionId is "" — no session exists yet;
 * callers must treat "" as "no session" (never a real session id).
 * Returns null for an open cycle or a cycle without fills — never a
 * fabricated row.
 */
export function groupedTradeFromCycle(
  cycle: DrCycleInfo,
  meta: { tradeKey: string; ticker: string; tradeDate: string },
): GroupedTrade | null {
  if (!cycle.closed) return null;
  const fills: RawFill[] = [];
  let unassignedSell: RawFill | null = null;
  for (const e of cycle.events) {
    if (e.type === "order_filled") {
      const side = e.payload.side === "sell" ? "sell" : "buy";
      const qty = typeof e.payload.qty === "number" ? e.payload.qty : 0;
      const price = typeof e.payload.price === "number" ? e.payload.price : 0;
      if (!(qty > 0) || !(price > 0)) continue;
      const candleTime = e.marketTs != null ? new Date(e.marketTs).toISOString() : null;
      const fill: RawFill = {
        id: `${meta.tradeKey}:f${e.seq}`,
        session_id: "",
        side,
        qty,
        price,
        candle_index: typeof e.payload.candleIndex === "number" ? e.payload.candleIndex : (e.marketIdx ?? 0),
        candle_time: candleTime,
        realized_pnl: 0,
        created_at: candleTime ?? new Date(e.wallTs).toISOString(),
      };
      fills.push(fill);
      if (side === "sell") unassignedSell = fill;
    } else if (e.type === "partial_exit" || e.type === "position_closed") {
      if (unassignedSell && typeof e.payload.realizedPnl === "number") {
        unassignedSell.realized_pnl = e.payload.realizedPnl;
        unassignedSell = null;
      }
    }
  }
  // The Daily Replay engine is long-only: a cycle can never
  // legitimately sell more than it bought. Excess sells prove a
  // buy fill is missing from the stream — the cycle's shape cannot
  // be trusted, so no row is built from it (the draft-window
  // fallback applies the same test more strictly).
  let bq = 0, sq = 0;
  for (const f of fills) { if (f.side === "buy") bq += f.qty; else sq += f.qty; }
  if (sq > bq) return null;
  return assembleCycleTrade(fills, cycle.realizedSum, cycle.cycleIndex, meta);
}

/**
 * The shared tail of the pre-completion builders: turn a cycle's
 * fills (in seq order, sell fills carrying their exit P&L) plus the
 * cycle's authoritative realized total into a GroupedTrade, using
 * exactly groupFillsIntoTrades' conventions (qty-weighted average
 * entry/exit, direction from the larger side). Null when the fills
 * cannot form a closed trade — never a fabricated row.
 */
function assembleCycleTrade(
  fills: RawFill[],
  realizedPnl: number,
  sequence: number,
  meta: { tradeKey: string; ticker: string; tradeDate: string },
): GroupedTrade | null {
  if (fills.length === 0) return null;
  let buyQty = 0, buyValue = 0, sellQty = 0, sellValue = 0;
  for (const f of fills) {
    if (f.side === "buy") { buyQty += f.qty; buyValue += f.qty * f.price; }
    else { sellQty += f.qty; sellValue += f.qty * f.price; }
  }
  if (buyQty <= 0 || sellQty <= 0) return null;
  const direction: "long" | "short" = buyQty >= sellQty ? "long" : "short";
  return {
    tradeKey: meta.tradeKey,
    sessionId: "",
    ticker: meta.ticker,
    tradeDate: meta.tradeDate,
    source: "daily_replay",
    sequence,
    direction,
    entryPrice: direction === "long" ? buyValue / buyQty : sellValue / sellQty,
    exitPrice: direction === "long" ? sellValue / sellQty : buyValue / buyQty,
    qty: direction === "long" ? buyQty : sellQty,
    entryTime: fills[0].candle_time,
    exitTime: fills[fills.length - 1].candle_time,
    realizedPnl,
    fees: 0,
    fills,
    rMultiple: null, // overlaid from recorded evidence by the caller
  };
}

/**
 * The verified pre-completion journal row for a FINALIZED draft: the
 * draft's cycle must reconcile with the draft's recorded anchors
 * (first-fill candle/price/qty + realized sum) under the same
 * cent-level tolerances the post-completion pairing uses. Any
 * mismatch withholds the row (null) — the trade stays out of the
 * journal rather than showing unverified numbers, and the caller can
 * count it as withheld for the export hint. The row keys off the
 * DRAFT key — the identity its screenshots and journal meta already
 * use; at completion the canonical session row replaces it.
 */
export function buildPreCompletionTrade(
  draft: DrDraftRow,
  cycle: DrCycleInfo,
  meta: { ticker: string; tradeDate: string },
): GroupedTrade | null {
  if (draft.status !== "finalized") return null;
  if (!cycle.closed) return null;
  if (cycle.generation !== draft.resetGeneration || cycle.cycleIndex !== draft.cycleIndex) return null;
  const ff = cycle.firstFill;
  if (!ff) return null;
  if (ff.payload.candleIndex !== draft.firstFillCandleIndex) return null;
  if (typeof ff.payload.price !== "number" || Math.abs(ff.payload.price - draft.firstFillPrice) > ANCHOR_PRICE_EPS) return null;
  if (ff.payload.qty !== draft.firstFillQty) return null;
  if (Math.abs(cycle.realizedSum - draft.realizedPnl) > ANCHOR_PNL_EPS) return null;
  return groupedTradeFromCycle(cycle, { tradeKey: draft.draftKey, ticker: meta.ticker, tradeDate: meta.tradeDate });
}

/**
 * Fallback pre-completion builder over the draft's OWN recorded
 * event window — used only when the cycle-based build above fails.
 *
 * Why this exists: the journal reads the SERVER copy of the event
 * stream, and that copy can be incomplete (the recorder's flush can
 * drop an event from a close burst; a capped fetch can truncate the
 * stream). One lost `position_closed` makes the cycle read "open"
 * and one lost closing `order_filled` leaves the cycle sell-less —
 * the trade then vanishes even though the draft row, written from
 * the live engine at the close, is complete and self-consistent.
 *
 * The draft row records the exact seq window of its cycle
 * (event_first_seq .. event_last_seq: first entry fill through
 * position_closed) plus its anchors. Within that window the
 * recorder's records are DUAL: every exit exists both as an
 * `order_filled` (qty/price) and as the `partial_exit` /
 * `position_closed` event emitted immediately after it (qty/price/
 * realizedPnl, built by the recorder from that same fill). This
 * builder cross-verifies the three records against each other:
 *
 *   - the window's first order_filled must be the draft's recorded
 *     first fill (candle / price / qty, exact anchors);
 *   - buy quantity must equal exit quantity (position fully closed
 *     inside the window);
 *   - realized P&L is the DRAFT's recorded total; exit events that
 *     survive must not contradict it. A lost exit event leaves its
 *     fill unpaired — the residual (draft total minus the paired
 *     exits' realized sum) is exactly that exit's recorded P&L and
 *     is carried by the unpaired sell fill, so per-fill figures
 *     still sum to the recorded total. A lost order_filled is
 *     reconstituted from its surviving exit event (same qty/price/
 *     realized the recorder derived from the fill).
 *
 * Anything that cannot be cross-verified this way (entry fill
 * lost, quantities unbalanced, two surviving records contradicting
 * the draft's total) returns null — withheld, never fabricated.
 */
export function groupedTradeFromDraftWindow(
  draft: DrDraftRow,
  events: DrEvent[],
  meta: { ticker: string; tradeDate: string },
): GroupedTrade | null {
  if (draft.status !== "finalized") return null;
  if (!(draft.eventFirstSeq > 0) || draft.eventLastSeq < draft.eventFirstSeq) return null;
  const win = events
    .filter((e) => e.seq >= draft.eventFirstSeq && e.seq <= draft.eventLastSeq)
    .sort((a, b) => a.seq - b.seq);
  if (win.length === 0) return null;

  // Gate 1: the window's first fill must be the draft's first fill.
  const firstFillEvent = win.find((e) => e.type === "order_filled");
  if (!firstFillEvent || firstFillEvent.payload.side !== "buy") return null;
  const ffCandle = typeof firstFillEvent.payload.candleIndex === "number"
    ? firstFillEvent.payload.candleIndex
    : firstFillEvent.marketIdx;
  if (ffCandle !== draft.firstFillCandleIndex) return null;
  if (typeof firstFillEvent.payload.price !== "number"
    || Math.abs(firstFillEvent.payload.price - draft.firstFillPrice) > ANCHOR_PRICE_EPS) return null;
  if (firstFillEvent.payload.qty !== draft.firstFillQty) return null;

  const fills: RawFill[] = [];
  // Sell fills whose exit event has not been seen yet, in seq order
  // (a lost exit event leaves its fill queued here; pairing with a
  // surviving exit event is by the qty the exit event records).
  const unpairedSells: RawFill[] = [];
  let assignedRealized = 0;
  const makeFill = (
    side: "buy" | "sell", qty: number, price: number, candleIndex: number, e: DrEvent,
  ): RawFill => {
    const candleTime = e.marketTs != null ? new Date(e.marketTs).toISOString() : null;
    return {
      id: `${draft.draftKey}:f${e.seq}`,
      session_id: "",
      side,
      qty,
      price,
      candle_index: candleIndex,
      candle_time: candleTime,
      realized_pnl: 0,
      created_at: candleTime ?? new Date(e.wallTs).toISOString(),
    };
  };
  // Sell fills reconstituted from exit events (their own
  // order_filled record was missing at that point in the walk). If
  // the real order_filled shows up LATER in the window — a flushed
  // batch can persist a position_closed ahead of its fill — it
  // replaces the reconstituted fill instead of duplicating it.
  const synthesized: RawFill[] = [];
  for (const e of win) {
    if (e.type === "order_filled") {
      const side = e.payload.side === "sell" ? "sell" : "buy";
      const qty = typeof e.payload.qty === "number" ? e.payload.qty : 0;
      const price = typeof e.payload.price === "number" ? e.payload.price : 0;
      if (!(qty > 0) || !(price > 0)) continue;
      const candleIndex = typeof e.payload.candleIndex === "number" ? e.payload.candleIndex : (e.marketIdx ?? 0);
      if (side === "sell") {
        const dupIdx = synthesized.findIndex(
          (f) => f.qty === qty && Math.abs(f.price - price) <= ANCHOR_PRICE_EPS && f.candle_index === candleIndex,
        );
        if (dupIdx >= 0) {
          const [kept] = synthesized.splice(dupIdx, 1);
          kept.id = `${draft.draftKey}:f${e.seq}`; // adopt the real fill's identity
          continue;
        }
      }
      const fill = makeFill(side, qty, price, candleIndex, e);
      fills.push(fill);
      if (side === "sell") unpairedSells.push(fill);
    } else if (e.type === "partial_exit" || e.type === "position_closed") {
      const realized = typeof e.payload.realizedPnl === "number" ? e.payload.realizedPnl : null;
      if (realized == null) return null; // exit record too damaged to cross-verify
      // Correspondence: the exit event records its own fill's qty.
      // Pair it with the unpaired sell of the same qty — the
      // earliest for a partial exit (its fill immediately precedes
      // it), the latest for the closing exit (its fill is the
      // cycle's final sell). No qty match means this exit's own
      // fill was lost: reconstitute it from the payload (the
      // recorder's dual record of that fill) and leave the unpaired
      // sells to the residual check below.
      const q = typeof e.payload.qty === "number" ? e.payload.qty : 0;
      let pairIdx = -1;
      if (e.type === "position_closed") {
        for (let i = unpairedSells.length - 1; i >= 0; i--) {
          if (unpairedSells[i].qty === q) { pairIdx = i; break; }
        }
      } else {
        for (let i = 0; i < unpairedSells.length; i++) {
          if (unpairedSells[i].qty === q) { pairIdx = i; break; }
        }
      }
      if (pairIdx >= 0) {
        const [pair] = unpairedSells.splice(pairIdx, 1);
        pair.realized_pnl = realized;
        assignedRealized += realized;
      } else {
        const qty = q;
        const price = typeof e.payload.price === "number" ? e.payload.price : 0;
        if (!(qty > 0) || !(price > 0)) return null;
        const fill = makeFill("sell", qty, price, e.marketIdx ?? draft.closeFillCandleIndex, e);
        fill.realized_pnl = realized;
        assignedRealized += realized;
        fills.push(fill);
        synthesized.push(fill);
      }
    }
  }

  // Gate 2: the window must contain a fully closed position.
  let buyQty = 0, sellQty = 0;
  for (const f of fills) {
    if (f.side === "buy") buyQty += f.qty;
    else sellQty += f.qty;
  }
  if (buyQty <= 0 || sellQty !== buyQty) return null;

  // Gate 3: realized consistency with the draft's recorded total.
  const residual = draft.realizedPnl - assignedRealized;
  if (Math.abs(residual) > ANCHOR_PNL_EPS) {
    const carrier = unpairedSells[unpairedSells.length - 1];
    if (carrier) {
      // Exit event(s) lost while their fills survive: the residual
      // is exactly the lost exits' realized P&L (a single unpaired
      // sell — the common case — makes the split exact, not an
      // allocation). Per-fill P&L still sums to the recorded total.
      carrier.realized_pnl += residual;
    } else {
      // Surviving records contradict the draft's total — withhold.
      return null;
    }
  }
  return assembleCycleTrade(fills, draft.realizedPnl, draft.cycleIndex, {
    tradeKey: draft.draftKey, ticker: meta.ticker, tradeDate: meta.tradeDate,
  });
}

/**
 * Last-resort builder: the finalized DRAFT ROW alone. Proven
 * necessary by real data (2026-10-18): two of the user's finalized
 * trades sit on attempts whose persisted event stream is EMPTY —
 * the recorder's batched flush lost every event on very short
 * sessions while the awaited draft upsert survived. No stream
 * reconstruction can produce those rows; the events simply do not
 * exist server-side.
 *
 * This is not fabrication: the draft row is itself the system's
 * authoritative persisted record of the trade, written at the
 * close from the live engine (buildDraftPayload throws unless the
 * cycle is genuinely closed). Everything on the built row is a
 * recorded value: entry price / qty / candle and close candle from
 * the draft's anchors, realized P&L from the draft's recorded
 * total, identity (tradeKey / cycle / attempt) from the draft,
 * ticker + date from the attempt's dataset row. The exit price is
 * the unique value implied by those recorded numbers for the
 * closed position (entry + realized / qty) — exact for the
 * single-entry/single-exit cycles this fallback exists for (the
 * proven real-world trigger is very short sessions); for a
 * multi-fill cycle the row reports the recorded first fill and
 * the recorded total P&L, the only figures the draft preserves.
 * What
 * the draft does NOT record stays honestly absent: no candle
 * timestamps (entryTime / exitTime null) and no per-fill detail
 * beyond the anchor entry fill and the implied exit fill; R /
 * evidence remain null (they derive from events, never invented).
 *
 * Gates: finalized status, and the anchors of a genuinely recorded
 * close (positive first-fill price + qty, a recorded event window,
 * close candle at or after the entry candle). An anchor-incomplete
 * draft still returns null — withheld, and surfaced visibly by the
 * caller.
 */
export function groupedTradeFromDraftAnchors(
  draft: DrDraftRow,
  meta: { ticker: string; tradeDate: string },
): GroupedTrade | null {
  if (draft.status !== "finalized") return null;
  if (!(draft.firstFillQty > 0) || !(draft.firstFillPrice > 0)) return null;
  if (!(draft.eventFirstSeq > 0)) return null;
  if (draft.closeFillCandleIndex < draft.firstFillCandleIndex) return null;
  const exitPrice = draft.firstFillPrice + draft.realizedPnl / draft.firstFillQty;
  if (!(exitPrice > 0)) return null;
  const fills: RawFill[] = [
    {
      id: `${draft.draftKey}:fa`,
      session_id: "",
      side: "buy",
      qty: draft.firstFillQty,
      price: draft.firstFillPrice,
      candle_index: draft.firstFillCandleIndex,
      candle_time: null,
      realized_pnl: 0,
      created_at: draft.createdAt,
    },
    {
      id: `${draft.draftKey}:fb`,
      session_id: "",
      side: "sell",
      qty: draft.firstFillQty,
      price: exitPrice,
      candle_index: draft.closeFillCandleIndex,
      candle_time: null,
      realized_pnl: draft.realizedPnl,
      created_at: draft.createdAt,
    },
  ];
  const trade = assembleCycleTrade(fills, draft.realizedPnl, draft.cycleIndex, {
    tradeKey: draft.draftKey, ticker: meta.ticker, tradeDate: meta.tradeDate,
  });
  // §G 3h provenance: the exit fill above is IMPLIED by the recorded
  // anchors (entry price + realized P&L / qty), not a recorded fill.
  // The flag travels with the trade so downstream surfaces (the AI
  // Edge Export) can label the derivation instead of presenting the
  // implied price as a recorded fill.
  if (trade) trade.anchorsDerived = true;
  return trade;
}

/**
 * The journal's pre-completion entry point, in fidelity order:
 * (1) the cycle-based build (exact stream reconstruction,
 * anchor-verified); (2) the draft-window fallback (cross-verified
 * dual records inside the draft's own seq window) when the
 * server-side stream copy lost an event; (3) the draft-anchors
 * build when the stream is missing entirely or too damaged to
 * cross-verify — the finalized draft row is the authoritative
 * record. Null means the draft's own record is incomplete —
 * withheld, and the caller surfaces it visibly (journal history
 * note + export hint) rather than letting a finalized trade
 * vanish silently.
 */
export function buildPreCompletionTradeFromEvents(
  draft: DrDraftRow,
  events: DrEvent[],
  meta: { ticker: string; tradeDate: string },
): GroupedTrade | null {
  if (draft.status !== "finalized") return null;
  const { cycles } = splitCyclesByGeneration(events);
  const cycle = cycles.find(
    (c) => c.generation === draft.resetGeneration && c.cycleIndex === draft.cycleIndex && c.closed,
  ) ?? null;
  if (cycle) {
    const row = buildPreCompletionTrade(draft, cycle, meta);
    if (row) return row;
  }
  return groupedTradeFromDraftWindow(draft, events, meta)
    ?? groupedTradeFromDraftAnchors(draft, meta);
}
