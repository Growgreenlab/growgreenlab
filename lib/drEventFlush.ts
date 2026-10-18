/**
 * Daily Replay — Decision Timeline event flusher.
 *
 * Serializes persistence of recorded events to daily_replay_events.
 *
 * The bug this replaces (flushDrEvents in app/replay/page.tsx, pre-fix):
 * the old flush sliced the pending batch from a shared offset BEFORE
 * awaiting the network send, then advanced the offset by the batch
 * length AFTER the await — with nothing serializing concurrent calls.
 * Two overlapping flushes of the same batch double-advanced the offset
 * past events that were recorded later, and those tail events (in
 * practice the lifecycle events session_paused / session_completed,
 * which are recorded last) were sliced away forever: silent loss, no
 * error anywhere. Reproduced deterministically against the old logic:
 * two concurrent flushes over 3 events left offset = 6, and the two
 * lifecycle events recorded afterwards were never sent.
 *
 * Rules here:
 *  - Flushes are serialized on a single promise chain: at most one
 *    send is ever in flight for a flusher instance.
 *  - The pending batch is sliced INSIDE the serialized run, at the
 *    moment the run executes — never at call time.
 *  - The offset advances only after a send confirms, and only by
 *    exactly the batch that was sent. A failed send leaves the offset
 *    untouched, so a later flush retries the same events.
 *  - A drain keeps looping while new events appear during a send, so
 *    events recorded mid-flight are picked up in order by the same
 *    drain instead of depending on a later call that may never come.
 *  - "skip" (backend not configured / signed out) leaves everything
 *    pending and unlatched — a later flush can still send.
 *  - A missing-storage error latches state.missing: the timeline then
 *    stays device-only, exactly the pre-existing degradation contract.
 *  - State is per-attempt: the page replaces the state object when a
 *    new attempt starts (or a resume loads a persisted stream), so a
 *    still-queued flush for the previous attempt can only ever touch
 *    its own state object, never the new attempt's offset.
 */
import type { DrEvent } from "./dailyReplayEvents";

export interface DrFlushState {
  /** Events [0, offset) of the attempt's stream are confirmed persisted. */
  offset: number;
  /** Latched when the events table is missing: stop trying entirely. */
  missing: boolean;
}

export function newDrFlushState(offset = 0): DrFlushState {
  return { offset, missing: false };
}

/**
 * "sent"  — the batch was confirmed persisted; advance past it.
 * "skip"  — persistence is unavailable right now (not configured or
 *           signed out); leave the batch pending, do not latch.
 * Throwing signals a failed send: a missing-storage error (as decided
 * by the caller's isMissingError) latches state.missing; anything else
 * leaves the batch pending for a retry.
 */
export type DrFlushSendResult = "sent" | "skip";

export type DrFlushSend = (
  batch: readonly DrEvent[]
) => Promise<DrFlushSendResult>;

export class DrEventFlusher {
  private chain: Promise<void> = Promise.resolve();

  /**
   * Queue a flush. Concurrent calls never overlap: each runs after the
   * previous one settles, and reads the event stream when it runs.
   * Never rejects — send failures are absorbed per the rules above.
   */
  flush(
    state: DrFlushState,
    getEvents: () => readonly DrEvent[],
    send: DrFlushSend,
    isMissingError: (e: unknown) => boolean
  ): Promise<void> {
    const run = this.chain.then(() =>
      this.drain(state, getEvents, send, isMissingError)
    );
    // Keep the chain alive even if a drain somehow throws, so one bad
    // flush can never wedge every later flush behind a rejection.
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async drain(
    state: DrFlushState,
    getEvents: () => readonly DrEvent[],
    send: DrFlushSend,
    isMissingError: (e: unknown) => boolean
  ): Promise<void> {
    while (!state.missing) {
      // Slice at run time from the current offset: this is the exact
      // point the old code got wrong (it sliced at call time, before
      // the await, from an offset other flushes could also be using).
      const batch = getEvents().slice(state.offset);
      if (batch.length === 0) return;
      let result: DrFlushSendResult;
      try {
        result = await send(batch);
      } catch (e) {
        if (isMissingError(e)) state.missing = true;
        // Otherwise: leave the offset untouched — the same batch is
        // retried by a later flush, and the send's upsert
        // (ignore-duplicates on attempt_id+seq) makes a retry after an
        // uncertain failure safe against duplicates.
        return;
      }
      if (result === "skip") return;
      // Advance ONLY over the batch just confirmed, by its exact size.
      state.offset += batch.length;
      // Loop: events recorded while this send was in flight are now
      // pending and are sent next, in order, by this same drain.
    }
  }
}
