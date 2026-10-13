/**
 * journalQuickEntry.test.ts — quick-entry P&L + fills conversion tests.
 * Run: npx tsx lib/journalQuickEntry.test.ts
 * Verifies the Add Real Trade "Quick entry" path: direction-aware
 * gross/net math, conversion into standard fills, and that calcRealTrade
 * (the journal's single P&L engine) reproduces the same numbers from
 * those fills — including partial exits and open trades.
 */
import { quickPnl, quickFills, calcRealTrade, type RealFill } from "./journal";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`); }
}
function approx(name: string, actual: number | null | undefined, expected: number, eps = 1e-6) {
  check(`${name} (got ${actual}, want ${expected})`, actual != null && Math.abs(actual - expected) < eps);
}
function toRealFills(q: ReturnType<typeof quickFills>): RealFill[] {
  return q.map((f, i) => ({ id: `q${i}`, side: f.side, qty: f.qty, price: f.price, fees: f.fees, fill_time: null }));
}

/* ---- quickPnl: the specified example -------------------------------
 * LONG entry $3.30, exit $3.50, qty 100, fees $2 → gross +$20, net +$18 */
const ex = quickPnl("long", 3.30, 3.50, 100, 2);
approx("example gross = +20", ex?.gross, 20);
approx("example net = +18", ex?.net, 18);

/* ---- direction matrix ---------------------------------------------- */
approx("long win gross", quickPnl("long", 3.30, 3.50, 100, 0)?.gross, 20);
approx("long loss gross", quickPnl("long", 3.50, 3.30, 100, 0)?.gross, -20);
approx("long loss net with fees", quickPnl("long", 3.50, 3.30, 100, 2)?.net, -22);
approx("short win gross (entry − exit)", quickPnl("short", 3.50, 3.30, 100, 0)?.gross, 20);
approx("short win net", quickPnl("short", 3.50, 3.30, 100, 2)?.net, 18);
approx("short loss gross", quickPnl("short", 3.30, 3.50, 100, 0)?.gross, -20);
approx("short loss net with fees", quickPnl("short", 3.30, 3.50, 100, 2)?.net, -22);
approx("breakeven gross = 0", quickPnl("long", 3.30, 3.30, 100, 0)?.gross, 0);
approx("breakeven net = 0 (no fees)", quickPnl("long", 3.30, 3.30, 100, 0)?.net, 0);
approx("breakeven with fees: net = −fees", quickPnl("long", 3.30, 3.30, 100, 2)?.net, -2);
approx("fees deducted once", quickPnl("long", 5, 6, 10, 3.5)?.net, 6.5);

/* ---- missing / invalid input: never a number, never fabricated ------ */
check("missing exit → null (open trade)", quickPnl("long", 3.30, null, 100, 0) === null);
check("zero entry → null", quickPnl("long", 0, 3.50, 100, 0) === null);
check("negative qty → null", quickPnl("long", 3.30, 3.50, -5, 0) === null);
check("zero exit → null", quickPnl("long", 3.30, 0, 100, 0) === null);
check("negative fees → null", quickPnl("long", 3.30, 3.50, 100, -1) === null);

/* ---- quickFills → calcRealTrade: one engine, identical results ------ */
const closed = calcRealTrade(toRealFills(quickFills("long", 3.30, 3.50, 100, 2)), "long", null, null);
approx("engine gross matches quick (20)", closed.grossRealized, 20);
approx("engine net matches quick (18)", closed.netRealized, 18);
approx("engine totalFees = 2", closed.totalFees, 2);
check("engine: fully closed", closed.isClosed && closed.openQty === 0);
approx("engine avgEntry = 3.30", closed.avgEntry, 3.30);

const shortWin = calcRealTrade(toRealFills(quickFills("short", 3.50, 3.30, 100, 2)), "short", null, null);
approx("engine short win net = 18", shortWin.netRealized, 18);
check("engine short: closed", shortWin.isClosed);

// Open trade: entry fill only → nothing realized, full quantity open.
const open = calcRealTrade(toRealFills(quickFills("long", 3.30, null, 100, 0)), "long", null, null);
check("open: quickFills yields exactly 1 fill", quickFills("long", 3.30, null, 100, 0).length === 1);
approx("open: openQty = 100", open.openQty, 100);
approx("open: gross realized = 0", open.grossRealized, 0);
check("open: not closed", !open.isClosed);
check("quickFills invalid entry → []", quickFills("long", 0, 3.50, 100, 0).length === 0);

/* ---- partial exits through the detailed fills path (unchanged) ------
 * Long 100 @ 3.30 (fees $2 on entry), exits 50 @ 3.50 + 50 @ 3.40:
 * gross = 50×0.20 + 50×0.10 = 15 → net 13. */
const partial = calcRealTrade([
  { id: "p1", side: "buy", qty: 100, price: 3.30, fees: 2, fill_time: null },
  { id: "p2", side: "sell", qty: 50, price: 3.50, fees: 0, fill_time: null },
  { id: "p3", side: "sell", qty: 50, price: 3.40, fees: 0, fill_time: null },
], "long", null, null);
approx("partial exits gross = 15", partial.grossRealized, 15);
approx("partial exits net = 13", partial.netRealized, 13);
check("partial exits: closed after both exits", partial.isClosed);

/* ---- recorded stop stays independent of the exit price --------------
 * Same quick trade + stop $3.10: initial risk = (3.30 − 3.10) × 100 = $20,
 * R = net 18 / 20 = 0.9 — driven by the stop, never by the exit. */
const withStop = calcRealTrade(toRealFills(quickFills("long", 3.30, 3.50, 100, 2)), "long", 3.10, null);
approx("stop: initialRisk = 20", withStop.initialRisk, 20);
approx("stop: R = 0.9 from net/initialRisk", withStop.rMultiple, 0.9);
const noStop = calcRealTrade(toRealFills(quickFills("long", 3.30, 3.50, 100, 2)), "long", null, null);
check("no stop: R stays null even with an exit price", noStop.rMultiple === null && noStop.initialRisk === null);

console.log(`journalQuickEntry tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
