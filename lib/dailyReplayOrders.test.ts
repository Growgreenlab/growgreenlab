/**
 * dailyReplayOrders.test.ts — tests for Daily Replay persistent
 * working orders (lib/dailyReplayOrders.ts + the orders half of
 * lib/dailyReplayResume.ts).
 * Run: npx -y tsx lib/dailyReplayOrders.test.ts
 *
 * The "server" here is FakeOrderStore: an in-memory implementation
 * of DrOrderStore that enforces the SAME rules as
 * daily-replay-v2-orders.sql — idempotent place on the uuid,
 * ownership via the parent attempt, attempt must be active to place,
 * and dr_update_order's transition guards (shared code:
 * validateOrderTransition). The SQL itself is exercised separately
 * in the scratch-Postgres harness (test-v2.mjs).
 *
 * The live-session scripts drive the real ReplayEngine + a
 * DrOrderTracker through the page's exact choreography: register on
 * engine acceptance, settle via the departure diff in the central
 * fill sync (snapshot pending ids → diff → persist ops), take() on
 * user cancel. A "refresh" is then: read the store rows back and run
 * reconstructDrAttempt with them.
 */
import { ReplayEngine } from "./engine";
import { etToUtcMs } from "./marketData";
import { DrEventRecorder, type DrEvent } from "./dailyReplayEvents";
import { reconstructDrAttempt } from "./dailyReplayResume";
import {
  DrOrderTracker,
  newDrOrderId,
  planRestoredOrders,
  validateOrderTransition,
  type DrOrderRow,
  type DrOrderStatus,
  type DrOrderStore,
  type DrOrderUpdateOp,
} from "./dailyReplayOrders";
import type { Candle, Side } from "./types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const FRI = "2026-10-16";

/** Valid 1-minute candles for `date`, starting at ET time `from`, n of them.
 *  Price drifts down 0.10/candle from `start` so limit buys below the
 *  market fill deterministically as the tape advances. */
function makeCandles(date: string, from: string, n: number, start = 110): Candle[] {
  const [fh, fm] = from.split(":").map(Number);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const mins = fh * 60 + fm + i;
    const hhmm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    const price = start - i * 0.1;
    out.push({
      t: etToUtcMs(date, hhmm),
      o: price,
      h: price + 0.05,
      l: price - 0.05,
      c: price - 0.02,
      v: 1000 + i,
    });
  }
  return out;
}

/* ---------------- FakeOrderStore (mirrors the v2 SQL rules) ---------------- */
class FakeOrderStore implements DrOrderStore {
  rows = new Map<string, DrOrderRow>();
  attempts = new Map<string, { ownerId: string; status: string }>();
  private clock = 0;

  addAttempt(attemptId: string, ownerId: string): void {
    this.attempts.set(attemptId, { ownerId, status: "active" });
  }
  finishAttempt(attemptId: string): void {
    const a = this.attempts.get(attemptId);
    if (a) a.status = "finished";
  }

  constructor(private callerId: string) {}

  async place(row: {
    id: string; attemptId: string; side: Side; qty: number;
    limitPrice: number; engineOrderId: number | null;
  }): Promise<DrOrderRow> {
    const att = this.attempts.get(row.attemptId);
    if (!att) throw new Error("attempt not found");
    if (att.ownerId !== this.callerId) throw new Error("permission denied: not your attempt");
    if (att.status !== "active") throw new Error("attempt is not active");
    const existing = this.rows.get(row.id);
    if (existing) {
      // Idempotent on the uuid — but never confirm another attempt's id.
      if (existing.attemptId !== row.attemptId || ownerOf(existing) !== this.callerId) {
        throw new Error("order id already in use");
      }
      return existing;
    }
    const full: DrOrderRow = {
      id: row.id,
      attemptId: row.attemptId,
      side: row.side,
      orderType: "limit",
      qty: row.qty,
      filledQty: 0,
      limitPrice: row.limitPrice,
      status: "working",
      engineOrderId: row.engineOrderId,
      createdAt: new Date(1_780_000_000_000 + ++this.clock).toISOString(),
    };
    // userId is not part of DrOrderRow; ownership rides on the attempt.
    (full as DrOrderRow & { _owner: string })._owner = this.callerId;
    this.rows.set(row.id, full);
    return full;
  }

  async update(orderId: string, status: DrOrderStatus, filledQty: number): Promise<DrOrderRow> {
    const row = this.rows.get(orderId);
    if (!row) throw new Error("order not found");
    if (ownerOf(row) !== this.callerId) {
      throw new Error("permission denied: not your order");
    }
    const err = validateOrderTransition(row, { status, filledQty });
    if (err) throw new Error(err);
    row.status = status;
    row.filledQty = filledQty;
    return row;
  }

  async list(attemptId: string): Promise<DrOrderRow[]> {
    const att = this.attempts.get(attemptId);
    if (!att || att.ownerId !== this.callerId) return [];
    return [...this.rows.values()]
      .filter((r) => r.attemptId === attemptId)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }

  /** Count of store mutations that would hit the network (for dupe checks). */
  get size(): number {
    return this.rows.size;
  }
}

// DrOrderRow carries no user id by design (ownership rides on the
// parent attempt, as in the SQL); the fake keeps it out-of-band.
function ownerOf(row: DrOrderRow): string {
  return (row as DrOrderRow & { _owner: string })._owner;
}

/* ---------------- session harness: engine + tracker + store ---------------- */
/**
 * Mirrors the page: placeLimit places in the engine, registers with
 * the tracker, persists; sync() is drSyncFills' order half — diff
 * tracked orders vs current pending ids over the fills produced
 * since the last sync, persist the resulting ops in order.
 */
class Session {
  eng: ReplayEngine;
  tracker = new DrOrderTracker();
  seenFills = 0;
  opsLog: DrOrderUpdateOp[] = [];
  fillOrderIds = new Map<number, string>(); // engine fill id -> persistent uuid

  constructor(
    candles: Candle[],
    startIndex: number,
    private store: FakeOrderStore,
    private attemptId: string,
  ) {
    this.eng = new ReplayEngine(candles, 100_000, startIndex);
  }

  async placeLimit(side: Side, qty: number, price: number): Promise<string | null> {
    const before = new Set(this.eng.pendingOrders.map((o) => o.id));
    const err = this.eng.placeLimitOrder(side, qty, price);
    if (err) return err; // engine refused: never persisted
    const placed = this.eng.pendingOrders.find((o) => !before.has(o.id))!;
    const row: DrOrderRow = {
      id: newDrOrderId(),
      attemptId: this.attemptId,
      side: placed.side,
      orderType: "limit",
      qty: placed.qty,
      filledQty: 0,
      limitPrice: placed.limitPrice,
      status: "working",
      engineOrderId: placed.id,
    };
    this.tracker.track(placed.id, row);
    await this.store.place(row);
    return null;
  }

  async cancel(engineOrderId: number): Promise<boolean> {
    const o = this.eng.pendingOrders.find((x) => x.id === engineOrderId);
    if (!o || !this.eng.cancelOrder(engineOrderId)) return false;
    const row = this.tracker.take(engineOrderId);
    if (row) {
      const op = { orderId: row.id, status: "cancelled" as const, filledQty: row.filledQty };
      this.opsLog.push(op);
      await this.store.update(op.orderId, op.status, op.filledQty);
    }
    return true;
  }

  /** One drSyncFills pass (order half). Returns this pass's new fills. */
  async sync(): Promise<void> {
    const newFills = this.eng.fills.slice(this.seenFills);
    this.seenFills = this.eng.fills.length;
    const settled = this.tracker.syncDepartures(
      new Set(this.eng.pendingOrders.map((o) => o.id)),
      newFills,
    );
    for (const [fill, uuid] of settled.fillOrderId) {
      this.fillOrderIds.set(fill.id, uuid);
    }
    for (const op of settled.updates) {
      this.opsLog.push(op);
      await this.store.update(op.orderId, op.status, op.filledQty);
    }
  }

  /** The engine fill ids currently in the engine, for dupe checks. */
  get fillCount(): number {
    return this.eng.fills.length;
  }
}

const ctxOf = (eng: ReplayEngine) => ({
  marketIdx: eng.index,
  marketTs: eng.candles[eng.index]?.t ?? null,
});

/* ---------------- transition guards (unit) ---------------- */
{
  const w = { status: "working" as const, qty: 100, filledQty: 0 };
  check("guard: working->filled at full qty ok",
    validateOrderTransition(w, { status: "filled", filledQty: 100 }) === null);
  check("guard: working->filled short of qty rejected",
    validateOrderTransition(w, { status: "filled", filledQty: 99 }) !== null);
  check("guard: working->working progress ok",
    validateOrderTransition(w, { status: "working", filledQty: 40 }) === null);
  check("guard: working->working at full qty rejected (must be 'filled')",
    validateOrderTransition(w, { status: "working", filledQty: 100 }) !== null);
  check("guard: filled_qty above qty rejected",
    validateOrderTransition(w, { status: "working", filledQty: 101 }) !== null);
  check("guard: filled_qty regression rejected",
    validateOrderTransition({ status: "working", qty: 100, filledQty: 40 }, { status: "cancelled", filledQty: 39 }) !== null);
  check("guard: working->cancelled ok",
    validateOrderTransition(w, { status: "cancelled", filledQty: 0 }) === null);
  check("guard: filled is terminal (filled->cancelled rejected)",
    validateOrderTransition({ status: "filled", qty: 100, filledQty: 100 }, { status: "cancelled", filledQty: 100 }) !== null);
  check("guard: cancelled is terminal (cancelled->working rejected)",
    validateOrderTransition({ status: "cancelled", qty: 100, filledQty: 0 }, { status: "working", filledQty: 0 }) !== null);
  check("guard: rejected is terminal",
    validateOrderTransition({ status: "rejected", qty: 100, filledQty: 0 }, { status: "working", filledQty: 0 }) !== null);
  check("guard: invalid status rejected",
    validateOrderTransition(w, { status: "bogus" as DrOrderStatus, filledQty: 0 }) !== null);
}

/* ---------------- restore planning (unit) ---------------- */
{
  const rows: DrOrderRow[] = [
    { id: "a", attemptId: "t", side: "buy", orderType: "limit", qty: 100, filledQty: 0, limitPrice: 90, status: "working", engineOrderId: 1 },
    { id: "b", attemptId: "t", side: "buy", orderType: "limit", qty: 100, filledQty: 30, limitPrice: 91, status: "working", engineOrderId: 2 },
    { id: "c", attemptId: "t", side: "sell", orderType: "limit", qty: 50, filledQty: 50, limitPrice: 95, status: "filled", engineOrderId: 3 },
    { id: "d", attemptId: "t", side: "sell", orderType: "limit", qty: 50, filledQty: 0, limitPrice: 96, status: "cancelled", engineOrderId: 4 },
    { id: "e", attemptId: "t", side: "buy", orderType: "limit", qty: 10, filledQty: 0, limitPrice: 92, status: "rejected", engineOrderId: null },
    { id: "f", attemptId: "t", side: "buy", orderType: "limit", qty: 10, filledQty: 10, limitPrice: 93, status: "working", engineOrderId: 5 },
  ];
  const plan = planRestoredOrders(rows);
  check("plan: only working rows with remaining qty restore",
    plan.length === 2 && plan[0].row.id === "a" && plan[1].row.id === "b");
  check("plan: remaining qty = qty - filled_qty",
    plan[0].remainingQty === 100 && plan[1].remainingQty === 70);
}

/* ---------------- store rules: idempotency + ownership ---------------- */
async function storeRuleTests() {
  const store = new FakeOrderStore("user-a");
  store.addAttempt("att-1", "user-a");
  const row = {
    id: newDrOrderId(), attemptId: "att-1", side: "buy" as Side,
    qty: 25, limitPrice: 88.5, engineOrderId: 7,
  };
  await store.place(row);
  await store.place(row); // retry of the same placement (refresh racing it)
  check("store: place is idempotent on the uuid (one row)", store.size === 1);
  const listed = await store.list("att-1");
  check("store: owner lists the working order",
    listed.length === 1 && listed[0].status === "working" && listed[0].qty === 25);

  const other = new FakeOrderStore("user-b");
  other.attempts = store.attempts;
  other.rows = store.rows;
  check("store: other user lists nothing (RLS)", (await other.list("att-1")).length === 0);
  let threw = false;
  try { await other.update(row.id, "cancelled", 0); } catch { threw = true; }
  check("store: wrong-owner update rejected", threw);
  threw = false;
  try {
    await other.place({ id: newDrOrderId(), attemptId: "att-1", side: "buy", qty: 1, limitPrice: 1, engineOrderId: null });
  } catch { threw = true; }
  check("store: wrong-owner place rejected (attempt ownership)", threw);
  threw = false;
  try {
    // Reusing user-a's order uuid against user-b's own attempt must not confirm it.
    const bStore = new FakeOrderStore("user-b");
    bStore.attempts = store.attempts; bStore.rows = store.rows;
    bStore.addAttempt("att-2", "user-b");
    await bStore.place({ id: row.id, attemptId: "att-2", side: "buy", qty: 1, limitPrice: 1, engineOrderId: null });
  } catch { threw = true; }
  check("store: an existing uuid cannot be claimed by another attempt", threw);

  store.finishAttempt("att-1");
  threw = false;
  try {
    await store.place({ id: newDrOrderId(), attemptId: "att-1", side: "buy", qty: 1, limitPrice: 1, engineOrderId: null });
  } catch { threw = true; }
  check("store: place on a finished attempt rejected", threw);
  // …but a fill that landed just before the finish can still be marked.
  await store.update(row.id, "filled", 25);
  check("store: working->filled at full qty lands", store.rows.get(row.id)?.status === "filled");
  threw = false;
  try { await store.update(row.id, "cancelled", 25); } catch { threw = true; }
  check("store: terminal order can never change again", threw);
}

/* ---------------- live session: fill, cancel, extinguish, restore ---------------- */
async function liveSessionTests() {
  const DAY = makeCandles(FRI, "09:30", 90, 110); // drifts 110 -> ~101
  const store = new FakeOrderStore("user-a");
  store.addAttempt("att-live", "user-a");
  const s = new Session(DAY, 5, store, "att-live");

  // A working buy limit below the market, and one that will fill.
  await s.placeLimit("buy", 40, 105); // fills when tape reaches ~105 (candle ~50)
  const workingId = s.tracker.all()[0].id;
  await s.placeLimit("buy", 10, 95); // never reached (tape ends ~101)
  const restingId = s.tracker.all()[1].id;
  await s.sync();
  check("live: both orders persisted as working",
    (await store.list("att-live")).filter((r) => r.status === "working").length === 2);

  // A user-cancelled order stays cancelled.
  await s.placeLimit("buy", 5, 96);
  const cancelledId = s.tracker.all()[2].id;
  const engIdOfCancelled = s.eng.pendingOrders.find((o) => o.limitPrice === 96)!.id;
  check("live: cancel succeeds", await s.cancel(engIdOfCancelled));
  check("live: cancelled row is terminal in the store",
    store.rows.get(cancelledId)?.status === "cancelled");

  // Engine-rejected placements are never persisted (sell with no position).
  const rowsBefore = store.size;
  const rejectedErr = await s.placeLimit("sell", 10, 120);
  check("live: engine-rejected placement returns its error and persists nothing",
    rejectedErr !== null && store.size === rowsBefore);

  // Run the tape until the 105 limit fills.
  for (let i = 0; i < 55 && s.eng.positionQty === 0; i++) { s.eng.step(); await s.sync(); }
  check("live: limit order filled in the engine", s.eng.positionQty === 40);
  check("live: filled order's row is 'filled' at full qty",
    store.rows.get(workingId)?.status === "filled" && store.rows.get(workingId)?.filledQty === 40);
  check("live: the fill is linked to the persistent order id",
    [...s.fillOrderIds.values()].includes(workingId));
  check("live: tracker no longer holds the filled order",
    s.tracker.get(s.eng.pendingOrders[0]?.id ?? -1)?.id !== workingId && s.tracker.size === 1);

  // A resting SELL order dies with the position (engine side-cancel):
  // place a sell limit that cannot fill (price above the tape), then
  // close the position with a market sell.
  await s.placeLimit("sell", 40, 130);
  const doomedSellId = s.tracker.all().find((r) => r.side === "sell")!.id;
  s.eng.sell(40);
  await s.sync();
  check("live: position closed by market sell", s.eng.positionQty === 0);
  check("live: sell order extinguished by the close is 'cancelled' server-side",
    store.rows.get(doomedSellId)?.status === "cancelled");

  // --- Refresh: reconstruction from the store rows + the events the
  // live session would have persisted (fills replayed from events). ---
  let wt = 1_780_400_000_000;
  const rec = new DrEventRecorder(() => (wt += 1000));
  rec.record("attempt_created", { ticker: "TEST", tradeDate: FRI, startIndex: 5, startingBalance: 100_000 }, ctxOf(s.eng));
  for (const f of s.eng.fills) {
    rec.recordFill({ side: f.side, qty: f.qty, price: f.price, candleIndex: f.candleIndex, time: f.time, note: f.note, realizedPnl: f.realizedPnl });
  }
  const rows = await store.list("att-live");
  const recon = reconstructDrAttempt({
    candles: DAY.slice(0, 70),
    startingBalance: 100_000,
    startIndex: 5,
    events: rec.all,
    orders: rows,
  });
  check("refresh: exactly the still-working order is restored",
    recon.restoredOrders.length === 1 && recon.restoredOrders[0].orderId === restingId);
  check("refresh: restored order rests in the rebuilt engine at full remaining qty",
    recon.engine.pendingOrders.length === 1
    && recon.engine.pendingOrders[0].qty === 10
    && recon.engine.pendingOrders[0].limitPrice === 95);
  check("refresh: filled order NOT duplicated (fill count = recorded fills)",
    recon.engine.fills.length === s.eng.fills.length && recon.fillsReplayed === s.eng.fills.length);
  check("refresh: cancelled orders stay cancelled (none restored)",
    !recon.restoredOrders.some((o) => o.orderId === cancelledId || o.orderId === doomedSellId));

  // Second consecutive refresh from the SAME server state → identical
  // restoration, no new rows, no new events.
  const rowsAgain = await store.list("att-live");
  const recon2 = reconstructDrAttempt({
    candles: DAY.slice(0, 70),
    startingBalance: 100_000,
    startIndex: 5,
    events: rec.all,
    orders: rowsAgain,
  });
  check("refresh x2: identical working-order state",
    recon2.engine.pendingOrders.length === 1
    && recon2.engine.pendingOrders[0].limitPrice === 95
    && recon2.engine.fills.length === recon.engine.fills.length);
  check("refresh x2: store unchanged (no duplicate orders)",
    store.size === rowsBefore + 1 /* the doomed sell */);
  check("refresh x2: reconstruction itself records no events",
    recon2.recorder.length === rec.all.length);
}

/* ---------------- partial fill (engine sell clamp) + remaining qty ---------------- */
async function partialFillTests() {
  const DAY = makeCandles(FRI, "09:30", 90, 110);
  const store = new FakeOrderStore("user-a");
  store.addAttempt("att-partial", "user-a");
  const s = new Session(DAY, 5, store, "att-partial");

  s.eng.buy(100); // position 100 at ~109.5
  await s.sync();
  check("partial: market buy filled", s.eng.positionQty === 100);
  await s.placeLimit("sell", 80, 108); // fills when tape falls to 108
  const orderId = s.tracker.all()[0].id;
  s.eng.sell(50); // market sell halves the position BEFORE the limit can fill
  await s.sync();
  check("partial: position halved by market sell", s.eng.positionQty === 50);
  // Tape drifts down to 108: the engine's execSell clamps the 80-share
  // order to the 50 shares that exist; the order then leaves the book.
  for (let i = 0; i < 30 && s.eng.positionQty > 0; i++) { s.eng.step(); await s.sync(); }
  check("partial: clamped fill emptied the position", s.eng.positionQty === 0);
  const row = store.rows.get(orderId)!;
  check("partial: row records the exact filled quantity (50 of 80)",
    row.filledQty === 50 && row.qty === 80);
  check("partial: extinguished remainder is terminal (cancelled), never restorable",
    row.status === "cancelled" && planRestoredOrders([row]).length === 0);
  const fillQty = s.eng.fills.filter((f) => f.note?.startsWith("limit")).reduce((a, f) => a + f.qty, 0);
  check("partial: engine limit fill qty matches the row", fillQty === 50);
}

/* ---------------- progressive filled_qty -> restore remaining, fill rest after resume ---------------- */
async function progressiveRestoreTests() {
  const store = new FakeOrderStore("user-a");
  store.addAttempt("att-prog", "user-a");
  // Authoritative state mid-flight: an order placed and partially
  // executed (filled_qty persisted progressively), still working.
  const id = newDrOrderId();
  await store.place({ id, attemptId: "att-prog", side: "buy", qty: 100, limitPrice: 105, engineOrderId: 3 });
  await store.update(id, "working", 30); // progressive fill update
  check("progressive: filled_qty persists on a working row",
    store.rows.get(id)?.status === "working" && store.rows.get(id)?.filledQty === 30);

  const DAY = makeCandles(FRI, "09:30", 90, 110);
  let wt = 1_780_500_000_000;
  const rec = new DrEventRecorder(() => (wt += 1000));
  rec.record("attempt_created", { ticker: "TEST", tradeDate: FRI, startIndex: 5, startingBalance: 100_000 }, { marketIdx: 5, marketTs: DAY[5].t });
  rec.recordFill({ side: "buy", qty: 30, price: 105, candleIndex: 20, time: DAY[20].t, note: "limit 105.00", realizedPnl: 0, orderUuid: id });

  const rows = await store.list("att-prog");
  const recon = reconstructDrAttempt({
    candles: DAY.slice(0, 80),
    startingBalance: 100_000,
    startIndex: 5,
    events: rec.all,
    orders: rows,
  });
  check("progressive: restored at REMAINING qty (100 - 30 = 70)",
    recon.restoredOrders.length === 1 && recon.restoredOrders[0].remainingQty === 70
    && recon.engine.pendingOrders[0].qty === 70);
  check("progressive: the earlier partial fill is in the engine exactly once",
    recon.engine.positionQty === 30 && recon.engine.fills.length === 1);

  // The resumed order fills the rest; the tracker (registered by the
  // page from restoredOrders) settles the SAME row to filled/100.
  const tracker = new DrOrderTracker();
  const ro = recon.restoredOrders[0];
  tracker.track(ro.engineOrderId, { ...rows[0] });
  const seen = { n: recon.engine.fills.length };
  for (let i = 0; i < 60 && tracker.size > 0; i++) {
    recon.engine.step();
    const pending = new Set(recon.engine.pendingOrders.map((o) => o.id));
    const newFills = recon.engine.fills.slice(seen.n);
    seen.n = recon.engine.fills.length;
    const settled = tracker.syncDepartures(pending, newFills);
    for (const op of settled.updates) await store.update(op.orderId, op.status, op.filledQty);
  }
  check("progressive: post-resume fill settles the same row to filled at FULL qty",
    store.rows.get(id)?.status === "filled" && store.rows.get(id)?.filledQty === 100);
  check("progressive: total executed across refresh = 30 + 70 (no duplication)",
    recon.engine.fills.reduce((a, f) => a + f.qty, 0) === 100);
}

/* ---------------- refresh during submission (server has it, engine doesn't) ---------------- */
async function refreshDuringSubmissionTests() {
  const store = new FakeOrderStore("user-a");
  store.addAttempt("att-crash", "user-a");
  const id = newDrOrderId();
  // The insert landed; the page died before the order ever rested in
  // an engine (or before this client ever saw it).
  await store.place({ id, attemptId: "att-crash", side: "buy", qty: 15, limitPrice: 99, engineOrderId: 1 });
  const DAY = makeCandles(FRI, "09:30", 40, 110);
  let wt = 1_780_600_000_000;
  const rec = new DrEventRecorder(() => (wt += 1000));
  rec.record("attempt_created", { ticker: "TEST", tradeDate: FRI, startIndex: 5, startingBalance: 100_000 }, { marketIdx: 5, marketTs: DAY[5].t });
  const rows = await store.list("att-crash");
  const recon = reconstructDrAttempt({
    candles: DAY.slice(0, 20),
    startingBalance: 100_000,
    startIndex: 5,
    events: rec.all,
    orders: rows,
  });
  check("crash-window: server-working order is restored exactly once",
    recon.restoredOrders.length === 1 && recon.engine.pendingOrders.length === 1
    && recon.engine.pendingOrders[0].qty === 15 && recon.engine.pendingOrders[0].limitPrice === 99);
  // And a second refresh still restores exactly once (same row).
  const recon2 = reconstructDrAttempt({
    candles: DAY.slice(0, 20),
    startingBalance: 100_000,
    startIndex: 5,
    events: rec.all,
    orders: await store.list("att-crash"),
  });
  check("crash-window: second refresh does not duplicate it",
    recon2.engine.pendingOrders.length === 1 && store.size === 1);
}

/* ---------------- restored sell larger than position (resting-order semantics) ---------------- */
async function oversizeRestoredSellTests() {
  const DAY = makeCandles(FRI, "09:30", 60, 110);
  const store = new FakeOrderStore("user-a");
  store.addAttempt("att-over", "user-a");
  const id = newDrOrderId();
  await store.place({ id, attemptId: "att-over", side: "sell", qty: 80, limitPrice: 115, engineOrderId: 2 });
  // Position at refresh time is only 50 (a market sell reduced it
  // after the limit was placed). placeLimitOrder would reject
  // restoring 80 > 50 — reconstruction must restore it anyway,
  // because the live engine never revalidates resting orders.
  let wt = 1_780_700_000_000;
  const rec = new DrEventRecorder(() => (wt += 1000));
  rec.record("attempt_created", { ticker: "TEST", tradeDate: FRI, startIndex: 5, startingBalance: 100_000 }, { marketIdx: 5, marketTs: DAY[5].t });
  rec.recordFill({ side: "buy", qty: 100, price: 109.5, candleIndex: 6, time: DAY[6].t, realizedPnl: 0 });
  rec.recordFill({ side: "sell", qty: 50, price: 109.4, candleIndex: 7, time: DAY[7].t, realizedPnl: -5 });
  const recon = reconstructDrAttempt({
    candles: DAY.slice(0, 30),
    startingBalance: 100_000,
    startIndex: 5,
    events: rec.all,
    orders: await store.list("att-over"),
  });
  check("oversize: position reconstructed at 50", recon.engine.positionQty === 50);
  check("oversize: resting sell (80) restored despite exceeding position",
    recon.engine.pendingOrders.length === 1 && recon.engine.pendingOrders[0].qty === 80);
  check("oversize: restored engine id is in the reserved range (no counter collision)",
    recon.engine.pendingOrders[0].id >= 1_000_000_000);
  const err = recon.engine.placeLimitOrder("buy", 1, 50);
  check("oversize: a fresh placement after resume gets a non-colliding counter id",
    err === null && recon.engine.pendingOrders.length === 2
    && recon.engine.pendingOrders[1].id < 1_000_000_000);
}

/* ---------------- session_reset kills working orders (reconstruction view) ---------------- */
async function resetKillsOrdersTests() {
  const store = new FakeOrderStore("user-a");
  store.addAttempt("att-reset", "user-a");
  const DAY = makeCandles(FRI, "09:30", 60, 110);
  const s = new Session(DAY, 5, store, "att-reset");
  await s.placeLimit("buy", 20, 100);
  const orderId = s.tracker.all()[0].id;
  // The page's reset path settles tracked orders at the call site:
  const ops: DrOrderUpdateOp[] = s.tracker.all().map((r) => ({
    orderId: r.id, status: "cancelled" as const, filledQty: r.filledQty,
  }));
  s.tracker.clear();
  for (const op of ops) await store.update(op.orderId, op.status, op.filledQty);
  s.eng.reset();
  check("reset: tracked order settled cancelled at reset time",
    store.rows.get(orderId)?.status === "cancelled");
  const plan = planRestoredOrders(await store.list("att-reset"));
  check("reset: nothing restores after the reset", plan.length === 0);
}

(async () => {
  await storeRuleTests();
  await liveSessionTests();
  await partialFillTests();
  await progressiveRestoreTests();
  await refreshDuringSubmissionTests();
  await oversizeRestoredSellTests();
  await resetKillsOrdersTests();
  console.log(`\n=== DAILY REPLAY ORDERS RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
