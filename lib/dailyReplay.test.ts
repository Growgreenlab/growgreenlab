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
  highlightBandFor,
  resolveHighlightBar,
  type HighlightDisplayBar,
  premarketWarningGate,
  premarketOverlayVisible,
  drDatasetKey,
  SealedCandleFeed,
  buildDrEngine,
  DAILY_REPLAY_STARTING_BALANCE,
  DAILY_REPLAY_STATE_KEY,
  encodeDrResumeHint,
  decodeDrResumeHint,
  normalizeReloadedSource,
  type SealedTransport,
  type CreateAttemptResult,
  type AdvanceResult,
  type RevealedResult,
} from "./dailyReplay";
import { ReplayEngine } from "./engine";
import { etToUtcMs } from "./marketData";
import {
  DrEventRecorder,
  classifyBracketMove,
  describeDrEvent,
  formatDrClock,
} from "./dailyReplayEvents";
import {
  parseTwelveDataResponse,
  classifyTwelveError,
  TwelveDataError,
} from "./marketData.twelve";
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

/* ---------------- premarket availability (validation stats) ---------------- */
{
  const v = validateDataset(makeCandles(FRI, "04:00", 10), { ticker: "AAPL", tradeDate: FRI });
  check("premarket: 04:00 start → available", v.stats.premarketAvailable === true);
  check("premarket: 04:00 start → firstCandleEt", v.stats.firstCandleEt === "04:00");
  check("premarket: availability does not change the verdict", v.ok && v.errors.length === 0);
}
{
  const v = validateDataset(makeCandles(FRI, "09:30", 10), { ticker: "AAPL", tradeDate: FRI });
  check("premarket: 09:30 start → unavailable", v.stats.premarketAvailable === false);
  check("premarket: 09:30 start → firstCandleEt", v.stats.firstCandleEt === "09:30");
  check("premarket: regular-only set still validates clean", v.ok);
}
{
  const v = validateDataset(makeCandles(FRI, "08:15", 4), { ticker: "AAPL", tradeDate: FRI });
  check("premarket: 08:15 start → available", v.stats.premarketAvailable === true);
}
{
  // A single candle at 09:29 is before the 09:30 open → premarket exists.
  const v = validateDataset(makeCandles(FRI, "09:29", 3), { ticker: "AAPL", tradeDate: FRI });
  check("premarket: 09:29 start → available", v.stats.premarketAvailable === true);
}
{
  const v = validateDataset([], { ticker: "AAPL", tradeDate: FRI });
  check("premarket: empty → unavailable", v.stats.premarketAvailable === false);
  check("premarket: empty → firstCandleEt null", v.stats.firstCandleEt === null);
  check("premarket: empty → existing error unchanged", !v.ok && v.errors.length === 1);
}

/* ---------------- locked-candle highlight band ---------------- */
{
  const cs = makeCandles(FRI, "09:30", 10); // 09:30..09:39, 1-minute spacing
  const band = highlightBandFor(cs, 3);
  check("highlight: band targets the chosen candle", band !== null && band.timeSec === Math.floor(cs[3].t / 1000));
  check("highlight: span is exactly one interval", band !== null && band.spanSec === 60);
  check("highlight: previous neighbor excluded", band !== null && band.timeSec === Math.floor(cs[2].t / 1000) + 60);
  check("highlight: next neighbor excluded", band !== null && band.timeSec + band.spanSec === Math.floor(cs[4].t / 1000));
  const first = highlightBandFor(cs, 0);
  check("highlight: first candle band", first !== null && first.timeSec === Math.floor(cs[0].t / 1000) && first.spanSec === 60);
  const last = highlightBandFor(cs, 9);
  check("highlight: last candle span from previous spacing",
    last !== null && last.timeSec === Math.floor(cs[9].t / 1000) && last.spanSec === 60);
  check("highlight: resume startIndex maps to the locked candle",
    highlightBandFor(cs, 7)?.timeSec === Math.floor(cs[7].t / 1000));
  check("highlight: out-of-range index → null", highlightBandFor(cs, -1) === null && highlightBandFor(cs, 10) === null);
  check("highlight: empty series → null", highlightBandFor([], 0) === null);
}
{
  const one = makeCandles(FRI, "09:30", 1);
  const band = highlightBandFor(one, 0);
  check("highlight: lone candle defaults to a 60s span", band !== null && band.spanSec === 60);
  // Irregular spacing: span follows the actual next/previous intervals.
  const cs = [...makeCandles(FRI, "09:30", 2), ...makeCandles(FRI, "09:35", 1)]; // 09:30, 09:31, 09:35
  check("highlight: span to next candle uses real spacing", highlightBandFor(cs, 1)?.spanSec === 240);
  check("highlight: last candle uses previous spacing", highlightBandFor(cs, 2)?.spanSec === 240);
}

/* ------------- highlight glow: displayed-bar resolution ------------- */
{
  const cs = makeCandles(FRI, "09:30", 10); // 09:30..09:39, 1-minute spacing
  const bars1m: HighlightDisplayBar[] = cs.map((c) => ({
    timeSec: Math.floor(c.t / 1000),
    high: c.h,
    low: c.l,
  }));
  const t = (i: number) => Math.floor(cs[i].t / 1000);

  // 1m view: the target resolves to exactly its own candle.
  const exact = resolveHighlightBar(bars1m, t(3));
  check("glow: 1m target resolves to its exact bar",
    exact !== null && exact.barTime === t(3) && exact.spanSec === 60);
  check("glow: resolved bar carries the candle's high/low",
    exact !== null && exact.high === cs[3].h && exact.low === cs[3].l);
  // A target at the next bar's first second belongs to that bar.
  check("glow: target at a bar start resolves to that bar",
    resolveHighlightBar(bars1m, t(4))?.barTime === t(4));
  // Inside the last bar (before its end) still resolves; at/after its
  // end does not — nothing is displayed there.
  check("glow: target inside the last bar resolves",
    resolveHighlightBar(bars1m, t(9) + 30)?.barTime === t(9));
  check("glow: target at/after the last bar's end → null",
    resolveHighlightBar(bars1m, t(9) + 60) === null);
  check("glow: target before the first bar → null",
    resolveHighlightBar(bars1m, t(0) - 60) === null);
  check("glow: empty bars → null", resolveHighlightBar([], t(0)) === null);
  check("glow: non-finite target → null",
    resolveHighlightBar(bars1m, Number.NaN) === null);

  // Aggregated 5m view: two displayed bars aggregated from the same
  // 1m candles (prices rise with i, so extremes are the group edges).
  const agg = (from: number, to: number): HighlightDisplayBar => ({
    timeSec: t(from),
    high: Math.max(...cs.slice(from, to).map((c) => c.h)),
    low: Math.min(...cs.slice(from, to).map((c) => c.l)),
  });
  const bars5m = [agg(0, 5), agg(5, 10)];
  // A locked 09:57 candle falls inside the second aggregated bar.
  const inside = resolveHighlightBar(bars5m, t(7));
  check("glow: aggregated bar containing the target minute resolves",
    inside !== null && inside.barTime === t(5) && inside.spanSec === 300);
  check("glow: aggregated bar carries the group's high/low",
    inside !== null && inside.high === cs[9].h && inside.low === cs[5].l);
  check("glow: target in the first aggregated bar resolves to it",
    resolveHighlightBar(bars5m, t(2))?.barTime === t(0));
}

/* ---------------- premarket warning gate ---------------- */
{
  const key = drDatasetKey("aapl", FRI, 390);
  check("gate: dataset key format", key === `AAPL|${FRI}|390`);
  check("gate: key changes with ticker/date/count",
    drDatasetKey("TSLA", FRI, 390) !== key && drDatasetKey("AAPL", "2026-10-15", 390) !== key && drDatasetKey("AAPL", FRI, 391) !== key);
  const shown = premarketWarningGate({ premarketAvailable: false, datasetKey: key, dismissedKey: null });
  check("gate: unavailable + not dismissed → show + block", shown.showWarning && shown.blockSelection);
  const dismissed = premarketWarningGate({ premarketAvailable: false, datasetKey: key, dismissedKey: key });
  check("gate: dismissed for this dataset → hidden + selection enabled", !dismissed.showWarning && !dismissed.blockSelection);
  const otherKey = premarketWarningGate({ premarketAvailable: false, datasetKey: drDatasetKey("TSLA", FRI, 390), dismissedKey: key });
  check("gate: new dataset re-evaluates → shown again", otherKey.showWarning && otherKey.blockSelection);
  const avail = premarketWarningGate({ premarketAvailable: true, datasetKey: key, dismissedKey: null });
  check("gate: premarket available → never shown, never blocked", !avail.showWarning && !avail.blockSelection);
}

/* ------------- in-replay premarket overlay visibility -------------
 * The chart-overlay notice is a STANDARD-replay surface. This helper
 * governs ONLY that overlay; the Daily Replay preview warning is
 * premarketWarningGate's job (tested above) and is out of scope here.
 * The bug being pinned: in a DR attempt the overlay kept rendering at
 * Candle 78/390 because its dismissal state is separate from the
 * preview gate's — the user had already been informed and confirmed. */
{
  // Standard replay ("off"): unchanged behavior.
  check("overlay: standard + unavailable + not dismissed → show",
    premarketOverlayVisible({ phase: "off", premarketUnavailable: true, dismissed: false }) === true);
  check("overlay: standard + unavailable + dismissed → hide",
    premarketOverlayVisible({ phase: "off", premarketUnavailable: true, dismissed: true }) === false);
  check("overlay: standard + available → hide",
    premarketOverlayVisible({ phase: "off", premarketUnavailable: false, dismissed: false }) === false);
  // DR preview (no attempt yet): the underlying standard rule applies;
  // the DR warning itself lives in the preview gate, not this overlay.
  check("overlay: preview + unavailable + not dismissed → standard rule (show)",
    premarketOverlayVisible({ phase: "preview", premarketUnavailable: true, dismissed: false }) === true);
  // DR attempt phases: NEVER shown, even with the overlay's own
  // dismissal state untouched (the reported Candle 78/390 case).
  check("overlay: DR active + unavailable + not dismissed → hide (bug case)",
    premarketOverlayVisible({ phase: "active", premarketUnavailable: true, dismissed: false }) === false);
  check("overlay: DR active after resume + unavailable → hide",
    premarketOverlayVisible({ phase: "active", premarketUnavailable: true, dismissed: false }) === false);
  check("overlay: DR active + unavailable + dismissed → hide",
    premarketOverlayVisible({ phase: "active", premarketUnavailable: true, dismissed: true }) === false);
  check("overlay: DR done + unavailable + not dismissed → hide",
    premarketOverlayVisible({ phase: "done", premarketUnavailable: true, dismissed: false }) === false);
  // Premarket available: hidden in every phase.
  const phases = ["off", "preview", "active", "done"] as const;
  check("overlay: premarket available → hide in every phase",
    phases.every((phase) => !premarketOverlayVisible({ phase, premarketUnavailable: false, dismissed: false })));
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
  // ensure(): the strict release gate — advances one candle at a
  // time until the index is held, and never one candle further.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAY);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    await feed.create(dsId, 5);
    const ok = await feed.ensure(50);
    check("ensure: advances until held", ok && feed.position >= 50 && feed.candles.length === feed.position + 1);
    check("ensure: stops exactly at the requested candle (no overshoot)",
      feed.position === 50 && feed.candles.length === 51);
    const beyond = await feed.ensure(DAY.length + 100);
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

/* ------------- Twelve Data pre-replay verification -------------
 * Representative response payloads mapped to distinct error kinds:
 * the load gate shows the kind's message inline and never proceeds. */
function expectTwelveKind(name: string, payload: unknown, kind: string) {
  try {
    parseTwelveDataResponse(payload);
    check(name, false);
  } catch (e) {
    check(name, e instanceof TwelveDataError && e.kind === kind);
  }
}
function twelveDataTests() {
  // Success: newest-first values become chronological candles.
  const ok = parseTwelveDataResponse({
    status: "ok",
    values: [
      { datetime: "2026-10-16 09:31:00", open: "101.00", high: "101.50", low: "100.90", close: "101.20", volume: "12345" },
      { datetime: "2026-10-16 09:30:00", open: "100.00", high: "100.80", low: "99.90", close: "100.50", volume: "23456" },
    ],
  });
  check("twelvedata success: parses + reorders chronologically",
    ok.length === 2 && ok[0].t === etToUtcMs(FRI, "09:30") && ok[1].c === 101.2 && ok[0].v === 23456);
  expectTwelveKind("twelvedata invalid key (401) → invalid_key",
    { code: 401, message: "Invalid API key", status: "error" }, "invalid_key");
  expectTwelveKind("twelvedata rate limit (429 credits) → rate_limit",
    { code: 429, message: "You have run out of API credits for the current minute. Please wait and try again.", status: "error" }, "rate_limit");
  expectTwelveKind("twelvedata plan-restricted (403) → plan_restricted",
    { code: 403, message: "You are not authorized to access this resource", status: "error" }, "plan_restricted");
  expectTwelveKind("twelvedata plan-restricted (message) → plan_restricted",
    { code: 400, message: "This interval is not available on your plan. Please upgrade to access 1min historical data.", status: "error" }, "plan_restricted");
  expectTwelveKind("twelvedata unknown symbol (400) → symbol_not_found",
    { code: 400, message: "Symbol not found", status: "error" }, "symbol_not_found");
  expectTwelveKind("twelvedata empty values → no_data",
    { status: "ok", values: [] }, "no_data");
  expectTwelveKind("twelvedata missing values → no_data",
    { status: "ok" }, "no_data");
  check("classify: message-only rate limit", classifyTwelveError(undefined, "API rate limit exceeded") === "rate_limit");
  check("classify: 401 wins over message", classifyTwelveError(401, "whatever") === "invalid_key");
  check("classify: unknown stays unknown", classifyTwelveError(500, "Internal error") === "unknown");
}

/* ------------- Decision Timeline recorder ------------- */
function eventsTests() {
  let tick = 0;
  const now = () => 1_760_000_000_000 + (tick += 1000); // deterministic wall clock
  const rec = new DrEventRecorder(now);
  let heard = 0;
  rec.setListener(() => { heard++; });
  const t40 = etToUtcMs(FRI, "09:30");
  const ctx = { marketIdx: 40, marketTs: t40 };
  const pos = { avgEntry: 182.44, direction: "long" as const };

  rec.record("attempt_created", {
    ticker: "AAPL", tradeDate: FRI, startIndex: 40, startEtTime: "09:30",
    startingBalance: 100_000,
  }, ctx);
  rec.record("session_started", {}, ctx);
  rec.recordOrderSubmitted({ orderType: "market", side: "buy", qty: 100 }, ctx);
  rec.recordFill({ side: "buy", qty: 100, price: 182.44, candleIndex: 40, time: t40, realizedPnl: 0 });
  rec.recordRiskSnapshot({
    entry: 182.44, qty: 100, stopLoss: 180, takeProfit: 190,
    plannedRisk: 244, rewardRisk: 3.1,
  }, ctx);
  rec.recordBrackets(180, 190, "control", "active", ctx, pos); // initial set
  rec.recordBrackets(181.5, 190, "drag", "active", ctx, pos); // drag SL tighter
  rec.recordBrackets(182.44, 190, "drag", "active", ctx, pos); // drag SL to breakeven
  rec.recordBrackets(182.44, 195, "control", "active", ctx, pos); // panel widens TP
  const countsDuringTrade = rec.bracketMoveCounts("active"); // per-trade: resets at close
  const t55 = etToUtcMs(FRI, "09:55");
  rec.recordFill({ side: "sell", qty: 50, price: 185, candleIndex: 55, time: t55, realizedPnl: 128 }); // partial exit
  const t70 = etToUtcMs(FRI, "10:10");
  rec.recordFill({ side: "sell", qty: 50, price: 182.4, candleIndex: 70, time: t70, note: "stop-loss", realizedPnl: -2 }); // stop closes the rest
  rec.record("session_completed", { realizedPnl: 126, equity: 100_126 }, { marketIdx: 70, marketTs: t70 });

  const evts = rec.all;
  const types = evts.map((e) => e.type);
  const expected = [
    "attempt_created", "session_started", "order_submitted", "order_filled",
    "position_changed", "risk_snapshot", "bracket_set", "bracket_modified",
    "bracket_modified", "bracket_modified", "order_filled", "partial_exit",
    "bracket_triggered", "order_filled", "position_closed", "session_completed",
  ];
  check("scripted session: exact event sequence", JSON.stringify(types) === JSON.stringify(expected));
  check("seq is monotonic from 1", evts.every((e, i) => e.seq === i + 1));
  check("wall timestamps distinct + increasing (two clocks kept separate)",
    evts.every((e, i) => i === 0 || e.wallTs > evts[i - 1].wallTs));
  check("market clock rides along (idx/ts)", evts[3].marketIdx === 40 && evts[3].marketTs === t40);
  check("listener heard every append", heard === evts.length);

  const slTighten = evts[7];
  check("SL drag: prev/new preserved", slTighten.payload.prev === 180 && slTighten.payload.next === 181.5);
  check("SL drag: classified tightened (long, stop up)", slTighten.payload.classification === "tightened");
  check("SL drag: method + counter", slTighten.payload.method === "drag" && slTighten.payload.timesMoved === 1);
  const slBE = evts[8];
  check("SL to avg entry: moved-to-breakeven", slBE.payload.classification === "moved-to-breakeven" && slBE.payload.timesMoved === 2);
  const tpWiden = evts[9];
  check("TP panel change: widened, prev/new kept", tpWiden.payload.field === "takeProfit"
    && tpWiden.payload.prev === 190 && tpWiden.payload.next === 195
    && tpWiden.payload.classification === "widened" && tpWiden.payload.method === "control");
  check("per-trade counters on the recorder (during the trade)",
    countsDuringTrade.sl === 2 && countsDuringTrade.tp === 1);
  check("per-trade counters reset for the next trade at close", (() => {
    const c = rec.bracketMoveCounts("active"); return c.sl === 0 && c.tp === 0;
  })());
  check("counters derivable from the stream", (() => {
    const mods = evts.filter((e) => e.type === "bracket_modified");
    return mods.filter((e) => e.payload.field === "stopLoss").length === 2
      && mods.filter((e) => e.payload.field === "takeProfit").length === 1;
  })());
  const partial = evts[11];
  check("partial exit: qty after + P&L snapshot", partial.payload.qtyAfter === 50 && partial.payload.sessionRealized === 128);
  const closed = evts[14];
  check("close: stop-loss reason + cumulative realized", closed.payload.reason === "stop-loss" && closed.payload.sessionRealized === 126);
  check("shadow position flat after close", rec.positionQty === 0);

  // Append-only: events are frozen; earlier events never change.
  check("events are frozen", Object.isFrozen(evts[0]) && Object.isFrozen(evts[0].payload));
  const before = JSON.stringify(evts[7]);
  rec.record("session_paused", {}, ctx);
  check("later appends never rewrite earlier events", JSON.stringify(rec.all[7]) === before);

  // Plain-language rendering (the Review Timeline lines).
  check("describe: SL move line", describeDrEvent(slTighten) === "Stop-loss moved $180.00 → $181.50 (tightened, drag)");
  check("describe: breakeven line", describeDrEvent(slBE) === "Stop-loss moved to breakeven $182.44 (was $181.50, drag)");
  check("describe: trigger line", describeDrEvent(evts[12]) === "Stop-loss triggered @ $182.40");
  check("describe: clock is ET 12-hour", formatDrClock(etToUtcMs(FRI, "10:04")) === "10:04 AM ET");

  // Direction-aware classification, incl. shorts.
  check("classify: short stop down = tightened", classifyBracketMove("stopLoss", 100, 99, null, "short") === "tightened");
  check("classify: short stop up = widened", classifyBracketMove("stopLoss", 100, 101, null, "short") === "widened");
  check("classify: short target up (toward entry) = tightened", classifyBracketMove("takeProfit", 90, 95, null, "short") === "tightened");
  check("classify: long target down (toward entry) = tightened", classifyBracketMove("takeProfit", 190, 185, null, "long") === "tightened");
  check("classify: new level = set, removal = cleared",
    classifyBracketMove("stopLoss", null, 100, null, "long") === "set"
    && classifyBracketMove("stopLoss", 100, null, null, "long") === "cleared");

  // Scopes are independent trackers.
  const rec2 = new DrEventRecorder(now);
  rec2.recordBrackets(10, 12, "drag", "planned", ctx, { avgEntry: null, direction: "long" });
  rec2.recordBrackets(11, 12, "drag", "planned", ctx, { avgEntry: null, direction: "long" });
  const p = rec2.all;
  check("planned scope: set then modify, independent of active",
    p.length === 2 && p[0].type === "bracket_set" && p[0].payload.scope === "planned"
    && p[1].type === "bracket_modified" && p[1].payload.classification === "tightened");
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

/* ------------- locked-candle boundary (buildDrEngine) -------------
 * The confirmed semantics: the locked candle is the LAST COMPLETED
 * historical candle; the NEXT candle forms tick-by-tick; candles
 * beyond it stay hidden. buildDrEngine is the exact construction the
 * page's confirm handler runs. Candles here have DISJOINT price
 * ranges (candle i trades strictly inside [100+i+0.05, 100+i+0.9])
 * so an execution price provably belongs to exactly one candle. */
function makeDisjointCandles(date: string, from: string, n: number): Candle[] {
  const [fh, fm] = from.split(":").map(Number);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const mins = fh * 60 + fm + i;
    const hhmm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    const b = 100 + i;
    out.push({
      t: etToUtcMs(date, hhmm),
      o: b + 0.4, h: b + 0.9, l: b + 0.05, c: b + 0.6, v: 1000 + i * 10,
    });
  }
  return out;
}

async function boundaryTests() {
  const DAYB = makeDisjointCandles(FRI, "09:30", 120);
  const LOCK = 40;

  // --- fresh attempt, mid-session lock ---
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAYB);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feed.setTotal(DAYB.length);
    await feed.create(dsId, LOCK);
    check("boundary: create leaves position AT the locked candle",
      feed.position === LOCK && feed.candles.length === LOCK + 1);

    const eng = await buildDrEngine(feed, LOCK, DAILY_REPLAY_STARTING_BALANCE);
    check("boundary: exactly one extra candle released for formation",
      feed.position === LOCK + 1 && feed.candles.length === LOCK + 2);
    check("(a) completed set at start is [0..lock]",
      eng.index === LOCK && eng.revealed.length === LOCK + 1
      && eng.revealed.every((c, i) => c.t === DAYB[i].t));
    check("(a) locked candle displayed with its full true OHLC",
      (() => { const d = eng.displayCandles[LOCK]; return d.o === DAYB[LOCK].o && d.h === DAYB[LOCK].h && d.l === DAYB[LOCK].l && d.c === DAYB[LOCK].c; })());
    check("(b) first forming candle is lock+1, starting at its own open",
      (() => { const d = eng.displayCandles; const f = d[d.length - 1]; return d.length === LOCK + 2 && f.t === DAYB[LOCK + 1].t && f.o === DAYB[LOCK + 1].o && f.c === DAYB[LOCK + 1].o && f.v === 0; })());
    check("(c) client array holds nothing beyond the forming candle at start",
      feed.candles.length === LOCK + 2 && eng.displayCandles.length === LOCK + 2);

    // (e) Immediate market buy: executes inside the FORMING candle.
    const fill0 = eng.buy(10);
    check("(e) buy at start fills on candle lock+1 at its open",
      !!fill0 && fill0.candleIndex === LOCK + 1 && fill0.price === DAYB[LOCK + 1].o && fill0.time === DAYB[LOCK + 1].t);

    // (b)+(d) Tick the forming candle through: every tick stays
    // inside its true range, volume accrues monotonically up to its
    // true volume, and it finalizes after exactly 360 ticks, landing
    // on its true OHLCV.
    let inRange = true, volMono = true, prevV = 0, ticks = 0, finalized = false;
    while (ticks < 400) {
      const r = eng.tick(); ticks++;
      const d = eng.displayCandles;
      const f = d[d.length - 1];
      if (f.c < DAYB[LOCK + 1].l || f.c > DAYB[LOCK + 1].h) inRange = false;
      if (f.v < prevV || f.v > DAYB[LOCK + 1].v) volMono = false;
      prevV = f.v;
      if (r.finalized) { finalized = true; break; }
    }
    check("(b) forming candle finalizes after exactly 360 ticks", finalized && ticks === 360);
    check("(d) every tick stayed inside the forming candle's true range", inRange);
    check("(d) forming volume accrued monotonically up to the true volume",
      volMono && prevV === DAYB[LOCK + 1].v);
    check("(b) settled candle is the true candle (exact OHLCV)",
      eng.index === LOCK + 1
      && eng.revealed[LOCK + 1].o === DAYB[LOCK + 1].o && eng.revealed[LOCK + 1].h === DAYB[LOCK + 1].h
      && eng.revealed[LOCK + 1].l === DAYB[LOCK + 1].l && eng.revealed[LOCK + 1].c === DAYB[LOCK + 1].c
      && eng.revealed[LOCK + 1].v === DAYB[LOCK + 1].v);
    check("(d) displayed timestamps are the dataset's, in order",
      eng.displayCandles.every((c, i) => c.t === DAYB[i].t));

    // Play-loop shape (page timer + Step button, post-strict-sealing):
    // drain through the ensure() gate; the display must never run
    // ahead of finalized + the one forming candle, and — the strict
    // invariant — the held array must never run ahead of the forming
    // candle either (position ≤ engine.index + 1 at all times).
    let displayOk = true, sealOk = true, guard = 0;
    while (guard++ < 500) {
      if (eng.atEnd) {
        if (feed.finished) break;
        await feed.ensure(eng.index + 1);
      }
      eng.step();
      const d = eng.displayCandles;
      if (!(d.length === eng.index + 1
        || (d.length === eng.index + 2 && d[d.length - 1].t === DAYB[eng.index + 1].t))) displayOk = false;
      if (!d.every((c, i) => c.t === DAYB[i].t)) displayOk = false;
      if (feed.candles.length !== feed.position + 1) sealOk = false;
      if (feed.position > eng.index + 1) sealOk = false;
    }
    check("play loop: display never exceeds finalized + the one forming candle", displayOk);
    check("play loop: held array never exceeds the server position", sealOk);
    check("play loop: session drains to the final candle, fully revealed",
      eng.index === DAYB.length - 1 && feed.finished && eng.revealed.length === DAYB.length);
  }

  // --- mid-formation execution provenance ---
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAYB);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feed.setTotal(DAYB.length);
    await feed.create(dsId, LOCK);
    const eng = await buildDrEngine(feed, LOCK, DAILY_REPLAY_STARTING_BALANCE);
    for (let i = 0; i < 100; i++) eng.tick();
    const fill = eng.buy(5);
    check("(e) mid-formation buy is stamped on the forming candle",
      !!fill && fill.candleIndex === LOCK + 1 && fill.time === DAYB[LOCK + 1].t);
    check("(e) mid-formation price belongs to the forming candle only (disjoint ranges)",
      !!fill && fill.price >= DAYB[LOCK + 1].l && fill.price <= DAYB[LOCK + 1].h
      && !(fill.price >= DAYB[LOCK].l && fill.price <= DAYB[LOCK].h));
  }

  // --- lock the second-to-last candle ---
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAYB);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feed.setTotal(DAYB.length);
    await feed.create(dsId, DAYB.length - 2);
    const eng = await buildDrEngine(feed, DAYB.length - 2, DAILY_REPLAY_STARTING_BALANCE);
    check("boundary: locking #N-1 releases the final candle and forms it",
      feed.position === DAYB.length - 1 && feed.finished
      && eng.index === DAYB.length - 2
      && eng.displayCandles[DAYB.length - 1].t === DAYB[DAYB.length - 1].t);
    eng.step();
    check("boundary: locking #N-1 completes on the final candle",
      eng.atEnd && eng.index === DAYB.length - 1 && eng.revealed.length === DAYB.length);
  }

  // --- lock the final candle (degenerate) ---
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAYB);
    const feed = new SealedCandleFeed(new FakeTransport(store, "user-a"));
    feed.setTotal(DAYB.length);
    await feed.create(dsId, DAYB.length - 1);
    const eng = await buildDrEngine(feed, DAYB.length - 1, DAILY_REPLAY_STARTING_BALANCE);
    check("boundary: locking the final candle opens already at the end",
      eng.atEnd && eng.index === DAYB.length - 1 && eng.revealed.length === DAYB.length);
    check("boundary: the final locked candle stands complete (not re-formed)",
      (() => { const d = eng.displayCandles; const last = d[d.length - 1]; return d.length === DAYB.length && last.h === DAYB[DAYB.length - 1].h && last.c === DAYB[DAYB.length - 1].c && last.v === DAYB[DAYB.length - 1].v; })());
  }
}

/* ------------- strict future-candle sealing (release-on-consume) -------------
 * The guarantee: future candle data must NOT be present in the
 * browser before replay reveals it. The only releases in the DR
 * flow are create's prefix [0..lock], buildDrEngine's single
 * advance(1), resume's single advance(1), and — during play, step,
 * and fast step-through — the feed.ensure(engine.index + 1) gate,
 * which advances exactly one candle per transport call and stops at
 * the requested candle. These tests drive the page's exact call
 * shapes over a counting transport and pin both the invariant
 * (feed length ≤ formingIndex + 1 at every instant) and the
 * release-call accounting. */
class CountingTransport implements SealedTransport {
  advanceSteps: number[] = [];
  constructor(private inner: FakeTransport) {}
  createAttempt(datasetId: string, startIndex: number) {
    return this.inner.createAttempt(datasetId, startIndex);
  }
  async advance(attemptId: string, steps: number) {
    this.advanceSteps.push(steps);
    return this.inner.advance(attemptId, steps);
  }
  getRevealed(attemptId: string) {
    return this.inner.getRevealed(attemptId);
  }
}

/** Fails exactly one advance — the one that would release candle
 *  `failIndex` — then heals. The failure is raised BEFORE the inner
 *  transport is touched, mirroring a network/RPC error. */
class FailOnceTransport implements SealedTransport {
  private failed = false;
  constructor(
    private store: FakeStore,
    private inner: FakeTransport,
    private failIndex: number,
  ) {}
  createAttempt(datasetId: string, startIndex: number) {
    return this.inner.createAttempt(datasetId, startIndex);
  }
  async advance(attemptId: string, steps: number) {
    const att = this.store.attempts.get(attemptId)!;
    if (!this.failed && att.position + 1 === this.failIndex) {
      this.failed = true;
      throw new Error("simulated release failure");
    }
    return this.inner.advance(attemptId, steps);
  }
  getRevealed(attemptId: string) {
    return this.inner.getRevealed(attemptId);
  }
}

async function strictSealingTests() {
  const DAYB = makeDisjointCandles(FRI, "09:30", 120);
  const LOCK = 40;
  const N = DAYB.length;

  // (1)+(2) Full play-through in the page's shape: the timer's gate
  // call interleaved with tick(), invariant asserted after EVERY
  // tick and EVERY release; then the release-call accounting.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAYB);
    const transport = new CountingTransport(new FakeTransport(store, "user-a"));
    const feed = new SealedCandleFeed(transport);
    feed.setTotal(N);
    await feed.create(dsId, LOCK);
    const eng = await buildDrEngine(feed, LOCK, DAILY_REPLAY_STARTING_BALANCE);

    let invariantOk = true;
    const assertInvariant = () => {
      const forming = eng.index + 1; // candle being formed / next to form
      if (feed.candles.length > forming + 1) invariantOk = false;
      if (feed.position > forming) invariantOk = false;
      if (eng.displayCandles.length > feed.candles.length) invariantOk = false;
    };
    assertInvariant();
    let guard = 0;
    while (guard++ < 200_000) {
      if (eng.atEnd) {
        if (feed.finished) break;
        await feed.ensure(eng.index + 1); // the play loop's exact gate call
        assertInvariant();
        continue;
      }
      eng.tick();
      assertInvariant();
    }
    check("strict: array never ahead of the forming candle across a full tick-by-tick play-through",
      invariantOk);
    check("strict: play-through completes the session",
      eng.index === N - 1 && feed.finished && feed.position === N - 1 && eng.revealed.length === N);
    check("strict: every release requested exactly one candle (zero requests for steps > 1)",
      transport.advanceSteps.length > 0 && transport.advanceSteps.every((s) => s === 1));
    check("strict: release calls = candles consumed after the lock",
      transport.advanceSteps.length === N - 1 - LOCK);
  }

  // Gate precision: ensure(i) lands exactly on i — never a batch
  // end — and ensure of an already-held candle releases nothing.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAYB);
    const transport = new CountingTransport(new FakeTransport(store, "user-a"));
    const feed = new SealedCandleFeed(transport);
    feed.setTotal(N);
    await feed.create(dsId, LOCK); // position = LOCK
    const held = await feed.ensure(LOCK);
    check("strict gate: ensure of a held candle releases nothing",
      held && transport.advanceSteps.length === 0 && feed.position === LOCK);
    await feed.ensure(LOCK + 5);
    check("strict gate: ensure(i) lands exactly on i, one candle per call",
      feed.position === LOCK + 5 && feed.candles.length === LOCK + 6
      && transport.advanceSteps.length === 5 && transport.advanceSteps.every((s) => s === 1));
  }

  // (3) Step button shape + fast step-through ("skip"): every
  // boundary crossing goes through the same gate; K step-throughs
  // consume exactly one single-candle release per candle formed.
  {
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAYB);
    const transport = new CountingTransport(new FakeTransport(store, "user-a"));
    const feed = new SealedCandleFeed(transport);
    feed.setTotal(N);
    await feed.create(dsId, LOCK);
    const eng = await buildDrEngine(feed, LOCK, DAILY_REPLAY_STARTING_BALANCE);
    // drStepNext's exact shape: gate first, then step.
    const drStep = async () => {
      if (eng.atEnd && !feed.finished) await feed.ensure(eng.index + 1);
      if (!eng.atEnd) eng.step();
    };
    let invariantOk = feed.position <= eng.index + 1;
    const K = 25;
    for (let s = 0; s < K; s++) {
      await drStep();
      if (feed.position > eng.index + 1) invariantOk = false;
      if (feed.candles.length > eng.index + 2) invariantOk = false;
    }
    check("strict step: array-never-ahead invariant holds after every step", invariantOk);
    check("strict step: K step-throughs finalize exactly K candles",
      eng.index === LOCK + K);
    check("strict step: exactly one single-candle release per candle formed",
      transport.advanceSteps.length === K
      && transport.advanceSteps.every((s) => s === 1)
      && feed.position === LOCK + K);
  }

  // (4) A failed release mid-play: the error surfaces, the feed is
  // left untouched at exactly [0..k-1] with the engine finalized on
  // k-1 — no partial or phantom candle — and a retry succeeds.
  {
    const FAIL = 60;
    const store = new FakeStore();
    const dsId = store.addDataset("user-a", DAYB);
    const transport = new FailOnceTransport(store, new FakeTransport(store, "user-a"), FAIL);
    const feed = new SealedCandleFeed(transport);
    feed.setTotal(N);
    await feed.create(dsId, LOCK);
    const eng = await buildDrEngine(feed, LOCK, DAILY_REPLAY_STARTING_BALANCE);
    let surfaced: unknown = null;
    let guard = 0;
    while (guard++ < 200_000) {
      if (eng.atEnd) {
        if (feed.finished) break;
        try {
          await feed.ensure(eng.index + 1);
        } catch (e) {
          surfaced = e;
          break;
        }
        continue;
      }
      eng.tick();
    }
    check("strict failure: the release error surfaces to the caller",
      surfaced instanceof Error && /simulated release failure/.test((surfaced as Error).message));
    check("strict failure: feed holds exactly [0..k-1] — no partial/phantom candle",
      feed.position === FAIL - 1 && feed.candles.length === FAIL
      && feed.candles[FAIL - 1].t === DAYB[FAIL - 1].t
      && !feed.candles.some((c) => c.t === DAYB[FAIL].t));
    check("strict failure: engine rests finalized on candle k-1",
      eng.index === FAIL - 1 && eng.atEnd);
    const ok = await feed.ensure(eng.index + 1);
    check("strict failure: retry releases exactly the failed candle",
      ok && feed.position === FAIL && feed.candles[FAIL].t === DAYB[FAIL].t);
  }
}

/* ============ strategy binding + source normalization (2.0) ============ */
async function strategyBindingTests() {
  console.log("\n-- strategy binding at lock + reload normalization --");
  check("normalize: daily_replay loads as twelvedata", normalizeReloadedSource("daily_replay") === "twelvedata");
  check("normalize: twelvedata unchanged", normalizeReloadedSource("twelvedata") === "twelvedata");
  check("normalize: sample unchanged", normalizeReloadedSource("sample") === "sample");
  check("normalize: csv unchanged", normalizeReloadedSource("csv") === "csv");

  // The feed must hand the bound version id to the transport verbatim —
  // binding happens at creation, server-side, never later.
  const store = new FakeStore();
  const owner = "owner-1";
  const dsId = store.addDataset(owner, DAY);
  const seen: (string | null | undefined)[] = [];
  const recording: SealedTransport = {
    async createAttempt(datasetId: string, startIndex: number, strategyVersionId?: string | null) {
      seen.push(strategyVersionId);
      return new FakeTransport(store, owner).createAttempt(datasetId, startIndex);
    },
    advance: (id: string, steps: number) => new FakeTransport(store, owner).advance(id, steps),
    getRevealed: (id: string) => new FakeTransport(store, owner).getRevealed(id),
  };
  const feed = new SealedCandleFeed(recording);
  await feed.create(dsId, 2, "ver-123");
  check("feed.create passes the strategy version id through", seen[0] === "ver-123");
  const feed2 = new SealedCandleFeed(recording);
  await feed2.create(dsId, 2);
  check("feed.create without a strategy passes null", seen[1] === null);
}

(async () => {
  await sealingTests();
  await engineGrowthTests();
  await boundaryTests();
  await strictSealingTests();
  twelveDataTests();
  eventsTests();
  balanceTests();
  await strategyBindingTests();
  console.log(`\n=== DAILY REPLAY RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
