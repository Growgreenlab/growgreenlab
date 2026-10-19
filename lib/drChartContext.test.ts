/**
 * drChartContext.test.ts — chart-context builder (Representative plan
 * §6.2). Run: npx tsx lib/drChartContext.test.ts
 *
 * THE SENTINEL HINDSIGHT TRIPWIRE: sentinel values planted in the
 * entry candle (and beyond) must appear ONLY in their own sections —
 * never in entry_context. If a future refactor lets one post-fill
 * tick of data into the entry section, these checks fail.
 */
import {
  buildChartContextCsv,
  buildTradeChartContext,
  summarizeChartContexts,
  type ChartCandle,
  type TradeChartContext,
} from "./drChartContext";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}

const BASE = Date.UTC(2026, 9, 15, 13, 30, 0); // 2026-10-15 09:30 ET
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function candles(n: number, mutate?: (c: ChartCandle, i: number) => void): ChartCandle[] {
  const out: ChartCandle[] = [];
  for (let i = 0; i < n; i++) {
    const c: ChartCandle = { t: BASE + i * MIN, o: 10 + i * 0.1, h: 10.2 + i * 0.1, l: 9.9 + i * 0.1, c: 10.1 + i * 0.1, v: 1000 + i * 100 };
    mutate?.(c, i);
    out.push(c);
  }
  return out;
}

const E = 5, X = 9;
const SENTINEL_ENTRY_CLOSE = 777.77;
const SENTINEL_ENTRY_HIGH = 888.88;
const SENTINEL_ENTRY_VOL = 999999;
const SENTINEL_EXIT_CLOSE = 555.55;
const SENTINEL_POST_EXIT = 111.11;

const withSentinels = candles(12, (c, i) => {
  if (i === E) { c.c = SENTINEL_ENTRY_CLOSE; c.h = SENTINEL_ENTRY_HIGH; c.v = SENTINEL_ENTRY_VOL; }
  if (i === X) { c.c = SENTINEL_EXIT_CLOSE; }
  if (i > X) { c.o = SENTINEL_POST_EXIT; c.h = SENTINEL_POST_EXIT; c.l = SENTINEL_POST_EXIT; c.c = SENTINEL_POST_EXIT; c.v = SENTINEL_POST_EXIT; }
});

const ctxArgs = (over: Partial<Parameters<typeof buildTradeChartContext>[0]> = {}) => ({
  tradeId: "TRADE-sess-1",
  tradeKey: "sess:1",
  symbol: "DRCO",
  attemptId: "att-1",
  entryCandleIndex: E,
  exitCandleIndex: X,
  recordedEntryTime: iso(BASE + E * MIN),
  candles: withSentinels,
  ...over,
});

/* ---- happy path + section boundaries ---- */
const ctx: TradeChartContext = buildTradeChartContext(ctxArgs());
check("context available", ctx.available === true && ctx.unavailableReason === null);
check("counts: 5 entry / 1 final / 4 post", ctx.counts.entryContext === 5 && ctx.counts.entryCandleFinal === 1 && ctx.counts.postEntry === 4);
check("entry_context indices are exactly 0..E-1",
  ctx.rows.filter((r) => r.section === "entry_context").map((r) => r.candleIndex).join(",") === "0,1,2,3,4");
check("boundary: E-1 IS in entry_context", ctx.rows.some((r) => r.section === "entry_context" && r.candleIndex === E - 1));
check("boundary: E is NOT in entry_context", !ctx.rows.some((r) => r.section === "entry_context" && r.candleIndex === E));
check("entry candle appears once, as entry_candle_final",
  ctx.rows.filter((r) => r.candleIndex === E).length === 1 && ctx.rows.find((r) => r.candleIndex === E)?.section === "entry_candle_final");
check("post_entry indices are exactly E+1..X",
  ctx.rows.filter((r) => r.section === "post_entry_development").map((r) => r.candleIndex).join(",") === "6,7,8,9");
check("NO post-exit tail: no row beyond X", ctx.rows.every((r) => r.candleIndex <= X));
check("entry row carries ET time 09:35", ctx.rows.find((r) => r.candleIndex === E)?.candleTimeEt === "09:35");
check("entry time recorded", ctx.entryTime === iso(BASE + E * MIN));

/* ---- THE SENTINEL TRIPWIRE ---- */
const entrySectionRows = ctx.rows.filter((r) => r.section === "entry_context");
check("sentinel entry close NEVER in entry_context", entrySectionRows.every((r) => r.close !== SENTINEL_ENTRY_CLOSE));
check("sentinel entry high NEVER in entry_context", entrySectionRows.every((r) => r.high !== SENTINEL_ENTRY_HIGH));
check("sentinel entry volume NEVER in entry_context", entrySectionRows.every((r) => r.volume !== SENTINEL_ENTRY_VOL));
check("sentinel entry close appears ONLY in entry_candle_final",
  ctx.rows.filter((r) => r.close === SENTINEL_ENTRY_CLOSE).every((r) => r.section === "entry_candle_final")
  && ctx.rows.some((r) => r.close === SENTINEL_ENTRY_CLOSE));
check("sentinel exit close appears ONLY in post_entry_development",
  ctx.rows.filter((r) => r.close === SENTINEL_EXIT_CLOSE).every((r) => r.section === "post_entry_development")
  && ctx.rows.some((r) => r.close === SENTINEL_EXIT_CLOSE));
check("post-exit sentinel appears NOWHERE", ctx.rows.every((r) =>
  r.open !== SENTINEL_POST_EXIT && r.high !== SENTINEL_POST_EXIT && r.low !== SENTINEL_POST_EXIT && r.close !== SENTINEL_POST_EXIT && r.volume !== SENTINEL_POST_EXIT));

const csv = buildChartContextCsv([ctx]);
check("csv produced", csv !== null);
const csvLines = (csv ?? "").split("\r\n").filter((l) => l.length > 0);
check("csv header exact", csvLines[0] === "trade_id,symbol,attempt_id,section,candle_index,candle_time,candle_time_et,open,high,low,close,volume,timeframe_min,session_high_so_far,vwap_typical_approx,ema_fast_9,ema_slow_20,premarket_high,premarket_low,key_levels");
check("csv row count = header + 10 rows", csvLines.length === 11);
check("csv entry_context lines carry NO sentinel values",
  csvLines.filter((l) => l.includes(",entry_context,")).every((l) => !l.includes("777.77") && !l.includes("888.88") && !l.includes("999999")));
check("csv never contains the post-exit sentinel", !(csv ?? "").includes("111.11"));
check("csv rows are self-describing (trade/symbol/attempt on every row)",
  csvLines.slice(1).every((l) => l.startsWith("TRADE-sess-1,DRCO,att-1,")));

/* ---- edge cases ---- */
{
  const c0 = buildTradeChartContext(ctxArgs({ entryCandleIndex: 0, recordedEntryTime: iso(BASE) }));
  check("E=0: available with empty entry_context", c0.available && c0.counts.entryContext === 0);
  check("E=0: explicit note", c0.notes.some((n) => n.includes("No completed candles before entry")));
}
{
  const cSame = buildTradeChartContext(ctxArgs({ exitCandleIndex: E }));
  check("X=E: no post-entry rows", cSame.available && cSame.counts.postEntry === 0);
  check("X=E: explicit note", cSame.notes.some((n) => n.includes("same candle")));
}
{
  const cOpen = buildTradeChartContext(ctxArgs({ exitCandleIndex: null }));
  check("X null (no exit recorded): available, no post rows", cOpen.available && cOpen.counts.postEntry === 0);
}
{
  const cGap = buildTradeChartContext(ctxArgs({
    candles: candles(12, (c, i) => { if (i >= 3) c.t += MIN; }), // one-minute gap after index 2
    recordedEntryTime: iso(BASE + E * MIN + MIN),
  }));
  check("gap: context still available, gap flagged, rows not fabricated",
    cGap.available && cGap.notes.some((n) => n.includes("gaps")) && cGap.rows.length === 10);
}

/* ---- unavailability (never shifted, never guessed) ---- */
{
  const c = buildTradeChartContext(ctxArgs({ candles: null }));
  check("missing candles -> unavailable", !c.available && (c.unavailableReason ?? "").includes("missing or empty"));
  check("csv is null when nothing is available", buildChartContextCsv([c]) === null);
}
{
  const c = buildTradeChartContext(ctxArgs({ candles: candles(4) }));
  check("candles[E] missing -> unavailable", !c.available && (c.unavailableReason ?? "").includes("no candle at the entry index"));
}
{
  const c = buildTradeChartContext(ctxArgs({ recordedEntryTime: iso(BASE + (E + 1) * MIN) }));
  check("entry-time mismatch -> unavailable (alignment unproven)", !c.available && (c.unavailableReason ?? "").includes("does not match"));
}
{
  const c = buildTradeChartContext(ctxArgs({ recordedEntryTime: null }));
  check("no recorded entry time -> unavailable", !c.available);
}
{
  const c = buildTradeChartContext(ctxArgs({ entryCandleIndex: null }));
  check("no entry candle index -> unavailable", !c.available);
}
{
  const bad = candles(12, (c, i) => { if (i === 7) c.t = c.t - 2 * MIN; });
  const c = buildTradeChartContext(ctxArgs({ candles: bad }));
  check("non-monotonic candles -> unavailable", !c.available && (c.unavailableReason ?? "").includes("increasing"));
}
{
  const bad = candles(12) as unknown as Record<string, unknown>[];
  bad[3] = { t: BASE + 3 * MIN, o: 1, h: 1, l: 1, c: 1 }; // missing v
  const c = buildTradeChartContext(ctxArgs({ candles: bad }));
  check("malformed candle row -> unavailable", !c.available && (c.unavailableReason ?? "").includes("malformed"));
}
{
  const good = buildTradeChartContext(ctxArgs());
  const badOne = buildTradeChartContext(ctxArgs({ tradeId: "TRADE-other", recordedEntryTime: null }));
  const summary = summarizeChartContexts([good, badOne]);
  check("summary counts available/unavailable per trade",
    summary.tradesWithContext === 1 && summary.tradesUnavailable === 1 && summary.unavailable[0].tradeId === "TRADE-other");
  const mixed = buildChartContextCsv([good, badOne]);
  check("csv includes only the available trade's rows", mixed !== null && !mixed.includes("TRADE-other"));
}

/* ---- derived columns (audit §G 2a/2b/2c/2e), hand-checked ----
 * Fixture starts 09:28 ET (13:28 UTC): candles 0-1 are premarket,
 * 2 is the 09:30 regular open, E=3 entry, X=4 exit, candle 5 exists
 * in storage but is beyond the exit and must not leak into any
 * derived value (session high through exit must ignore its 99 high).
 *   i:  o     h     l     c     v
 *   0:  10    11    9     10    100   (09:28, premarket)
 *   1:  10    12    10    11    100   (09:29, premarket)
 *   2:  11    13    10    12    300   (09:30)
 *   3:  12    12.5  11    12    100   (09:31, ENTRY)
 *   4:  12    14    11.5  13    200   (09:32, EXIT)
 *   5:  13    99    12    50    100   (beyond exit — excluded)
 * Hand-computed expectations:
 *   premarket high/low = 12 / 9 (candles 0-1 only)
 *   session high through exit = 14 (candle 4, NOT 99)
 *   row0: hod 11; vwap = typical(10) = 10; ema9 = ema20 = 10 (seed)
 *   row1: hod 12; vwap = (10*100 + 11*100)/200 = 10.5;
 *         ema9 = 11*0.2 + 10*0.8 = 10.2;
 *         ema20 = 11*(2/21) + 10*(19/21) = 212/21 ≈ 10.095238
 *   row2: hod 13; vwap = (1000 + 1100 + (35/3)*300)/500 = 5600/500 = 11.2;
 *         ema9 = 12*0.2 + 10.2*0.8 = 10.56
 *   row3: hod 13 (12.5 < 13); vwap = (5600 + (35.5/3)*100)/600 ≈ 11.305556
 */
{
  const BASE3 = Date.UTC(2026, 9, 15, 13, 28, 0); // 09:28 ET
  const dc: ChartCandle[] = [
    { t: BASE3 + 0 * MIN, o: 10, h: 11, l: 9, c: 10, v: 100 },
    { t: BASE3 + 1 * MIN, o: 10, h: 12, l: 10, c: 11, v: 100 },
    { t: BASE3 + 2 * MIN, o: 11, h: 13, l: 10, c: 12, v: 300 },
    { t: BASE3 + 3 * MIN, o: 12, h: 12.5, l: 11, c: 12, v: 100 },
    { t: BASE3 + 4 * MIN, o: 12, h: 14, l: 11.5, c: 13, v: 200 },
    { t: BASE3 + 5 * MIN, o: 13, h: 99, l: 12, c: 50, v: 100 },
  ];
  const dctx = buildTradeChartContext({
    tradeId: "TRADE-deriv", tradeKey: "sess:9", symbol: "DERIV", attemptId: "att-9",
    entryCandleIndex: 3, exitCandleIndex: 4,
    recordedEntryTime: iso(BASE3 + 3 * MIN),
    candles: dc,
    timeframeMinutes: 1,
    keyLevels: [{ price: 12.5, type: "Resistance", interaction: "Resistance rejection" }],
  });
  check("derived: context available", dctx.available === true);
  const approx = (name: string, actual: number | null, expected: number) =>
    check(`${name} (got ${actual}, want ${expected})`, actual != null && Math.abs(actual - expected) < 1e-6);
  approx("derived: premarket high = 12", dctx.derived.premarketHigh, 12);
  approx("derived: premarket low = 9", dctx.derived.premarketLow, 9);
  check("derived: premarket candles flagged present", dctx.derived.premarketCandlesPresent === true);
  approx("derived: session high through exit = 14 (post-exit 99 excluded)", dctx.derived.sessionHighThroughExit, 14);
  const r0 = dctx.rows[0], r1 = dctx.rows[1], r2 = dctx.rows[2], r3 = dctx.rows[3];
  approx("derived: row0 hod-so-far 11", r0.sessionHighSoFar, 11);
  approx("derived: row0 vwap 10", r0.vwap, 10);
  approx("derived: row0 ema seed = first close", r0.emaFast, 10);
  approx("derived: row1 hod-so-far 12", r1.sessionHighSoFar, 12);
  approx("derived: row1 vwap 10.5", r1.vwap, 10.5);
  approx("derived: row1 ema9 10.2", r1.emaFast, 10.2);
  approx("derived: row1 ema20 212/21", r1.emaSlow, 212 / 21);
  approx("derived: row2 vwap 11.2", r2.vwap, 11.2);
  approx("derived: row2 ema9 10.56", r2.emaFast, 10.56);
  approx("derived: row3 (entry) hod-so-far still 13", r3.sessionHighSoFar, 13);
  approx("derived: row3 vwap ≈ 11.305556", r3.vwap, 11.305556);
  check("derived: timeframe carried", dctx.timeframeMinutes === 1);
  check("derived: key levels joined", dctx.keyLevelsText === "12.5 Resistance (Resistance rejection)");
  const dCsv = buildChartContextCsv([dctx]) ?? "";
  const dRows = dCsv.split("\r\n").filter((l) => l.length > 0).slice(1).map((l) => l.split(","));
  check("derived: csv rows carry timeframe + premarket + key levels",
    dRows.length === 5 && dRows.every((r) => r[12] === "1" && r[17] === "12" && r[18] === "9" && r[19] === "12.5 Resistance (Resistance rejection)"));
  check("derived: csv session_high_so_far final row = 14", dRows[4][13] === "14");
}

{
  // The standard fixture starts AT 09:30 ET — no premarket candles:
  // premarket extremes are honestly absent, never derived from
  // regular-hours rows.
  check("derived: no premarket rows -> extremes null + flag false",
    ctx.derived.premarketCandlesPresent === false && ctx.derived.premarketHigh === null && ctx.derived.premarketLow === null);
  check("derived: timeframe null when the source records none", ctx.timeframeMinutes === null);
}

console.log(`drChartContext tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
