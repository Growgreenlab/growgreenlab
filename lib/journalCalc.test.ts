/**
 * journalCalc.test.ts — hand-computed fixtures for calcRealTrade +
 * validateRealFills (lib/journal.ts).
 * Run: npx tsx lib/journalCalc.test.ts
 * Focuses on the avgExit addition (FIFO-matched weighted average exit
 * price) and the fill-validation rules, while pinning the pre-existing
 * outputs (avgEntry, gross/net realized, fees, openQty) so changes to
 * the FIFO walk can't silently alter them.
 */
import { calcRealTrade, validateRealFills, perExitPnl, parseKeyLevels, validateKeyLevels, computePlanUpdate, type RealFill } from "./journal";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`); }
}
function approx(name: string, actual: number | null, expected: number, eps = 1e-9) {
  check(`${name} (got ${actual}, want ${expected})`, actual != null && Math.abs(actual - expected) < eps);
}

let seq = 0;
function F(side: "buy" | "sell", qty: number, price: number, fees = 0): RealFill {
  return { id: `f${++seq}`, side, qty, price, fees, fill_time: null };
}

/* ============ avgExit: simple full close (long) ============
 * In 100 @ 3.30, out 100 @ 3.50 → avgExit 3.50, avgEntry 3.30,
 * gross (3.50 − 3.30) × 100 = 20. */
const simple = calcRealTrade([F("buy", 100, 3.30), F("sell", 100, 3.50)], "long", null, null);
approx("simple avgExit = 3.50", simple.avgExit, 3.50);
approx("simple avgEntry = 3.30", simple.avgEntry, 3.30);
approx("simple grossRealized = 20", simple.grossRealized, 20);
approx("simple netRealized = 20", simple.netRealized, 20);
approx("simple openQty = 0", simple.openQty, 0);
check("simple isClosed", simple.isClosed === true);

/* ============ avgExit: partial exits at two prices ============
 * In 100 @ 3.30, out 50 @ 3.50 + 50 @ 3.40 →
 * avgExit = (50×3.50 + 50×3.40) / 100 = 3.45,
 * gross = 50×0.20 + 50×0.10 = 15. */
const partial = calcRealTrade(
  [F("buy", 100, 3.30), F("sell", 50, 3.50), F("sell", 50, 3.40)],
  "long", null, null,
);
approx("partial avgExit = 3.45", partial.avgExit, 3.45);
approx("partial grossRealized = 15", partial.grossRealized, 15);
approx("partial avgEntry = 3.30", partial.avgEntry, 3.30);
check("partial isClosed", partial.isClosed === true);

/* ============ avgExit: scaled-in entries, FIFO order ============
 * In 50 @ 3.00 + 50 @ 4.00 (avgEntry 3.50), out 100 @ 5.00 →
 * avgExit 5.00, gross = 50×2.00 + 50×1.00 = 150. */
const scaled = calcRealTrade(
  [F("buy", 50, 3.00), F("buy", 50, 4.00), F("sell", 100, 5.00)],
  "long", null, null,
);
approx("scaled avgEntry = 3.50", scaled.avgEntry, 3.50);
approx("scaled avgExit = 5.00", scaled.avgExit, 5.00);
approx("scaled grossRealized = 150", scaled.grossRealized, 150);

/* ============ avgExit: short trade ============
 * Short: entry sell 100 @ 3.50, exit buy 100 @ 3.30 →
 * avgEntry 3.50, avgExit 3.30, gross (3.50 − 3.30) × 100 = 20. */
const short = calcRealTrade([F("sell", 100, 3.50), F("buy", 100, 3.30)], "short", null, null);
approx("short avgEntry = 3.50", short.avgEntry, 3.50);
approx("short avgExit = 3.30", short.avgExit, 3.30);
approx("short grossRealized = 20", short.grossRealized, 20);
check("short isClosed", short.isClosed === true);

/* ============ avgExit: open trade → null ============
 * Entry only: nothing has closed, so no average exit price. */
const open = calcRealTrade([F("buy", 100, 3.30)], "long", null, null);
check("open avgExit = null", open.avgExit === null);
approx("open avgEntry = 3.30", open.avgEntry, 3.30);
approx("open openQty = 100", open.openQty, 100);
approx("open grossRealized = 0", open.grossRealized, 0);
check("open isClosed = false", open.isClosed === false);

/* ============ avgExit: partial close (half out) ============
 * In 100 @ 3.30, out 50 @ 3.50 → avgExit 3.50 (matched portion only),
 * gross 50 × 0.20 = 10, 50 shares remain open. */
const half = calcRealTrade([F("buy", 100, 3.30), F("sell", 50, 3.50)], "long", null, null);
approx("half avgExit = 3.50", half.avgExit, 3.50);
approx("half grossRealized = 10", half.grossRealized, 10);
approx("half openQty = 50", half.openQty, 50);
check("half isClosed = false", half.isClosed === false);

/* ============ pre-existing outputs unchanged: fees ============
 * In 100 @ 3.30 (fees 1), out 100 @ 3.50 (fees 1) →
 * totalFees 2, net = 20 − 2 = 18. */
const withFees = calcRealTrade([F("buy", 100, 3.30, 1), F("sell", 100, 3.50, 1)], "long", null, null);
approx("fees totalFees = 2", withFees.totalFees, 2);
approx("fees netRealized = 18", withFees.netRealized, 18);
approx("fees avgExit = 3.50", withFees.avgExit, 3.50);

/* ============ validateRealFills matrix ============ */
check("valid simple long", validateRealFills("long", [F("buy", 100, 3.30), F("sell", 100, 3.50)]) === null);
check("valid open long (entry only)", validateRealFills("long", [F("buy", 100, 3.30)]) === null);
check("valid partial exit", validateRealFills("long", [F("buy", 100, 3.30), F("sell", 40, 3.50)]) === null);
check("valid short", validateRealFills("short", [F("sell", 100, 3.50), F("buy", 100, 3.30)]) === null);
check("empty fills rejected", validateRealFills("long", []) !== null);
check("zero qty rejected", validateRealFills("long", [F("buy", 0, 3.30)]) !== null);
check("zero price rejected", validateRealFills("long", [F("buy", 100, 0)]) !== null);
check("negative price rejected", validateRealFills("long", [F("buy", 100, -3.30)]) !== null);
check("negative fees rejected", validateRealFills("long", [F("buy", 100, 3.30, -1)]) !== null);
check("no entry fill (long, sells only) rejected", validateRealFills("long", [F("sell", 100, 3.50)]) !== null);
check("no entry fill (short, buys only) rejected", validateRealFills("short", [F("buy", 100, 3.30)]) !== null);
const overErr = validateRealFills("long", [F("buy", 100, 3.30), F("sell", 150, 3.50)]);
check("exit > entry rejected (long)", overErr !== null);
check("exit > entry message format", overErr === "Exit quantity (150) exceeds position size (100)");
const overErrShort = validateRealFills("short", [F("sell", 100, 3.50), F("buy", 120, 3.30)]);
check("exit > entry message format (short)", overErrShort === "Exit quantity (120) exceeds position size (100)");


/* ============ per-exit P&L: multiple entries + multiple exits ============
 * buy 100@3.00, buy 100@3.20, sell 120@3.50, sell 80@3.40.
 * Exit 1 FIFO: 100x(3.50-3.00) + 20x(3.50-3.20) = 56. Exit 2: 80x(3.40-3.20) = 16. */
{
  const fills: RealFill[] = [
    { id: "a", side: "buy", qty: 100, price: 3.00, fees: 1, fill_time: "2026-10-12T13:30:00Z" },
    { id: "b", side: "buy", qty: 100, price: 3.20, fees: 1, fill_time: "2026-10-12T13:31:00Z" },
    { id: "c", side: "sell", qty: 120, price: 3.50, fees: 1, fill_time: "2026-10-12T13:35:00Z" },
    { id: "d", side: "sell", qty: 80, price: 3.40, fees: 1, fill_time: "2026-10-12T13:40:00Z" },
  ];
  const px = perExitPnl(fills, "long");
  check("perExit: two exits reported", px.length === 2);
  approx("perExit: first exit FIFO gross = 56", px[0]?.grossPnl, 56);
  approx("perExit: second exit FIFO gross = 16", px[1]?.grossPnl, 16);
  const total = calcRealTrade(fills, "long", null, null);
  approx("perExit: reconciles with gross", (px[0]?.grossPnl ?? 0) + (px[1]?.grossPnl ?? 0), total.grossRealized);
  approx("multi in/out: fully closed", total.openQty, 0);
  approx("multi in/out: weighted avg entry", total.avgEntry, 3.10);
}
/* Short per-exit: sell 100@5.00, buy 40@4.80 (+8), buy 60@4.90 (+6) */
{
  const fills: RealFill[] = [
    { id: "a", side: "sell", qty: 100, price: 5.00, fees: 0, fill_time: "2026-10-12T13:30:00Z" },
    { id: "b", side: "buy", qty: 40, price: 4.80, fees: 0, fill_time: "2026-10-12T13:31:00Z" },
    { id: "c", side: "buy", qty: 60, price: 4.90, fees: 0, fill_time: "2026-10-12T13:32:00Z" },
  ];
  const px = perExitPnl(fills, "short");
  approx("perExit short: first exit +8", px[0]?.grossPnl, 8);
  approx("perExit short: second exit +6", px[1]?.grossPnl, 6);
}

/* ============ key levels ============ */
{
  const parsed = parseKeyLevels([
    { price: 4.2, type: "HOD / High of Day", interaction: "Breakout", notes: "  held twice " },
    { price: -1, type: "Support" },
    { price: "x", type: "Support" },
    { price: 3.9, type: "" },
    "garbage",
    { price: 3.95, type: "Support", interaction: "", notes: "" },
  ]);
  check("keyLevels: only valid entries survive", parsed.length === 2);
  check("keyLevels: notes trimmed", parsed[0]?.notes === "held twice");
  check("keyLevels: empty interaction -> null", parsed[1]?.interaction === null);
  check("keyLevels: null -> []", parseKeyLevels(null).length === 0);
  check("keyLevels: untouched row ok", validateKeyLevels([{ price: "", type: "" }]) === null);
  check("keyLevels: type without price rejected", (validateKeyLevels([{ price: "", type: "Support" }]) ?? "").includes("needs a price"));
  check("keyLevels: price without type rejected", (validateKeyLevels([{ price: "4.20", type: "" }]) ?? "").includes("needs a level type"));
  check("keyLevels: negative price rejected", (validateKeyLevels([{ price: "-2", type: "Support" }]) ?? "").includes("greater than 0"));
  check("keyLevels: valid row ok", validateKeyLevels([{ price: "4.20", type: "Support" }]) === null);
}

/* ============ plan preservation ============ */
{
  const c = computePlanUpdate(null, null, null, 3.90, 4.50, "2026-10-12T14:00:00Z");
  approx("plan: create captures original stop", c.original_stop_loss, 3.90);
  check("plan: create logs no change", c.plan_history.length === 0);
  const e1 = computePlanUpdate(null, 3.90, 4.50, 4.00, 4.50, "2026-10-13T14:00:00Z");
  approx("plan: old trade original = pre-edit stop", e1.original_stop_loss, 3.90);
  check("plan: stop change logged", e1.plan_history.length === 1);
  approx("plan: change records new value", e1.plan_history[0]?.to, 4.00);
  const e2 = computePlanUpdate(e1, 4.00, 4.50, 4.05, null, "2026-10-14T14:00:00Z");
  approx("plan: original stop is set-once", e2.original_stop_loss, 3.90);
  approx("plan: original target survives clear", e2.original_target, 4.50);
  check("plan: history appends (stop + target-clear)", e2.plan_history.length === 3);
  const n = computePlanUpdate(null, null, null, null, null, "2026-10-12T14:00:00Z");
  check("plan: no data -> null original", n.original_stop_loss === null);
}

console.log(`journalCalc tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
