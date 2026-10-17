/**
 * Daily Replay — refresh-resume reconstruction (pure, no DOM/Supabase).
 *
 * Rebuilds a live attempt from its two authoritative server artifacts:
 * the revealed candle prefix (dr_get_revealed, position enforced
 * server-side) and the persisted Decision Timeline events
 * (daily_replay_events). The pattern mirrors the saved-session reload
 * in app/replay/page.tsx: fast-forward the engine candle by candle and
 * re-apply each recorded fill at its exact price with buyAt/sellAt, so
 * cash, position, average entry, and realized P&L reproduce the
 * original run exactly.
 *
 * What is restored:
 *  - engine cash / position / average entry / realized P&L (from the
 *    order_filled events, in seq order; a session_reset event resets
 *    the engine mid-stream, exactly as it did live);
 *  - current SL/TP: the recorder's final bracket values per scope —
 *    the ACTIVE scope is applied to the engine, the PLANNED scope is
 *    handed back for the page's planned-level state;
 *  - the DrEventRecorder itself (see loadExisting): full history,
 *    seq continuity, shadow state, move counters.
 *
 * What is deliberately NOT restored:
 *  - Working (unfilled) limit orders. limit_placed events carry no
 *    order id and order_cancelled references engine-local ids, so
 *    which placements are still live cannot be determined without
 *    guessing — and guessing could resurrect an order that already
 *    filled or was cancelled. Fills those orders produced ARE
 *    restored (they are order_filled events). Known limitation.
 *  - Intra-candle tick progress and any candle progress past the
 *    last recorded fill. Neither is persisted anywhere; the engine
 *    resumes at the last fill's candle (or the starting candle when
 *    nothing has filled yet) and the user replays forward from
 *    there, through candles the feed already legitimately holds.
 *  - Bracket backstop extremes (lowSinceEntry/highSinceEntry): the
 *    engine re-tracks them from the resume point forward, the same
 *    trade-off the saved-session reload already makes.
 */
import { ReplayEngine } from "./engine";
import { DrEventRecorder, type DrEvent } from "./dailyReplayEvents";
import type { Candle } from "./types";

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
}

export function reconstructDrAttempt(opts: {
  /** The feed's revealed candle prefix (single array identity). */
  candles: Candle[];
  startingBalance: number;
  startIndex: number;
  /** Persisted events for the attempt (any order; sorted here). */
  events: DrEvent[];
}): DrReconstruction {
  const { candles, startingBalance, startIndex } = opts;
  const events = [...opts.events].sort((a, b) => a.seq - b.seq);

  const recorder = new DrEventRecorder();
  recorder.loadExisting(events);

  const engine = new ReplayEngine(candles, startingBalance, startIndex);
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

  return {
    engine,
    recorder,
    fillsReplayed,
    restoredActiveBrackets,
    restoredPlannedBrackets,
  };
}
