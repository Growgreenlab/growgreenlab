/**
 * dailyReplay.test.ts — tests for the Daily Replay core (lib/dailyReplay.ts).
 * Run: npx -y tsx lib/dailyReplay.test.ts
 *
 * The FakeTransport below mirrors the rules the dr_* security-definer
 * RPCs enforce in supabase/migrations/daily-replay-v1.sql: ownership on
 * every call, position clamped server-side, steps clamped to [1, 60],
 * skip-ahead impossible (position only moves inside advance()).
 */
import {
  validateDataset,
  marketSessionStatus,
  SealedCandleFeed,
  DAILY_REPLAY_STARTING_BALANCE,
  DAILY_REPLAY_STATE_KEY,
  encodeDrResumeHint,
  decodeDrResumeHint,
  type SealedTransport,
  type CreateAttemptResult,
  type AdvanceResult,
  type RevealedResult,
} from "./dailyReplay";
import { ReplayEngine } from "./engine";
import { etToUtcMs } from "./marketData";
import type { Candle } from "./types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}

/** Valid 1-minute candles for `date`, starting at ET time `from`, n of them. */
function makeCandles(date: string, from: string, n: number, skip: number[] = []): Candle[] {
  const [fh, fm] = from.split(":").map(Number);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    if (skip.includes(i)) continue;
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

const FRI = "2026-10-16"; // a Friday

/* ---------------- validation ---------------- */
{
  const cs = makeCandles(FRI, "09:30", 6);
  const v = validateDataset(cs, { ticker: "AAPL", tradeDate: FRI });
  check("valid set passes", v.ok && v.errors.length === 0);
  check("valid set: no warnings", v.warnings.length === 0);
  check("valid set: stats count", v.stats.count === 6 && v.stats.gapCount === 0);
}
{
  const cs = makeCandles(FRI, "09:30", 6);
  cs.splice(3, 0, { ...cs[2] }); // duplicate timestamp of candle 2
  const v = validateDataset(cs, { ticker: "AAPL", tradeDate: FRI });
  check("duplicate timestamp is an error", !v.ok && v.errors.some((e) => /duplicate/i.test(e)));
}
{
  const cs = makeCandles(FRI, "09:30", 4);
  cs[1] = { ...cs[1], h: cs[1].c - 0.5 }; // high below close
  const v = validateDataset(cs, { ticker: "AAPL", tradeDate: FRI });
  check("OHLC violation (high < close) is an error", !v.ok && v.errors.some((e) => /high ≥ max/.test(e)));
}
{
  const cs = makeCandles(FRI, "09:30", 4);
  cs[2] = { ...cs[2], l: cs[2].o + 0.5 }; // low above open
  const v = validateDataset(cs, { ticker: "AAPL", tradeDate: FRI });
  check("OHLC violation (low > open) is an error", !v.ok && v.errors.some((e) => /low ≤ min/.test(e)));
}
{
  const cs = makeCandles(FRI, "09:30", 4);
  cs[0] = { ...cs[0], c: 0 }; // non-positive price
  const v = validateDataset(cs, { ticker: "AAPL", tradeDate: FRI });
  check("non-positive price is an error", !v.ok && v.errors.some((e) => /non-positive/.test(e)));
}
{
  const cs = makeCandles(FRI, "09:30", 4);
  cs.push(makeCandles("2026-10-15", "09:34", 1)[0]); // previous day's candle
  const v = validateDataset(cs, { ticker: "AAPL", tradeDate: FRI });
  check("wrong-date candle is an error", !v.ok && v.errors.some((e) => /outside 2026-10-16/.test(e)));
}
{
  // 09:30, 09:31, then 09:34 — two candles missing (09:32, 09:33).
  const cs = [...makeCandles(FRI, "09:30", 2), ...makeCandles(FRI, "09:34", 2)];
  const v = validateDataset(cs, { ticker: "AAPL", tradeDate: FRI });
  check("gap does not fail validation", v.ok);
  check("gap reported as warning", v.warnings.length === 1 && /Missing 2 candles/.test(v.warnings[0]));
  check("gap range correct", v.gaps.length === 1 && v.gaps[0].missing === 2
    && v.gaps[0].fromT === etToUtcMs(FRI, "09:32") && v.gaps[0].toT === etToUtcMs(FRI, "09:33"));
  check("gap stats correct", v.stats.gapCount === 1 && v.stats.missingCandles === 2);
}
{
  const v = validateDataset([], { ticker: "AAPL", tradeDate: FRI });
  check("empty dataset is an error", !v.ok && v.errors.length === 1);
}
{
  const cs = makeCandles(FRI, "09:30", 4).reverse(); // out of order
  const v = validateDataset(cs, { ticker: "AAPL", tradeDate: FRI });
  check("out-of-order is an error", !v.ok && v.errors.some((e) => /chronological/.test(e)));
}

/* ---------------- market-session calendar ---------------- */
{
  const sat = marketSessionStatus("2026-10-17");
  check("2026-10-17 is a Saturday → closed", !sat.isTradingDay && sat.reason === "Saturday");
  const sun = marketSessionStatus("2026-10-18");
  check("2026-10-18 is a Sunday → closed", !sun.isTradingDay && sun.reason === "Sunday");
  const fri = marketSessionStatus("2026-10-16");
  check("2026-10-16 Friday → trading day", fri.isTradingDay);
  const xmas = marketSessionStatus("2026-12-25");
  check("2026-12-25 Christmas → closed", !xmas.isTradingDay && /Christmas/.test(xmas.reason));
  const jul3 = marketSessionStatus("2026-07-03");
  check("2026-07-03 observed Independence Day → closed", !jul3.isTradingDay && /Independence Day/.test(jul3.reason));
  const dst = marketSessionStatus("2026-03-09"); // Monday after spring-forward
  check("2026-03-09 (DST week) → trading day", dst.isTradingDay);
  const thx = marketSessionStatus("2026-11-26");
  check("2026-11-26 Thanksgiving → closed", !thx.isTradingDay && /Thanksgiving/.test(thx.reason));
  const mlk = marketSessionStatus("2026-01-19");
  check("2026-01-19 MLK Day → closed", !mlk.isTradingDay && /Martin Luther King/.test(mlk.reason));
  const gf = marketSessionStatus("2026-04-03");
  check("2026-04-03 Good Friday → closed", !gf.isTradingDay && /Good Friday/.test(gf.reason));
  const jun = marketSessionStatus("2027-06-18");
  check("2027-06-18 observed Juneteenth → closed", !jun.isTradingDay && /Juneteenth/.test(jun.reason));
  const bad = marketSessionStatus("16/10/2026");
  check("malformed date → closed with reason", !bad.isTradingDay && bad.reason === "Invalid date");
}

/* ---------------- fake server (mirrors the dr_* RPC rules) ---------------- */
interface FakeDataset { ownerId: string; candles: Candle[] }
interface FakeAttempt { ownerId: string; datasetId: string; position: number; status: "active" | "finished" }

class FakeStore {
  datasets = new Map<string, FakeDataset>();
  attempts = new Map<string, FakeAttempt>();
  private seq = 0;
  addDataset(ownerId: string, candles: Candle[]): string {
    const id = `ds-${++this.seq}`;
    this.datasets.set(id, { ownerId, candles });
    return id;
  }
}

/** A transport bound to one caller — exactly like an authenticated RPC. */
class FakeTransport implements SealedTransport {
  constructor(private store: FakeStore, private callerId: string) {}

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

const DAY = makeCandles(FRI, "04:00", 120); // 120-candle dataset

async function sealingTests() {
  // Happy path: create → reveal prefix only; advance → only new candles.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAY);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feed.setTotal(DAY.length);
    await feed.create(dsId, 40);
    check("create: position = start index", feed.position === 40);
    check("create: holds exactly [0..start]", feed.candles.length === 41);
    check("create: not finished", feed.finished === false);
    const heldRef = feed.candles;
    const added = await feed.advance(10);
    check("advance: returns only the new candles", added === 10 && feed.candles.length === 51);
    check("advance: single array identity preserved", feed.candles === heldRef);
    check("advance: position tracks server", feed.position === 50);
    check("advance: last held candle is the position candle", feed.candles[50].t === DAY[50].t);
    check("has() respects the sealed position", feed.has(50) && !feed.has(51));
  }
  // ensure(): advances until the index is held.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAY);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    await feed.create(dsId, 5);
    const ok = await feed.ensure(50, 10);
    check("ensure: advances until held", ok && feed.position >= 50 && feed.candles.length === feed.position + 1);
    const beyond = await feed.ensure(DAY.length + 100, 60);
    check("ensure: beyond the end returns false, clamps at finished", beyond === false && feed.finished && feed.position === DAY.length - 1);
  }
  // Advance past the end clamps + finished.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAY);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    await feed.create(dsId, DAY.length - 3);
    const added = await feed.advance(60);
    check("advance past end: clamps to last candle", feed.position === DAY.length - 1 && added === 2);
    check("advance past end: finished", feed.finished === true);
    check("advance past end: holds the whole day, no more", feed.candles.length === DAY.length);
    const more = await feed.advance(10);
    check("advance after finished is a no-op", more === 0 && feed.position === DAY.length - 1);
  }
  // Skip-ahead: steps are clamped server-side to 60 per call.
  {
    const store = new FakeStore();
    const big = makeCandles(FRI, "04:00", 200);
    const dsId = store.addDataset("user-a", big);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    await feed.create(dsId, 0);
    await feed.advance(500); // tries to skip ahead
    check("skip-ahead impossible: one advance moves ≤ 60", feed.position === 60);
  }
  // Wrong owner is rejected at every door.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAY);
    const feedA = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    await feedA.create(dsId, 10);
    const attemptId = feedA.attemptId!;
    const intruder = new FakeTransport(store, "user-b");
    let createBlocked = false, advBlocked = false, readBlocked = false;
    try { await intruder.createAttempt(dsId, 0); } catch { createBlocked = true; }
    try { await intruder.advance(attemptId, 1); } catch { advBlocked = true; }
    try { await intruder.getRevealed(attemptId); } catch { readBlocked = true; }
    check("wrong owner: create rejected", createBlocked);
    check("wrong owner: advance rejected", advBlocked);
    check("wrong owner: getRevealed rejected", readBlocked);
    check("wrong owner: victim position untouched", feedA.position === 10);
  }
  // getRevealed returns exactly [0..position]; sync keeps identity.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAY);
    const t = new FakeTransport(store, "user-a");
    const feed = new SealedCandleFeed(t);
    await feed.create(dsId, 3);
    await feed.advance(7);
    const rev = await t.getRevealed(feed.attemptId!);
    check("getRevealed returns exactly [0..position]",
      rev.position === 10 && rev.candles.length === 11 && rev.candles[10].t === DAY[10].t);
    const ref = feed.candles;
    await feed.sync();
    check("sync: same array, same length, no extras", feed.candles === ref && feed.candles.length === 11);
  }
  // A misbehaving server that returns extras gets truncated + surfaced.
  {
    const evil: SealedTransport = {
      async createAttempt() {
        return { attemptId: "evil-1", position: 2, candles: DAY.slice(0, 10) }; // 7 extra!
      },
      async advance() { throw new Error("n/a"); },
      async getRevealed() { throw new Error("n/a"); },
    };
    const feed = new SealedCandleFeed(evil);
    await feed.create("ds", 2);
    check("over-returning create: truncated to position", feed.candles.length === 3 && feed.position === 2);
    check("over-returning create: error surfaced", typeof feed.lastError === "string" && feed.lastError.length > 0);
  }
  {
    const evil: SealedTransport = {
      async createAttempt() {
        return { attemptId: "evil-2", position: 0, candles: DAY.slice(0, 1) };
      },
      async advance() {
        return { position: 5, candles: DAY.slice(1, 12), finished: false }; // 6 too many
      },
      async getRevealed() { throw new Error("n/a"); },
    };
    const feed = new SealedCandleFeed(evil);
    await feed.create("ds", 0);
    feed.lastError = null;
    await feed.advance(5);
    check("over-returning advance: truncated to position delta", feed.candles.length === 6 && feed.position === 5);
    check("over-returning advance: error surfaced", typeof feed.lastError === "string");
  }
  // Under-returning server is a hard error (would corrupt indexing).
  {
    const broken: SealedTransport = {
      async createAttempt() {
        return { attemptId: "bad-1", position: 5, candles: DAY.slice(0, 3) }; // claims 6, sends 3
      },
      async advance() { throw new Error("n/a"); },
      async getRevealed() { throw new Error("n/a"); },
    };
    const feed = new SealedCandleFeed(broken);
    let threw = false;
    try { await feed.create("ds", 5); } catch { threw = true; }
    check("under-returning create: hard error", threw);
  }
}

/* ------------- engine array-growth (the sealing linchpin) ------------- */
async function engineGrowthTests() {
  const store = new FakeStore();
  const dsId = store.addDataset("user-a", DAY);
  const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
  feed.setTotal(DAY.length);
  await feed.create(dsId, 40); // engine starts at candle 40

  const eng = new ReplayEngine(feed.candles, DAILY_REPLAY_STARTING_BALANCE, 40);
  check("engine uses the feed's exact array (identity)", eng.candles === feed.candles);
  check("engine start cash is the DR balance", eng.cash === 100_000 && eng.startCash === 100_000);
  check("engine not at end with prefix held", eng.atEnd === false);

  // Drain everything the feed currently holds.
  let guard = 0;
  while (!eng.atEnd && guard++ < 500) eng.step();
  check("engine drains to the held end", eng.atEnd === true && eng.index === 40);
  const idxAtHeldEnd = eng.index;
  const noop = eng.tick();
  check("tick at held end is a no-op (no future candle exists client-side)",
    noop.atEnd === true && eng.index === idxAtHeldEnd);

  // Server releases more candles → the SAME engine must pick them up.
  await feed.advance(30);
  check("after advance: engine no longer at end (dynamic length)", eng.atEnd === false);
  eng.step();
  check("after advance: engine forms + finalizes a newly released candle", eng.index === idxAtHeldEnd + 1);
  check("displayCandles only ever show held candles",
    eng.displayCandles.length <= feed.candles.length);
}

/* ------------- balance independence ------------- */
function balanceTests() {
  check("DR state key is the DR key", DAILY_REPLAY_STATE_KEY === "ggl-daily-replay-state");
  check("DR state key differs from the Trade Lab balance key", DAILY_REPLAY_STATE_KEY !== "ggl-account-balance");
  check("DR starting balance is $100,000", DAILY_REPLAY_STARTING_BALANCE === 100_000);

  // Even if a Trade Lab balance exists in storage, DR never reads it:
  // the engine built for DR gets the DR constant, and storage is untouched.
  const store: Record<string, string> = { "ggl-account-balance": "5" };
  const fakeLocalStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  };
  const g = globalThis as unknown as { localStorage?: unknown };
  const prev = g.localStorage;
  g.localStorage = fakeLocalStorage;
  try {
    const eng = new ReplayEngine(makeCandles(FRI, "09:30", 3), DAILY_REPLAY_STARTING_BALANCE, 0);
    check("DR engine ignores the Trade Lab balance value", eng.cash === 100_000);
    check("Trade Lab balance key untouched by DR setup", store["ggl-account-balance"] === "5");
    check("no Trade Lab keys written by DR setup", Object.keys(store).length === 1);
  } finally {
    g.localStorage = prev;
  }

  const hint = { attemptId: "a1", datasetId: "d1", ticker: "AAPL", tradeDate: FRI, startIndex: 42 };
  const round = decodeDrResumeHint(encodeDrResumeHint(hint));
  check("resume hint round-trips", round !== null && round.attemptId === "a1" && round.startIndex === 42);
  check("resume hint rejects garbage", decodeDrResumeHint("not json") === null && decodeDrResumeHint(null) === null);
  check("resume hint rejects partial data", decodeDrResumeHint('{"attemptId":"a1"}') === null);
}

(async () => {
  await sealingTests();
  await engineGrowthTests();
  balanceTests();
  console.log(`\n=== DAILY REPLAY RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
