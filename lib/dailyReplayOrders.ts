/**
 * Daily Replay — persistent working orders (pure, no DOM/Supabase).
 *
 * Why this module exists: until now, refresh-resume could not restore
 * working (unfilled) limit orders — the Decision Timeline's
 * limit_placed events carry no stable order id, so which placements
 * were still live at refresh time could not be determined without
 * guessing. The fix makes the SERVER authoritative for order state:
 * every limit order placed in Daily Replay is registered in
 * daily_replay_orders (supabase/migrations/daily-replay-v2-orders.sql)
 * under a client-generated uuid — the stable persistent identity —
 * and its lifecycle (working → filled / cancelled / rejected, with
 * monotonic filled_qty) is transitioned only through guarded
 * security-definer RPCs. Resume reads the rows back and restores
 * exactly the 'working' ones, at their remaining quantity.
 *
 * This module holds everything that does not need the network:
 *  - DrOrderRow / DrOrderStore — the row shape + the store contract
 *    (the page implements the store over Supabase RPCs; the tests
 *    implement it in memory with the same guards as the SQL).
 *  - validateOrderTransition — the transition state machine,
 *    mirroring dr_update_order's checks one-for-one.
 *  - DrOrderTracker — the live-session bookkeeping: which engine
 *    order id maps to which persistent row, and the departure diff
 *    that turns engine order removals into status updates.
 *  - planRestoredOrders — which server rows a resume must re-place,
 *    and at what remaining quantity.
 *
 * Fill ↔ order linkage (the engine cannot tell us directly — a Fill
 * carries no order id): fillPendingOrders stamps every limit fill's
 * note as `limit <price, 2dp>` and processes pendingOrders in
 * placement order, appending fills in that same order. The page's
 * central fill sync diffs tracked orders against the engine's current
 * pendingOrders after every state change: orders that departed are
 * zipped, in placement order, against this pass's new limit fills
 * within each (side, note) group — an exact match, not a heuristic.
 * A departed order with no matching fill was extinguished by the
 * engine itself (position closed → working sells die; session reset
 * clears all) and is recorded as cancelled, so it can never be
 * resurrected by a later resume.
 */
import type { Fill, Side } from "./types";

export type DrOrderStatus = "working" | "filled" | "cancelled" | "rejected";

/** One row of daily_replay_orders, as the client sees it. */
export interface DrOrderRow {
  /** Stable persistent order id (uuid, client-generated). */
  id: string;
  attemptId: string;
  side: Side;
  orderType: string;
  /** Original order quantity (shares). */
  qty: number;
  /** Executed quantity so far (monotonic, 0..qty). */
  filledQty: number;
  limitPrice: number;
  status: DrOrderStatus;
  /** Engine-local id in the session that placed the order (info only). */
  engineOrderId: number | null;
  /** ISO timestamp from the server row, when read back. */
  createdAt?: string;
}

/**
 * The server-side order store. Implemented over the dr_place_order /
 * dr_update_order RPCs + the owner-SELECT policy in the page, and by
 * an in-memory fake in tests. place() must be idempotent on row.id.
 */
export interface DrOrderStore {
  place(row: {
    id: string;
    attemptId: string;
    side: Side;
    qty: number;
    limitPrice: number;
    engineOrderId: number | null;
  }): Promise<DrOrderRow>;
  update(
    orderId: string,
    status: DrOrderStatus,
    filledQty: number,
  ): Promise<DrOrderRow>;
  /** All rows for one attempt, in creation order. */
  list(attemptId: string): Promise<DrOrderRow[]>;
}

/** One status change the tracker decided the server needs. */
export interface DrOrderUpdateOp {
  orderId: string;
  status: DrOrderStatus;
  filledQty: number;
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

let fallbackCounter = 0;

/**
 * A new persistent order id. Uses crypto.randomUUID (the id only
 * needs to be unique + unguessable, never sequential); the fallback
 * exists for non-secure contexts and test runners without it.
 */
export function newDrOrderId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  fallbackCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `dr-${Date.now().toString(36)}-${fallbackCounter}-${rand}`;
}

/* ------------------------------------------------------------------ */
/* Transition state machine (mirrors dr_update_order in the SQL)       */
/* ------------------------------------------------------------------ */

/**
 * Validate one order-state transition. Returns an error string, or
 * null when the transition is legal. The rules are identical to the
 * database function's, so client-side logic (and test fakes) can
 * never accept a transition the server would reject:
 *  - only a 'working' order can change; terminal states are final;
 *  - filled_qty is monotonic non-decreasing and never exceeds qty;
 *  - 'filled' requires filled_qty = qty;
 *  - 'working' requires filled_qty < qty.
 */
export function validateOrderTransition(
  cur: { status: DrOrderStatus; qty: number; filledQty: number },
  next: { status: DrOrderStatus; filledQty: number },
): string | null {
  if (!["working", "filled", "cancelled", "rejected"].includes(next.status)) {
    return `invalid status ${next.status}`;
  }
  if (cur.status !== "working") {
    return `order is already ${cur.status} (terminal)`;
  }
  if (!(next.filledQty >= cur.filledQty)) {
    return `filled_qty cannot decrease (${cur.filledQty} -> ${next.filledQty})`;
  }
  if (next.filledQty > cur.qty) {
    return `filled_qty ${next.filledQty} exceeds order qty ${cur.qty}`;
  }
  if (next.status === "filled" && next.filledQty !== cur.qty) {
    return `a filled order must have filled_qty = qty (${next.filledQty} of ${cur.qty})`;
  }
  if (next.status === "working" && next.filledQty >= cur.qty) {
    return `filled_qty ${next.filledQty} of ${cur.qty} must be reported as filled`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Fill linkage                                                        */
/* ------------------------------------------------------------------ */

/** The note fillPendingOrders stamps on a limit fill. */
export function limitFillNote(limitPrice: number): string {
  return `limit ${limitPrice.toFixed(2)}`;
}

/** True when a fill was produced by a working limit order. */
export function isLimitFill(f: Fill): boolean {
  return typeof f.note === "string" && f.note.startsWith("limit ");
}

/* ------------------------------------------------------------------ */
/* Live-session tracker                                                */
/* ------------------------------------------------------------------ */

/**
 * Tracks the working limit orders of ONE live Daily Replay attempt:
 * engine order id → persistent server row. Insertion order is
 * placement order (Map semantics), which the departure matching
 * relies on.
 *
 * The page registers an order the moment the engine accepts it,
 * takes it back out on a user-initiated cancel (whose status update
 * the caller issues), and after every engine state change calls
 * syncDepartures() to settle the orders the engine removed on its
 * own: fills (matched exactly, see the module header), position-close
 * side-cancels, cancel-all, and session resets.
 */
export class DrOrderTracker {
  private byEngineId = new Map<number, DrOrderRow>();

  track(engineOrderId: number, row: DrOrderRow): void {
    this.byEngineId.set(engineOrderId, row);
  }

  get(engineOrderId: number): DrOrderRow | undefined {
    return this.byEngineId.get(engineOrderId);
  }

  /** Remove and return the tracked row (user-initiated cancel path). */
  take(engineOrderId: number): DrOrderRow | undefined {
    const row = this.byEngineId.get(engineOrderId);
    if (row) this.byEngineId.delete(engineOrderId);
    return row;
  }

  get size(): number {
    return this.byEngineId.size;
  }

  all(): DrOrderRow[] {
    return [...this.byEngineId.values()];
  }

  clear(): void {
    this.byEngineId.clear();
  }

  /**
   * Settle orders the engine no longer holds.
   *
   * `currentPendingIds` is the engine's pendingOrders id set right
   * now; `newFills` is the fills the engine produced since the last
   * sync (the same batch the page feeds to the event recorder).
   * Departed tracked orders are matched — in placement order, within
   * each (side, limit-note) group — to this batch's limit fills:
   *  - matched, cumulative filled_qty reaches qty → 'filled';
   *  - matched, cumulative < qty (the engine's sell clamp filled what
   *    the shrinking position allowed, then extinguished the order
   *    with the position) → progress update to 'working' at the true
   *    filled_qty, then 'cancelled' for the extinguished remainder —
   *    quantities stay exact, and the row ends terminal so a resume
   *    can never resurrect the remainder;
   *  - unmatched → the engine extinguished it without a fill
   *    (position closed, cancel-all, session reset) → 'cancelled'.
   *
   * Departed orders leave the tracker. Returns the update ops to
   * persist (in order) and which persistent id each matched fill
   * belongs to (so the order_filled event can carry it).
   */
  syncDepartures(
    currentPendingIds: ReadonlySet<number>,
    newFills: Fill[],
  ): { updates: DrOrderUpdateOp[]; fillOrderId: Map<Fill, string> } {
    const updates: DrOrderUpdateOp[] = [];
    const fillOrderId = new Map<Fill, string>();

    const departed: Array<[number, DrOrderRow]> = [];
    for (const [engineId, row] of this.byEngineId) {
      if (!currentPendingIds.has(engineId)) departed.push([engineId, row]);
    }
    if (departed.length === 0) return { updates, fillOrderId };

    // Candidate fills, queued per (side, note) in production order.
    const queues = new Map<string, Fill[]>();
    for (const f of newFills) {
      if (!isLimitFill(f)) continue;
      const key = `${f.side}|${f.note}`;
      const q = queues.get(key);
      if (q) q.push(f);
      else queues.set(key, [f]);
    }

    for (const [engineId, row] of departed) {
      const key = `${row.side}|${limitFillNote(row.limitPrice)}`;
      const q = queues.get(key);
      const fill = q && q.length > 0 ? q.shift()! : null;
      if (fill) {
        fillOrderId.set(fill, row.id);
        const cumulative = row.filledQty + fill.qty;
        if (cumulative >= row.qty) {
          updates.push({ orderId: row.id, status: "filled", filledQty: row.qty });
        } else {
          updates.push({ orderId: row.id, status: "working", filledQty: cumulative });
          updates.push({ orderId: row.id, status: "cancelled", filledQty: cumulative });
        }
        row.filledQty = Math.min(cumulative, row.qty);
      } else {
        updates.push({
          orderId: row.id,
          status: "cancelled",
          filledQty: row.filledQty,
        });
      }
      this.byEngineId.delete(engineId);
    }
    return { updates, fillOrderId };
  }
}

/* ------------------------------------------------------------------ */
/* Resume restore planning                                             */
/* ------------------------------------------------------------------ */

export interface DrRestoredOrderPlan {
  /** The authoritative server row (status 'working'). */
  row: DrOrderRow;
  /** qty - filled_qty: what the resumed engine must still execute. */
  remainingQty: number;
}

/**
 * Which server rows a resume re-places into the rebuilt engine:
 * exactly the 'working' rows with a positive remaining quantity.
 * Terminal rows (filled / cancelled / rejected) are never restored —
 * and a filled row's fill is restored from the event stream instead,
 * so nothing is ever duplicated. Input order is preserved (the page
 * reads rows back in creation order = placement order).
 */
export function planRestoredOrders(rows: DrOrderRow[]): DrRestoredOrderPlan[] {
  const out: DrRestoredOrderPlan[] = [];
  for (const row of rows) {
    if (row.status !== "working") continue;
    const remainingQty = row.qty - row.filledQty;
    if (!(remainingQty > 0)) continue;
    out.push({ row, remainingQty });
  }
  return out;
}
