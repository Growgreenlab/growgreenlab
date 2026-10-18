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
 * trade by coordinates), trades with no draft, and trades with no
 * attempt are all included.
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
 *  affects 0 rows — returns the affected-row count. */
export async function finalizeDraft(client: SupabaseClient, draftId: string): Promise<number> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from(TABLE)
    .update({ status: "finalized", finalized_at: now, updated_at: now })
    .eq("id", draftId)
    .eq("status", "draft")
    .select();
  if (error || !data) return 0;
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
    sequence: cycle.cycleIndex,
    direction,
    entryPrice: direction === "long" ? buyValue / buyQty : sellValue / sellQty,
    exitPrice: direction === "long" ? sellValue / sellQty : buyValue / buyQty,
    qty: direction === "long" ? buyQty : sellQty,
    entryTime: fills[0].candle_time,
    exitTime: fills[fills.length - 1].candle_time,
    realizedPnl: cycle.realizedSum,
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
