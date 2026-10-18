/**
 * drDrafts.test.ts — synthetic event streams for lib/drDrafts.
 * Run: npx tsx lib/drDrafts.test.ts
 * Fixtures mirror the recorder's event contract
 * (lib/dailyReplayEvents.ts): per sell fill the recorder emits
 * order_filled then partial_exit | position_closed.
 */
import {
  buildDraftPayload,
  computeDrExclusions,
  draftKeyFor,
  draftListCounts,
  draftsForAttempt,
  latestClosedCycle,
  mapDraftRow,
  reconcileDrafts,
  type DrDraftRow,
} from "./drDrafts";
import { splitCyclesByGeneration } from "./drTradeEvidence";
import { groupFillsIntoTrades, type GroupedTrade, type RawFill } from "./journal";
import type { DrEvent, DrEventType } from "./dailyReplayEvents";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name} ${extra}`); }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
    JSON.stringify(actual) === JSON.stringify(expected));
}

const ATT = "att-1";
const SID = "sess-1";
let seq = 0;
function ev(type: DrEventType, payload: Record<string, unknown> = {}, marketIdx: number | null = null): DrEvent {
  seq += 1;
  return {
    seq, type,
    wallTs: 1760000000000 + seq * 1000,
    marketIdx,
    marketTs: marketIdx == null ? null : 1760000000000 + marketIdx * 60000,
    payload,
  };
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
const tradesOf = (fills: RawFill[]): GroupedTrade[] =>
  groupFillsIntoTrades(fills, { id: SID, ticker: "AAPL", trade_date: "2026-10-15", source: "daily_replay" });

/** One clean cycle: buy 100@10 (c5) → snapshot → sell 100@11 (c9), +100. */
function cleanCycleEvents(): DrEvent[] {
  return [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("position_changed", { qtyAfter: 100, avgPrice: 10 }, 5),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "manual", unrealizedPnl: 0 }, 9),
  ];
}
function draftRow(partial: Partial<DrDraftRow>): DrDraftRow {
  return {
    id: "d-1", userId: "u-1", attemptId: ATT, resetGeneration: 0, cycleIndex: 1,
    draftKey: draftKeyFor(ATT, 0, 1), status: "draft",
    firstFillCandleIndex: 5, firstFillPrice: 10, firstFillQty: 100,
    closeFillCandleIndex: 9, realizedPnl: 100, eventFirstSeq: 1, eventLastSeq: 5,
    autoCapture: {}, finalizedSessionId: null, finalizedTradeKey: null,
    finalizedAt: null, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z",
    ...partial,
  };
}

/* ===== 1. Clean single cycle → one draft payload ===== */
seq = 0;
{
  const events = cleanCycleEvents();
  const payloads = draftsForAttempt(ATT, events);
  eq("1 exactly one payload", payloads.length, 1);
  const p = payloads[0];
  eq("1 draft_key format", p.draft_key, `dr:${ATT}:g0:c1`);
  eq("1 draftKeyFor matches", draftKeyFor(ATT, 0, 1), p.draft_key);
  eq("1 attempt/generation/cycle", [p.attempt_id, p.reset_generation, p.cycle_index], [ATT, 0, 1]);
  eq("1 first-fill anchors", [p.first_fill_candle_index, p.first_fill_price, p.first_fill_qty], [5, 10, 100]);
  eq("1 close-fill candle", p.close_fill_candle_index, 9);
  eq("1 seq range = first fill .. position_closed", [p.event_first_seq, p.event_last_seq], [events[0].seq, events[4].seq]);
  eq("1 realized = position_closed realizedPnl", p.realized_pnl, 100);
  eq("1 status draft", p.status, "draft");
}

/* ===== 2. Partial exit: no draft at partial, exactly one at close ===== */
seq = 0;
{
  const partialEvents: DrEvent[] = [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("order_filled", { side: "sell", qty: 40, price: 11, candleIndex: 8 }, 8),
    ev("partial_exit", { qty: 40, price: 11, realizedPnl: 40, qtyAfter: 60, sessionRealized: 40 }, 8),
  ];
  eq("2 no payload at partial exit", draftsForAttempt(ATT, partialEvents).length, 0);
  check("2 latestClosedCycle null before close", latestClosedCycle(partialEvents) === null);
  const full = [
    ...partialEvents,
    ev("order_filled", { side: "sell", qty: 60, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 60, price: 11, realizedPnl: 60, sessionRealized: 100, reason: "target", unrealizedPnl: 0 }, 9),
  ];
  const payloads = draftsForAttempt(ATT, full);
  eq("2 exactly one payload at close", payloads.length, 1);
  eq("2 realized = partial + close", payloads[0].realized_pnl, 100);
}

/* ===== 3. Add-on buys: single draft, aggregation = groupFillsIntoTrades ===== */
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
  const payloads = draftsForAttempt(ATT, events);
  eq("3 add-ons produce a single draft", payloads.length, 1);
  eq("3 grouped trades also single", trades.length, 1);
  eq("3 draft realized equals grouped realizedPnl", payloads[0].realized_pnl, trades[0].realizedPnl);
  eq("3 first-fill anchors are the FIRST buy", [payloads[0].first_fill_price, payloads[0].first_fill_qty], [10, 50]);
}

/* ===== 4. Two cycles, same generation → distinct c1/c2 keys ===== */
seq = 0;
{
  const events = [...cleanCycleEvents(), ...cleanCycleEvents()];
  const payloads = draftsForAttempt(ATT, events);
  eq("4 two payloads", payloads.length, 2);
  eq("4 keys", payloads.map((p) => p.draft_key), [`dr:${ATT}:g0:c1`, `dr:${ATT}:g0:c2`]);
  check("4 keys distinct", payloads[0].draft_key !== payloads[1].draft_key);
  eq("4 latestClosedCycle is cycle 2", latestClosedCycle(events)?.cycleIndex, 2);
}

/* ===== 5. Reset BEFORE any fill → next cycle is g1:c1 ===== */
seq = 0;
{
  const events = [ev("attempt_created"), ev("session_reset"), ...cleanCycleEvents()];
  const payloads = draftsForAttempt(ATT, events);
  eq("5 one payload", payloads.length, 1);
  eq("5 key is g1:c1", payloads[0].draft_key, `dr:${ATT}:g1:c1`);
  eq("5 status draft (final generation)", payloads[0].status, "draft");
  const split = splitCyclesByGeneration(events);
  eq("5 resetCount/lastGeneration = 1", [split.resetCount, split.lastGeneration], [1, 1]);
}

/* ===== 6. Reset AFTER a closed cycle → first superseded, second g1:c1 ===== */
seq = 0;
{
  const events = [...cleanCycleEvents(), ev("session_reset"), ...cleanCycleEvents()];
  const payloads = draftsForAttempt(ATT, events);
  eq("6 two payloads", payloads.length, 2);
  eq("6 first is superseded g0:c1", [payloads[0].draft_key, payloads[0].status], [`dr:${ATT}:g0:c1`, "superseded"]);
  eq("6 second is draft g1:c1", [payloads[1].draft_key, payloads[1].status], [`dr:${ATT}:g1:c1`, "draft"]);
  check("6 keys never collide", payloads[0].draft_key !== payloads[1].draft_key);
}

/* ===== 7. Repeated resets (×2) → generations 0/1/2, only final is draft ===== */
seq = 0;
{
  const events = [
    ...cleanCycleEvents(), ev("session_reset"),
    ...cleanCycleEvents(), ev("session_reset"),
    ...cleanCycleEvents(),
  ];
  const payloads = draftsForAttempt(ATT, events);
  eq("7 three payloads", payloads.length, 3);
  eq("7 generations", payloads.map((p) => p.reset_generation), [0, 1, 2]);
  eq("7 statuses", payloads.map((p) => p.status), ["superseded", "superseded", "draft"]);
  eq("7 keys", payloads.map((p) => p.draft_key),
    [`dr:${ATT}:g0:c1`, `dr:${ATT}:g1:c1`, `dr:${ATT}:g2:c1`]);
}

/* ===== 8. Cycle open at reset → discarded, no payload ===== */
seq = 0;
{
  const events = [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("session_reset"),
    ...cleanCycleEvents(),
  ];
  const payloads = draftsForAttempt(ATT, events);
  eq("8 open-at-reset cycle yields no payload", payloads.length, 1);
  eq("8 surviving payload is the post-reset g1:c1", payloads[0].draft_key, `dr:${ATT}:g1:c1`);
  const openOnly = events.slice(0, 3);
  eq("8 stream ending in reset after an open buy → zero payloads", draftsForAttempt(ATT, openOnly).length, 0);
}

/* ===== 9. Writer idempotency inputs: same events → deep-equal payloads ===== */
seq = 0;
{
  const events = [...cleanCycleEvents(), ev("session_reset"), ...cleanCycleEvents()];
  const a = draftsForAttempt(ATT, events);
  const b = draftsForAttempt(ATT, events);
  eq("9 draftsForAttempt twice is deep-equal", a, b);
  const cycle = latestClosedCycle(events)!;
  const { lastGeneration } = splitCyclesByGeneration(events);
  eq("9 buildDraftPayload is deterministic",
    buildDraftPayload(ATT, cycle, lastGeneration), buildDraftPayload(ATT, cycle, lastGeneration));
}

/* ===== 10. Timeline slice: seq range covers exactly the cycle's events ===== */
seq = 0;
{
  const events: DrEvent[] = [
    ev("session_started"),
    ev("bracket_set", { scope: "planned", stopLoss: 9.5, takeProfit: 11, method: "typed" }),
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("bracket_set", { scope: "active", stopLoss: 9.5, takeProfit: 11, method: "typed" }, 6),
    ev("bracket_modified", { scope: "active", field: "stopLoss", prev: 9.5, next: 9.8, method: "typed", classification: "tightened", timesMoved: 1 }, 7),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "manual", unrealizedPnl: 0 }, 9),
    ev("session_completed", {}, 25),
  ];
  const p = draftsForAttempt(ATT, events)[0];
  const cycle = latestClosedCycle(events)!;
  const slice = events.filter((e) => e.seq >= p.event_first_seq && e.seq <= p.event_last_seq);
  eq("10 slice seqs equal the cycle's event seqs", slice.map((e) => e.seq), cycle.events.map((e) => e.seq));
  check("10 slice contains the risk_snapshot", slice.some((e) => e.type === "risk_snapshot"));
  check("10 slice contains the bracket events", slice.some((e) => e.type === "bracket_set" && e.payload.scope === "active") && slice.some((e) => e.type === "bracket_modified"));
  check("10 slice excludes pre-cycle and post-close events",
    !slice.some((e) => e.type === "session_started") && !slice.some((e) => e.type === "session_completed"));
}

/* ===== 11. computeDrExclusions ===== */
{
  const trade = { tradeKey: `${SID}:1`, attemptId: ATT };
  const noResets = new Map<string, number>();
  check("11 finalized draft → trade included",
    !computeDrExclusions({ trades: [trade], drafts: [draftRow({ status: "finalized" })], resetCounts: noResets }).has(trade.tradeKey));
  check("11 draft → trade excluded",
    computeDrExclusions({ trades: [trade], drafts: [draftRow({ status: "draft" })], resetCounts: noResets }).has(trade.tradeKey));
  check("11 no draft → trade included",
    !computeDrExclusions({ trades: [trade], drafts: [], resetCounts: noResets }).has(trade.tradeKey));
  check("11 draft matched via finalizedTradeKey (draft) → excluded",
    computeDrExclusions({
      trades: [trade],
      drafts: [draftRow({ status: "draft", resetGeneration: 7, cycleIndex: 9, finalizedTradeKey: trade.tradeKey })],
      resetCounts: noResets,
    }).has(trade.tradeKey));
  check("11 draft matched via finalizedTradeKey (finalized) → included",
    !computeDrExclusions({
      trades: [trade],
      drafts: [draftRow({ status: "finalized", finalizedTradeKey: trade.tradeKey })],
      resetCounts: noResets,
    }).has(trade.tradeKey));
  check("11 superseded earlier-gen draft does NOT exclude final-gen trade with same cycleIndex",
    !computeDrExclusions({
      trades: [trade],
      drafts: [draftRow({ status: "superseded", resetGeneration: 0, cycleIndex: 1 })],
      resetCounts: new Map([[ATT, 1]]),
    }).has(trade.tradeKey));
  check("11 trade without attemptId is never excluded",
    !computeDrExclusions({
      trades: [{ tradeKey: `${SID}:1`, attemptId: null }],
      drafts: [draftRow({ status: "draft" })],
      resetCounts: noResets,
    }).has(`${SID}:1`));
}

/* ===== 12. reconcileDrafts ===== */
seq = 0;
{
  const events = cleanCycleEvents();
  const trades = tradesOf([fill("buy", 100, 10, 5), fill("sell", 100, 11, 9, 100)]);
  const existing = draftRow({ id: "d-existing" });

  const plan = reconcileDrafts({ attemptId: ATT, sessionId: SID, events, trades, drafts: [existing], allowCreate: true });
  eq("12 verified pair → one mapping", plan.mappings.length, 1);
  eq("12 mapping targets the existing draft",
    [plan.mappings[0].draftId, plan.mappings[0].draftKey, plan.mappings[0].finalizedSessionId, plan.mappings[0].finalizedTradeKey],
    ["d-existing", existing.draftKey, SID, trades[0].tradeKey]);
  eq("12 verified pair → no creates, no supersedes", [plan.creates.length, plan.supersedeDraftIds.length], [0, 0]);

  // Tampered fills: buy price in the journal fills disagrees with the event stream.
  const tampered = tradesOf([fill("buy", 100, 10.5, 5), fill("sell", 100, 11, 9, 50)]);
  const planT = reconcileDrafts({ attemptId: ATT, sessionId: SID, events, trades: tampered, drafts: [existing], allowCreate: true });
  eq("12 tampered fills → NO mapping, NO create", [planT.mappings.length, planT.creates.length], [0, 0]);
  const planT2 = reconcileDrafts({ attemptId: ATT, sessionId: SID, events, trades: tampered, drafts: [], allowCreate: true });
  eq("12 tampered fills with no draft → still nothing created", [planT2.mappings.length, planT2.creates.length], [0, 0]);

  const planC = reconcileDrafts({ attemptId: ATT, sessionId: SID, events, trades, drafts: [], allowCreate: true });
  eq("12 missing draft + allowCreate → one create", planC.creates.length, 1);
  eq("12 create payload is a plain draft with the right key",
    [planC.creates[0].draft_key, planC.creates[0].status], [`dr:${ATT}:g0:c1`, "draft"]);
  eq("12 create also yields a mapping keyed by draftKey (draftId empty until insert)",
    [planC.mappings.length, planC.mappings[0].draftId, planC.mappings[0].draftKey, planC.mappings[0].finalizedTradeKey],
    [1, "", `dr:${ATT}:g0:c1`, trades[0].tradeKey]);

  const planN = reconcileDrafts({ attemptId: ATT, sessionId: SID, events, trades, drafts: [], allowCreate: false });
  eq("12 allowCreate=false → no create, no mapping", [planN.creates.length, planN.mappings.length], [0, 0]);
}

/* ===== 12b. reconcileDrafts: supersede + idempotent re-run ===== */
seq = 0;
{
  // Stream: cycle closed in g0, reset, cycle closed in g1 (different prices).
  const events: DrEvent[] = [
    ev("order_filled", { side: "buy", qty: 100, price: 10, candleIndex: 5 }, 5),
    ev("risk_snapshot", { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 }, 5),
    ev("order_filled", { side: "sell", qty: 100, price: 11, candleIndex: 9 }, 9),
    ev("position_closed", { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "manual", unrealizedPnl: 0 }, 9),
    ev("session_reset"),
    ev("order_filled", { side: "buy", qty: 100, price: 12, candleIndex: 20 }, 20),
    ev("risk_snapshot", { entry: 12, qty: 100, stopLoss: 11, takeProfit: 14, plannedRisk: 100, rewardRisk: 2 }, 20),
    ev("order_filled", { side: "sell", qty: 100, price: 13, candleIndex: 24 }, 24),
    ev("position_closed", { qty: 100, price: 13, realizedPnl: 100, sessionRealized: 200, reason: "manual", unrealizedPnl: 0 }, 24),
  ];
  // session_trades carry only the post-reset fills.
  const trades = tradesOf([fill("buy", 100, 12, 20), fill("sell", 100, 13, 24, 100)]);
  const gen0Draft = draftRow({ id: "d-gen0", resetGeneration: 0, draftKey: draftKeyFor(ATT, 0, 1), status: "draft" });
  const gen1Draft = draftRow({
    id: "d-gen1", resetGeneration: 1, draftKey: draftKeyFor(ATT, 1, 1),
    firstFillCandleIndex: 20, firstFillPrice: 12, closeFillCandleIndex: 24, status: "draft",
  });
  const plan = reconcileDrafts({ attemptId: ATT, sessionId: SID, events, trades, drafts: [gen0Draft, gen1Draft], allowCreate: true });
  eq("12b final-gen pair maps to the g1 draft", plan.mappings.map((m) => m.draftId), ["d-gen1"]);
  eq("12b earlier-gen draft listed for supersede", plan.supersedeDraftIds, ["d-gen0"]);
  eq("12b no creates", plan.creates.length, 0);

  // Post-state: g1 mapped, g0 superseded → re-run is an empty plan.
  const post = reconcileDrafts({
    attemptId: ATT, sessionId: SID, events, trades,
    drafts: [
      draftRow({ id: "d-gen0", resetGeneration: 0, draftKey: draftKeyFor(ATT, 0, 1), status: "superseded" }),
      draftRow({
        id: "d-gen1", resetGeneration: 1, draftKey: draftKeyFor(ATT, 1, 1), status: "draft",
        finalizedSessionId: SID, finalizedTradeKey: trades[0].tradeKey,
      }),
    ],
    allowCreate: true,
  });
  eq("12b second run over post-state → empty plan",
    [post.mappings.length, post.creates.length, post.supersedeDraftIds.length], [0, 0, 0]);
}

/* ===== 13. mapDraftRow: snake_case → camelCase ===== */
{
  const row = mapDraftRow({
    id: "d-9", user_id: "u-9", attempt_id: ATT, reset_generation: 2, cycle_index: 3,
    draft_key: `dr:${ATT}:g2:c3`, status: "finalized",
    first_fill_candle_index: 5, first_fill_price: "10.5", first_fill_qty: 100,
    close_fill_candle_index: 9, realized_pnl: "100.25",
    event_first_seq: 4, event_last_seq: 11, auto_capture: { entry: { status: "captured" } },
    finalized_session_id: SID, finalized_trade_key: `${SID}:1`,
    finalized_at: "2026-10-17T01:00:00Z", created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T01:00:00Z",
  });
  eq("13 mapped fields", [row.id, row.userId, row.resetGeneration, row.cycleIndex, row.status, row.firstFillPrice, row.realizedPnl, row.finalizedTradeKey],
    ["d-9", "u-9", 2, 3, "finalized", 10.5, 100.25, `${SID}:1`]);
  eq("13 autoCapture preserved", row.autoCapture, { entry: { status: "captured" } });
}

/* ===== 14. Representative selection round-trips through the draft row
 * (Representative plan §6.2): the auto_capture JSONB carries the new
 * `representative` member opaquely; no migration, no new column. ===== */
{
  const selCapture = {
    entry: { path: "u-9/dr_att_g0_c1/auto-entry-c6.png", candleIndex: 5, status: "captured" },
    exit: { path: "u-9/dr_att_g0_c1/auto-exit-c10.png", candleIndex: 9, status: "captured" },
    representative: { path: "u-9/dr_att_g0_c1/auto-exit-c10.png", selectedAt: "2026-10-17T02:00:00.000Z" },
  };
  const row = mapDraftRow({
    id: "d-10", user_id: "u-9", attempt_id: ATT, reset_generation: 0, cycle_index: 1,
    draft_key: `dr:${ATT}:g0:c1`, status: "finalized",
    first_fill_candle_index: 5, first_fill_price: "10.5", first_fill_qty: 100,
    close_fill_candle_index: 9, realized_pnl: "100.25",
    event_first_seq: 4, event_last_seq: 11, auto_capture: selCapture,
    finalized_session_id: SID, finalized_trade_key: `${SID}:1`,
    finalized_at: "2026-10-17T01:00:00Z", created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T02:00:00Z",
  });
  eq("14 representative member round-trips through mapDraftRow", row.autoCapture, selCapture);
  eq("14 representative path readable for resolution",
    (row.autoCapture.representative as { path?: string }).path, "u-9/dr_att_g0_c1/auto-exit-c10.png");
}

/* ===== 15. Draft list counts: header/chip total must equal the list =====
 * Regression for the reported mismatch: the drafts card lists EVERY
 * draft row (finalized included), but the header and the source chip
 * counted only status="draft" — one finalized draft rendered as
 * "0 drafts" above a list of one. draftListCounts is the single
 * aggregation the card header and chip both read: total is ALWAYS the
 * list length; the unfinalized remainder is reported separately as
 * toReview, never as the headline count. */
{
  // The exact reported scenario: one finalized draft, nothing pending.
  const only = [draftRow({ status: "finalized", finalizedSessionId: SID, finalizedTradeKey: `${SID}:1`, finalizedAt: "2026-10-17T01:00:00Z" })];
  const c1 = draftListCounts(only, () => false);
  eq("15 reported scenario: total = list length (1)", c1.total, 1);
  eq("15 reported scenario: finalized", c1.finalized, 1);
  eq("15 reported scenario: toReview", c1.toReview, 0);
  eq("15 reported scenario: superseded", c1.superseded, 0);

  // Mixed list: 1 open draft, 1 finalized, 1 stored-superseded, and 1
  // still-"draft" row that DISPLAYS as superseded (pre-reset, finished
  // attempt) via the caller's predicate.
  const preReset = draftRow({ id: "d-pre", draftKey: draftKeyFor(ATT, 0, 2), cycleIndex: 2 });
  const mixed = [
    draftRow({}),
    draftRow({ id: "d-fin", status: "finalized" }),
    draftRow({ id: "d-sup", status: "superseded" }),
    preReset,
  ];
  const c2 = draftListCounts(mixed, (d) => d.status === "superseded" || d.id === "d-pre");
  eq("15 mixed: total = list length (4)", c2.total, 4);
  eq("15 mixed: toReview counts only display-drafts", c2.toReview, 1);
  eq("15 mixed: finalized", c2.finalized, 1);
  eq("15 mixed: superseded (stored + display)", c2.superseded, 2);
  eq("15 mixed: buckets partition the total", c2.toReview + c2.finalized + c2.superseded, c2.total);

  eq("15 empty list", draftListCounts([], () => false), { total: 0, toReview: 0, finalized: 0, superseded: 0 });
}

console.log(`=== drDrafts RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
