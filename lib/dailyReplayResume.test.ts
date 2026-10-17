/**
 * dailyReplayResume.test.ts — tests for Daily Replay refresh-resume:
 * SealedCandleFeed.attach, DrEventRecorder.loadExisting, and
 * reconstructDrAttempt (lib/dailyReplayResume.ts).
 * Run: npx -y tsx lib/dailyReplayResume.test.ts
 *
 * The "live session" scripts below drive the real engine + recorder
 * the way app/replay/page.tsx does (fills observed centrally and fed
 * to the recorder; brackets fed on every application), capture the
 * resulting event stream — the same stream that would be persisted to
 * daily_replay_events — and then prove that reconstruction from the
 * stream + the revealed candle prefix reproduces the live state.
 */
import {
  SealedCandleFeed,
  type SealedTransport,
  type CreateAttemptResult,
  type AdvanceResult,
  type RevealedResult,
} from "./dailyReplay";
import { ReplayEngine } from "./engine";
import { etToUtcMs } from "./marketData";
import { DrEventRecorder, type DrEvent } from "./dailyReplayEvents";
import {
  reconstructDrAttempt,
  shouldOfferDrResume,
} from "./dailyReplayResume";
import type { Candle } from "./types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const FRI = "2026-10-16";

/** Valid 1-minute candles for `date`, starting at ET time `from`, n of them. */
function makeCandles(date: string, from: string, n: number): Candle[] {
  const [fh, fm] = from.split(":").map(Number);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const mins = fh * 60 + fm + i;
    const hhmm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    const price = 100 + i * 0.1;
    out.push({
      t: etToUtcMs(date, hhmm),
      o: price,
      h: price + 0.05,
      l: price - 0.05,
      c: price + 0.02,
      v: 1000 + i,
    });
  }
  return out;
}

/* Fake server mirroring the dr_* RPC rules (same pattern as
 * lib/dailyReplay.test.ts): ownership on every call, position only
 * moves inside advance, steps clamped to [1, 60]. */
class FakeStore {
  datasets = new Map<string, { ownerId: string; candles: Candle[] }>();
  attempts = new Map<
    string,
    { ownerId: string; datasetId: string; position: number; status: string }
  >();
  private n = 0;
  addDataset(ownerId: string, candles: Candle[]): string {
    const id = `ds-${++this.n}`;
    this.datasets.set(id, { ownerId, candles });
    return id;
  }
}

class FakeTransport implements SealedTransport {
  constructor(
    private store: FakeStore,
    private callerId: string,
  ) {}

  async createAttempt(datasetId: string, startIndex: number): Promise<CreateAttemptResult> {
    const ds = this.store.datasets.get(datasetId);
    if (!ds) throw new Error("dataset not found");
    if (ds.ownerId !== this.callerId) throw new Error("permission denied: not your dataset");
    if (startIndex < 0 || startIndex > ds.candles.length - 1) {
      throw new Error("start_index out of range");
    }
    const attemptId = `att-${Math.random().toString(36).slice(2, 9)}`;
    this.store.attempts.set(attemptId, {
      ownerId: this.callerId, datasetId, position: startIndex, status: "active",
    });
    return { attemptId, position: startIndex, candles: ds.candles.slice(0, startIndex + 1) };
  }

  async advance(attemptId: string, steps: number): Promise<AdvanceResult> {
    const att = this.store.attempts.get(attemptId);
    if (!att) throw new Error("attempt not found");
    if (att.ownerId !== this.callerId) throw new Error("permission denied: not your attempt");
    if (att.status !== "active") throw new Error("attempt is not active");
    const ds = this.store.datasets.get(att.datasetId)!;
    const clamped = Math.min(60, Math.max(1, Math.floor(steps)));
    const old = att.position;
    att.position = Math.min(old + clamped, ds.candles.length - 1);
    return {
      position: att.position,
      candles: ds.candles.slice(old + 1, att.position + 1),
      finished: att.position === ds.candles.length - 1,
    };
  }

  async getRevealed(attemptId: string): Promise<RevealedResult> {
    const att = this.store.attempts.get(attemptId);
    if (!att) throw new Error("attempt not found");
    if (att.ownerId !== this.callerId) throw new Error("permission denied: not your attempt");
    const ds = this.store.datasets.get(att.datasetId)!;
    return { position: att.position, candles: ds.candles.slice(0, att.position + 1) };
  }
}

/**
 * The page's central fill observation (drSyncFills), minus the risk
 * snapshot: every new engine fill is fed to the recorder exactly
 * once; a shrinking fills array (engine reset) restarts the shadow.
 */
function makeFillSync(eng: ReplayEngine, rec: DrEventRecorder) {
  const seen = { n: 0 };
  return () => {
    if (eng.fills.length < seen.n) {
      seen.n = 0;
      rec.resetTradingState();
    }
    while (seen.n < eng.fills.length) {
      const f = eng.fills[seen.n++];
      rec.recordFill({
        side: f.side,
        qty: f.qty,
        price: f.price,
        candleIndex: f.candleIndex,
        time: f.time,
        note: f.note,
        realizedPnl: f.realizedPnl,
      });
    }
  };
}

const ctxOf = (eng: ReplayEngine) => ({
  marketIdx: eng.index,
  marketTs: eng.candles[eng.index]?.t ?? null,
});

/* ---------------- resume-offer decision ---------------- */
{
  check("offer: active attempt resumes", shouldOfferDrResume("active") === true);
  check("offer: finished attempt does not", shouldOfferDrResume("finished") === false);
  check("offer: abandoned attempt does not", shouldOfferDrResume("abandoned") === false);
  check("offer: missing row does not", shouldOfferDrResume(null) === false && shouldOfferDrResume(undefined) === false);
  check("offer: unknown status does not", shouldOfferDrResume("whatever") === false);
}

/* ---------------- feed attach (reload re-sync) ---------------- */
async function attachTests() {
  const DAY = makeCandles(FRI, "04:00", 120);
  const store = new FakeStore();
  const dsId = store.addDataset("user-a", DAY);
  const feedA = new SealedCandleFeed(new FakeTransport(store, "user-a"));
  feedA.setTotal(DAY.length);
  await feedA.create(dsId, 30);
  await feedA.advance(25); // server position now 55

  // A brand-new feed (the "reloaded page") attaches to the attempt.
  const feedB = new SealedCandleFeed(new FakeTransport(store, "user-a"));
  feedB.setTotal(DAY.length);
  await feedB.attach(feedA.attemptId!);
  check("attach: position is the server's", feedB.position === 55);
  check("attach: holds exactly the revealed prefix", feedB.candles.length === 56);
  check("attach: prefix matches the original feed", feedB.candles[55].t === feedA.candles[55].t);
  check("attach: attempt id carried", feedB.attemptId === feedA.attemptId);

  // The attached feed continues the attempt normally.
  const added = await feedB.advance(10);
  check("attach: advance still server-gated", added === 10 && feedB.position === 65);
  const eng = new ReplayEngine(feedB.candles, 100_000, 30);
  eng.step();
  check("attach: engine runs over the attached array", eng.index === 30 && !eng.atEnd);

  // Double-attach is a programming error, not a silent re-sync.
  let threw = false;
  try {
    await feedB.attach(feedA.attemptId!);
  } catch {
    threw = true;
  }
  check("attach: second attach throws", threw);
}

/* ---------------- full reconstruction from a scripted live session ---------------- */
async function reconstructionTests() {
  const DAY = makeCandles(FRI, "04:00", 120);
  const store = new FakeStore();
  const dsId = store.addDataset("user-a", DAY);
  const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
  feed.setTotal(DAY.length);
  await feed.create(dsId, 40);
  await feed.advance(30); // revealed [0..70]

  const eng = new ReplayEngine(feed.candles, 100_000, 40);
  let wt = 1_780_000_000_000;
  const rec = new DrEventRecorder(() => (wt += 1000));
  const sync = makeFillSync(eng, rec);
  const ctx = () => ctxOf(eng);

  rec.record(
    "attempt_created",
    { ticker: "TEST", tradeDate: FRI, startIndex: 40, startEtTime: "09:20", startingBalance: 100_000 },
    { marketIdx: 40, marketTs: DAY[40].t },
  );

  eng.step(); eng.step(); eng.step(); // forming candle 43
  // Planned levels first (as typed pre-entry), then the entry.
  rec.recordBrackets(95, 130, "control", "planned", ctx(), { avgEntry: null, direction: "long" });
  eng.buy(100);
  sync();
  // The buy applies planned levels to the live position.
  eng.setBrackets(95, 130);
  rec.recordBrackets(95, 130, "control", "active", ctx(), { avgEntry: eng.positionAvg, direction: "long" });
  // Drag the stop tighter, then widen the target from the panel.
  eng.setBrackets(98, 130);
  rec.recordBrackets(98, 130, "drag", "active", ctx(), { avgEntry: eng.positionAvg, direction: "long" });
  eng.setBrackets(98, 135);
  rec.recordBrackets(98, 135, "control", "active", ctx(), { avgEntry: eng.positionAvg, direction: "long" });
  // A working limit order, left open at "reload" time.
  check("live: limit order accepted", eng.placeLimitOrder("buy", 10, 90) === null);
  rec.recordLimitPlaced({ side: "buy", qty: 10, limitPrice: 90 }, ctx());
  check("live: one working order before reload", eng.pendingOrders.length === 1);
  // Partial exit, then close.
  eng.step(); eng.step();
  eng.sell(40);
  sync();
  eng.sell(60);
  sync();
  check("live: flat after close", eng.positionQty === 0);
  // Second trade: fresh entry + fresh brackets.
  eng.buy(50);
  sync();
  eng.setBrackets(100, 140);
  rec.recordBrackets(100, 140, "control", "active", ctx(), { avgEntry: eng.positionAvg, direction: "long" });
  eng.step();

  // Snapshot the live state.
  const live = {
    cash: eng.cash,
    qty: eng.positionQty,
    avg: eng.positionAvg,
    realized: eng.realizedPnl,
    fills: eng.fills.map((f) => ({ ...f })),
    sl: eng.stopLoss,
    tp: eng.takeProfit,
    recQty: rec.positionQty,
    recRealized: rec.sessionRealized,
    counts: rec.bracketMoveCounts("active"),
  };
  const events = rec.all;
  const maxSeq = events.length; // seqs are contiguous from 1
  check("live: script produced the expected fills", live.fills.length === 4);

  // --- Reconstruct (the "reload") ---
  const recon = reconstructDrAttempt({
    candles: feed.candles,
    startingBalance: 100_000,
    startIndex: 40,
    events,
  });
  const e2 = recon.engine;
  check("recon: cash reproduced", approx(e2.cash, live.cash));
  check("recon: position reproduced", e2.positionQty === live.qty && live.qty === 50);
  check("recon: average entry reproduced", approx(e2.positionAvg, live.avg, 1e-9));
  check("recon: realized P&L reproduced", approx(e2.realizedPnl, live.realized, 1e-9));
  check("recon: fill count reproduced", e2.fills.length === live.fills.length && recon.fillsReplayed === live.fills.length);
  check(
    "recon: every fill reproduced exactly",
    e2.fills.every((f, i) => {
      const o = live.fills[i];
      return f.side === o.side && f.qty === o.qty && approx(f.price, o.price, 1e-9)
        && f.candleIndex === o.candleIndex && approx(f.realizedPnl, o.realizedPnl, 1e-9);
    }),
  );
  check("recon: engine brackets are the final modified values",
    e2.stopLoss === live.sl && e2.takeProfit === live.tp && live.sl === 100 && live.tp === 140);
  check("recon: restored active bracket levels reported",
    recon.restoredActiveBrackets?.sl === 100 && recon.restoredActiveBrackets?.tp === 140);
  check("recon: restored planned bracket levels reported",
    recon.restoredPlannedBrackets?.sl === 95 && recon.restoredPlannedBrackets?.tp === 130);
  check("recon: recorder shadow position matches live",
    recon.recorder.positionQty === live.recQty && approx(recon.recorder.sessionRealized, live.recRealized, 1e-9));
  check("recon: recorder bracket state matches live",
    recon.recorder.bracketState("active").sl === 100
    && recon.recorder.bracketState("active").tp === 140
    && recon.recorder.bracketState("planned").sl === 95
    && recon.recorder.bracketMoveCounts("active").sl === live.counts.sl
    && recon.recorder.bracketMoveCounts("active").tp === live.counts.tp);
  check("recon: history carried verbatim",
    recon.recorder.all.length === events.length
    && recon.recorder.all.every((e, i) => e.seq === events[i].seq && e.type === events[i].type));
  const marker = recon.recorder.record("session_resumed", { via: "page-reload" });
  check("recon: seq continues from the restored maximum", marker.seq === maxSeq + 1);
  check("recon: restored history untouched by the new event",
    recon.recorder.all.slice(0, events.length).every((e, i) => e.seq === events[i].seq && e.type === events[i].type));
  check("recon: events alone restore no orders (no server order rows passed — daily_replay_orders is the authoritative source)",
    e2.pendingOrders.length === 0 && eng.pendingOrders.length === 1 && recon.restoredOrders.length === 0);

  // The resumed engine keeps working over the feed's array.
  check("recon: engine continues stepping after resume", (() => { e2.step(); return e2.index > 40; })());
}

/* ---------------- session_reset inside the stream ---------------- */
async function resetStreamTests() {
  const DAY = makeCandles(FRI, "09:30", 60);
  const store = new FakeStore();
  const dsId = store.addDataset("user-a", DAY);
  const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
  feed.setTotal(DAY.length);
  await feed.create(dsId, 10);
  await feed.advance(30);

  const eng = new ReplayEngine(feed.candles, 100_000, 10);
  let wt = 1_780_100_000_000;
  const rec = new DrEventRecorder(() => (wt += 1000));
  const sync = makeFillSync(eng, rec);
  rec.record("attempt_created", { ticker: "TEST", tradeDate: FRI, startIndex: 10, startingBalance: 100_000 }, { marketIdx: 10, marketTs: DAY[10].t });

  eng.step();
  eng.buy(10);
  sync();
  // User resets the replay (page: engine reset + timeline event; the
  // recorder's shadow restart happens on the next fill sync).
  eng.reset();
  rec.record("session_reset", {}, ctxOf(eng));
  sync(); // observes the shrink: shadow + counter restart
  eng.step(); eng.step();
  eng.buy(20);
  sync();

  const recon = reconstructDrAttempt({
    candles: feed.candles,
    startingBalance: 100_000,
    startIndex: 10,
    events: rec.all,
  });
  check("reset: only the post-reset fill is in the rebuilt engine",
    recon.engine.fills.length === 1 && recon.fillsReplayed === 1);
  check("reset: cash reflects only the post-reset trade", approx(recon.engine.cash, eng.cash));
  check("reset: position reflects only the post-reset trade",
    recon.engine.positionQty === 20 && recon.recorder.positionQty === 20);
  check("reset: pre-reset history is still in the timeline",
    recon.recorder.all.some((e) => e.type === "order_filled") && recon.recorder.all.length === rec.all.length);
}

/* ---------------- honest degradation: no usable events ---------------- */
{
  const DAY = makeCandles(FRI, "09:30", 30);
  const empty = reconstructDrAttempt({
    candles: DAY.slice(0, 11),
    startingBalance: 100_000,
    startIndex: 10,
    events: [],
  });
  check("degraded: no events → fresh trading state",
    empty.engine.positionQty === 0 && empty.engine.cash === 100_000 && empty.engine.realizedPnl === 0);
  check("degraded: no events → nothing replayed, no brackets",
    empty.fillsReplayed === 0 && empty.restoredActiveBrackets === null && empty.restoredPlannedBrackets === null);
  check("degraded: no events → empty recorder", empty.recorder.length === 0);

  let wt = 1_780_200_000_000;
  const rec = new DrEventRecorder(() => (wt += 1000));
  rec.record("attempt_created", { ticker: "TEST", tradeDate: FRI, startIndex: 10, startingBalance: 100_000 }, { marketIdx: 10, marketTs: DAY[10].t });
  const onlyCreated = reconstructDrAttempt({
    candles: DAY.slice(0, 11),
    startingBalance: 100_000,
    startIndex: 10,
    events: rec.all,
  });
  check("degraded: attempt_created only → flat state, history kept",
    onlyCreated.engine.positionQty === 0 && onlyCreated.engine.cash === 100_000
    && onlyCreated.recorder.length === 1);
}

/* ---------------- recorder restore guards ---------------- */
{
  let wt = 1_780_300_000_000;
  const rec = new DrEventRecorder(() => (wt += 1000));
  rec.record("attempt_created", { ticker: "TEST" });
  const other = new DrEventRecorder(() => (wt += 1000));
  other.loadExisting(rec.all);
  check("guard: loadExisting restores a fresh recorder", other.length === 1 && other.all[0].type === "attempt_created");
  let threw = false;
  try {
    other.loadExisting(rec.all);
  } catch {
    threw = true;
  }
  check("guard: loadExisting twice throws", threw);
  threw = false;
  try {
    rec.loadExisting(rec.all);
  } catch {
    threw = true;
  }
  check("guard: loadExisting on a used recorder throws", threw);
  // Restored events are frozen, like live ones.
  check("guard: restored events are frozen", Object.isFrozen(other.all[0]) && Object.isFrozen(other.all[0].payload));
}

/* ---------------- locked-candle boundary on resume ---------------- */
async function boundaryResumeTests() {
  const DAY = makeCandles(FRI, "04:00", 120);

  // Locked, then refreshed BEFORE ever playing: the server position
  // never moved past the locked candle. The page's resume rule
  // releases exactly the first live candle, then reconstruction must
  // rest ON the locked candle (complete) with lock+1 forming next.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAY);
    const feedA = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feedA.setTotal(DAY.length);
    await feedA.create(dsId, 40);

    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feed.setTotal(DAY.length);
    await feed.attach(feedA.attemptId!);
    if (!feed.finished && feed.position <= 40) await feed.advance(1); // page resume rule
    check("resume-boundary: first live candle released at resume",
      feed.position === 41 && feed.candles.length === 42);

    const recon = reconstructDrAttempt({
      candles: feed.candles, startingBalance: 100_000, startIndex: 40, events: [],
    });
    const e = recon.engine;
    check("resume-boundary: engine rests ON the locked candle, complete",
      e.index === 40 && e.revealed.length === 41 && e.revealed[40].t === DAY[40].t);
    check("resume-boundary: the next candle (lock+1) is the one forming",
      e.displayCandles.length === 42 && e.displayCandles[41].t === DAY[41].t);
    let ticks = 0;
    while (e.index < 41 && ticks < 400) { e.tick(); ticks++; }
    check("resume-boundary: 360 ticks finalize lock+1 (the locked candle never re-forms)",
      ticks === 360 && e.index === 41);
  }

  // Legacy stream: a fill recorded under the OLD boundary at the
  // locked candle itself (it formed live before the fix) must still
  // replay exactly — same fill, same candle index — and the engine
  // then continues with lock+1 as the next live candle.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAY);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feed.setTotal(DAY.length);
    await feed.create(dsId, 40);
    await feed.advance(30); // server position 70: prefix [0..70]

    let wt = 1_780_800_000_000;
    const rec = new DrEventRecorder(() => (wt += 1000));
    rec.record("attempt_created", { ticker: "TEST", tradeDate: FRI, startIndex: 40, startingBalance: 100_000 }, { marketIdx: 40, marketTs: DAY[40].t });
    rec.recordFill({ side: "buy", qty: 10, price: DAY[40].c, candleIndex: 40, time: DAY[40].t, realizedPnl: 0 });

    const recon = reconstructDrAttempt({
      candles: feed.candles, startingBalance: 100_000, startIndex: 40, events: rec.all,
    });
    check("resume-boundary: legacy fill at the locked candle replays exactly",
      recon.fillsReplayed === 1 && recon.engine.fills.length === 1
      && recon.engine.fills[0].candleIndex === 40 && recon.engine.positionQty === 10);
    check("resume-boundary: after a legacy fill the next live candle is lock+1",
      recon.engine.index === 40 && recon.engine.displayCandles[41]?.t === DAY[41].t);
  }

  // Locked the dataset's FINAL candle, then refreshed: the attempt
  // restores already at its end, the final candle complete.
  {
    const DAY30 = makeCandles(FRI, "09:30", 30);
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAY30);
    const feedA = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feedA.setTotal(DAY30.length);
    await feedA.create(dsId, 29);

    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feed.setTotal(DAY30.length);
    await feed.attach(feedA.attemptId!);
    const recon = reconstructDrAttempt({
      candles: feed.candles, startingBalance: 100_000, startIndex: 29, events: [],
    });
    const e = recon.engine;
    check("resume-boundary: locking the final candle resumes at the end, complete",
      e.atEnd && e.index === 29 && e.displayCandles.length === 30
      && e.displayCandles[29].h === DAY30[29].h && e.displayCandles[29].c === DAY30[29].c);
  }
}

(async () => {
  await attachTests();
  await reconstructionTests();
  await resetStreamTests();
  await boundaryResumeTests();
  console.log(`\n=== DAILY REPLAY RESUME RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
