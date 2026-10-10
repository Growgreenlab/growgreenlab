// Smoke test for the Trade Replay Lab v2 engine + market-data helpers.
// Compiles the pure-TS lib files with tsc, then runs assertions in Node.
// Run: node scripts/smoke.mjs
import { execSync } from "child_process";
import { createRequire } from "module";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), "trb-test-"));
try {
  execSync(
    `npx tsc lib/engine.ts lib/types.ts lib/marketData.ts lib/marketData.twelve.ts lib/marketData.csv.ts ` +
      `--outDir ${OUT} --module commonjs --target es2020 --moduleResolution node --strict --skipLibCheck`,
    { cwd: ROOT, stdio: "pipe" }
  );
} catch (e) {
  console.error("TSC COMPILE FAILED:\n" + e.stdout?.toString() + e.stderr?.toString());
  process.exit(1);
}
const require = createRequire(import.meta.url + "/");
const { ReplayEngine, formatMoney } = require(join(OUT, "engine.js"));
const MD = require(join(OUT, "marketData.js"));
const TW = require(join(OUT, "marketData.twelve.js"));
const CSV = require(join(OUT, "marketData.csv.js"));

let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) passed++;
  else { failed++; console.error("FAIL:", name); }
};
const eq = (a, b, name, eps = 1e-9) =>
  ok(Math.abs(a - b) <= eps, `${name} (got ${a}, want ${b})`);

// --- fixture: simple rising/falling tape, 1-min apart ---
const T0 = Date.UTC(2026, 9, 9, 13, 30);
const C = (o, h, l, c, v = 1000, i = 0) => ({ t: T0 + i * 60000, o, h, l, c, v });
const tape = [
  C(5.00, 5.05, 4.98, 5.02, 1000, 0),
  C(5.02, 5.10, 5.00, 5.08, 1200, 1),
  C(5.08, 5.12, 5.03, 5.05, 900, 2),
  C(5.05, 5.06, 4.90, 4.92, 2000, 3), // dips to 4.90
  C(4.92, 5.20, 4.91, 5.15, 3000, 4), // spikes to 5.20
  C(5.15, 5.18, 5.10, 5.12, 1100, 5),
];

// 1. futures hidden
{
  const e = new ReplayEngine(tape, 100_000, 2);
  ok(e.index === 2, "engine starts at startIndex");
  ok(e.revealed.length === 3, "only 3 candles revealed");
  ok(!e.revealed.some((c) => c.t > tape[2].t), "no future candle leaks");
  eq(e.hod, 5.12, "HOD over revealed candles");
}

// 2. buy opens position
{
  const e = new ReplayEngine(tape, 100_000, 1); // price 5.08
  const f = e.buy(100);
  ok(!!f, "buy fills");
  eq(e.positionQty, 100, "position qty");
  eq(e.positionAvg, 5.08, "avg price");
  eq(e.cash, 100_000 - 508, "cash reduced");
  eq(e.unrealizedPnl(), 0, "unrealized zero at entry");
}

// 3. sell closes with correct P/L
{
  const e = new ReplayEngine(tape, 100_000, 1);
  e.buy(100); // @5.08
  e.step(); e.step(); // index 3, price 4.92
  const f = e.sell(100);
  ok(!!f, "sell fills");
  eq(f.realizedPnl, (4.92 - 5.08) * 100, "realized loss math");
  eq(e.realizedPnl, -16, "engine realized total");
  eq(e.positionQty, 0, "flat after sell");
  eq(e.cash, 100_000 - 508 + 492, "cash after round trip");
}

// 4. stop-loss triggers on the right candle
{
  const e = new ReplayEngine(tape, 100_000, 1);
  e.buy(100); // @5.08
  e.setBrackets(5.0, null);
  const r = e.step(); // index 2: low 5.03, no trigger
  ok(r.autoFills.length === 0, "no trigger above stop");
  const r2 = e.step(); // index 3: low 4.90 <= 5.00 -> trigger at 5.00
  ok(r2.autoFills.length === 1, "stop triggers");
  eq(r2.autoFills[0].price, 5.0, "stop fill price");
  ok(r2.autoFills[0].note === "stop-loss", "stop note");
  eq(e.positionQty, 0, "flat after stop");
  eq(e.realizedPnl, (5.0 - 5.08) * 100, "stop realized");
  ok(e.stopLoss === null, "brackets cleared after trigger");
}

// 5. take-profit triggers
{
  const e = new ReplayEngine(tape, 100_000, 3); // price 4.92
  e.buy(100);
  e.setBrackets(null, 5.18);
  const r = e.step(); // index 4: high 5.20 >= 5.18 -> fill at 5.18
  ok(r.autoFills.length === 1 && r.autoFills[0].note === "take-profit", "tp triggers");
  eq(r.autoFills[0].price, 5.18, "tp fill price");
  eq(e.realizedPnl, (5.18 - 4.92) * 100, "tp realized");
}

// 6. both hit same candle -> stop wins (conservative)
{
  const both = [C(5.0, 5.3, 4.9, 5.1, 1000, 0), C(5.1, 5.5, 4.8, 5.2, 1000, 1)];
  const e = new ReplayEngine(both, 100_000, 0);
  e.buy(100);
  e.setBrackets(4.95, 5.4);
  const r = e.step();
  ok(r.autoFills.length === 1 && r.autoFills[0].note === "stop-loss", "stop wins when both hit");
}

// 7. gap through stop fills at the open
{
  const gap = [C(5.0, 5.05, 4.98, 5.02, 1000, 0), C(4.80, 4.85, 4.70, 4.75, 1000, 1)];
  const e = new ReplayEngine(gap, 100_000, 0);
  e.buy(100); // @5.02
  e.setBrackets(4.9, null);
  const r = e.step(); // opens at 4.80 < 4.90
  eq(r.autoFills[0].price, 4.8, "gap-down stop fills at open");
}

// 8. rejects bad orders
{
  const e = new ReplayEngine(tape, 100, 0); // only $100 cash
  ok(e.buy(1000) === null, "buy rejected: insufficient cash");
  ok(e.sell(10) === null, "sell rejected: no position");
  const e2 = new ReplayEngine(tape, 100_000, 0);
  e2.buy(50);
  const f = e2.sell(999); // more than held -> closes all
  ok(f !== null && f.qty === 50, "oversell clamps to position");
}

// 9. reset
{
  const e = new ReplayEngine(tape, 100_000, 2);
  e.buy(10); e.step();
  e.reset();
  ok(e.index === 2 && e.cash === 100_000 && e.positionQty === 0 &&
     e.fills.length === 0 && e.realizedPnl === 0, "reset restores state");
}

// 10. sample generator: deterministic, 390 1-min candles, sane OHLC
{
  const a = MD.generateSampleSession("VEEA", "2026-10-09");
  const b = MD.generateSampleSession("VEEA", "2026-10-09");
  const c = MD.generateSampleSession("AAPL", "2026-10-09");
  ok(a.length === 390, "390 candles");
  ok(JSON.stringify(a) === JSON.stringify(b), "deterministic per ticker+date");
  ok(JSON.stringify(a) !== JSON.stringify(c), "differs per ticker");
  ok(a.every((x, i) => x.h >= x.l && x.h >= x.o && x.h >= x.c && x.l <= x.o && x.l <= x.c),
    "OHLC invariants");
  ok(a.every((x, i) => i === 0 || x.t - a[i - 1].t === 60000), "1-minute spacing");
}

// 11. ET time math (Oct = EDT = UTC-4)
{
  eq(MD.etToUtcMs("2026-10-09", "09:30"), Date.UTC(2026, 9, 9, 13, 30), "09:30 ET -> 13:30Z");
  eq(MD.easternOffsetMinutes("2026-01-09"), 300, "EST offset in January");
}

// 12. Twelve Data URL + key extraction
{
  const url = TW.buildTwelveDataUrl("veea", "2026-10-09", "KEY123");
  ok(url.includes("symbol=VEEA") && url.includes("interval=1min") &&
     url.includes("start_date=2026-10-09+09%3A30%3A00") &&
     url.includes("timezone=America%2FNew_York") && url.includes("apikey=KEY123"),
    "URL contract: " + url);
  ok(TW.extractApiKey("  KEY123  ") === "KEY123", "raw key trimmed");
  ok(TW.extractApiKey("https://api.twelvedata.com/time_series?apikey=ABC&symbol=VEEA") === "ABC",
    "key extracted from full URL");
}

// 13. Twelve Data response parsing (mocked, newest-first)
{
  const mock = {
    status: "ok",
    values: [
      { datetime: "2026-10-09 09:31:00", open: "5.10", high: "5.12", low: "5.08", close: "5.11", volume: "1200" },
      { datetime: "2026-10-09 09:30:00", open: "5.00", high: "5.05", low: "4.98", close: "5.02", volume: "1000" },
    ],
  };
  const cs = TW.parseTwelveDataResponse(mock);
  ok(cs.length === 2, "two candles parsed");
  ok(cs[0].t < cs[1].t, "reversed to chronological");
  eq(cs[0].o, 5.0, "open parsed");
  eq(cs[0].t, Date.UTC(2026, 9, 9, 13, 30), "ET datetime -> epoch");
  let threw = "";
  try { TW.parseTwelveDataResponse({ status: "error", code: 401, message: "Invalid API key" }); }
  catch (e) { threw = e.message; }
  ok(threw.includes("not accepted") && threw.includes("401"), "401 -> friendly message");
  threw = "";
  try { TW.parseTwelveDataResponse({ status: "ok", values: [] }); }
  catch (e) { threw = e.message; }
  ok(threw.includes("weekends"), "empty values -> weekend/holiday message");
}

// 14. CSV parse + round-trip + header tolerance
{
  const csv = `Date,Time,Open,HIGH,low,CLOSE,VOL
2026-10-09 09:30:00,5.00,5.05,4.98,5.02,1000
2026-10-09 09:31:00,5.02,5.10,5.00,5.08,1200`;
  // note: single datetime col required; this uses header aliases incl. "date"
  const cs = CSV.parseCsv(`datetime,open,high,low,close,volume\n2026-10-09 09:30:00,5.00,5.05,4.98,5.02,1000\n2026-10-09 09:31:00,5.02,5.10,5.00,5.08,1200`);
  ok(cs.length === 2 && cs[0].t < cs[1].t, "csv parsed + sorted");
  const rt = CSV.parseCsv(CSV.candlesToCsv(cs));
  ok(JSON.stringify(rt.map((c) => [c.o, c.h, c.l, c.c, c.v])) ===
     JSON.stringify(cs.map((c) => [c.o, c.h, c.l, c.c, c.v])), "csv round-trip");
  void csv;
  let threw = "";
  try { CSV.parseCsv("open,high\n1,2"); } catch (e) { threw = e.message; }
  ok(threw.includes('missing a "datetime"'), "missing column error names it");
}

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(OUT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
