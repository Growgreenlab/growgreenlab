import type { Candle, Fill, PendingOrder, Side } from "./types";

export interface StepResult {
  /** Fills produced by automatic stop-loss / take-profit triggers this step. */
  autoFills: Fill[];
  /** True when the replay reached the final candle. */
  atEnd: boolean;
}

export interface TickResult {
  /** True when a candle just finalized on this tick. */
  finalized: boolean;
  /** True when the replay reached the final candle. */
  atEnd: boolean;
  /** Fills produced by automatic stop-loss / take-profit triggers this tick. */
  autoFills: Fill[];
}

/** Intra-candle ticks per simulated minute. Fixed so sessions animate identically. */
export const TICKS_PER_CANDLE = 360; // ~6 ticks/sec at 1x real-time speed
/** Real seconds for one 1-minute candle to form at 1x speed (live market pace). */
export const SECONDS_PER_CANDLE = 60;

interface FormingState {
  ticks: number[];
  /** Cumulative volume fraction per tick (0..1), bursts with price activity. */
  volFrac: number[];
  pos: number; // index of the latest applied tick
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function hashSeed(...nums: number[]): number {
  let h = 2166136261;
  const s = nums.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure replay + simulated-trading engine. No DOM, no framework —
 * safe to unit-test in Node. Long-only: buys open/add to a long
 * position, sells close/reduce it.
 *
 * `index` is the last finalized candle. `startIndex` names the first LIVE
 * candle: everything before it is history, and the replay opens with it
 * forming tick-by-tick (so `index` starts at `startIndex - 1`). The chart
 * must render only finalized candles plus the live-forming candle via
 * `displayCandles`; future candles are never exposed by this class.
 *
 * Live formation: each candle is revealed tick-by-tick (TICKS_PER_CANDLE
 * ticks per simulated minute) from a deterministic, seeded intra-candle
 * price path that stays inside the candle's true [low, high] range,
 * touches the true high/low, and settles exactly on the true OHLC.
 * Bracket triggers are evaluated per tick (stop-first when both the
 * stop and target would be touched by the candle), so fills happen at
 * realistic intra-candle prices.
 */
export class ReplayEngine {
  readonly candles: Candle[];
  readonly startCash: number;
  readonly startIndex: number;
  /** Index of the first real candle; leading `syn` premarket context is visual only. */
  readonly sessionStart: number;
  /**
   * Optional guard called before any buy (market or limit). Return an error
   * message to block the order, or null to allow. Used by Psychology Guard.
   * Sells and historical replay (buyAt) are never blocked.
   */
  tradeGuard: (() => string | null) | null = null;

  index: number;
  cash: number;
  positionQty: number;
  positionAvg: number;
  realizedPnl: number;
  fills: Fill[];
  stopLoss: number | null = null;
  takeProfit: number | null = null;
  pendingOrders: PendingOrder[] = [];

  private nextFillId = 1;
  private nextOrderId = 1;
  private forming: FormingState | null = null;

  constructor(candles: Candle[], startCash = 100_000, startIndex = 0) {
    if (candles.length === 0) throw new Error("Engine needs at least one candle");
    this.candles = candles;
    this.startCash = startCash;
    // startIndex = the first LIVE candle: everything before it is history,
    // and the replay opens with it forming tick-by-tick.
    this.startIndex = Math.max(0, Math.min(startIndex, candles.length - 1));
    const firstReal = candles.findIndex((c) => !c.syn);
    this.sessionStart = firstReal === -1 ? 0 : Math.min(firstReal, this.startIndex);
    this.index = this.startIndex - 1;
    this.cash = startCash;
    this.positionQty = 0;
    this.positionAvg = 0;
    this.realizedPnl = 0;
    this.fills = [];
    this.nextFillId = 1;
    this.nextOrderId = 1;
    // The start candle is live from the first render: no index=-1 edge
    // cases anywhere, and no future close leaking into the price header.
    if (!this.atEnd) this.beginForming();
  }

  /** Candles the trader is allowed to see right now (finalized only). */
  get revealed(): Candle[] {
    return this.candles.slice(0, this.index + 1);
  }

  get currentCandle(): Candle {
    return this.candles[this.index];
  }

  /** Last traded price = close of the current candle. */
  get currentPrice(): number {
    return this.currentCandle.c;
  }

  /** Live price: the forming tick while a candle builds, else the close. */
  get displayPrice(): number {
    return this.forming ? this.forming.c : this.currentPrice;
  }

  /** Finalized candles plus the partially-formed live candle (if any). */
  get displayCandles(): Candle[] {
    const out = this.candles.slice(0, this.index + 1);
    if (this.forming) {
      const t = this.candles[this.index + 1];
      out.push({
        t: t.t,
        o: this.forming.o,
        h: this.forming.h,
        l: this.forming.l,
        c: this.forming.c,
        v: this.forming.v,
      });
    }
    return out;
  }

  /** 0..1 progress of the currently forming candle (0 when idle). */
  get formationProgress(): number {
    return this.forming ? (this.forming.pos + 1) / TICKS_PER_CANDLE : 0;
  }

  get atEnd(): boolean {
    return this.index >= this.candles.length - 1;
  }

  /** High of day across revealed candles, including the live-forming high. */
  get hod(): number {
    let m = -Infinity;
    for (let i = this.sessionStart; i <= this.index; i++) m = Math.max(m, this.candles[i].h);
    if (this.forming) m = Math.max(m, this.forming.h);
    return m;
  }

  /** Advance one full candle instantly (drains its ticks); check brackets. */
  step(): StepResult {
    const autoFills: Fill[] = [];
    if (this.atEnd) return { autoFills, atEnd: true };
    let r: TickResult;
    do {
      r = this.tick();
      autoFills.push(...r.autoFills);
    } while (!r.finalized && !r.atEnd);
    return { autoFills, atEnd: r.atEnd };
  }

  /**
   * Advance the live-forming candle by one tick. When the candle's ticks
   * are exhausted it finalizes (index advances) exactly as step() would.
   */
  tick(): TickResult {
    const autoFills: Fill[] = [];
    if (this.atEnd) return { finalized: false, atEnd: true, autoFills };
    if (!this.forming) this.beginForming();
    const f = this.forming!;
    const target = this.candles[this.index + 1];

    f.pos += 1;
    const tick = f.ticks[f.pos];
    f.c = tick;
    if (tick > f.h) f.h = tick;
    if (tick < f.l) f.l = tick;
    f.v = target.v * f.volFrac[f.pos];

    // Bracket triggers, evaluated per tick. Stop-first when the candle's
    // true range would touch both (conservative, matches step()).
    if (this.positionQty > 0) {
      const willStop = this.stopLoss != null && this.stopLoss >= target.l;
      const willTp = this.takeProfit != null && this.takeProfit <= target.h;
      if (this.stopLoss != null && tick <= this.stopLoss) {
        const px = f.pos === 0 && tick < this.stopLoss ? tick : this.stopLoss;
        autoFills.push(this.closePosition(px, "stop-loss"));
      } else if (
        !(willStop && willTp) &&
        this.takeProfit != null &&
        tick >= this.takeProfit
      ) {
        const px = f.pos === 0 && tick > this.takeProfit ? tick : this.takeProfit;
        autoFills.push(this.closePosition(px, "take-profit"));
      }
    }

    // Working limit orders fill when the live tick touches their price.
    this.fillPendingOrders(tick);

    let finalized = false;
    if (f.pos >= TICKS_PER_CANDLE - 1) {
      this.index += 1;
      this.forming = null;
      finalized = true;
      // Classic end-of-candle check for brackets set mid-formation (or any
      // still-open position): stop-first, fills at stop/target unless gapped.
      if (this.positionQty > 0) {
        const c = this.currentCandle;
        if (this.stopLoss != null && c.l <= this.stopLoss) {
          const exitPrice = c.o < this.stopLoss ? c.o : this.stopLoss; // gapped through
          autoFills.push(this.closePosition(exitPrice, "stop-loss"));
        } else if (this.takeProfit != null && c.h >= this.takeProfit) {
          const exitPrice = c.o > this.takeProfit ? c.o : this.takeProfit; // gapped through
          autoFills.push(this.closePosition(exitPrice, "take-profit"));
        }
      }
    }
    return { finalized, atEnd: this.atEnd, autoFills };
  }

  /** Market buy at the live price. Returns the fill or null if rejected. */
  buy(qty: number): Fill | null {
    if (this.tradeGuard) {
      const err = this.tradeGuard();
      if (err) return null;
    }
    return this.execBuy(
      Math.floor(qty),
      this.executionPrice(),
      this.executionIndex(),
      this.executionTime()
    );
  }

  /**
   * Market sell at the live price (closes/reduces the long).
   * Returns the fill or null if there is nothing to sell.
   */
  sell(qty: number): Fill | null {
    return this.execSell(
      Math.floor(qty),
      this.executionPrice(),
      this.executionIndex(),
      this.executionTime()
    );
  }

  /**
   * Replay a recorded fill at its exact price (used when reloading saved
   * sessions so P/L matches the original run tick-for-tick).
   */
  buyAt(qty: number, price: number, candleIndex: number, time: number): Fill | null {
    return this.execBuy(Math.floor(qty), price, candleIndex, time);
  }

  /** Replay a recorded closing fill at its exact price. */
  sellAt(qty: number, price: number, candleIndex: number, time: number): Fill | null {
    return this.execSell(Math.floor(qty), price, candleIndex, time);
  }

  /**
   * Place a limit order. It rests until a live tick touches its price
   * (buy: tick <= limit, sell: tick >= limit) and fills at the tick price
   * (price improvement, like a real book). Returns an error string, or null
   * when the order is accepted and working.
   */
  placeLimitOrder(side: Side, qty: number, limitPrice: number): string | null {
    qty = Math.floor(qty);
    if (!(qty > 0)) return "Enter a share quantity.";
    if (!(limitPrice > 0)) return "Enter a limit price.";
    if (side === "buy") {
      if (this.tradeGuard) {
        const err = this.tradeGuard();
        if (err) return err;
      }
      if (qty * limitPrice > this.cash + 1e-9) return "Not enough virtual cash for that size.";
    } else {
      if (this.positionQty <= 0) return "No open position to sell.";
      if (qty > this.positionQty) return `Only ${this.positionQty} shares in position.`;
    }
    this.pendingOrders.push({ id: this.nextOrderId++, side, qty, limitPrice });
    return null;
  }

  /** Cancel one working limit order. Returns true if it existed. */
  cancelOrder(id: number): boolean {
    const i = this.pendingOrders.findIndex((o) => o.id === id);
    if (i === -1) return false;
    this.pendingOrders.splice(i, 1);
    return true;
  }

  /** Cancel all working limit orders. */
  cancelAllOrders(): void {
    this.pendingOrders = [];
  }

  /** Cancel all working limit orders for one side. */
  private cancelWorkingSide(side: Side): void {
    this.pendingOrders = this.pendingOrders.filter((o) => o.side !== side);
  }

  /** Try to fill working limit orders against a live tick price. */
  private fillPendingOrders(tick: number): void {
    if (this.pendingOrders.length === 0) return;
    const idx = this.executionIndex();
    const time = this.executionTime();
    const done: number[] = [];
    for (const o of this.pendingOrders) {
      let fill: Fill | null = null;
      if (o.side === "buy" && tick <= o.limitPrice) {
        fill = this.execBuy(o.qty, tick, idx, time);
        if (fill) fill.note = `limit ${o.limitPrice.toFixed(2)}`;
      } else if (o.side === "sell" && tick >= o.limitPrice) {
        fill = this.execSell(o.qty, tick, idx, time);
        if (fill) fill.note = `limit ${o.limitPrice.toFixed(2)}`;
      }
      if (fill) done.push(o.id);
      // if validation failed (e.g. cash moved), the order keeps working
    }
    if (done.length > 0) {
      const gone = new Set(done);
      this.pendingOrders = this.pendingOrders.filter((o) => !gone.has(o.id));
    }
  }

  /** Unrealized P/L of the open position at the live price. */
  unrealizedPnl(): number {
    if (this.positionQty <= 0) return 0;
    return (this.displayPrice - this.positionAvg) * this.positionQty;
  }

  /** Total account equity at the live price. */
  equity(): number {
    return this.cash + this.positionQty * this.displayPrice;
  }

  setBrackets(stopLoss: number | null, takeProfit: number | null): void {
    this.stopLoss = stopLoss != null && stopLoss > 0 ? stopLoss : null;
    this.takeProfit = takeProfit != null && takeProfit > 0 ? takeProfit : null;
  }

  clearBrackets(): void {
    this.stopLoss = null;
    this.takeProfit = null;
  }

  /** Restore starting cash/position; the start candle forms live again. */
  reset(): void {
    this.index = this.startIndex - 1;
    this.cash = this.startCash;
    this.positionQty = 0;
    this.positionAvg = 0;
    this.realizedPnl = 0;
    this.fills = [];
    this.clearBrackets();
    this.pendingOrders = [];
    this.forming = null;
    this.nextFillId = 1;
    this.nextOrderId = 1;
    if (!this.atEnd) this.beginForming();
  }

  private executionPrice(): number {
    return this.displayPrice;
  }

  private executionIndex(): number {
    return this.forming ? this.index + 1 : this.index;
  }

  private executionTime(): number {
    return this.forming ? this.candles[this.index + 1].t : this.currentCandle.t;
  }

  private beginForming(): void {
    const target = this.candles[this.index + 1];
    const { ticks, volFrac } = makeTicks(target);
    this.forming = {
      ticks,
      volFrac,
      pos: -1,
      o: target.o,
      h: target.o,
      l: target.o,
      c: target.o,
      v: 0,
    };
  }

  private execBuy(qty: number, price: number, candleIndex: number, time: number): Fill | null {
    if (!(qty > 0)) return null;
    const cost = qty * price;
    if (cost > this.cash + 1e-9) return null; // insufficient virtual cash
    const newQty = this.positionQty + qty;
    this.positionAvg = (this.positionAvg * this.positionQty + price * qty) / newQty;
    this.positionQty = newQty;
    this.cash -= cost;
    const fill: Fill = {
      id: this.nextFillId++,
      side: "buy",
      qty,
      price,
      candleIndex,
      time,
      realizedPnl: 0,
    };
    this.fills.push(fill);
    return fill;
  }

  private execSell(qty: number, price: number, candleIndex: number, time: number): Fill | null {
    if (!(qty > 0) || this.positionQty <= 0) return null;
    const sellQty = Math.min(qty, this.positionQty);
    const realized = (price - this.positionAvg) * sellQty;
    this.positionQty -= sellQty;
    this.cash += sellQty * price;
    this.realizedPnl += realized;
    if (this.positionQty === 0) {
      this.clearBrackets();
      this.cancelWorkingSide("sell"); // exit orders die with the position
    }
    const fill: Fill = {
      id: this.nextFillId++,
      side: "sell",
      qty: sellQty,
      price,
      candleIndex,
      time,
      realizedPnl: realized,
    };
    this.fills.push(fill);
    return fill;
  }

  private closePosition(price: number, note: string): Fill {
    const qty = this.positionQty;
    const realized = (price - this.positionAvg) * qty;
    this.cash += qty * price;
    this.realizedPnl += realized;
    this.positionQty = 0;
    this.positionAvg = 0;
    this.clearBrackets();
    this.cancelWorkingSide("sell");
    const fill: Fill = {
      id: this.nextFillId++,
      side: "sell",
      qty,
      price,
      candleIndex: this.executionIndex(),
      time: this.executionTime(),
      note,
      realizedPnl: realized,
    };
    this.fills.push(fill);
    return fill;
  }
}

/**
 * Deterministic intra-candle tick path: a Brownian bridge pinned to the
 * open and close, so the price fluctuates naturally like a live tape —
 * drifting, pulling back, and breathing around the open→close line.
 * The path is clamped to the candle's true [low, high], pinned to touch
 * the true high and low once (no visual snap at finalize), and volume
 * accumulates in bursts proportional to price movement, as in real markets.
 */
function makeTicks(c: Candle): { ticks: number[]; volFrac: number[] } {
  const n = TICKS_PER_CANDLE;
  const rand = mulberry32(hashSeed(c.t, c.o, c.h, c.l, c.c, c.v));
  const zn = () => (rand() + rand() + rand() - 1.5) * 2; // ~N(0,1)

  // random walk with unit variance at t=1, then bridge it between open and close
  const w: number[] = new Array(n);
  w[0] = 0;
  const step = 1 / Math.sqrt(n);
  for (let k = 1; k < n; k++) w[k] = w[k - 1] + zn() * step;
  const range = Math.max(c.h - c.l, 1e-9);
  const sigma = range * 0.5;
  const pts: number[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    let p = c.o + (c.c - c.o) * t + sigma * (w[k] - t * w[n - 1]);
    if (p > c.h) p = c.h;
    if (p < c.l) p = c.l;
    pts[k] = p;
  }
  pts[0] = c.o;
  pts[n - 1] = c.c;
  if (c.h > c.l && n > 4) {
    const iH = 1 + Math.floor(rand() * (n - 2));
    let iL = 1 + Math.floor(rand() * (n - 2));
    if (iL === iH) iL = iL >= n - 2 ? 1 : iL + 1;
    pts[iH] = c.h;
    pts[iL] = c.l;
  }

  // volume follows price activity: bursts on moves, quiet on drifts
  const deltas: number[] = new Array(n);
  deltas[0] = 0;
  let tot = 0;
  for (let k = 1; k < n; k++) {
    deltas[k] = Math.abs(pts[k] - pts[k - 1]);
    tot += deltas[k];
  }
  const volFrac: number[] = new Array(n);
  let acc = 0;
  for (let k = 0; k < n; k++) {
    acc += deltas[k];
    volFrac[k] = tot > 1e-12 ? acc / tot : (k + 1) / n;
  }
  return { ticks: pts, volFrac };
}

export function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatSigned(n: number): string {
  return `${n >= 0 ? "+" : ""}${formatMoney(n)}`;
}

/**
 * Countdown (MM:SS) until the forming candle closes, honoring replay speed.
 * progress is 0..1 of the current candle.
 */
export function countdownText(progress: number, speed: number): string {
  return countdownTextFor(progress, speed, SECONDS_PER_CANDLE);
}

/** Countdown for a candle of arbitrary duration (used by multi-timeframe charts). */
export function countdownTextFor(progress: number, speed: number, secondsPerCandle: number): string {
  const ticksPerSec = (TICKS_PER_CANDLE / secondsPerCandle) * speed;
  const ticksLeft = Math.max(0, TICKS_PER_CANDLE - Math.round(progress * TICKS_PER_CANDLE));
  const secs = Math.max(0, Math.ceil(ticksLeft / ticksPerSec));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
