/**
 * drEventFlush.test.ts — tests for the serialized Decision Timeline
 * event flusher (lib/drEventFlush.ts).
 * Run: npx -y tsx lib/drEventFlush.test.ts
 *
 * The centerpiece is the regression test for the flush race that the
 * old page-level flushDrEvents shipped with: it sliced the pending
 * batch from a shared offset BEFORE awaiting the send and advanced the
 * offset by the batch size AFTER the await, unserialized — two
 * overlapping flushes double-advanced the offset past tail events
 * (session_paused / session_completed), which were then never sent.
 * That failure was reproduced deterministically against the old logic
 * before this fix (2 concurrent flushes over 3 events -> offset 6 ->
 * the 2 lifecycle events recorded afterwards silently dropped). Every
 * interleaving below is driven with gated sends, so the tests are
 * deterministic — no timers, no randomness.
 */
import { DrEventFlusher, newDrFlushState, type DrFlushState } from "./drEventFlush";
import {
  DrEventRecorder,
  type DrEvent,
  type DrEventType,
} from "./dailyReplayEvents";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function ev(seq: number, type: DrEventType): DrEvent {
  return { seq, type, wallTs: 1_700_000_000_000 + seq, marketIdx: seq - 1, marketTs: null, payload: {} };
}

/**
 * A fake server + send. The server is a Map keyed by seq with
 * ignore-duplicates upsert semantics — the same contract the real
 * daily_replay_events upsert (onConflict attempt_id,seq) provides.
 * `sendLog` records every batch's seqs, in call order, so tests can
 * prove exactly-once delivery and global ordering.
 */
class FakeTransport {
  server = new Map<number, DrEventType>();
  sendLog: number[][] = [];
  /** When true, each send waits until releaseOne() is called. */
  gated = false;
  private gates: Array<() => void> = [];
  /** Throw this error on the next send (after optionally landing). */
  failNext: { error: unknown; landFirst: boolean } | null = null;
  /** Return "skip" instead of sending. */
  skip = false;

  send = async (batch: readonly DrEvent[]): Promise<"sent" | "skip"> => {
    this.sendLog.push(batch.map((e) => e.seq));
    if (this.gated) {
      await new Promise<void>((resolve) => this.gates.push(resolve));
    }
    if (this.skip) return "skip";
    const fail = this.failNext;
    if (fail) {
      this.failNext = null;
      if (fail.landFirst) this.land(batch);
      throw fail.error;
    }
    this.land(batch);
    return "sent";
  };

  private land(batch: readonly DrEvent[]) {
    for (const e of batch) {
      if (!this.server.has(e.seq)) this.server.set(e.seq, e.type);
    }
  }

  releaseOne() {
    const g = this.gates.shift();
    if (g) g();
  }

  get sendCalls() {
    return this.sendLog.length;
  }

  /** Every seq sent across all calls, flattened, in call order. */
  get sentSeqs(): number[] {
    return this.sendLog.flat();
  }

  persistedTypes(): DrEventType[] {
    return [...this.server.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  }
}

const notMissing = (_e: unknown) => false;
const MISSING = new Error("PGRST205: could not find the table");
const isMissing = (e: unknown) => e === MISSING;

/* ------------------------------------------------------------------ */
/* 1. Plain burst: one flush persists everything, in order.            */
/* ------------------------------------------------------------------ */
async function burstTests() {
  const t = new FakeTransport();
  const f = new DrEventFlusher();
  const state = newDrFlushState();
  const events: DrEvent[] = [
    ev(1, "attempt_created"), ev(2, "session_started"), ev(3, "order_filled"),
    ev(4, "session_paused"), ev(5, "session_completed"),
  ];
  await f.flush(state, () => events, t.send, notMissing);
  check("burst: all 5 events persisted", t.server.size === 5);
  check("burst: offset advanced to 5", state.offset === 5);
  check("burst: exactly one send", t.sendCalls === 1);
  check("burst: order preserved",
    JSON.stringify(t.persistedTypes()) === JSON.stringify(
      ["attempt_created", "session_started", "order_filled", "session_paused", "session_completed"]));
  // Extra flushes after completion send nothing.
  await f.flush(state, () => events, t.send, notMissing);
  await f.flush(state, () => events, t.send, notMissing);
  check("burst: repeat flushes are no-ops", t.sendCalls === 1 && state.offset === 5);
}

/* ------------------------------------------------------------------ */
/* 2. THE RACE: concurrent flushes + events recorded mid-flight.       */
/*    Old logic: offset overshot to 6 over 3 events and the two        */
/*    lifecycle events recorded afterwards were lost forever.          */
/* ------------------------------------------------------------------ */
async function raceTests() {
  const t = new FakeTransport();
  t.gated = true;
  const f = new DrEventFlusher();
  const state = newDrFlushState();
  const events: DrEvent[] = [ev(1, "attempt_created"), ev(2, "session_started"), ev(3, "order_filled")];

  const flushA = f.flush(state, () => events, t.send, notMissing);
  const flushB = f.flush(state, () => events, t.send, notMissing);
  await tick(); // first drain is inside its gated send
  check("race: only one send in flight despite two flush calls", t.sendCalls === 1);

  // Tail lifecycle events arrive while the first send is in flight —
  // the exact events the old code dropped.
  events.push(ev(4, "session_paused"), ev(5, "session_completed"));

  t.releaseOne(); // first send lands [1..3]; the drain must loop for [4..5]
  await tick();
  check("race: drain picked up mid-flight events in a second batch",
    t.sendCalls === 2 && JSON.stringify(t.sendLog[1]) === JSON.stringify([4, 5]));
  t.releaseOne(); // second send lands
  await Promise.all([flushA, flushB]);

  check("race: all 5 events persisted exactly once",
    t.server.size === 5 && JSON.stringify(t.sentSeqs) === JSON.stringify([1, 2, 3, 4, 5]));
  check("race: offset is exactly 5 (no overshoot)", state.offset === 5);
  check("race: lifecycle tail persisted",
    t.server.get(4) === "session_paused" && t.server.get(5) === "session_completed");
  check("race: second flush call sent nothing of its own", t.sendCalls === 2);
}

/* ------------------------------------------------------------------ */
/* 3. Burst of 10+ with many concurrent flush calls.                   */
/* ------------------------------------------------------------------ */
async function concurrentBurstTests() {
  const t = new FakeTransport();
  const f = new DrEventFlusher();
  const state = newDrFlushState();
  const types: DrEventType[] = [
    "attempt_created", "session_started", "order_submitted", "order_filled",
    "bracket_set", "bracket_modified", "partial_exit", "position_closed",
    "risk_snapshot", "session_paused", "session_resumed", "session_completed",
  ];
  const events: DrEvent[] = types.map((ty, i) => ev(i + 1, ty));
  const calls = Array.from({ length: 5 }, () =>
    f.flush(state, () => events, t.send, notMissing));
  await Promise.all(calls);
  check("concurrent burst: all 12 persisted", t.server.size === 12);
  check("concurrent burst: each seq sent exactly once",
    JSON.stringify(t.sentSeqs) === JSON.stringify(types.map((_, i) => i + 1)));
  check("concurrent burst: offset exact", state.offset === 12);
}

/* ------------------------------------------------------------------ */
/* 4. Failures: offset never advances over an unconfirmed batch.       */
/* ------------------------------------------------------------------ */
async function failureTests() {
  // (a) Plain failure, then a successful retry.
  {
    const t = new FakeTransport();
    const f = new DrEventFlusher();
    const state = newDrFlushState();
    const events: DrEvent[] = [ev(1, "attempt_created"), ev(2, "order_filled"), ev(3, "session_completed")];
    t.failNext = { error: new Error("network down"), landFirst: false };
    await f.flush(state, () => events, t.send, notMissing);
    check("failure: offset untouched after failed send", state.offset === 0);
    check("failure: nothing persisted", t.server.size === 0);
    check("failure: not latched missing", state.missing === false);
    await f.flush(state, () => events, t.send, notMissing);
    check("failure: retry persists the same batch", t.server.size === 3 && state.offset === 3);
    check("failure: retried batch resent in full",
      JSON.stringify(t.sendLog[1]) === JSON.stringify([1, 2, 3]));
  }
  // (b) Uncertain failure: rows landed, response lost. The retry must
  //     re-send the batch and the server must still hold each event
  //     exactly once (ignore-duplicates upsert semantics).
  {
    const t = new FakeTransport();
    const f = new DrEventFlusher();
    const state = newDrFlushState();
    const events: DrEvent[] = [ev(1, "attempt_created"), ev(2, "session_paused"), ev(3, "session_completed")];
    t.failNext = { error: new Error("response lost"), landFirst: true };
    await f.flush(state, () => events, t.send, notMissing);
    check("uncertain: offset untouched even though rows landed", state.offset === 0);
    await f.flush(state, () => events, t.send, notMissing);
    check("uncertain: retry completes the stream", state.offset === 3 && t.server.size === 3);
    check("uncertain: no duplicates on the server",
      JSON.stringify(t.persistedTypes()) === JSON.stringify(
        ["attempt_created", "session_paused", "session_completed"]));
  }
}

/* ------------------------------------------------------------------ */
/* 5. Missing-storage latch and skip semantics.                        */
/* ------------------------------------------------------------------ */
async function latchAndSkipTests() {
  // Missing table -> latch, never try again, offset untouched.
  {
    const t = new FakeTransport();
    const f = new DrEventFlusher();
    const state = newDrFlushState();
    const events: DrEvent[] = [ev(1, "attempt_created"), ev(2, "session_completed")];
    t.failNext = { error: MISSING, landFirst: false };
    await f.flush(state, () => events, t.send, isMissing);
    check("missing: latched", state.missing === true);
    check("missing: offset untouched", state.offset === 0);
    const calls = t.sendCalls;
    await f.flush(state, () => events, t.send, isMissing);
    await f.flush(state, () => events, t.send, isMissing);
    check("missing: later flushes never call send again", t.sendCalls === calls);
  }
  // Skip (not configured / signed out) -> pending, unlatched, sendable later.
  {
    const t = new FakeTransport();
    const f = new DrEventFlusher();
    const state = newDrFlushState();
    const events: DrEvent[] = [ev(1, "attempt_created"), ev(2, "session_completed")];
    t.skip = true;
    await f.flush(state, () => events, t.send, notMissing);
    check("skip: offset untouched and not latched", state.offset === 0 && state.missing === false);
    check("skip: nothing persisted", t.server.size === 0);
    t.skip = false;
    await f.flush(state, () => events, t.send, notMissing);
    check("skip: a later flush sends the pending events", t.server.size === 2 && state.offset === 2);
  }
}

/* ------------------------------------------------------------------ */
/* 6. Attempt switch: a queued flush for attempt A must never advance  */
/*    attempt B's state (the page replaces the state object per        */
/*    attempt; resume starts from a pre-advanced offset).              */
/* ------------------------------------------------------------------ */
async function attemptSwitchTests() {
  const tA = new FakeTransport();
  tA.gated = true;
  const tB = new FakeTransport();
  const f = new DrEventFlusher(); // one flusher per page, as in production
  const stateA = newDrFlushState();
  const eventsA: DrEvent[] = [ev(1, "attempt_created"), ev(2, "order_filled"), ev(3, "session_completed")];

  const flushA = f.flush(stateA, () => eventsA, tA.send, notMissing);
  await tick(); // A is inside its gated send

  // The user locks a NEW attempt before A's flush settles: fresh state.
  const stateB = newDrFlushState();
  const eventsB: DrEvent[] = [ev(1, "attempt_created"), ev(2, "session_started")];
  const flushB = f.flush(stateB, () => eventsB, tB.send, notMissing);

  tA.releaseOne();
  await Promise.all([flushA, flushB]);
  check("switch: A persisted fully on its own state", stateA.offset === 3 && tA.server.size === 3);
  check("switch: B persisted fully on its own state", stateB.offset === 2 && tB.server.size === 2);

  // Resume: state starts pre-advanced past the loaded stream; only the
  // new tail is sent.
  const stateR: DrFlushState = newDrFlushState(3);
  const eventsR: DrEvent[] = [
    ev(1, "attempt_created"), ev(2, "order_filled"), ev(3, "position_closed"),
    ev(4, "session_paused"), ev(5, "session_completed"),
  ];
  const tR = new FakeTransport();
  await f.flush(stateR, () => eventsR, tR.send, notMissing);
  check("resume: only the un-persisted tail is sent",
    JSON.stringify(tR.sentSeqs) === JSON.stringify([4, 5]) && stateR.offset === 5);
}

/* ------------------------------------------------------------------ */
/* 7. BUG PINS: the OLD page algorithm, ported faithfully, MUST lose   */
/*    events under the exact interleavings above. These checks pass    */
/*    by confirming the loss — they pin the root cause so the fix's    */
/*    value is proven against the shipped behavior, not asserted.      */
/*    Old algorithm (app/replay/page.tsx pre-fix): slice the pending   */
/*    batch from the shared offset at CALL time, await the send, then  */
/*    advance the offset by the batch's own length. Nothing serialized */
/*    concurrent calls (recorder listener, exit handler, completion).  */
/* ------------------------------------------------------------------ */
class OldPageFlush {
  flushed = 0;
  missing = false;
  constructor(private transport: FakeTransport) {}
  async flush(getEvents: () => readonly DrEvent[]): Promise<void> {
    if (this.missing) return;
    const pending = getEvents().slice(this.flushed); // call-time slice
    if (pending.length === 0) return;
    try {
      const r = await this.transport.send(pending);
      if (r === "skip") return;
      this.flushed += pending.length; // advance by own batch length
    } catch (e) {
      if (isMissing(e)) this.missing = true;
      // otherwise: leave pending; a later flush retries
    }
  }
}

async function oldLogicBugPins() {
  // Race shape: two overlapping flushes double-advance past the tail.
  {
    const t = new FakeTransport();
    t.gated = true;
    const f = new OldPageFlush(t);
    const events: DrEvent[] = [
      ev(1, "attempt_created"), ev(2, "session_started"), ev(3, "order_filled"),
    ];
    const a = f.flush(() => events);
    const b = f.flush(() => events);
    await tick();
    t.releaseOne();
    t.releaseOne();
    await Promise.all([a, b]);
    check("bug pin (old): offset overshoots to 6 over 3 events", f.flushed === 6);
    events.push(ev(4, "session_paused"), ev(5, "session_completed"));
    await f.flush(() => events);
    check("bug pin (old): lifecycle tail is lost forever",
      t.server.size === 3 && !t.server.has(4) && !t.server.has(5));
  }
  // Short-session shape: the overshoot strands the fill/risk/close
  // events recorded after it — a mid-stream hole (the shape behind
  // production attempts whose persisted stream is missing the events
  // that carry R).
  {
    const t = new FakeTransport();
    t.gated = true;
    const f = new OldPageFlush(t);
    const events: DrEvent[] = [
      ev(1, "attempt_created"), ev(2, "session_started"), ev(3, "order_submitted"),
    ];
    const a = f.flush(() => events);
    const b = f.flush(() => events);
    await tick();
    t.releaseOne();
    t.releaseOne();
    await Promise.all([a, b]);
    t.gated = false;
    events.push(
      ev(4, "order_filled"), ev(5, "position_changed"), ev(6, "risk_snapshot"),
      ev(7, "order_filled"), ev(8, "position_closed"), ev(9, "session_completed"),
    );
    await f.flush(() => events);
    check("bug pin (old): short-session hole — entry/risk events stranded",
      !t.server.has(4) && !t.server.has(5) && !t.server.has(6) &&
      t.server.has(9) && t.server.size === 6);
  }
}

/* ------------------------------------------------------------------ */
/* 8. Recorder-driven short session through the NEW flusher, wired    */
/*    exactly like the page (state captured per attempt, getEvents =   */
/*    recorder.all, completion awaits a final flush): every event —    */
/*    including the risk_snapshot that R derives from and the          */
/*    session_completed tail — must persist exactly once, in order.    */
/* ------------------------------------------------------------------ */
async function recorderShortSessionTests() {
  const t = new FakeTransport();
  t.gated = true;
  const f = new DrEventFlusher();
  const state = newDrFlushState();
  const rec = new DrEventRecorder(() => 1_700_000_000_000);
  const flush = () => f.flush(state, () => rec.all, t.send, notMissing);

  rec.record("attempt_created", { ticker: "DEMO" });
  rec.record("session_started", {});
  rec.record("order_submitted", { side: "buy", qty: 100 });
  const a = flush(); // opening burst in flight…
  const b = flush(); // …raced by a second trigger, as in production
  await tick();
  check("recorder session: one send in flight for two triggers", t.sendCalls === 1);

  // The trade happens while the first send is still in flight.
  rec.recordFill({ side: "buy", qty: 100, price: 10, candleIndex: 5, time: 1_700_000_060_000 });
  rec.recordRiskSnapshot(
    { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 12, plannedRisk: 50, rewardRisk: 4 },
    { marketIdx: 5, marketTs: 1_700_000_060_000 },
  );
  rec.recordFill({
    side: "sell", qty: 100, price: 11, candleIndex: 9, time: 1_700_000_300_000,
    realizedPnl: 100,
  });
  rec.record("session_completed", { realizedPnl: 100 });

  t.releaseOne(); // opening batch lands; the drain must loop for the rest
  await tick();
  t.releaseOne(); // remainder lands
  await Promise.all([a, b]);
  await flush(); // completion's awaited final flush: nothing left

  const total = rec.length;
  check("recorder session: every recorded event persisted",
    t.server.size === total);
  check("recorder session: seqs sent exactly once, in order",
    JSON.stringify(t.sentSeqs) ===
      JSON.stringify(Array.from({ length: total }, (_, i) => i + 1)));
  const types = t.persistedTypes();
  check("recorder session: risk_snapshot persisted (R source intact)",
    types.includes("risk_snapshot"));
  check("recorder session: position_closed + session_completed persisted",
    types.includes("position_closed") &&
      types[types.length - 1] === "session_completed");
  check("recorder session: offset exact at stream end", state.offset === total);
}

(async () => {
  await burstTests();
  await raceTests();
  await concurrentBurstTests();
  await failureTests();
  await latchAndSkipTests();
  await attemptSwitchTests();
  await oldLogicBugPins();
  await recorderShortSessionTests();
  console.log(`\n=== DR EVENT FLUSH RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
