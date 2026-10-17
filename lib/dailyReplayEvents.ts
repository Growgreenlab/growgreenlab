/**
 * Daily Replay — Decision Timeline (append-only event recorder).
 *
 * Pure module: no DOM, no Supabase. The replay page feeds the recorder
 * from the same call sites where actions happen (order handlers, the
 * SL/TP drag/control handlers, the play controls) and observes engine
 * fills centrally, so every meaningful action lands here exactly once.
 *
 * Rules:
 *  - Events are append-only and frozen at record time. There is NO
 *    API to edit or delete an event; corrections would be new events.
 *  - `seq` is monotonic from 1. `wallTs` is the real clock (injectable
 *    for tests); `marketIdx`/`marketTs` identify the historical candle
 *    the action belongs to — the two clocks are never mixed.
 *  - SL/TP history is preserved as prev → new on every modification,
 *    with a direction-aware classification and per-trade move counters.
 *
 * Persistence (once supabase/migrations/daily-replay-v1.sql is
 * applied): rows in daily_replay_events, owner SELECT + INSERT only —
 * append-only at the database level too.
 */
import { formatMoney, formatSigned } from "./engine";

export type DrEventType =
  | "attempt_created"
  | "session_started"
  | "session_paused"
  | "session_resumed"
  | "session_reset"
  | "session_exited"
  | "session_completed"
  | "order_submitted"
  | "order_filled"
  | "order_rejected"
  | "order_cancelled"
  | "limit_placed"
  | "position_changed"
  | "bracket_set"
  | "bracket_modified"
  | "bracket_triggered"
  | "partial_exit"
  | "position_closed"
  | "risk_snapshot";

export interface DrEvent {
  seq: number;
  type: DrEventType;
  /** Real (wall-clock) time the action happened, epoch ms. */
  wallTs: number;
  /** Historical candle index the action belongs to, if any. */
  marketIdx: number | null;
  /** Historical candle timestamp (epoch ms), if any. */
  marketTs: number | null;
  payload: Record<string, unknown>;
}

export interface DrMarketCtx {
  marketIdx?: number | null;
  marketTs?: number | null;
}

export type DrBracketMethod = "drag" | "control";
export type DrBracketScope = "planned" | "active";
export type DrBracketClassification =
  | "set"
  | "cleared"
  | "tightened"
  | "widened"
  | "moved-to-breakeven";

/**
 * Direction-aware classification of one bracket-level change.
 * Stop, long: up = tightened, down = widened. Stop, short: mirrored.
 * A stop landing within a cent of the average entry is breakeven.
 * Target: closer to entry = tightened, farther = widened.
 */
export function classifyBracketMove(
  field: "stopLoss" | "takeProfit",
  prev: number | null,
  next: number | null,
  avgEntry: number | null,
  direction: "long" | "short",
): DrBracketClassification {
  if (prev == null && next != null) return "set";
  if (next == null) return "cleared";
  if (prev == null) return "set"; // unreachable, keeps TS honest
  if (
    field === "stopLoss" &&
    avgEntry != null &&
    Math.abs(next - avgEntry) <= 0.01
  ) {
    return "moved-to-breakeven";
  }
  if (field === "stopLoss") {
    if (direction === "long") return next > prev ? "tightened" : "widened";
    return next < prev ? "tightened" : "widened";
  }
  if (direction === "long") return next < prev ? "tightened" : "widened";
  return next > prev ? "tightened" : "widened";
}

interface BracketTracker {
  sl: number | null;
  tp: number | null;
  everSet: boolean;
  slMoves: number;
  tpMoves: number;
}

const freshTracker = (): BracketTracker => ({
  sl: null,
  tp: null,
  everSet: false,
  slMoves: 0,
  tpMoves: 0,
});

export class DrEventRecorder {
  private events: DrEvent[] = [];
  private seq = 0;
  private listener: (() => void) | null = null;
  // Shadow position, maintained from recorded fills (exact: fills
  // carry qty/price/realizedPnl).
  private shadowQty = 0;
  private shadowAvg = 0;
  private shadowRealized = 0;
  private trackers: Record<DrBracketScope, BracketTracker> = {
    planned: freshTracker(),
    active: freshTracker(),
  };

  constructor(private now: () => number = Date.now) {}

  /** Notified after every appended event (UI sync / persistence). */
  setListener(fn: (() => void) | null): void {
    this.listener = fn;
  }

  /** All events in order. The array is a copy; events are frozen. */
  get all(): DrEvent[] {
    return [...this.events];
  }

  get length(): number {
    return this.events.length;
  }

  /** Current shadow position size (from recorded fills). */
  get positionQty(): number {
    return this.shadowQty;
  }

  /** Per-trade bracket move counters for one scope. */
  bracketMoveCounts(scope: DrBracketScope): { sl: number; tp: number } {
    const t = this.trackers[scope];
    return { sl: t.slMoves, tp: t.tpMoves };
  }

  record(
    type: DrEventType,
    payload: Record<string, unknown>,
    ctx: DrMarketCtx = {},
  ): DrEvent {
    const e: DrEvent = {
      seq: ++this.seq,
      type,
      wallTs: this.now(),
      marketIdx: ctx.marketIdx ?? null,
      marketTs: ctx.marketTs ?? null,
      payload: { ...payload },
    };
    Object.freeze(e.payload);
    Object.freeze(e);
    this.events.push(e);
    this.listener?.();
    return e;
  }

  /* ---------------- orders & fills ---------------- */

  recordOrderSubmitted(
    o: { orderType: "market" | "limit"; side: "buy" | "sell"; qty: number; requestedPrice?: number | null },
    ctx: DrMarketCtx = {},
  ): void {
    this.record("order_submitted", { ...o }, ctx);
  }

  recordOrderRejected(
    o: { side: "buy" | "sell"; qty: number; reason: string },
    ctx: DrMarketCtx = {},
  ): void {
    this.record("order_rejected", { ...o }, ctx);
  }

  recordLimitPlaced(
    o: { side: "buy" | "sell"; qty: number; limitPrice: number },
    ctx: DrMarketCtx = {},
  ): void {
    this.record("limit_placed", { ...o }, ctx);
  }

  recordOrderCancelled(
    o: { orderId: number; side?: string; qty?: number; limitPrice?: number },
    ctx: DrMarketCtx = {},
  ): void {
    this.record("order_cancelled", { ...o }, ctx);
  }

  /**
   * Record one engine fill and its consequences. Emission order:
   * [bracket_triggered] → order_filled → position_changed (open/add) |
   * partial_exit (reduce) | position_closed (flat). A closing fill
   * carries the trade's realized P&L snapshot and resets the ACTIVE
   * bracket tracker (the engine clears brackets on close too).
   */
  recordFill(
    f: {
      side: "buy" | "sell";
      qty: number;
      price: number;
      candleIndex: number;
      time: number;
      note?: string | null;
      realizedPnl?: number;
    },
  ): void {
    const ctx: DrMarketCtx = { marketIdx: f.candleIndex, marketTs: f.time };
    const trigger =
      f.note === "stop-loss" ? "stop" : f.note === "take-profit" ? "target" : null;
    if (trigger) {
      this.record("bracket_triggered", { kind: trigger, price: f.price }, ctx);
    }
    this.record(
      "order_filled",
      {
        side: f.side,
        qty: f.qty,
        price: f.price,
        candleIndex: f.candleIndex,
        ...(f.note ? { note: f.note } : {}),
      },
      ctx,
    );
    if (f.side === "buy") {
      const newQty = this.shadowQty + f.qty;
      this.shadowAvg =
        newQty > 0
          ? (this.shadowAvg * this.shadowQty + f.price * f.qty) / newQty
          : 0;
      this.shadowQty = newQty;
      this.record(
        "position_changed",
        { qtyAfter: this.shadowQty, avgPrice: round2(this.shadowAvg) },
        ctx,
      );
    } else {
      const realized = f.realizedPnl ?? 0;
      this.shadowRealized += realized;
      const qtyAfter = Math.max(0, this.shadowQty - f.qty);
      this.shadowQty = qtyAfter;
      if (qtyAfter > 0) {
        this.record(
          "partial_exit",
          {
            qty: f.qty,
            price: f.price,
            realizedPnl: realized,
            qtyAfter,
            sessionRealized: round2(this.shadowRealized),
          },
          ctx,
        );
      } else {
        this.record(
          "position_closed",
          {
            qty: f.qty,
            price: f.price,
            realizedPnl: realized,
            sessionRealized: round2(this.shadowRealized),
            reason: f.note ?? "manual",
            unrealizedPnl: 0,
          },
          ctx,
        );
        this.trackers.active = freshTracker();
      }
    }
  }

  /* ---------------- brackets ---------------- */

  /**
   * Feed EVERY SL/TP state the UI applies (planned or active scope,
   * drag or control). Emits bracket_set the first time levels appear
   * in a scope, then one bracket_modified per changed field with
   * prev/new preserved and a direction-aware classification.
   */
  recordBrackets(
    sl: number | null,
    tp: number | null,
    method: DrBracketMethod,
    scope: DrBracketScope,
    ctx: DrMarketCtx = {},
    pos: { avgEntry?: number | null; direction?: "long" | "short" } = {},
  ): void {
    const t = this.trackers[scope];
    const direction = pos.direction ?? "long";
    if (!t.everSet && (sl != null || tp != null)) {
      t.everSet = true;
      t.sl = sl;
      t.tp = tp;
      this.record(
        "bracket_set",
        { scope, stopLoss: sl, takeProfit: tp, method },
        ctx,
      );
      return;
    }
    const fields: Array<{
      field: "stopLoss" | "takeProfit";
      prev: number | null;
      next: number | null;
    }> = [
      { field: "stopLoss", prev: t.sl, next: sl },
      { field: "takeProfit", prev: t.tp, next: tp },
    ];
    for (const { field, prev, next } of fields) {
      if (prev === next) continue;
      const classification = classifyBracketMove(
        field,
        prev,
        next,
        pos.avgEntry ?? null,
        direction,
      );
      if (field === "stopLoss") t.slMoves++;
      else t.tpMoves++;
      this.record(
        "bracket_modified",
        {
          scope,
          field,
          prev,
          next,
          method,
          classification,
          timesMoved: field === "stopLoss" ? t.slMoves : t.tpMoves,
        },
        ctx,
      );
    }
    t.sl = sl;
    t.tp = tp;
  }

  /* ---------------- risk & lifecycle ---------------- */

  recordRiskSnapshot(
    s: {
      entry: number;
      qty: number;
      stopLoss: number | null;
      takeProfit: number | null;
      plannedRisk: number | null;
      rewardRisk: number | null;
    },
    ctx: DrMarketCtx = {},
  ): void {
    this.record("risk_snapshot", { ...s }, ctx);
  }

  /**
   * Engine reset: trading shadow + bracket trackers restart (the
   * recorded history does NOT — reset itself is a timeline event the
   * page records; history is never rewritten).
   */
  resetTradingState(): void {
    this.shadowQty = 0;
    this.shadowAvg = 0;
    this.shadowRealized = 0;
    this.trackers = { planned: freshTracker(), active: freshTracker() };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Plain-language rendering (Review Timeline UI + tests)               */
/* ------------------------------------------------------------------ */

const clockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "10:04 AM ET" for an epoch-ms instant. */
export function formatDrClock(ms: number): string {
  return `${clockFmt.format(new Date(ms))} ET`;
}

function money(v: unknown): string {
  return typeof v === "number" ? formatMoney(v) : "—";
}
function signed(v: unknown): string {
  return typeof v === "number" ? formatSigned(v) : "—";
}
function num(v: unknown): string {
  return typeof v === "number" ? String(v) : "—";
}

/** One plain-language line describing an event (no timestamp prefix). */
export function describeDrEvent(e: DrEvent): string {
  const p = e.payload;
  switch (e.type) {
    case "attempt_created":
      return `Daily Replay started — ${String(p.ticker ?? "")} ${String(p.tradeDate ?? "")}, starting candle #${num((p.startIndex as number) + 1)} (${String(p.startEtTime ?? "")} ET), balance ${money(p.startingBalance)}`;
    case "session_started":
      return "Replay started";
    case "session_paused":
      return "Replay paused";
    case "session_resumed":
      return "Replay resumed";
    case "session_reset":
      return "Replay reset to the starting candle (history preserved)";
    case "session_exited":
      return "Exited Daily Replay (attempt left open on the server)";
    case "session_completed":
      return `Session completed — final realized P&L ${signed(p.realizedPnl)}, equity ${money(p.equity)}`;
    case "order_submitted":
      return `${p.side === "buy" ? "Buy" : "Sell"} order submitted — ${num(p.qty)} shares (${String(p.orderType ?? "market")})`;
    case "limit_placed":
      return `Limit ${p.side === "buy" ? "buy" : "sell"} placed — ${num(p.qty)} @ ${money(p.limitPrice)}`;
    case "order_filled":
      return `${p.side === "buy" ? "Bought" : "Sold"} ${num(p.qty)} @ ${money(p.price)}`;
    case "order_rejected":
      return `Order rejected — ${String(p.reason ?? "rejected")}`;
    case "order_cancelled":
      return "Limit order cancelled";
    case "position_changed":
      return `Position now ${num(p.qtyAfter)} shares @ avg ${money(p.avgPrice)}`;
    case "bracket_set": {
      const parts: string[] = [];
      if (p.stopLoss != null) parts.push(`SL ${money(p.stopLoss)}`);
      if (p.takeProfit != null) parts.push(`TP ${money(p.takeProfit)}`);
      return `${p.scope === "planned" ? "Planned levels" : "Stop-loss / target"} set — ${parts.join(" · ")} (${String(p.method ?? "")})`;
    }
    case "bracket_modified": {
      const label = p.field === "stopLoss" ? "Stop-loss" : "Take-profit";
      const cls = String(p.classification ?? "");
      if (cls === "set") return `${label} set at ${money(p.next)} (${String(p.method ?? "")})`;
      if (cls === "cleared") return `${label} cleared (was ${money(p.prev)})`;
      if (cls === "moved-to-breakeven")
        return `${label} moved to breakeven ${money(p.next)} (was ${money(p.prev)}, ${String(p.method ?? "")})`;
      return `${label} moved ${money(p.prev)} → ${money(p.next)} (${cls}, ${String(p.method ?? "")})`;
    }
    case "bracket_triggered":
      return `${p.kind === "stop" ? "Stop-loss" : "Take-profit"} triggered @ ${money(p.price)}`;
    case "partial_exit":
      return `Partial exit — sold ${num(p.qty)} @ ${money(p.price)} (${signed(p.realizedPnl)}), ${num(p.qtyAfter)} shares remain`;
    case "position_closed": {
      const reason =
        p.reason === "stop-loss"
          ? ", stop-loss"
          : p.reason === "take-profit"
            ? ", take-profit"
            : "";
      return `Position closed — sold ${num(p.qty)} @ ${money(p.price)} (${signed(p.realizedPnl)}${reason})`;
    }
    case "risk_snapshot": {
      const parts = [`entry ${money(p.entry)} × ${num(p.qty)}`];
      if (p.plannedRisk != null) parts.push(`planned risk ${money(p.plannedRisk)}`);
      if (p.rewardRisk != null)
        parts.push(`R:R ${(p.rewardRisk as number).toFixed(2)}`);
      if (p.stopLoss != null) parts.push(`SL ${money(p.stopLoss)}`);
      if (p.takeProfit != null) parts.push(`TP ${money(p.takeProfit)}`);
      return `Plan at entry — ${parts.join(", ")}`;
    }
    default:
      return e.type;
  }
}
