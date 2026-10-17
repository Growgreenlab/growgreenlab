/**
 * drTradeEvidence.test.ts — hand-built event streams + fills for
 * lib/drTradeEvidence. Run: npx tsx lib/drTradeEvidence.test.ts
 * Every expectation is derived by hand from the fixture, mirroring
 * the recorder's event contract (lib/dailyReplayEvents.ts).
 */
import { deriveDrEvidence } from "./drTradeEvidence";
import { groupFillsIntoTrades, type RawFill } from "./journal";
import type { DrEvent, DrEventType } from "./dailyReplayEvents";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name} ${extra}`); }
}
function approx(name: string, actual: number | null, expected: number, eps = 1e-9) {
  check(`${name} (got ${actual}, want ${expected})`, actual != null && Math.abs(actual - expected) < eps);
}

const SID = "sess-1";
let seq = 0;
function ev(type: DrEventType, payload: Record<string, unknown> = {}, marketIdx = 0): DrEvent {
  seq += 1;
  return { seq, type, wallTs: 1760000000000 + seq * 1000, marketIdx, marketTs: 1760000000000 + marketIdx * 60000, payload };
}
let fillId = 0;
function fill(side: "buy" | "sell", qty: number, price: number, ci: number, realized = 0): RawFill {
  fillId += 1;
  return {
    id: `f${fillId}`, session_id: SID, side, qty, price, candle_index: ci,
    candle_time: new Date(1760000000000 + ci * 60000).toISOString(),
    realized_pnl: realized, created_at: new Date(1760000000000 + fillId * 1000).toISOString(),
  };
}
const tradesOf = (fills: RawFill[]) =>
  groupFillsIntoTrades(fills, { id: SID, ticker: "AAPL", trade_date: "2026-10-15", source: "daily_replay" });

/* ===== 1. Clean trade: snapshot basis, R = 100/50 = 2 ===== */
seq = 0;
{
  const fills = [fill("buy", 100, 10, 5), fill("sell", 100, 11, 9, 100)];
  const trades = tradesOf(fills);
  const events: DrEvent[] = [
    ev("attempt_created"), ev("session_started"),
    ev("bracket_set", { scope: "planned", stopLoss: 9.5, takeProfit: 11, method: "typed" }),
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("position_changed", { qtyAfter: 100, avgPrice: 10 }, 5),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "manual", unrealizedPnl: 0 }, 9),
  ];
  const out = deriveDrEvidence({ attemptId: "att-1", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  check("1 trade evidenced", !!e);
  approx("1 originalStopLoss", e.originalStopLoss, 9.5);
  approx("1 originalTarget", e.originalTarget, 11);
  approx("1 initialRisk", e.initialRisk, 50);
  approx("1 R = 2", e.rMultiple, 2);
  check("1 planHistory empty (planned application is not a change)", e.planHistory.length === 0);
  check("1 no adds", e.addedAfterEntry === false);
  check("1 event assignment: fill events -> trade", out.eventTradeKey.get(events[3].seq) === trades[0].tradeKey);
  check("1 event assignment: lifecycle events unassigned", out.eventTradeKey.get(events[0].seq) === null);
  check("1 cyclesFound = 1", out.cyclesFound === 1);
  check("1 not resumed", out.resumed === false);
}

/* ===== 2. Moved stop: history records it; R stays on snapshot basis ===== */
seq = 0;
{
  const fills = [fill("buy", 100, 10, 5), fill("sell", 100, 10.4, 9, 40)];
  const trades = tradesOf(fills);
  const events: DrEvent[] = [
    ev("session_started"),
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("bracket_set", { scope: "active", stopLoss: 9.5, takeProfit: 11, method: "typed" }, 6),
    ev("bracket_modified", { scope: "active", field: "stopLoss", prev: 9.5, next: 9.8, method: "typed", classification: "tightened", timesMoved: 1 }, 7),
    ev("order_filled", { side: "sell", qty: 100, price: 10.4, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 10.4, realizedPnl: 40, sessionRealized: 40, reason: "stop", unrealizedPnl: 0 }, 9),
  ];
  const out = deriveDrEvidence({ attemptId: "att-2", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  check("2 planHistory holds exactly the modification (entry bracket_set skipped)",
    e.planHistory.length === 1 && e.planHistory[0].field === "stop_loss" && e.planHistory[0].from === 9.5 && e.planHistory[0].to === 9.8,
    JSON.stringify(e.planHistory));
  approx("2 final stopLoss = 9.8", e.stopLoss, 9.8);
  approx("2 R still snapshot-based = 40/50", e.rMultiple, 0.8);
}

/* ===== 3. Partial exits: realized sums across partial + close ===== */
seq = 0;
{
  const fills = [fill("buy", 100, 10, 5), fill("sell", 40, 11, 8, 40), fill("sell", 60, 11, 9, 60)];
  const trades = tradesOf(fills);
  check("3 grouped into ONE trade", trades.length === 1 && trades[0].realizedPnl === 100);
  const events: DrEvent[] = [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("order_filled", { side: "sell", qty: 40, price: 11, candleIndex: 8 }, 8),
    ev("partial_exit", { qty: 40, price: 11, realizedPnl: 40, qtyAfter: 60, sessionRealized: 40 }, 8),
    ev("order_filled", { side: "sell", qty: 60, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 60, price: 11, realizedPnl: 60, sessionRealized: 100, reason: "target", unrealizedPnl: 0 }, 9),
  ];
  const out = deriveDrEvidence({ attemptId: "att-3", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  approx("3 R = 100/50 = 2 across partials", e.rMultiple, 2);
}

/* ===== 4. Add after entry: first-fill basis disclosed, never rescaled ===== */
seq = 0;
{
  const fills = [fill("buy", 50, 10, 5), fill("buy", 50, 10.2, 6), fill("sell", 100, 11, 9, 90)];
  const trades = tradesOf(fills);
  const events: DrEvent[] = [
    ev("order_filled", { side: "buy", qty: 50, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 50, stopLoss: 9.5, takeProfit: 11, plannedRisk: 25, rewardRisk: 2 }, 5),
    ev("position_changed", { qtyAfter: 50, avgPrice: 10 }, 5),
    ev("order_filled", { side: "buy", qty: 50, price: 10.2, candleIndex: 6 }, 6),
    ev("position_changed", { qtyAfter: 100, avgPrice: 10.1 }, 6),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 90, sessionRealized: 90, reason: "manual", unrealizedPnl: 0 }, 9),
  ];
  const out = deriveDrEvidence({ attemptId: "att-4", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  check("4 addedAfterEntry detected", e.addedAfterEntry === true);
  approx("4 initialRisk stays first-fill 25", e.initialRisk, 25);
  approx("4 R = 90/25 = 3.6", e.rMultiple, 3.6);
  check("4 basis discloses the first-fill basis", e.riskBasis.includes("first-fill") && e.riskBasis.includes("not rescaled"));
}

/* ===== 5. Missing snapshot: honest nulls ===== */
seq = 0;
{
  const fills = [fill("buy", 100, 10, 5), fill("sell", 100, 11, 9, 100)];
  const trades = tradesOf(fills);
  const events: DrEvent[] = [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "manual", unrealizedPnl: 0 }, 9),
  ];
  const out = deriveDrEvidence({ attemptId: "att-5", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  check("5 hasSnapshot false", e.hasSnapshot === false);
  check("5 all plan fields null", e.originalStopLoss === null && e.originalTarget === null && e.initialRisk === null && e.rMultiple === null);
  check("5 basis explains", e.riskBasis.includes("no risk snapshot"));
}

/* ===== 6. Snapshot without a stop: target known, R unavailable ===== */
seq = 0;
{
  const fills = [fill("buy", 100, 10, 5), fill("sell", 100, 11, 9, 100)];
  const trades = tradesOf(fills);
  const events: DrEvent[] = [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: null, takeProfit: 11, plannedRisk: null, rewardRisk: null }, 5),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "manual", unrealizedPnl: 0 }, 9),
  ];
  const out = deriveDrEvidence({ attemptId: "att-6", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  approx("6 originalTarget preserved", e.originalTarget, 11);
  check("6 R null (no stop in force)", e.rMultiple === null && e.initialRisk === null);
  check("6 basis explains", e.riskBasis.includes("no stop loss was in force"));
}

/* ===== 7. Open cycle at completion: closed trade evidenced, open cycle unassigned ===== */
seq = 0;
{
  const fills = [fill("buy", 100, 10, 5), fill("sell", 100, 11, 9, 100), fill("buy", 50, 12, 20)];
  const trades = tradesOf(fills);
  check("7 open trailing cycle excluded from trades", trades.length === 1);
  const events: DrEvent[] = [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "manual", unrealizedPnl: 0 }, 9),
    ev("order_filled", { side: "buy", qty: 50, price: 12, candleIndex: 20 }, 20),
    ev("risk_snapshot", { entry: 12, qty: 50, stopLoss: 11.5, takeProfit: 13, plannedRisk: 25, rewardRisk: 2 }, 20),
    ev("session_completed", {}, 25),
  ];
  const out = deriveDrEvidence({ attemptId: "att-7", trades, events });
  check("7 cyclesFound = 2", out.cyclesFound === 2);
  approx("7 closed trade R = 2", out.byTradeKey.get(trades[0].tradeKey)!.rMultiple, 2);
  check("7 open-cycle events unassigned", out.eventTradeKey.get(events[4].seq) === null && out.eventTradeKey.get(events[5].seq) === null);
}

/* ===== 8. Zero-trade attempt ===== */
seq = 0;
{
  const events: DrEvent[] = [ev("attempt_created"), ev("session_started"), ev("session_completed")];
  const out = deriveDrEvidence({ attemptId: "att-8", trades: [], events });
  check("8 no trades, no evidence, no crash", out.byTradeKey.size === 0 && out.cyclesFound === 0);
}

/* ===== 9. Misaligned events: refuse to attach evidence ===== */
seq = 0;
{
  const fills = [fill("buy", 100, 10, 5), fill("sell", 100, 11, 9, 100)];
  const trades = tradesOf(fills);
  const events: DrEvent[] = [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 55, sessionRealized: 55, reason: "manual", unrealizedPnl: 0 }, 9),
  ];
  const out = deriveDrEvidence({ attemptId: "att-9", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  check("9 mismatched realized -> evidence withheld", e.rMultiple === null && e.hasSnapshot === false);
  check("9 basis explains", e.riskBasis.includes("do not reconcile"));
  check("9 events unassigned", out.eventTradeKey.get(events[1].seq) === null);
}

/* ===== 10. Mid-trade bracket_set change + resumed flag ===== */
seq = 0;
{
  const fills = [fill("buy", 100, 10, 5), fill("sell", 100, 10.5, 12, 50)];
  const trades = tradesOf(fills);
  const events: DrEvent[] = [
    ev("session_resumed", { revealedThrough: 4 }, 4),
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("bracket_set", { scope: "active", stopLoss: 9.5, takeProfit: 12, method: "drag" }, 8),
    ev("order_filled", { side: "sell", qty: 100, price: 10.5, candleIndex: 12 }, 12),
    ev("position_closed", { qty: 100, price: 10.5, realizedPnl: 50, sessionRealized: 50, reason: "manual", unrealizedPnl: 0 }, 12),
  ];
  const out = deriveDrEvidence({ attemptId: "att-10", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  check("10 resumed detected", out.resumed === true);
  check("10 bracket_set change becomes one target history entry",
    e.planHistory.length === 1 && e.planHistory[0].field === "target" && e.planHistory[0].from === 11 && e.planHistory[0].to === 12,
    JSON.stringify(e.planHistory));
  approx("10 final target = 12", e.target, 12);
  approx("10 final stop unchanged = 9.5", e.stopLoss, 9.5);
}

/* ===== 11. Post-reset stream: evidence attaches to the POST-reset trade only =====
 * session_trades contain only post-reset fills, so the grouped trades
 * passed in are built from the post-reset fills alone. The pre-reset
 * closed cycle has no journal counterpart and must not shift pairing. */
seq = 0;
{
  const fills = [fill("buy", 100, 12, 20), fill("sell", 100, 13, 24, 100)];
  const trades = tradesOf(fills);
  check("11 grouped trades = post-reset only", trades.length === 1 && trades[0].tradeKey === `${SID}:1`);
  const events: DrEvent[] = [
    ev("session_started"),
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "manual", unrealizedPnl: 0 }, 9),
    ev("session_reset"),
    ev("order_filled", { side: "buy", qty: 100, price: 12, candleIndex: 20 }, 20),
    ev("risk_snapshot", { entry: 12, qty: 100, stopLoss: 11, takeProfit: 14, plannedRisk: 100, rewardRisk: 2 }, 20),
    ev("order_filled", { side: "sell", qty: 100, price: 13, candleIndex: 24 }, 24),
    ev("position_closed", { qty: 100, price: 13, realizedPnl: 100, sessionRealized: 100, reason: "manual", unrealizedPnl: 0 }, 24),
  ];
  const out = deriveDrEvidence({ attemptId: "att-11", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  check("11 only the post-reset trade gets an entry", out.byTradeKey.size === 1);
  approx("11 post-reset originalStopLoss = 11 (not the pre-reset 9.5)", e.originalStopLoss, 11);
  approx("11 post-reset initialRisk = 100", e.initialRisk, 100);
  approx("11 post-reset R = 100/100 = 1", e.rMultiple, 1);
  check("11 hasSnapshot true via the verified post-reset pair", e.hasSnapshot === true);
  check("11 cyclesFound = final-generation closed cycles = 1", out.cyclesFound === 1, `got ${out.cyclesFound}`);
  check("11 post-reset events assigned to the trade",
    out.eventTradeKey.get(events[6].seq) === trades[0].tradeKey && out.eventTradeKey.get(events[9].seq) === trades[0].tradeKey);
  check("11 pre-reset cycle events unassigned (no trade exists for them)",
    out.eventTradeKey.get(events[1].seq) === null && out.eventTradeKey.get(events[2].seq) === null && out.eventTradeKey.get(events[4].seq) === null);
}

/* ===== 12. Cycle open at reset is discarded; the post-reset cycle pairs ===== */
seq = 0;
{
  const fills = [fill("buy", 50, 12, 20), fill("sell", 50, 12.5, 22, 25)];
  const trades = tradesOf(fills);
  const events: DrEvent[] = [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("session_reset"),
    ev("order_filled", { side: "buy", qty: 50, price: 12, candleIndex: 20 }, 20),
    ev("risk_snapshot", { entry: 12, qty: 50, stopLoss: 11.5, takeProfit: 13, plannedRisk: 25, rewardRisk: 2 }, 20),
    ev("order_filled", { side: "sell", qty: 50, price: 12.5, candleIndex: 22 }, 22),
    ev("position_closed", { qty: 50, price: 12.5, realizedPnl: 25, sessionRealized: 25, reason: "manual", unrealizedPnl: 0 }, 22),
  ];
  const out = deriveDrEvidence({ attemptId: "att-12", trades, events });
  const e = out.byTradeKey.get(trades[0].tradeKey)!;
  approx("12 R = 25/25 = 1 from the post-reset cycle", e.rMultiple, 1);
  check("12 cyclesFound = 1 (discarded open cycle never counts)", out.cyclesFound === 1, `got ${out.cyclesFound}`);
  check("12 discarded cycle's events unassigned",
    out.eventTradeKey.get(events[0].seq) === null && out.eventTradeKey.get(events[1].seq) === null);
}

console.log(`=== drTradeEvidence RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
