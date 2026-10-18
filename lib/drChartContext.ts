/**
 * drChartContext.ts — per-trade historical OHLCV context for the AI
 * Edge Export (Representative Screenshot plan §3.3/§5, Stage 1),
 * built ONLY from the session's stored candles (replay_sessions.
 * candles — the revealed set the client passed to dr_complete_attempt
 * at completion). Nothing is fetched, resampled or invented: stored
 * values pass through unmodified, dataset gaps stay gaps.
 *
 * THE TRUNCATION BOUNDARY (the no-hindsight rule, enforced here so no
 * consumer can break it accidentally):
 *   Let E = the trade's first entry fill's candle index and
 *   X = its closing fill's candle index.
 *   - `entry_context`: candles with index < E ONLY. These were
 *     complete before the entry candle began; their final OHLCV was
 *     fully visible at the fill. This is the ONLY section an AI may
 *     use to judge the entry decision.
 *   - `entry_candle_final`: candle E's FINAL OHLCV, in its own
 *     flagged section. At the fill the candle was still forming — its
 *     final high/low/close/volume include post-fill ticks and were
 *     NOT known at entry time.
 *   - `post_entry_development`: candles with E < index <= X — what
 *     happened while the position was open (the exit candle's final
 *     values likewise include post-exit ticks within its period).
 *   There is deliberately NO post-exit tail in v1.
 *
 * Validation is per trade and paranoid: the candle array's position
 * is the candle index ONLY because the stored set is the full
 * revealed day from index 0 — so candles[E] must exist and its `t`
 * must equal the trade's recorded entry time. Any mismatch makes
 * THIS trade's context unavailable (reason recorded); the builder
 * never index-shifts or guesses, and other trades are unaffected.
 */

export interface ChartCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type ChartContextSection = "entry_context" | "entry_candle_final" | "post_entry_development";

export interface ChartContextRow {
  section: ChartContextSection;
  candleIndex: number;
  /** Candle period start as ISO instant. */
  candleTime: string;
  /** Candle period start as HH:MM in America/New_York (the session's
   *  own timezone convention — candle `t` is the ET period start). */
  candleTimeEt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeChartContext {
  tradeId: string;
  tradeKey: string;
  symbol: string;
  attemptId: string | null;
  available: boolean;
  /** Why the context is unavailable (null when available). */
  unavailableReason: string | null;
  entryIndex: number | null;
  exitIndex: number | null;
  /** The entry candle's period start (ISO), when known. */
  entryTime: string | null;
  counts: { entryContext: number; entryCandleFinal: number; postEntry: number };
  /** Honest edge-case notes (empty entry context, same-candle round
   *  trip, dataset gaps) — surfaced in the package, never hidden. */
  notes: string[];
  rows: ChartContextRow[];
}

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function isCandle(x: unknown): x is ChartCandle {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return ["t", "o", "h", "l", "c", "v"].every(
    (k) => typeof c[k] === "number" && Number.isFinite(c[k] as number),
  );
}

export interface BuildTradeChartContextInput {
  tradeId: string;
  tradeKey: string;
  symbol: string;
  attemptId: string | null;
  entryCandleIndex: number | null;
  exitCandleIndex: number | null;
  /** The trade's recorded entry time (ISO) — the first entry fill's
   *  candle_time. Used to VALIDATE the candle array's alignment. */
  recordedEntryTime: string | null;
  /** The session's stored candles (unknown JSON — validated here). */
  candles: unknown;
}

export function buildTradeChartContext(input: BuildTradeChartContextInput): TradeChartContext {
  const base: TradeChartContext = {
    tradeId: input.tradeId,
    tradeKey: input.tradeKey,
    symbol: input.symbol,
    attemptId: input.attemptId,
    available: false,
    unavailableReason: null,
    entryIndex: input.entryCandleIndex,
    exitIndex: input.exitCandleIndex,
    entryTime: null,
    counts: { entryContext: 0, entryCandleFinal: 0, postEntry: 0 },
    notes: [],
    rows: [],
  };
  const unavailable = (reason: string): TradeChartContext => ({ ...base, unavailableReason: reason });

  if (!Array.isArray(input.candles) || input.candles.length === 0) {
    return unavailable("the session's stored candle set is missing or empty");
  }
  const candles: ChartCandle[] = [];
  for (const raw of input.candles) {
    if (!isCandle(raw)) return unavailable("the session's stored candles contain a malformed row");
    candles.push(raw);
  }
  // The stored set must be the full revealed day in order: strictly
  // increasing period starts. Anything else means the array is not
  // index-aligned and must not be sliced by candle index.
  for (let i = 1; i < candles.length; i++) {
    if (!(candles[i].t > candles[i - 1].t)) {
      return unavailable("the session's stored candles are not in strictly increasing time order");
    }
  }

  const E = input.entryCandleIndex;
  if (E == null || !Number.isInteger(E) || E < 0) {
    return unavailable("the trade has no recorded entry candle index");
  }
  const entryCandle = candles[E];
  if (!entryCandle) {
    return unavailable(`the stored candle set has no candle at the entry index ${E}`);
  }
  if (!input.recordedEntryTime) {
    return unavailable("the trade has no recorded entry time to validate the candle alignment against");
  }
  const recordedMs = Date.parse(input.recordedEntryTime);
  if (!Number.isFinite(recordedMs) || recordedMs !== entryCandle.t) {
    return unavailable("the stored candle at the entry index does not match the trade's recorded entry time — alignment unproven, context withheld rather than guessed");
  }

  const X = input.exitCandleIndex;
  const notes: string[] = [];
  if (E === 0) {
    notes.push("No completed candles before entry — entry-time structure cannot be assessed from OHLCV for this trade.");
  }
  if (X != null && X === E) {
    notes.push("Entry and exit filled in the same candle — there are no post-entry development rows.");
  }
  if (X != null && X < E) {
    notes.push("The recorded exit candle precedes the entry candle (data inconsistency) — post-entry development is withheld.");
  }
  // Dataset gaps are preserved as gaps: flag any step that differs
  // from the session's first step instead of silently bridging it.
  if (candles.length > 2) {
    const step0 = candles[1].t - candles[0].t;
    for (let i = 2; i < candles.length; i++) {
      if (candles[i].t - candles[i - 1].t !== step0) {
        notes.push("The stored dataset contains time gaps; they are preserved as gaps, never filled.");
        break;
      }
    }
  }

  const rows: ChartContextRow[] = [];
  const push = (section: ChartContextSection, idx: number) => {
    const c = candles[idx];
    rows.push({
      section,
      candleIndex: idx,
      candleTime: new Date(c.t).toISOString(),
      candleTimeEt: etFmt.format(new Date(c.t)),
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v,
    });
  };
  for (let i = 0; i < E; i++) push("entry_context", i);
  push("entry_candle_final", E);
  if (X != null && X > E) {
    for (let i = E + 1; i <= X; i++) push("post_entry_development", i);
  }

  return {
    ...base,
    available: true,
    entryTime: new Date(entryCandle.t).toISOString(),
    counts: {
      entryContext: rows.filter((r) => r.section === "entry_context").length,
      entryCandleFinal: 1,
      postEntry: rows.filter((r) => r.section === "post_entry_development").length,
    },
    notes,
    rows,
  };
}

/* ================= chart_context.csv ================================ */

export const CHART_CONTEXT_COLUMNS = [
  "trade_id", "symbol", "attempt_id", "section",
  "candle_index", "candle_time", "candle_time_et",
  "open", "high", "low", "close", "volume",
] as const;

function ccCsvEscape(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function ccNum(n: number): string {
  return String(Number(n.toFixed(6)));
}

/**
 * Serialize the available contexts to chart_context.csv (RFC-4180,
 * CRLF). Every row is self-describing (trade_id, symbol, attempt_id
 * on each row). Returns null when NO trade has context — the file is
 * then honestly absent from the package rather than present-but-empty.
 */
export function buildChartContextCsv(contexts: TradeChartContext[]): string | null {
  const available = contexts.filter((c) => c.available && c.rows.length > 0);
  if (available.length === 0) return null;
  const lines: string[] = [CHART_CONTEXT_COLUMNS.join(",")];
  for (const ctx of available) {
    for (const r of ctx.rows) {
      lines.push([
        ccCsvEscape(ctx.tradeId),
        ccCsvEscape(ctx.symbol),
        ccCsvEscape(ctx.attemptId ?? ""),
        r.section,
        String(r.candleIndex),
        r.candleTime,
        r.candleTimeEt,
        ccNum(r.open), ccNum(r.high), ccNum(r.low), ccNum(r.close), ccNum(r.volume),
      ].join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}

export interface ChartContextSummary {
  tradesWithContext: number;
  tradesUnavailable: number;
  /** Per unavailable trade: "TRADE-x: reason" lines for warnings. */
  unavailable: { tradeId: string; reason: string }[];
  /** Edge-case notes from available contexts, trade-prefixed. */
  notes: string[];
}

export function summarizeChartContexts(contexts: TradeChartContext[]): ChartContextSummary {
  const unavailable = contexts
    .filter((c) => !c.available)
    .map((c) => ({ tradeId: c.tradeId, reason: c.unavailableReason ?? "unknown reason" }));
  const notes: string[] = [];
  for (const c of contexts) {
    if (!c.available) continue;
    for (const n of c.notes) notes.push(`${c.tradeId}: ${n}`);
  }
  return {
    tradesWithContext: contexts.filter((c) => c.available).length,
    tradesUnavailable: unavailable.length,
    unavailable,
    notes,
  };
}
