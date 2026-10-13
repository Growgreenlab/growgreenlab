/**
 * sessionAssembly.test.ts — regression suite for the Candle Parity Investigation.
 * Run: npx tsx lib/sessionAssembly.test.ts
 *
 * Locks in the audited session-assembly contract:
 *  - The Twelve Data loader returns the provider's bars VERBATIM: no
 *    synthetic premarket bridge is added (the bridge was removed in commit
 *    239c271), no syn flags are invented, missing minutes are NOT fabricated,
 *    and no bars are dropped, duplicated, or reordered beyond the documented
 *    newest-first -> chronological reverse.
 *  - The engine receives the array untouched: history before startIndex is
 *    revealed exactly, the startIndex candle forms first, and a full drive
 *    finalizes to the source values exactly.
 *  - The sample session's composition is 330 generated premarket candles
 *    (04:00-09:29 ET) + 390 regular candles (09:30-15:59 ET) = 720.
 *  - The app's own CSV export round-trips a gapped session exactly, gaps
 *    included (missing minutes stay missing).
 *  - 1-minute timeframe aggregation is the identity: the display timeframe
 *    layer cannot substitute aggregated values into the 1m view.
 */
import { ReplayEngine } from "./engine";
import type { Candle } from "./types";
import { parseTwelveDataResponse } from "./marketData.twelve";
import { parseCsv, candlesToCsv } from "./marketData.csv";
import { generateSampleSession, aggregateCandles, etToUtcMs, formatEtTime } from "./marketData";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`); }
}
const eqC = (a: Candle, b: Candle) =>
  a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;

/** Build a Twelve Data-shaped JSON body (newest-first values). */
function tdBody(rows: Array<[string, number, number, number, number, number]>, date = "2026-10-12") {
  return {
    status: "ok",
    values: [...rows].reverse().map(([time, o, h, l, c, v]) => ({
      datetime: `${date} ${time}:00`,
      open: String(o), high: String(h), low: String(l), close: String(c), volume: String(v),
    })),
  };
}

/* ---------- 1. Loader: premarket-inclusive response passes through verbatim ---------- */
{
  const rows: Array<[string, number, number, number, number, number]> = [
    ["07:23", 2.67, 2.71, 2.6, 2.66, 120000],
    ["07:24", 2.66, 2.68, 2.55, 2.58, 90000],
    ["09:30", 2.59, 2.65, 2.3, 2.45, 900000],
    ["09:31", 2.45, 2.9, 2.44, 2.85, 1500000],
  ];
  const out = parseTwelveDataResponse(tdBody(rows));
  check("loader(premarket-inclusive): count == response count (no bridge added, none dropped)",
    out.length === rows.length);
  check("loader(premarket-inclusive): every bar exact + chronological",
    out.every((c, i) => c.t === etToUtcMs("2026-10-12", rows[i][0]) && c.o === rows[i][1] && c.h === rows[i][2] && c.l === rows[i][3] && c.c === rows[i][4] && c.v === rows[i][5]));
  check("loader: no syn flags invented on provider bars", out.every((c) => c.syn === undefined));
  check("loader: premarket ET datetime parses to EDT instant (07:23 ET = 11:23Z)",
    out[0].t === Date.UTC(2026, 9, 12, 11, 23));
}

/* ---------- 2. Loader: missing minutes are NOT fabricated ---------- */
{
  // Regular-session response with 3 minutes absent (09:33, 09:34, 09:37).
  const present = ["09:30", "09:31", "09:32", "09:35", "09:36", "09:38"];
  const rows = present.map((hm, i) => [hm, 3 + i * 0.1, 3.05 + i * 0.1, 2.95 + i * 0.1, 3.02 + i * 0.1, 1000 * (i + 1)] as [string, number, number, number, number, number]);
  const out = parseTwelveDataResponse(tdBody(rows));
  check("loader(gapped): output count == input count (no fabricated fill bars)", out.length === present.length);
  check("loader(gapped): timestamps are exactly the provider's minutes",
    out.map((c) => formatEtTime(c.t)).join(",") === present.join(","));
}

/* ---------- 3. Engine assembly: startIndex semantics on a premarket-inclusive array ---------- */
{
  const rows: Array<[string, number, number, number, number, number]> = [
    ["08:00", 2.0, 2.05, 1.98, 2.02, 5000],
    ["08:01", 2.02, 2.03, 2.0, 2.01, 3000],
    ["09:30", 2.59, 2.65, 2.3, 2.45, 900000],
    ["09:31", 2.45, 2.9, 2.44, 2.85, 1500000],
    ["09:32", 2.85, 3.1, 2.8, 3.05, 2000000],
  ];
  const src = parseTwelveDataResponse(tdBody(rows));
  const eng = new ReplayEngine(structuredClone(src), 100_000, 2); // start at 09:30 bar
  check("engine assembly: candles array is the loader output (same values, same order)",
    eng.candles.every((c, i) => eqC(c, src[i])));
  check("engine assembly: history before startIndex revealed exactly at open",
    eng.revealed.length === 2 && eng.revealed.every((c, i) => eqC(c, src[i])));
  const dc = eng.displayCandles;
  check("engine assembly: forming candle is the startIndex candle, opening at its source open",
    dc.length === 3 && dc[2].t === src[2].t && dc[2].o === src[2].o);
  check("engine assembly: sessionStart is 0 when no syn flags exist (HOD scope = whole tape)",
    eng.sessionStart === 0);
  while (!eng.atEnd) eng.tick();
  check("engine assembly: full drive finalizes == source exactly",
    eng.revealed.length === src.length && eng.revealed.every((c, i) => eqC(c, src[i])));
  check("engine assembly: startIndex clamps into range",
    new ReplayEngine(structuredClone(src), 100_000, 999).startIndex === src.length - 1);
}

/* ---------- 4. Sample session composition ---------- */
{
  const cs = generateSampleSession("MNDR", "2026-10-12");
  check("sample session: 720 candles (330 premarket + 390 regular)", cs.length === 720);
  check("sample session: first candle 04:00 ET, candle 330 is 09:30 ET, last is 15:59 ET",
    formatEtTime(cs[0].t) === "04:00" && formatEtTime(cs[330].t) === "09:30" && formatEtTime(cs[719].t) === "15:59");
  check("sample session: regular segment is 390 contiguous minutes",
    cs.slice(330).every((c, i) => i === 0 || c.t - cs[330 + i - 1].t === 60000));
}

/* ---------- 5. CSV round-trip preserves gaps exactly ---------- */
{
  const rows: Array<[string, number, number, number, number, number]> = [
    ["09:30", 2.59, 2.65, 2.3, 2.45, 900000],
    ["09:31", 2.45, 2.9, 2.44, 2.85, 1500000],
    // 09:32 + 09:33 missing (e.g. halt) — must stay missing after round-trip
    ["09:34", 3.0, 3.4, 2.95, 3.3, 2200000],
    ["09:35", 3.3, 3.35, 3.1, 3.15, 800000],
  ];
  const src = rows.map(([hm, o, h, l, c, v]) => ({ t: etToUtcMs("2026-10-12", hm), o, h, l, c, v }));
  const back = parseCsv(candlesToCsv(src));
  check("CSV round-trip(gapped): count + every candle exact, gaps preserved",
    back.length === src.length && back.every((c, i) => eqC(c, src[i])));
}

/* ---------- 6. 1m aggregation is the identity ---------- */
{
  const src = parseTwelveDataResponse(tdBody([
    ["09:30", 2.59, 2.65, 2.3, 2.45, 900000],
    ["09:31", 2.45, 2.9, 2.44, 2.85, 1500000],
  ]));
  const agg = aggregateCandles(src, 1);
  check("aggregation at 1m returns the input unchanged (same reference)",
    agg === (src as Candle[]));
}

console.log(`\nsessionAssembly: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
