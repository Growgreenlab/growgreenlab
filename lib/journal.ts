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

/* ================= Broker CSV import ================= */

export interface ParsedBrokerFill {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  fillTime: string | null; // ISO string
  fees: number;
  /** Deterministic dedup hash */
  hash: string;
  raw: Record<string, string>;
}

export interface BrokerParseResult {
  broker: string;
  fills: ParsedBrokerFill[];
  rejected: { row: number; reason: string }[];
  totalRows: number;
  /** Raw headers for manual mapping fallback */
  headers: string[];
  /** Auto-detected column mapping */
  detectedMap: Record<string, string>;
}

/** Fields the user can map */
export const MAPPABLE_FIELDS = [
  { key: "symbol", label: "Symbol *", aliases: ["symbol", "ticker", "instrument"] },
  { key: "side", label: "Side (Buy/Sell) *", aliases: ["b/s", "side", "action", "buy/sell", "direction"] },
  { key: "qty", label: "Quantity *", aliases: ["filled qty", "filled", "quantity", "qty", "filled qty", "shares", "volume"] },
  { key: "price", label: "Price *", aliases: ["filled avg price", "avg price", "average filled price", "price", "fill price", "average price", "execution price"] },
  { key: "time", label: "Fill Time", aliases: ["filled time", "fill time", "exec time", "execution time", "time", "date", "timestamp", "date/time", "datetime"] },
  { key: "fees", label: "Fees/Commission", aliases: ["commission", "comm", "fees", "fee"] },
  { key: "status", label: "Order Status", aliases: ["status", "order status", "state"] },
];

/** Try to auto-map headers to fields */
export function autoMapColumns(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const lower = headers.map((h) => h.toLowerCase());
  for (const field of MAPPABLE_FIELDS) {
    for (const alias of field.aliases) {
      const idx = lower.indexOf(alias);
      if (idx >= 0) { map[field.key] = headers[idx]; break; }
    }
  }
  return map;
}

/**
 * Parse CSV using an explicit column mapping (for non-Webull brokers).
 * mapping: { symbol: "Symbol", side: "Action", ... } — values are CSV header names.
 * statusFilter: only import rows where status column matches (e.g. "Filled"), or null for all.
 */
export function parseWithMapping(
  text: string,
  mapping: Record<string, string>,
  statusFilter: string | null,
  brokerName: string,
): BrokerParseResult {
  const rows = parseCsvRows(text);
  const headers = rows.length > 0 ? Object.keys(rows[0]).map((k) => {
    // Recover original-case header
    const line = text.trim().split(/\r?\n/)[0];
    return k;
  }) : [];
  const rejected: { row: number; reason: string }[] = [];
  const fills: ParsedBrokerFill[] = [];
  // Build lowercase lookup: header-lower -> actual key in row
  const headerLookup: Record<string, string> = {};
  if (rows.length > 0) {
    for (const k of Object.keys(rows[0])) headerLookup[k.toLowerCase()] = k;
  }
  const get = (row: Record<string, string>, fieldKey: string): string => {
    const headerName = mapping[fieldKey];
    if (!headerName) return "";
    const actualKey = headerLookup[headerName.toLowerCase()];
    return actualKey ? row[actualKey] : "";
  };

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    try {
      if (statusFilter && mapping.status) {
        const st = get(row, "status").toLowerCase();
        if (st !== statusFilter.toLowerCase()) return;
      }
      const symbol = get(row, "symbol").toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
      const sideRaw = get(row, "side").toLowerCase();
      const side = sideRaw.startsWith("buy") ? "buy" : sideRaw.startsWith("sell") ? "sell" : null;
      const qty = parseNum(get(row, "qty"));
      const price = parseNum(get(row, "price"));
      const fees = parseNum(get(row, "fees")) || 0;
      const fillTime = parseBrokerTime(get(row, "time"));

      if (!symbol) { rejected.push({ row: rowNum, reason: "Missing symbol" }); return; }
      if (!side) { rejected.push({ row: rowNum, reason: `Unknown side: "${get(row, "side")}"` }); return; }
      if (!isFinite(qty) || qty <= 0) { rejected.push({ row: rowNum, reason: "Invalid quantity" }); return; }
      if (!isFinite(price) || price <= 0) { rejected.push({ row: rowNum, reason: "Invalid price" }); return; }

      fills.push({
        symbol, side, qty, price, fillTime, fees,
        hash: fillHash(symbol, side, qty, price, fillTime),
        raw: row,
      });
    } catch {
      rejected.push({ row: rowNum, reason: "Parse error" });
    }
  });

  return { broker: brokerName, fills, rejected, totalRows: rows.length, headers: Object.keys(headerLookup).map((k) => headerLookup[k]), detectedMap: mapping };
}

/** Simple deterministic hash (djb2) for dedup */
export function fillHash(symbol: string, side: string, qty: number, price: number, fillTime: string | null): string {
  const s = `${symbol}|${side}|${qty}|${price}|${fillTime ?? ""}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  // Handle quoted fields with commas
  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === "," && !inQ) { out.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = splitLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).filter((l) => l.trim()).map((line) => {
    const vals = splitLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
}

/** Parse a number that may have $ , or other formatting */
function parseNum(s: string): number {
  if (!s) return NaN;
  return parseFloat(s.replace(/[$,\s]/g, ""));
}

/** Parse "11/14/2025 11:31:56 EST" → ISO string */
function parseBrokerTime(s: string): string | null {
  if (!s) return null;
  // Try native parse first
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  // Try MM/DD/YYYY HH:MM:SS TZ
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(\w+)?/);
  if (m) {
    const [, mo, da, yr, hh, mm, ss] = m;
    const iso = `${yr}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm}:${ss ?? "00"}`;
    const d2 = new Date(iso);
    if (!isNaN(d2.getTime())) return d2.toISOString();
  }
  return null;
}

/**
 * Parse a broker CSV export. Auto-detects Webull format;
 * falls back to generic column matching.
 */
export function parseBrokerCsv(text: string): BrokerParseResult {
  const rows = parseCsvRows(text);
  const rejected: { row: number; reason: string }[] = [];
  const fills: ParsedBrokerFill[] = [];

  // Detect Webull: has "filled time" + price column (either "avg price" or "filled avg price" format)
  const sampleKeys = rows.length > 0 ? Object.keys(rows[0]) : [];
  const isWebull = sampleKeys.includes("filled time") &&
    (sampleKeys.includes("avg price") || sampleKeys.includes("filled avg price"));
  const broker = isWebull ? "Webull" : "Generic";

  // Column aliases
  const col = (row: Record<string, string>, ...names: string[]): string => {
    for (const n of names) {
      const v = row[n.toLowerCase()];
      if (v) return v;
    }
    return "";
  };

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // 1-based + header
    try {
      // Webull Trade Record export has no Status column — all rows are filled trades.
      // Webull Order History export has Status — only process Filled ones.
      if (isWebull && sampleKeys.includes("status")) {
        const status = col(row, "status").toLowerCase();
        if (status !== "filled") return; // skip pending/cancelled silently
      }
      const symbol = col(row, "symbol", "ticker").toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
      const sideRaw = col(row, "b/s", "side", "action").toLowerCase();
      const side = sideRaw.startsWith("buy") ? "buy" : sideRaw.startsWith("sell") ? "sell" : null;
      const qty = parseNum(col(row, "filled qty", "filled", "quantity", "qty"));
      const price = parseNum(col(row, "filled avg price", "avg price", "average filled price", "price", "fill price", "average price"));
      const fillTimeRaw = col(row, "filled time", "fill time", "exec time", "execution time", "time", "date");
      // Webull splits fees: Commission + Fee columns
      const commission = parseNum(col(row, "commission", "comm")) || 0;
      const fee = parseNum(col(row, "fee", "fees")) || 0;
      const fees = commission + fee;

      if (!symbol) { rejected.push({ row: rowNum, reason: "Missing symbol" }); return; }
      if (!side) { rejected.push({ row: rowNum, reason: `Unknown side: "${sideRaw}"` }); return; }
      if (!isFinite(qty) || qty <= 0) { rejected.push({ row: rowNum, reason: "Invalid quantity" }); return; }
      if (!isFinite(price) || price <= 0) { rejected.push({ row: rowNum, reason: "Invalid price" }); return; }

      const fillTime = parseBrokerTime(fillTimeRaw);
      fills.push({
        symbol, side, qty, price, fillTime, fees,
        hash: fillHash(symbol, side, qty, price, fillTime),
        raw: row,
      });
    } catch {
      rejected.push({ row: rowNum, reason: "Parse error" });
    }
  });

  return { broker, fills, rejected, totalRows: rows.length, headers: sampleKeys, detectedMap: autoMapColumns(sampleKeys) };
}

/**
 * Group imported fills into trades by symbol + position cycles.
 * Returns trades ready for DB insert.
 */
export interface ImportedTrade {
  ticker: string;
  tradeDate: string;
  direction: "long" | "short";
  fills: ParsedBrokerFill[];
}

export function groupImportedFills(fills: ParsedBrokerFill[]): ImportedTrade[] {
  // Group by symbol first
  const bySymbol = new Map<string, ParsedBrokerFill[]>();
  for (const f of fills) {
    if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, []);
    bySymbol.get(f.symbol)!.push(f);
  }
  const trades: ImportedTrade[] = [];
  for (const [symbol, symFills] of bySymbol) {
    const sorted = [...symFills].sort((a, b) =>
      new Date(a.fillTime ?? 0).getTime() - new Date(b.fillTime ?? 0).getTime()
    );
    let position = 0;
    let current: ParsedBrokerFill[] = [];
    let firstSide: "buy" | "sell" | null = null;
    const flush = () => {
      if (current.length === 0) return;
      const direction: "long" | "short" = firstSide === "sell" ? "short" : "long";
      const dateStr = current[0].fillTime ? current[0].fillTime.slice(0, 10) : new Date().toISOString().slice(0, 10);
      trades.push({ ticker: symbol, tradeDate: dateStr, direction, fills: [...current] });
      current = []; position = 0; firstSide = null;
    };
    for (const f of sorted) {
      if (firstSide == null) firstSide = f.side;
      position += f.side === "buy" ? f.qty : -f.qty;
      // For shorts, position goes negative; normalize
      const normPos = firstSide === "sell" ? -position : position;
      current.push(f);
      if (Math.abs(normPos) < 1e-9 && current.length > 0) flush();
    }
    if (current.length > 0) {
      // Open position — still import as open trade
      const direction: "long" | "short" = firstSide === "sell" ? "short" : "long";
      const dateStr = current[0].fillTime ? current[0].fillTime.slice(0, 10) : new Date().toISOString().slice(0, 10);
      trades.push({ ticker: symbol, tradeDate: dateStr, direction, fills: [...current] });
    }
  }
  return trades.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
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

/* ================= Real-market trades: FIFO accounting ================= */

export interface RealFill {
  id: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  fees: number;
  fill_time: string | null;
}

export interface RealTradeCalc {
  /** Weighted average entry price across all entry fills */
  avgEntry: number | null;
  /** Total entry quantity */
  entryQty: number;
  /** Quantity still open */
  openQty: number;
  /** Gross realized P&L (before fees) */
  grossRealized: number;
  /** Total fees across all fills */
  totalFees: number;
  /** Net realized P&L (after fees) */
  netRealized: number;
  /** Initial risk in $ (null when stop loss missing) */
  initialRisk: number | null;
  /** R-multiple (null when risk missing/invalid) */
  rMultiple: number | null;
  /** Risk-to-reward ratio (null when risk or target missing) */
  riskReward: number | null;
  /** Whether position is fully closed */
  isClosed: boolean;
}

/**
 * FIFO matching for real-market trades.
 * Long: buys are entries, sells are exits. Short: reversed.
 * Each exit fill matches against oldest unmatched entry fills.
 */
export function calcRealTrade(
  fills: RealFill[],
  direction: "long" | "short",
  stopLoss: number | null,
  target: number | null,
): RealTradeCalc {
  const sorted = [...fills].sort((a, b) =>
    new Date(a.fill_time ?? 0).getTime() - new Date(b.fill_time ?? 0).getTime()
  );
  const isEntry = (f: RealFill) =>
    direction === "long" ? f.side === "buy" : f.side === "sell";

  // FIFO queue of unmatched entry lots: { qty, price }
  const lots: { qty: number; price: number }[] = [];
  let grossRealized = 0;
  let totalFees = 0;
  let entryQty = 0;
  let entryCost = 0;

  for (const f of sorted) {
    const q = Number(f.qty), p = Number(f.price);
    totalFees += Number(f.fees || 0);
    if (isEntry(f)) {
      lots.push({ qty: q, price: p });
      entryQty += q;
      entryCost += p * q;
    } else {
      let remaining = q;
      while (remaining > 1e-9 && lots.length > 0) {
        const lot = lots[0];
        const matched = Math.min(remaining, lot.qty);
        const pnlPerShare = direction === "long" ? p - lot.price : lot.price - p;
        grossRealized += pnlPerShare * matched;
        lot.qty -= matched;
        remaining -= matched;
        if (lot.qty < 1e-9) lots.shift();
      }
      // Excess exit beyond entries: treat as reducing/closing (no cost basis)
      // — unmatched exits don't generate P&L beyond matched portion.
    }
  }

  const openQty = lots.reduce((s, l) => s + l.qty, 0);
  const avgEntry = entryQty > 0 ? entryCost / entryQty : null;
  const netRealized = grossRealized - totalFees;
  const isClosed = openQty < 1e-9 && entryQty > 0;

  // Initial risk: |entry - stop| × closed qty (use entry qty for open trades)
  let initialRisk: number | null = null;
  if (stopLoss != null && avgEntry != null && avgEntry > 0 && entryQty > 0) {
    const riskPerShare = Math.abs(avgEntry - stopLoss);
    if (riskPerShare > 0) initialRisk = riskPerShare * entryQty;
  }
  const rMultiple = initialRisk != null && initialRisk > 0 ? netRealized / initialRisk : null;

  let riskReward: number | null = null;
  if (stopLoss != null && target != null && avgEntry != null && avgEntry > 0) {
    const risk = Math.abs(avgEntry - stopLoss);
    const reward = Math.abs(target - avgEntry);
    if (risk > 0) riskReward = reward / risk;
  }

  return {
    avgEntry, entryQty, openQty,
    grossRealized, totalFees, netRealized,
    initialRisk, rMultiple, riskReward,
    isClosed,
  };
}

/* ================= Quick entry (single entry/exit) =================
 * The Add Real Trade form's simple path: entry price, optional exit
 * price, quantity, total fees. It does NOT create a second P&L system —
 * quickFills() converts the values into ordinary fills and calcRealTrade
 * remains the single source of truth for realized P&L, so Overview,
 * Analytics, Daily P&L and breakdowns stay consistent automatically.
 * The recorded stop loss is a separate input and is never derived from
 * the exit price; R-multiples keep using initial risk as before. */

/**
 * Live quick-entry P&L. Returns null when the trade is not complete
 * (no exit price) or any input is invalid — an open trade has no
 * realized P&L yet, and a missing exit is never fabricated.
 *   LONG:  gross = (exit − entry) × qty
 *   SHORT: gross = (entry − exit) × qty
 *   net = gross − totalFees
 */
export function quickPnl(
  direction: "long" | "short",
  entryPrice: number,
  exitPrice: number | null,
  qty: number,
  totalFees: number,
): { gross: number; net: number } | null {
  if (exitPrice == null) return null;
  if (!(entryPrice > 0) || !(exitPrice > 0) || !(qty > 0) || !(totalFees >= 0)) return null;
  const gross = (direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice) * qty;
  return { gross, net: gross - totalFees };
}

export interface QuickFill {
  side: "buy" | "sell";
  qty: number;
  price: number;
  fees: number;
}

/**
 * Convert quick-entry values into fills for calcRealTrade:
 *  - entry fill on the opening side (long → buy, short → sell),
 *    carrying the total fees so the net matches quickPnl exactly;
 *  - when an exit price is present, one closing fill on the opposite
 *    side for the full quantity (partial exits are built with the
 *    detailed fills editor, not here);
 *  - when the exit price is absent, only the entry fill — the trade
 *    stays open with no realized P&L.
 * Returns [] for invalid entry/qty/fees.
 */
export function quickFills(
  direction: "long" | "short",
  entryPrice: number,
  exitPrice: number | null,
  qty: number,
  totalFees: number,
): QuickFill[] {
  if (!(entryPrice > 0) || !(qty > 0) || !(totalFees >= 0)) return [];
  if (exitPrice != null && !(exitPrice > 0)) return [];
  const entrySide: "buy" | "sell" = direction === "long" ? "buy" : "sell";
  const exitSide: "buy" | "sell" = direction === "long" ? "sell" : "buy";
  const fills: QuickFill[] = [{ side: entrySide, qty, price: entryPrice, fees: totalFees }];
  if (exitPrice != null) fills.push({ side: exitSide, qty, price: exitPrice, fees: 0 });
  return fills;
}
