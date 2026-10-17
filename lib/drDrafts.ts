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
 * Finalization (plan §3): finalize is a durable FLAG on the draft
 * row only — it never writes journal rows. A cycle's journal trade is
 * visible iff the attempt completed AND (no draft row exists —
 * legacy/pre-feature attempts, unchanged — OR its draft is
 * finalized). computeDrExclusions encodes exactly that read-side rule.
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
import type { GroupedTrade } from "./journal";
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
