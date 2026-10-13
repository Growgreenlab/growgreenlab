/**
 * Buy-order execution regression suite (2026-10-13 incident: "Buy did
 * nothing"). Covers the required matrix against ReplayEngine:
 * valid market buys in every replay state, invalid quantity and
 * insufficient buying power, limit execution, position/avg/cash/P&L
 * updates, SL/TP + partial exits, guard semantics, and the
 * no-look-ahead rule (fills price off the LIVE forming candle only,
 * never a future candle).
 */
import { ReplayEngine } from "./engine";
import type { Candle } from "./types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}
function approx(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

/** Uptrend candles 2.00 -> ~3.19, distinct prices per candle. */
function uptrend(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 2 + i * 0.01;
    return { t: i * 60000, o: base, h: base + 0.05, l: base - 0.04, c: base + 0.02, v: 10_000 };
  });
}

// 1. Valid market buy before any tick: position, avg, cash, P&L update.
{
  const eng = new ReplayEngine(uptrend(120), 100_000, 0);
  const cashBefore = eng.cash;
  const f = eng.buy(100);
  check("market buy fills", !!f);
  check("position qty", eng.positionQty === 100);
  check("avg equals fill price", f != null && approx(eng.positionAvg, f.price));
  check("cash reduced by cost", f != null && approx(eng.cash, cashBefore - 100 * f.price));
  check("unrealized pnl ~0 at fill", Math.abs(eng.unrealizedPnl()) < 1.0, `u=${eng.unrealizedPnl()}`);
  check("fill recorded in ledger", eng.fills.length === 1 && eng.fills[0].side === "buy");
}

// 2. Buy mid-formation and after whole steps.
{
  const eng = new ReplayEngine(uptrend(120), 100_000, 0);
  for (let i = 0; i < 50; i++) eng.tick();
  check("buy mid-formation fills", !!eng.buy(200) && eng.positionQty === 200);
  const eng2 = new ReplayEngine(uptrend(120), 100_000, 0);
  eng2.step(); eng2.step();
  check("buy after steps fills", !!eng2.buy(50) && eng2.positionQty === 50);
}

// 3. Invalid quantity + insufficient buying power reject without a fill.
{
  const eng = new ReplayEngine(uptrend(120), 1_000, 0);
  check("qty 0 rejected", eng.buy(0) === null);
  check("negative qty rejected", eng.buy(-5) === null);
  check("fractional qty floors then rejects", eng.buy(0.5) === null);
  check("insufficient cash rejected", eng.buy(1_000_000) === null);
  check("no position after rejections", eng.positionQty === 0 && eng.fills.length === 0);
  check("valid small buy still works after rejections", !!eng.buy(10));
}

// 4. No look-ahead: the fill prices off the live forming candle only.
{
  const cs = uptrend(120);
  const eng = new ReplayEngine(cs, 100_000, 0);
  for (let i = 0; i < 30; i++) eng.tick(); // inside candle index 0's formation (startIndex 0)
  const livePrice = eng.displayPrice;
  const f = eng.buy(100);
  check("fill price equals live display price", f != null && approx(f.price, livePrice), `f=${f?.price} live=${livePrice}`);
  check("fill candle index is the forming candle", f != null && f.candleIndex === eng.index + 1, `idx=${f?.candleIndex} eng.index=${eng.index}`);
  // The forming candle is cs[eng.index + 1]; the fill must sit inside its
  // true range, not any later candle's.
  const forming = cs[eng.index + 1];
  check("fill inside forming candle range", f != null && f.price >= forming.l - 1e-9 && f.price <= forming.h + 1e-9);
}

// 5. Limit buy: rests, then fills on touch — never before.
{
  const eng = new ReplayEngine(uptrend(120), 100_000, 0);
  const px = eng.displayPrice;
  check("limit above market accepted", eng.placeLimitOrder("buy", 100, px + 1) === null);
  check("working order listed", eng.pendingOrders.length === 1);
  for (let i = 0; i < 400 && eng.positionQty === 0; i++) eng.tick();
  check("limit filled on tick touch", eng.positionQty === 100);
  check("limit fill noted", eng.fills.some((x) => (x.note ?? "").startsWith("limit")));
  // A limit far below the path never fills while price runs away upward.
  const eng2 = new ReplayEngine(uptrend(120), 100_000, 0);
  eng2.placeLimitOrder("buy", 100, 0.5);
  for (let i = 0; i < 720; i++) eng2.tick(); // two full candles up
  check("unreachable limit never fills", eng2.positionQty === 0 && eng2.pendingOrders.length === 1);
}

// 6. SL/TP brackets + partial exit accounting.
{
  const cs = uptrend(120);
  for (let i = 11; i < cs.length; i++) cs[i] = { ...cs[i], o: 1.5, h: 1.55, l: 1.4, c: 1.45 }; // cliff
  const eng = new ReplayEngine(cs, 100_000, 0);
  eng.buy(100);
  eng.setBrackets(1.9, null);
  for (let i = 0; i < 20 && eng.positionQty > 0; i++) eng.step();
  check("stop-loss closes position", eng.positionQty === 0);
  check("stop-loss realizes a loss", eng.realizedPnl < 0, `pnl=${eng.realizedPnl}`);

  const eng2 = new ReplayEngine(uptrend(120), 100_000, 0);
  eng2.buy(100);
  const s = eng2.sell(40);
  check("partial sell fills", !!s);
  check("partial leaves 60", eng2.positionQty === 60);
  check("avg unchanged by partial", approx(eng2.positionAvg, eng2.fills[0].price));
}

// 7. Guard (Psychology Guard lockout) blocks entries, never exits.
{
  const eng = new ReplayEngine(uptrend(120), 100_000, 0);
  eng.tradeGuard = () => "locked";
  check("guard blocks market buy", eng.buy(100) === null && eng.positionQty === 0);
  check("guard blocks limit buy", (eng.placeLimitOrder("buy", 100, 2) ?? "").length > 0);
  eng.tradeGuard = null;
  check("buy works once guard clears", !!eng.buy(100));
  eng.tradeGuard = () => "locked";
  check("guard never blocks sells", !!eng.sell(100) && eng.positionQty === 0);
}

// 8. Repeated clicks: second buy adds (no phantom dupes, no lost fills).
{
  const eng = new ReplayEngine(uptrend(120), 100_000, 0);
  eng.buy(100);
  eng.buy(100);
  check("two buys = 200 shares, 2 fills", eng.positionQty === 200 && eng.fills.length === 2);
  const eng2 = new ReplayEngine(uptrend(120), 250, 0); // ~$2/share: only one 100-lot affordable
  eng2.buy(100);
  check("second unaffordable buy rejected cleanly", eng2.buy(100) === null && eng2.positionQty === 100);
}

console.log(`\nbuyExecution: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
