/**
 * drTradeEvidence.ts — derive per-trade evidence for Daily Replay
 * trades from the attempt's append-only event stream. PURE: no I/O,
 * no clock reads; the same events always derive the same evidence.
 *
 * Why this exists: a grouped Daily Replay trade (lib/journal.ts)
 * knows prices and P&L but nothing about the PLAN. The plan lives in
 * the attempt's Decision Timeline events:
 *
 *   - `risk_snapshot` — recorded ONCE per position cycle, at the first
 *     entry fill, capturing the levels in force at entry and the
 *     planned risk on the FIRST fill's quantity. This is the ONLY
 *     legitimate source of original stop/target and initial risk.
 *   - `bracket_set` / `bracket_modified` (scope "active") — the plan
 *     adjustments made while the position was open.
 *
 * R is realizedPnl / plannedRisk, computed HERE at read time — never
 * stored, never reconstructed. When a cycle has no valid snapshot,
 * every plan field is null and `riskBasis` says exactly why. Trades
 * from the Trade Lab simulator never pass through this module: their
 * R stays unavailable by design.
 *
 * Alignment: event cycles and grouped trades both derive from the
 * same fills, in the same order. Each cycle is VERIFIED against its
 * grouped trade (first fill identity + realized P&L agreement) before
 * evidence is attached; an unverifiable pair yields nulls, never a
 * best guess. A trailing cycle with no grouped trade is the position
 * still open when the attempt completed — the journal correctly shows
 * closed trades only, and that cycle's events stay unassigned.
 *
 * Reset alignment (plan decision 10): cycle splitting is shared with
 * lib/drDrafts.ts via splitCyclesByGeneration and honors
 * `session_reset` — a reset wipes the engine fills, so only
 * final-generation closed cycles are paired with trades. An open
 * cycle at a reset is discarded entirely.
 */
import type { DrEvent } from "./dailyReplayEvents";
import type { GroupedTrade, PlanChange } from "./journal";

/** Evidence-stream status for a Daily Replay trade (AI Edge Export
 *  audit §G 3c): "recorded" — evidence derived from the attempt's
 *  recorded events; "events_missing" — the attempt's event stream is
 *  EMPTY/missing (a recording problem, e.g. the pre-fix recorder
 *  event loss — NOT evidence that nothing was recorded at entry);
 *  "events_unreconciled" — events exist but could not be matched to
 *  this trade. The distinction matters: only "recorded" trades may
 *  have their R-unavailability attributed to a missing snapshot. */
export type DrEvidenceStatus = "recorded" | "events_missing" | "events_unreconciled";

export const EVENTS_MISSING_BASIS =
  "Unavailable — this trade's Daily Replay attempt has NO recorded decision events: the event stream is missing (a recording problem — e.g. the recorder event loss fixed 2026-10-18 — not proof that no plan was recorded at entry), so the original plan and R cannot be derived. Never reconstructed.";

export interface DrTradeEvidence {
  tradeKey: string;
  attemptId: string;
  /** §G 3c evidence-stream status (see DrEvidenceStatus). */
  evidenceStatus: DrEvidenceStatus;
  /** Levels captured by the cycle's risk_snapshot (the original plan). */
  originalStopLoss: number | null;
  originalTarget: number | null;
  /** Levels in force when the position closed (after adjustments). */
  stopLoss: number | null;
  target: number | null;
  /** Planned risk ($) from the snapshot — first-fill quantity basis. */
  initialRisk: number | null;
  /** realizedPnl / initialRisk, or null when R is not available. */
  rMultiple: number | null;
  /** Plan adjustments during the position (journal PlanChange shape). */
  planHistory: PlanChange[];
  /** Plain-language basis for the risk/R figures (or their absence). */
  riskBasis: string;
  /** First-fill quantity the snapshot's planned risk was computed on. */
  snapshotQty: number | null;
  /** True when the position was increased after the first entry fill. */
  addedAfterEntry: boolean;
  /** True when a risk_snapshot event exists for this trade's cycle. */
  hasSnapshot: boolean;
}

export interface DrAttemptEvidence {
  attemptId: string;
  byTradeKey: Map<string, DrTradeEvidence>;
  /** Timeline assignment: event seq -> owning tradeKey (null = attempt-level event). */
  eventTradeKey: Map<number, string | null>;
  /** Position cycles found in the event stream. */
  cyclesFound: number;
  /** A session_resumed event exists (the attempt was continued after a reload). */
  resumed: boolean;
}

const EPS = 0.011;

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * One position cycle in the event stream, delineated exactly as the
 * original splitCycles did: a cycle opens on an `order_filled` buy at
 * shadow 0, its events run from that first entry fill through
 * `position_closed`, its snapshot is the cycle's first
 * `risk_snapshot`, and its realizedSum is the sum of its
 * `partial_exit` + `position_closed` realizedPnl payloads.
 *
 * Generation handling (plan decision 10 — the D1 reset fix): a
 * `session_reset` wipes the engine's fills, so only cycles from the
 * attempt's FINAL generation can ever correspond to grouped journal
 * trades (session_trades carry post-reset fills only). `generation`
 * is the number of `session_reset` events seen before the cycle, and
 * `cycleIndex` is the 1-based close order WITHIN that generation (a
 * still-open trailing cycle carries the next index of its
 * generation, provisionally). An OPEN cycle at a reset is discarded
 * entirely: it is never returned here, so its fills can never be
 * paired or drafted as if they reached the journal.
 */
export interface DrCycleInfo {
  generation: number;
  cycleIndex: number;
  events: DrEvent[];
  firstFill: DrEvent | null;
  closeEvent: DrEvent | null;
  snapshot: DrEvent | null;
  realizedSum: number;
  closed: boolean;
}

export function splitCyclesByGeneration(events: DrEvent[]): {
  cycles: DrCycleInfo[];
  resetCount: number;
  lastGeneration: number;
} {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const cycles: DrCycleInfo[] = [];
  let cur: DrCycleInfo | null = null;
  let shadow = 0;
  let generation = 0;
  let closedInGeneration = 0;
  for (const e of sorted) {
    if (e.type === "session_reset") {
      if (cur) {
        // Discard the open cycle entirely: the reset wiped its fills,
        // so it must never reach cycles, drafts, or session_trades
        // pairing. It is always the last cycle pushed (no other cycle
        // can open while one is open).
        if (cycles[cycles.length - 1] === cur) cycles.pop();
        cur = null;
      }
      shadow = 0;
      generation += 1;
      closedInGeneration = 0;
      continue;
    }
    if (e.type === "order_filled") {
      const side = e.payload.side;
      const qty = n(e.payload.qty) ?? 0;
      if (cur === null && shadow === 0 && side === "buy") {
        cur = {
          generation,
          cycleIndex: closedInGeneration + 1,
          events: [],
          firstFill: e,
          closeEvent: null,
          snapshot: null,
          realizedSum: 0,
          closed: false,
        };
        cycles.push(cur);
      }
      if (cur) cur.events.push(e);
      if (side === "buy") shadow += qty;
      else if (side === "sell") shadow -= qty;
      continue;
    }
    if (!cur) continue;
    cur.events.push(e);
    if (e.type === "risk_snapshot" && cur.snapshot === null) cur.snapshot = e;
    if (e.type === "partial_exit") cur.realizedSum += n(e.payload.realizedPnl) ?? 0;
    if (e.type === "position_closed") {
      cur.realizedSum += n(e.payload.realizedPnl) ?? 0;
      cur.closeEvent = e;
      cur.closed = true;
      closedInGeneration += 1;
      cur = null;
      shadow = 0;
    }
  }
  return { cycles, resetCount: generation, lastGeneration: generation };
}

export function verifyCycleTradePair(cycle: DrCycleInfo, trade: GroupedTrade): boolean {
  const ff = cycle.firstFill;
  const first = trade.fills[0];
  if (!ff || !first) return false;
  if (n(ff.payload.candleIndex) !== first.candle_index) return false;
  const price = n(ff.payload.price);
  if (price == null || Math.abs(price - Number(first.price)) > EPS) return false;
  if ((n(ff.payload.qty) ?? NaN) !== Number(first.qty)) return false;
  if (Math.abs(cycle.realizedSum - trade.realizedPnl) > EPS + 0.005 * Math.max(1, trade.fills.length)) return false;
  return true;
}

export function deriveDrEvidence(input: {
  attemptId: string;
  trades: GroupedTrade[];
  events: DrEvent[];
}): DrAttemptEvidence {
  const { attemptId, trades } = input;
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  const { cycles, resetCount, lastGeneration } = splitCyclesByGeneration(events);
  // Pairing is final-generation only: grouped trades derive from
  // session_trades, which a session_reset wipes back to post-reset
  // fills, so earlier-generation cycles have no journal counterpart.
  // Without a reset this is exactly the old splitCycles list, in the
  // same order — no-reset behavior is unchanged.
  const pairable = cycles.filter((c) => c.closed && c.generation === lastGeneration);
  const byTradeKey = new Map<string, DrTradeEvidence>();
  const eventTradeKey = new Map<number, string | null>();
  for (const e of events) eventTradeKey.set(e.seq, null);

  const pairs = Math.min(pairable.length, trades.length);
  for (let i = 0; i < pairs; i++) {
    const cycle = pairable[i];
    const trade = trades[i];
    if (!verifyCycleTradePair(cycle, trade)) continue;
    for (const e of cycle.events) eventTradeKey.set(e.seq, trade.tradeKey);
    byTradeKey.set(trade.tradeKey, buildEvidence(attemptId, trade, cycle));
  }
  // §G 3c: an EMPTY stream is a distinct, named state — a recording
  // problem — not "nothing was recorded at entry". Every trade of a
  // zero-event attempt gets the events_missing status + basis.
  if (events.length === 0) {
    for (const trade of trades) {
      byTradeKey.set(trade.tradeKey, missingEventsEvidence(attemptId, trade));
    }
    return { attemptId, byTradeKey, eventTradeKey, cyclesFound: 0, resumed: false };
  }
  // Trades beyond the pairable range (event stream shorter than the
  // fills — e.g. a partially flushed timeline) get honest nulls too.
  for (let i = pairs; i < trades.length; i++) {
    byTradeKey.set(trades[i].tradeKey, noEvidence(attemptId, trades[i],
      "Unavailable — this trade's position cycle could not be matched to the attempt's recorded events, so no plan evidence is attached. R cannot be calculated and is never reconstructed."));
  }
  for (let i = 0; i < pairs; i++) {
    if (!byTradeKey.has(trades[i].tradeKey)) {
      byTradeKey.set(trades[i].tradeKey, noEvidence(attemptId, trades[i],
        "Unavailable — the attempt's recorded events do not reconcile with this trade's fills (first fill or realized P&L mismatch), so no plan evidence is attached. R cannot be calculated and is never reconstructed."));
    }
  }

  return {
    attemptId,
    byTradeKey,
    eventTradeKey,
    // cyclesFound: with no reset this is exactly the old meaning —
    // every cycle splitCycles found, including a still-open trailing
    // cycle. Once a reset has occurred, earlier-generation cycles can
    // never correspond to journal trades, so the count narrows to the
    // final generation's CLOSED cycles — the only cycles that can
    // pair with trades or become drafts.
    cyclesFound: resetCount === 0 ? cycles.length : pairable.length,
    resumed: events.some((e) => e.type === "session_resumed"),
  };
}

function noEvidence(attemptId: string, trade: GroupedTrade, basis: string): DrTradeEvidence {
  return {
    tradeKey: trade.tradeKey, attemptId,
    evidenceStatus: "events_unreconciled",
    originalStopLoss: null, originalTarget: null,
    stopLoss: null, target: null,
    initialRisk: null, rMultiple: null,
    planHistory: [], riskBasis: basis,
    snapshotQty: null, addedAfterEntry: false, hasSnapshot: false,
  };
}

/**
 * The explicit no-evidence entry for a trade whose attempt event
 * stream is MISSING (§G 3c). Exported for the journal page: trades
 * built from a finalized draft's anchors never pass through
 * deriveDrEvidence (there are no cycles to pair), so the page creates
 * this entry itself — without it the export cannot distinguish
 * "stream lost" from "no snapshot recorded".
 */
export function missingEventsEvidence(attemptId: string, trade: GroupedTrade): DrTradeEvidence {
  return { ...noEvidence(attemptId, trade, EVENTS_MISSING_BASIS), evidenceStatus: "events_missing" };
}

/**
 * The explicit no-evidence entry for a pre-completion trade whose
 * attempt HAS events but whose cycle could not be reconciled into an
 * evidence pair (§G 3c companion to missingEventsEvidence).
 */
export function unreconciledEvidence(attemptId: string, trade: GroupedTrade): DrTradeEvidence {
  return noEvidence(attemptId, trade,
    "Unavailable — this trade was rebuilt from its finalized draft record, and the attempt's recorded events do not reconcile into plan evidence for it, so no plan evidence is attached. R cannot be calculated and is never reconstructed.");
}

function buildEvidence(attemptId: string, trade: GroupedTrade, cycle: DrCycleInfo): DrTradeEvidence {
  const snap = cycle.snapshot;
  const snapQty = snap ? n(snap.payload.qty) : null;

  /* Position adds after the first entry fill. */
  let addedAfterEntry = false;
  let seenFirstFill = false;
  for (const e of cycle.events) {
    if (e.type === "order_filled" && e.payload.side === "buy") {
      if (seenFirstFill) addedAfterEntry = true;
      seenFirstFill = true;
    }
    if (e.type === "position_changed" && snapQty != null) {
      const qa = n(e.payload.qtyAfter);
      if (qa != null && qa > snapQty) addedAfterEntry = true;
    }
  }

  if (!snap) {
    return {
      ...noEvidence(attemptId, trade,
        "Unavailable — no risk snapshot was recorded for this trade's position cycle, so the original stop, target and initial risk are not known. R cannot be calculated and is never reconstructed."),
      // The stream EXISTS and this cycle paired with it — the status
      // is "recorded" (stream present); only the snapshot is absent.
      evidenceStatus: "recorded",
      addedAfterEntry,
    };
  }

  const originalStopLoss = n(snap.payload.stopLoss);
  const originalTarget = n(snap.payload.takeProfit);
  const plannedRisk = n(snap.payload.plannedRisk);

  /* Plan adjustments + final levels: walk active-scope bracket events,
   * tracking the levels in force. A bracket_set carrying exactly the
   * snapshot's levels is the entry application itself (the original
   * plan being carried into the position), not an adjustment. */
  const planHistory: PlanChange[] = [];
  let curStop = originalStopLoss;
  let curTarget = originalTarget;
  const atIso = (e: DrEvent) => new Date(e.marketTs ?? e.wallTs).toISOString();
  for (const e of cycle.events) {
    if (e.type !== "bracket_set" && e.type !== "bracket_modified") continue;
    if (e.payload.scope !== "active") continue;
    if (e.type === "bracket_set") {
      const sl = n(e.payload.stopLoss);
      const tp = n(e.payload.takeProfit);
      if (sl === curStop && tp === curTarget) continue; // entry application
      if (sl !== curStop) planHistory.push({ at: atIso(e), field: "stop_loss", from: curStop, to: sl });
      if (tp !== curTarget) planHistory.push({ at: atIso(e), field: "target", from: curTarget, to: tp });
      curStop = sl;
      curTarget = tp;
    } else {
      const field = e.payload.field === "stopLoss" ? "stop_loss"
        : e.payload.field === "takeProfit" ? "target" : null;
      if (!field) continue;
      const prev = n(e.payload.prev);
      const next = n(e.payload.next);
      planHistory.push({ at: atIso(e), field, from: prev, to: next });
      if (field === "stop_loss") curStop = next; else curTarget = next;
    }
  }

  /* R: only from a valid recorded snapshot. */
  let initialRisk: number | null = null;
  let rMultiple: number | null = null;
  let riskBasis: string;
  if (originalStopLoss == null) {
    riskBasis = "Unavailable — no stop loss was in force when this position was entered (the risk snapshot recorded no stop), so initial risk and R cannot be calculated. Never reconstructed.";
  } else if (plannedRisk == null || !(plannedRisk > 0)) {
    riskBasis = "Unavailable — the recorded risk snapshot has no valid planned-risk figure, so R cannot be calculated. Never reconstructed.";
  } else {
    initialRisk = plannedRisk;
    rMultiple = trade.realizedPnl / plannedRisk;
    riskBasis = `Initial risk recorded at the first entry fill (risk snapshot): |entry − stop| × first-fill quantity${snapQty != null ? ` ${snapQty}` : ""} = $${plannedRisk.toFixed(2)}. R = realized P&L / recorded initial risk.`
      + (addedAfterEntry
        ? " The position was increased after entry; the recorded initial risk stays on the first-fill basis and is not rescaled."
        : "");
  }

  return {
    tradeKey: trade.tradeKey, attemptId,
    evidenceStatus: "recorded",
    originalStopLoss, originalTarget,
    stopLoss: curStop, target: curTarget,
    initialRisk, rMultiple,
    planHistory, riskBasis,
    snapshotQty: snapQty, addedAfterEntry,
    hasSnapshot: true,
  };
}
