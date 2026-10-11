/**
 * journal.ts — Trade grouping and metrics for the Trade Journal.
 *
 * Groups individual fills from session_trades into position-cycle trades:
 * a trade opens when position goes from flat to non-zero, and closes when
 * it returns to flat. Deterministic trade keys enable idempotent annotations.
 */

export interface RawFill {
  id: string;
  session_id: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  candle_index: number;
  candle_time: string | null;
  realized_pnl: number;
  created_at: string;
}

export interface GroupedTrade {
  /** Deterministic: "{session_id}:{sequence}" */
  tradeKey: string;
  sessionId: string;
  ticker: string;
  tradeDate: string;
  source: string;
  sequence: number;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  entryTime: string | null;
  exitTime: string | null;
  realizedPnl: number;
  fees: number;
  fills: RawFill[];
  /** R-multiple needs initial risk; null when stop loss unknown */
  rMultiple: number | null;
}

/**
 * Group fills into position-cycle trades.
 * Fills must be sorted chronologically (by created_at, then candle_index).
 */
export function groupFillsIntoTrades(
  fills: RawFill[],
  sessionMeta: { id: string; ticker: string; trade_date: string; source: string },
): GroupedTrade[] {
  const trades: GroupedTrade[] = [];
  let position = 0;
  let current: RawFill[] = [];
  let sequence = 0;

  const closeTrade = () => {
    if (current.length === 0) return;
    sequence++;
    const buys = current.filter((f) => f.side === "buy");
    const sells = current.filter((f) => f.side === "sell");
    const buyQty = buys.reduce((s, f) => s + Number(f.qty), 0);
    const sellQty = sells.reduce((s, f) => s + Number(f.qty), 0);
    const direction: "long" | "short" = buyQty >= sellQty ? "long" : "short";

    // Weighted average entry/exit
    const entryFills = direction === "long" ? buys : sells;
    const exitFills = direction === "long" ? sells : buys;
    const entryQty = entryFills.reduce((s, f) => s + Number(f.qty), 0);
    const exitQty = exitFills.reduce((s, f) => s + Number(f.qty), 0);
    const entryPrice = entryQty > 0
      ? entryFills.reduce((s, f) => s + Number(f.price) * Number(f.qty), 0) / entryQty
      : 0;
    const exitPrice = exitQty > 0
      ? exitFills.reduce((s, f) => s + Number(f.price) * Number(f.qty), 0) / exitQty
      : 0;
    const qty = Math.min(entryQty, exitQty);
    // Sum realized P&L from closing fills
    const realizedPnl = current.reduce((s, f) => s + Number(f.realized_pnl || 0), 0);

    trades.push({
      tradeKey: `${sessionMeta.id}:${sequence}`,
      sessionId: sessionMeta.id,
      ticker: sessionMeta.ticker,
      tradeDate: sessionMeta.trade_date,
      source: sessionMeta.source,
      sequence,
      direction,
      entryPrice,
      exitPrice,
      qty,
      entryTime: current[0].candle_time,
      exitTime: current[current.length - 1].candle_time,
      realizedPnl,
      fees: 0, // TODO: extract from engine when fee tracking is exposed
      fills: [...current],
      rMultiple: null, // needs initial risk; set when stop loss is recorded
    });
    current = [];
    position = 0;
  };

  for (const fill of fills) {
    const q = Number(fill.qty);
    if (fill.side === "buy") position += q;
    else position -= q;
    current.push(fill);
    // Position returned to flat → trade closed
    if (Math.abs(position) < 1e-9 && current.length > 0) {
      closeTrade();
    }
  }
  // Open position at end → not a closed trade, exclude from stats
  return trades;
}

export interface JournalMetrics {
  totalTrades: number;
  winners: number;
  losers: number;
  breakeven: number;
  winRate: number | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  avgWin: number | null;
  avgLoss: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
}

export function calcMetrics(trades: { realizedPnl: number }[]): JournalMetrics {
  const closed = trades;
  const winners = closed.filter((t) => t.realizedPnl > 0);
  const losers = closed.filter((t) => t.realizedPnl < 0);
  const breakeven = closed.filter((t) => t.realizedPnl === 0);
  const grossProfit = winners.reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.realizedPnl, 0));
  const netPnl = grossProfit - grossLoss;

  return {
    totalTrades: closed.length,
    winners: winners.length,
    losers: losers.length,
    breakeven: breakeven.length,
    winRate: closed.length > 0 ? (winners.length / closed.length) * 100 : null,
    netPnl,
    grossProfit,
    grossLoss,
    avgWin: winners.length > 0 ? grossProfit / winners.length : null,
    avgLoss: losers.length > 0 ? -(grossLoss / losers.length) : null,
    largestWin: winners.length > 0 ? Math.max(...winners.map((t) => t.realizedPnl)) : null,
    largestLoss: losers.length > 0 ? Math.min(...losers.map((t) => t.realizedPnl)) : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    expectancy: closed.length > 0 ? netPnl / closed.length : null,
  };
}

/** Format money with sign and 2 decimals */
export function fmtPnl(n: number | null): string {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPct(n: number | null): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}
