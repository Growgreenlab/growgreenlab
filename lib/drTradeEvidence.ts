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
 */
import type { DrEvent } from "./dailyReplayEvents";
import type { GroupedTrade, PlanChange } from "./journal";

export interface DrTradeEvidence {
  tradeKey: string;
  attemptId: string;
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

interface Cycle {
  events: DrEvent[];
  snapshot: DrEvent | null;
  firstFill: DrEvent | null;
  realizedSum: number;
  verified: boolean;
}

function splitCycles(events: DrEvent[]): Cycle[] {
  const cycles: Cycle[] = [];
  let cur: Cycle | null = null;
  let shadow = 0;
  for (const e of events) {
    if (e.type === "order_filled") {
      const side = e.payload.side;
      const qty = n(e.payload.qty) ?? 0;
      if (cur === null && shadow === 0 && side === "buy") {
        cur = { events: [], snapshot: null, firstFill: e, realizedSum: 0, verified: false };
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
      cur = null;
      shadow = 0;
    }
  }
  return cycles;
}

function verifyPair(cycle: Cycle, trade: GroupedTrade): boolean {
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
  const cycles = splitCycles(events);
  const byTradeKey = new Map<string, DrTradeEvidence>();
  const eventTradeKey = new Map<number, string | null>();
  for (const e of events) eventTradeKey.set(e.seq, null);

  const pairs = Math.min(cycles.length, trades.length);
  for (let i = 0; i < pairs; i++) {
    const cycle = cycles[i];
    const trade = trades[i];
    cycle.verified = verifyPair(cycle, trade);
    if (!cycle.verified) continue;
    for (const e of cycle.events) eventTradeKey.set(e.seq, trade.tradeKey);
    byTradeKey.set(trade.tradeKey, buildEvidence(attemptId, trade, cycle));
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
    cyclesFound: cycles.length,
    resumed: events.some((e) => e.type === "session_resumed"),
  };
}

function noEvidence(attemptId: string, trade: GroupedTrade, basis: string): DrTradeEvidence {
  return {
    tradeKey: trade.tradeKey, attemptId,
    originalStopLoss: null, originalTarget: null,
    stopLoss: null, target: null,
    initialRisk: null, rMultiple: null,
    planHistory: [], riskBasis: basis,
    snapshotQty: null, addedAfterEntry: false, hasSnapshot: false,
  };
}

function buildEvidence(attemptId: string, trade: GroupedTrade, cycle: Cycle): DrTradeEvidence {
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
    originalStopLoss, originalTarget,
    stopLoss: curStop, target: curTarget,
    initialRisk, rMultiple,
    planHistory, riskBasis,
    snapshotQty: snapQty, addedAfterEntry,
    hasSnapshot: true,
  };
}
