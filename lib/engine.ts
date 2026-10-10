import type { Candle, Fill, Side } from "./types";

export interface StepResult {
  /** Fills produced by automatic stop-loss / take-profit triggers this step. */
  autoFills: Fill[];
  /** True when the replay reached the final candle. */
  atEnd: boolean;
}

/**
 * Pure replay + simulated-trading engine. No DOM, no framework —
 * safe to unit-test in Node. Long-only: buys open/add to a long
 * position, sells close/reduce it.
 *
 * `index` is the last revealed candle. The chart must render only
 * candles[0..index]; future candles are never exposed by this class.
 */
export class ReplayEngine {
  readonly candles: Candle[];
  readonly startCash: number;
  readonly startIndex: number;

  index: number;
  cash: number;
  positionQty: number;
  positionAvg: number;
  realizedPnl: number;
  fills: Fill[];
  stopLoss: number | null = null;
  takeProfit: number | null = null;

  private nextFillId = 1;

  constructor(candles: Candle[], startCash = 100_000, startIndex = 0) {
    if (candles.length === 0) throw new Error("Engine needs at least one candle");
    this.candles = candles;
    this.startCash = startCash;
    this.startIndex = Math.max(0, Math.min(startIndex, candles.length - 1));
    this.index = this.startIndex;
    this.cash = startCash;
    this.positionQty = 0;
    this.positionAvg = 0;
    this.realizedPnl = 0;
    this.fills = [];
  }

  /** Candles the trader is allowed to see right now. */
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

  get atEnd(): boolean {
    return this.index >= this.candles.length - 1;
  }

  /** High of day across revealed candles. */
  get hod(): number {
    let m = -Infinity;
    for (let i = 0; i <= this.index; i++) m = Math.max(m, this.candles[i].h);
    return m;
  }

  /** Advance one candle; check stop-loss / take-profit brackets. */
  step(): StepResult {
    const autoFills: Fill[] = [];
    if (this.atEnd) return { autoFills, atEnd: true };
    this.index += 1;
    const c = this.currentCandle;

    if (this.positionQty > 0) {
      // Stop first (conservative) when both trigger inside one candle.
      if (this.stopLoss != null && c.l <= this.stopLoss) {
        const exitPrice = c.o < this.stopLoss ? c.o : this.stopLoss; // gapped through
        autoFills.push(this.closePosition(exitPrice, "stop-loss"));
      } else if (this.takeProfit != null && c.h >= this.takeProfit) {
        const exitPrice = c.o > this.takeProfit ? c.o : this.takeProfit; // gapped through
        autoFills.push(this.closePosition(exitPrice, "take-profit"));
      }
    }
    return { autoFills, atEnd: this.atEnd };
  }

  /** Market buy at the current close. Returns the fill or null if rejected. */
  buy(qty: number): Fill | null {
    qty = Math.floor(qty);
    if (!(qty > 0)) return null;
    const price = this.currentPrice;
    const cost = qty * price;
    if (cost > this.cash + 1e-9) return null; // insufficient virtual cash
    const newQty = this.positionQty + qty;
    this.positionAvg =
      (this.positionAvg * this.positionQty + price * qty) / newQty;
    this.positionQty = newQty;
    this.cash -= cost;
    const fill: Fill = {
      id: this.nextFillId++,
      side: "buy",
      qty,
      price,
      candleIndex: this.index,
      time: this.currentCandle.t,
      realizedPnl: 0,
    };
    this.fills.push(fill);
    return fill;
  }

  /**
   * Market sell at the current close (closes/reduces the long).
   * Returns the fill or null if there is nothing to sell.
   */
  sell(qty: number): Fill | null {
    qty = Math.floor(qty);
    if (!(qty > 0) || this.positionQty <= 0) return null;
    const sellQty = Math.min(qty, this.positionQty);
    const price = this.currentPrice;
    const realized = (price - this.positionAvg) * sellQty;
    this.positionQty -= sellQty;
    this.cash += sellQty * price;
    this.realizedPnl += realized;
    if (this.positionQty === 0) this.clearBrackets();
    const fill: Fill = {
      id: this.nextFillId++,
      side: "sell",
      qty: sellQty,
      price,
      candleIndex: this.index,
      time: this.currentCandle.t,
      realizedPnl: realized,
    };
    this.fills.push(fill);
    return fill;
  }

  /** Unrealized P/L of the open position at the current price. */
  unrealizedPnl(): number {
    if (this.positionQty <= 0) return 0;
    return (this.currentPrice - this.positionAvg) * this.positionQty;
  }

  /** Total account equity at the current price. */
  equity(): number {
    return this.cash + this.positionQty * this.currentPrice;
  }

  setBrackets(stopLoss: number | null, takeProfit: number | null): void {
    this.stopLoss = stopLoss != null && stopLoss > 0 ? stopLoss : null;
    this.takeProfit = takeProfit != null && takeProfit > 0 ? takeProfit : null;
  }

  clearBrackets(): void {
    this.stopLoss = null;
    this.takeProfit = null;
  }

  /** Restore starting cash/position; keep the same start index. */
  reset(): void {
    this.index = this.startIndex;
    this.cash = this.startCash;
    this.positionQty = 0;
    this.positionAvg = 0;
    this.realizedPnl = 0;
    this.fills = [];
    this.clearBrackets();
    this.nextFillId = 1;
  }

  private closePosition(price: number, note: string): Fill {
    const qty = this.positionQty;
    const realized = (price - this.positionAvg) * qty;
    this.cash += qty * price;
    this.realizedPnl += realized;
    this.positionQty = 0;
    this.positionAvg = 0;
    this.clearBrackets();
    const fill: Fill = {
      id: this.nextFillId++,
      side: "sell",
      qty,
      price,
      candleIndex: this.index,
      time: this.currentCandle.t,
      note,
      realizedPnl: realized,
    };
    this.fills.push(fill);
    return fill;
  }
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
