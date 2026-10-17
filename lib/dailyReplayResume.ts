/**
 * Daily Replay — refresh-resume reconstruction (pure, no DOM/Supabase).
 *
 * Rebuilds a live attempt from its authoritative server artifacts:
 * the revealed candle prefix (dr_get_revealed, position enforced
 * server-side), the persisted Decision Timeline events
 * (daily_replay_events), and the persisted working orders
 * (daily_replay_orders, supabase/migrations/daily-replay-v2-orders.sql).
 * The pattern mirrors the saved-session reload in app/replay/page.tsx:
 * fast-forward the engine candle by candle and re-apply each recorded
 * fill at its exact price with buyAt/sellAt, so cash, position,
 * average entry, and realized P&L reproduce the original run exactly.
 *
 * What is restored:
 *  - engine cash / position / average entry / realized P&L (from the
 *    order_filled events, in seq order; a session_reset event resets
 *    the engine mid-stream, exactly as it did live);
 *  - current SL/TP: the recorder's final bracket values per scope —
 *    the ACTIVE scope is applied to the engine, the PLANNED scope is
 *    handed back for the page's planned-level state;
 *  - the DrEventRecorder itself (see loadExisting): full history,
 *    seq continuity, shadow state, move counters;
 *  - working limit orders, from the daily_replay_orders rows (the
 *    authoritative source — NOT inferred from limit_placed events):
 *    exactly the status = 'working' rows, re-placed at their
 *    remaining quantity (qty - filled_qty). Terminal rows are never
 *    restored; a filled row's fill comes back via its order_filled
 *    event instead, so no fill is ever duplicated.
 *
 * How restored orders enter the engine: they are pushed directly
 * into engine.pendingOrders, NOT placed via placeLimitOrder — that
 * method re-validates against the CURRENT cash/position, checks that
 * by design do not apply to already-resting orders (a resting sell
 * may exceed the position it was placed against after partial exits;
 * a resting buy may exceed the cash that later trades spent). Their
 * engine ids come from a reserved range (DR_RESTORED_ORDER_ID_BASE)
 * because the engine's own id counter is private and counts up from
 * 1: restored ids can never collide with counter-issued ids in a
 * real session, and cancel/fill bookkeeping treats them identically.
 *
 * What is deliberately NOT restored:
 *  - Intra-candle tick progress and any candle progress past the
 *    last recorded fill. Neither is persisted anywhere; the engine
 *    resumes at the last fill's candle (or resting ON the locked
 *    starting candle — complete, per the locked-candle boundary —
 *    when nothing has filled yet) and the user replays forward from
 *    there, through candles the feed already legitimately holds.
 *  - Bracket backstop extremes (lowSinceEntry/highSinceEntry): the
 *    engine re-tracks them from the resume point forward, the same
 *    trade-off the saved-session reload already makes.
 */
import { ReplayEngine } from "./engine";
import { DrEventRecorder, type DrEvent } from "./dailyReplayEvents";
import {
  planRestoredOrders,
  type DrOrderRow,
} from "./dailyReplayOrders";
import type { Candle } from "./types";

/**
 * Engine ids for resume-restored orders are allocated from this base
 * upward. The engine's own counter starts at 1 (and resets to 1 on
 * session reset), so restored ids live in a range live placements
 * cannot reach — the two id spaces never collide, and the engine's
 * id-based cancel/fill bookkeeping works unchanged for both.
 */
export const DR_RESTORED_ORDER_ID_BASE = 1_000_000_000;

/**
 * Should a stored attempt produce a resume offer? Only an attempt the
 * server still reports as 'active' may resume — finished/abandoned
 * attempts are history, and the caller clears the resume hint for
 * anything else (including a missing row).
 */
export function shouldOfferDrResume(status: string | null | undefined): boolean {
  return status === "active";
}

export interface DrBracketLevels {
  sl: number | null;
  tp: number | null;
}

/** One working order restored into the rebuilt engine. */
export interface DrRestoredOrder {
  /** Persistent order id (daily_replay_orders uuid). */
  orderId: string;
  /** Engine-local id the order holds in the rebuilt engine. */
  engineOrderId: number;
  side: "buy" | "sell";
  /** Original order quantity from the server row. */
  qty: number;
  /** Quantity already executed before the refresh. */
  filledQty: number;
  limitPrice: number;
  /** Quantity the rebuilt engine still has working (qty - filledQty). */
  remainingQty: number;
}

export interface DrReconstruction {
  engine: ReplayEngine;
  recorder: DrEventRecorder;
  /** Fills present in the rebuilt engine (post any session_reset). */
  fillsReplayed: number;
  /** Final ACTIVE bracket levels, applied to the engine. Null when
   *  no active brackets were in force at the last recorded state. */
  restoredActiveBrackets: DrBracketLevels | null;
  /** Final PLANNED bracket levels, for the page's planned state. */
  restoredPlannedBrackets: DrBracketLevels | null;
  /** Working orders re-placed into the rebuilt engine, in the
   *  server rows' (creation) order. The page registers these with
   *  its order tracker so later fills/cancels keep updating the
   *  SAME server rows — repeated refreshes never duplicate them. */
  restoredOrders: DrRestoredOrder[];
}

export function reconstructDrAttempt(opts: {
  /** The feed's revealed candle prefix (single array identity). */
  candles: Candle[];
  startingBalance: number;
  startIndex: number;
  /** Persisted events for the attempt (any order; sorted here). */
  events: DrEvent[];
  /**
   * The attempt's daily_replay_orders rows, read back under the
   * owner SELECT policy in creation order. Only 'working' rows are
   * restored (see planRestoredOrders). Omit (or pass []) when order
   * persistence is unavailable — reconstruction then restores no
   * orders, exactly as it did before v2.
   */
  orders?: DrOrderRow[];
}): DrReconstruction {
  const { candles, startingBalance, startIndex } = opts;
  const events = [...opts.events].sort((a, b) => a.seq - b.seq);

  const recorder = new DrEventRecorder();
  recorder.loadExisting(events);

  // Boundary: startIndex is the attempt's LOCKED candle, which is
  // completed history — the engine's first LIVE candle is the one
  // after it (ReplayEngine startIndex semantics), exactly as a fresh
  // lock builds it (buildDrEngine in lib/dailyReplay.ts). The caller
  // guarantees candles[startIndex + 1] is held whenever a next candle
  // exists (the resume path releases it before reconstructing); when
  // the array ends AT the locked candle the constructor clamps and
  // the finalize guard below settles it.
  const engine = new ReplayEngine(candles, startingBalance, startIndex + 1);
  let fillsReplayed = 0;
  for (const e of events) {
    if (e.type === "session_reset") {
      // The live engine was reset here: cash/position/fills restarted
      // and earlier fills left the engine (they stay in the timeline).
      engine.reset();
      fillsReplayed = 0;
      continue;
    }
    if (e.type !== "order_filled") continue;
    const p = e.payload;
    const qty = typeof p.qty === "number" ? p.qty : NaN;
    const price = typeof p.price === "number" ? p.price : NaN;
    const candleIndex =
      typeof p.candleIndex === "number"
        ? p.candleIndex
        : typeof e.marketIdx === "number"
          ? e.marketIdx
          : NaN;
    if (
      !Number.isFinite(qty) ||
      !Number.isFinite(price) ||
      !Number.isFinite(candleIndex) ||
      candleIndex < 0 ||
      candleIndex >= candles.length
    ) {
      continue; // malformed recorded fill: skip, never fabricate
    }
    // Fast-forward to the fill's candle, exactly like the
    // saved-session reload. Brackets are NOT set yet and no orders
    // are working, so stepping cannot produce spurious fills.
    while (engine.index < candleIndex) {
      const before = engine.index;
      engine.step();
      if (engine.index === before) break; // at the held end; cannot happen for recorded fills
    }
    const time = e.marketTs ?? candles[candleIndex].t;
    const fill =
      p.side === "buy"
        ? engine.buyAt(qty, price, candleIndex, time)
        : p.side === "sell"
          ? engine.sellAt(qty, price, candleIndex, time)
          : null;
    if (fill) fillsReplayed++;
  }

  // Boundary guard for the degenerate restore: the held array ends
  // AT the locked candle (it was the dataset's final candle, or
  // nothing past it was ever released and the resume-time release
  // found the attempt finished). The constructor had to clamp the
  // first-live index onto the locked candle itself and began forming
  // it; if no recorded fill already finalized it, finalize it now so
  // the locked candle stands as completed history instead of
  // re-forming after the reload. (When fills WERE replayed, the loop
  // above already left the engine at or past the locked candle, so
  // this cannot fire under an open position.)
  if (startIndex >= candles.length - 1 && engine.index < startIndex) {
    engine.step();
  }

  // Current brackets: final recorded values win for the LIVE levels;
  // the history that produced them stays in the recorder untouched.
  let restoredActiveBrackets: DrBracketLevels | null = null;
  const active = recorder.bracketState("active");
  if (active.everSet && (active.sl != null || active.tp != null)) {
    engine.setBrackets(active.sl, active.tp);
    restoredActiveBrackets = {
      sl: engine.stopLoss,
      tp: engine.takeProfit,
    };
  }
  let restoredPlannedBrackets: DrBracketLevels | null = null;
  const planned = recorder.bracketState("planned");
  if (planned.everSet && (planned.sl != null || planned.tp != null)) {
    restoredPlannedBrackets = { sl: planned.sl, tp: planned.tp };
  }

  // Working orders come back LAST, once cash/position/brackets match
  // the live session, so a restored order's first tick behaves exactly
  // as it would have live. A session_reset in the stream already
  // restarted the engine above; server rows cancelled by that reset
  // read back as terminal, so nothing pre-reset can sneak back in.
  const restoredOrders: DrRestoredOrder[] = [];
  for (const { row, remainingQty } of planRestoredOrders(opts.orders ?? [])) {
    const engineOrderId = DR_RESTORED_ORDER_ID_BASE + restoredOrders.length;
    engine.pendingOrders.push({
      id: engineOrderId,
      side: row.side,
      qty: remainingQty,
      limitPrice: row.limitPrice,
    });
    restoredOrders.push({
      orderId: row.id,
      engineOrderId,
      side: row.side,
      qty: row.qty,
      filledQty: row.filledQty,
      limitPrice: row.limitPrice,
      remainingQty,
    });
  }

  return {
    engine,
    recorder,
    fillsReplayed,
    restoredActiveBrackets,
    restoredPlannedBrackets,
    restoredOrders,
  };
}
