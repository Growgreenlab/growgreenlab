/**
 * Daily Replay — pure core (no DOM, no Supabase).
 *
 * Three pieces:
 *  1. validateDataset()    — strict validation of a loaded historical
 *     session before it may be previewed/locked. Missing candles are
 *     reported as gap warnings and NEVER fabricated.
 *  2. marketSessionStatus() — weekend / US exchange-holiday calendar so
 *     the UI can explain a non-trading date instead of substituting one.
 *  3. SealedCandleFeed     — the client half of server-sealed replay.
 *     The feed owns ONE growing Candle[] (single array identity, push
 *     mutations only) whose contents can never exceed the position the
 *     server reports for the attempt: ReplayEngine reads
 *     `candles.length` dynamically (its `atEnd` getter), so an engine
 *     built over `feed.candles` forms exactly the candles the server
 *     has released — and no others exist in client memory at all.
 *
 * The server half lives in supabase/migrations/daily-replay-v1.sql
 * (security-definer RPCs; the candles table has no direct policies).
 */
import type { Candle } from "./types";
import { formatEtTime } from "./marketData";

/** Daily Replay attempts always start from this balance — fully
 *  separate from the Trade Lab persistent account balance. */
export const DAILY_REPLAY_STARTING_BALANCE = 100_000;

/**
 * localStorage key reserved for NON-AUTHORITATIVE Daily Replay UI
 * preferences (e.g. the resume hint written at lock time). Deliberately
 * different from the Trade Lab balance key ("ggl-account-balance"):
 * Daily Replay code never reads or writes that key.
 */
export const DAILY_REPLAY_STATE_KEY: string = "ggl-daily-replay-state";

/* ------------------------------------------------------------------ */
/* ET date helpers                                                     */
/* ------------------------------------------------------------------ */

const etDateParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" in America/New_York for an epoch-ms instant. */
export function etDateString(ms: number): string {
  const parts = etDateParts.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/* ------------------------------------------------------------------ */
/* 1. Dataset validation                                               */
/* ------------------------------------------------------------------ */

export interface DatasetValidationOptions {
  ticker: string;
  /** Requested trading date, "YYYY-MM-DD" in America/New_York. */
  tradeDate: string;
  /** Expected minutes between candles. Defaults to 1. */
  timeframeMinutes?: number;
}

export interface GapRange {
  /** First missing candle's timestamp (epoch ms). */
  fromT: number;
  /** Last missing candle's timestamp (epoch ms). */
  toT: number;
  /** How many candles are missing in this range. */
  missing: number;
}

export interface DatasetValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  gaps: GapRange[];
  stats: {
    count: number;
    firstT: number | null;
    lastT: number | null;
    gapCount: number;
    missingCandles: number;
  };
}

const EPS = 1e-9;

/**
 * Validate a loaded candle series for Daily Replay.
 * Errors block the flow; gaps are warnings (data is never invented).
 */
export function validateDataset(
  candles: Candle[],
  opts: DatasetValidationOptions,
): DatasetValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const gaps: GapRange[] = [];
  const tf = Math.max(1, Math.floor(opts.timeframeMinutes ?? 1));
  const stepMs = tf * 60_000;
  const stats = {
    count: candles.length,
    firstT: candles.length ? candles[0].t : null,
    lastT: candles.length ? candles[candles.length - 1].t : null,
    gapCount: 0,
    missingCandles: 0,
  };

  if (candles.length === 0) {
    errors.push(
      `No candles returned for ${opts.ticker.toUpperCase()} on ${opts.tradeDate} — nothing to replay.`,
    );
    return { ok: false, errors, warnings, gaps, stats };
  }

  let badPrice = 0;
  let badVolume = 0;
  let badHigh = 0;
  let badLow = 0;
  let duplicates = 0;
  let outOfOrder = 0;
  let wrongDate = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const pricesOk = [c.o, c.h, c.l, c.c].every(
      (p) => Number.isFinite(p) && p > 0,
    );
    if (!pricesOk) badPrice++;
    if (!Number.isFinite(c.v) || c.v < 0) badVolume++;
    if (Number.isFinite(c.h) && Number.isFinite(c.o) && Number.isFinite(c.c)) {
      if (c.h < Math.max(c.o, c.c) - EPS) badHigh++;
    }
    if (Number.isFinite(c.l) && Number.isFinite(c.o) && Number.isFinite(c.c)) {
      if (c.l > Math.min(c.o, c.c) + EPS) badLow++;
    }
    if (Number.isFinite(c.t) && etDateString(c.t) !== opts.tradeDate) {
      wrongDate++;
    }
    if (i > 0) {
      const dt = c.t - candles[i - 1].t;
      if (dt === 0) {
        duplicates++;
      } else if (dt < 0) {
        outOfOrder++;
      } else if (dt > stepMs) {
        const missing = Math.round(dt / stepMs) - 1;
        if (missing > 0) {
          gaps.push({
            fromT: candles[i - 1].t + stepMs,
            toT: c.t - stepMs,
            missing,
          });
          stats.missingCandles += missing;
        }
      }
    }
  }
  stats.gapCount = gaps.length;

  if (duplicates > 0) {
    errors.push(
      `${duplicates} duplicate candle timestamp${duplicates === 1 ? "" : "s"} — each ${tf}-minute slot may appear only once.`,
    );
  }
  if (outOfOrder > 0) {
    errors.push(
      `Candles are not in chronological order (${outOfOrder} out-of-order step${outOfOrder === 1 ? "" : "s"}).`,
    );
  }
  if (badPrice > 0) {
    errors.push(
      `${badPrice} candle${badPrice === 1 ? "" : "s"} ha${badPrice === 1 ? "s" : "ve"} missing, non-finite, or non-positive prices.`,
    );
  }
  if (badVolume > 0) {
    errors.push(`${badVolume} candle${badVolume === 1 ? "" : "s"} ha${badVolume === 1 ? "s" : "ve"} invalid volume.`);
  }
  if (badHigh > 0) {
    errors.push(
      `${badHigh} candle${badHigh === 1 ? "" : "s"} violate${badHigh === 1 ? "s" : ""} the OHLC rule high ≥ max(open, close).`,
    );
  }
  if (badLow > 0) {
    errors.push(
      `${badLow} candle${badLow === 1 ? "" : "s"} violate${badLow === 1 ? "s" : ""} the OHLC rule low ≤ min(open, close).`,
    );
  }
  if (wrongDate > 0) {
    errors.push(
      `${wrongDate} candle${wrongDate === 1 ? "" : "s"} fall${wrongDate === 1 ? "s" : ""} outside ${opts.tradeDate} in America/New_York — refusing to substitute another date.`,
    );
  }

  const MAX_GAP_WARNINGS = 10;
  for (const g of gaps.slice(0, MAX_GAP_WARNINGS)) {
    warnings.push(
      `Missing ${g.missing} candle${g.missing === 1 ? "" : "s"} between ${formatEtTime(g.fromT)} and ${formatEtTime(g.toT)} ET — reported, never filled in.`,
    );
  }
  if (gaps.length > MAX_GAP_WARNINGS) {
    warnings.push(`…and ${gaps.length - MAX_GAP_WARNINGS} more gap${gaps.length - MAX_GAP_WARNINGS === 1 ? "" : "s"} like these.`);
  }

  return { ok: errors.length === 0, errors, warnings, gaps, stats };
}

/* ------------------------------------------------------------------ */
/* 2. Market-session calendar                                          */
/* ------------------------------------------------------------------ */

/**
 * NYSE full-day holidays, 2025–2027, including observed shifts when the
 * holiday falls on a weekend (e.g. Independence Day 2026 falls on a
 * Saturday, so the exchange closes Friday 2026-07-03).
 */
const US_EXCHANGE_HOLIDAYS: Record<string, string> = {
  // 2025
  "2025-01-01": "New Year's Day",
  "2025-01-20": "Martin Luther King Jr. Day",
  "2025-02-17": "Washington's Birthday (Presidents Day)",
  "2025-04-18": "Good Friday",
  "2025-05-26": "Memorial Day",
  "2025-06-19": "Juneteenth",
  "2025-07-04": "Independence Day",
  "2025-09-01": "Labor Day",
  "2025-11-27": "Thanksgiving Day",
  "2025-12-25": "Christmas Day",
  // 2026
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King Jr. Day",
  "2026-02-16": "Washington's Birthday (Presidents Day)",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day (observed)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
  // 2027
  "2027-01-01": "New Year's Day",
  "2027-01-18": "Martin Luther King Jr. Day",
  "2027-02-15": "Washington's Birthday (Presidents Day)",
  "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth (observed)",
  "2027-07-05": "Independence Day (observed)",
  "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving Day",
  "2027-12-24": "Christmas Day (observed)",
};

export interface MarketSessionStatus {
  isTradingDay: boolean;
  /** "Saturday" / "Sunday" / holiday name when closed; "Trading day" when open. */
  reason: string;
}

/**
 * Is `dateStr` ("YYYY-MM-DD", a calendar date in America/New_York) a
 * regular US exchange session? Weekday math is done on the calendar
 * date itself (UTC date arithmetic), never the viewer's local timezone.
 */
export function marketSessionStatus(dateStr: string): MarketSessionStatus {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return { isTradingDay: false, reason: "Invalid date" };
  const dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  if (dow === 0) return { isTradingDay: false, reason: "Sunday" };
  if (dow === 6) return { isTradingDay: false, reason: "Saturday" };
  const holiday = US_EXCHANGE_HOLIDAYS[dateStr];
  if (holiday) return { isTradingDay: false, reason: holiday };
  return { isTradingDay: true, reason: "Trading day" };
}

/* ------------------------------------------------------------------ */
/* 3. Sealed candle feed                                               */
/* ------------------------------------------------------------------ */

export interface CreateAttemptResult {
  attemptId: string;
  /** Index of the last revealed candle (the locked starting candle). */
  position: number;
  /** Revealed prefix: candles [0..position] (history + starting candle). */
  candles: Candle[];
}

export interface AdvanceResult {
  position: number;
  /** ONLY the newly revealed candles (old position + 1 .. new position). */
  candles: Candle[];
  finished: boolean;
}

export interface RevealedResult {
  position: number;
  candles: Candle[];
}

/**
 * Transport to the server-side sealing layer. Implementations must
 * enforce ownership + position server-side (see the dr_* RPCs in
 * supabase/migrations/daily-replay-v1.sql, and the in-memory fake in
 * lib/dailyReplay.test.ts that mirrors those rules).
 */
export interface SealedTransport {
  createAttempt(datasetId: string, startIndex: number): Promise<CreateAttemptResult>;
  advance(attemptId: string, steps: number): Promise<AdvanceResult>;
  getRevealed(attemptId: string): Promise<RevealedResult>;
}

export class SealedCandleFeed {
  /**
   * The revealed candles. ONE array for the feed's whole life: growth
   * happens by push() only, so a ReplayEngine constructed over this
   * reference sees new candles as they are released (the engine reads
   * `candles.length` dynamically and caches nothing).
   */
  readonly candles: Candle[] = [];
  /** Index of the last revealed candle; -1 before create(). */
  position = -1;
  finished = false;
  attemptId: string | null = null;
  /**
   * Non-fatal protocol note (e.g. the server returned candles beyond
   * its own reported position and the extras were discarded). Surfaced
   * by the UI; never silently ignored.
   */
  lastError: string | null = null;
  private total: number | null = null;

  constructor(private transport: SealedTransport) {}

  /** Tell the feed the dataset's full candle count (when the client
   *  legitimately knows it, e.g. from the preview it just uploaded). */
  setTotal(n: number): void {
    if (Number.isFinite(n) && n > 0) {
      this.total = Math.floor(n);
      if (this.position >= this.total - 1) this.finished = true;
    }
  }

  /** True when candle `index` has been released and is held locally. */
  has(index: number): boolean {
    return index >= 0 && index <= this.position && index < this.candles.length;
  }

  /**
   * Ensure candle `index` is held, advancing the server position in
   * batches until it is (or the dataset ends). Returns whether the
   * candle is held. The replay loop calls this — via advance() —
   * before the engine may form a candle beyond the held array.
   */
  async ensure(index: number, batch = 30): Promise<boolean> {
    while (!this.has(index) && !this.finished) {
      const before = this.position;
      await this.advance(batch);
      if (this.position === before) break; // server made no progress
    }
    return this.has(index);
  }

  /** Create the attempt server-side and ingest the revealed prefix. */
  async create(datasetId: string, startIndex: number): Promise<CreateAttemptResult> {
    if (this.attemptId !== null) {
      throw new Error("SealedCandleFeed: this feed already has an attempt.");
    }
    const r = await this.transport.createAttempt(datasetId, startIndex);
    this.attemptId = r.attemptId;
    this.ingestPrefix(r.candles, r.position);
    this.position = r.position;
    this.refreshFinished(false);
    return r;
  }

  /**
   * Ask the server to reveal up to `steps` more candles. Returns how
   * many candles were actually appended.
   */
  async advance(steps: number): Promise<number> {
    if (this.attemptId === null) {
      throw new Error("SealedCandleFeed: no attempt — call create() first.");
    }
    if (this.finished) return 0;
    const r = await this.transport.advance(this.attemptId, steps);
    if (r.position < this.position) {
      throw new Error(
        "SealedCandleFeed: server position moved backwards — refusing to continue.",
      );
    }
    const added = this.ingestIncrement(r.candles, r.position);
    this.position = r.position;
    this.refreshFinished(r.finished);
    return added;
  }

  /**
   * Attach this feed to an EXISTING attempt (refresh-resume) and sync
   * the server's revealed prefix into the local array. The position
   * remains whatever the server reports — attach can never move it,
   * and the starting candle stays the one locked at create() time.
   */
  async attach(attemptId: string): Promise<void> {
    if (this.attemptId !== null) {
      throw new Error("SealedCandleFeed: this feed already has an attempt.");
    }
    this.attemptId = attemptId;
    await this.sync();
  }

  /** Re-sync with the server's revealed prefix (e.g. after a reload). */
  async sync(): Promise<void> {
    if (this.attemptId === null) {
      throw new Error("SealedCandleFeed: no attempt — call create() first.");
    }
    const r = await this.transport.getRevealed(this.attemptId);
    if (r.position < this.position) {
      throw new Error(
        "SealedCandleFeed: server position moved backwards — refusing to continue.",
      );
    }
    this.ingestPrefix(r.candles, r.position);
    this.position = r.position;
    this.refreshFinished(false);
  }

  private refreshFinished(serverFinished: boolean): void {
    if (serverFinished) this.finished = true;
    if (this.total !== null && this.position >= this.total - 1) {
      this.finished = true;
    }
  }

  /**
   * Ingest a revealed prefix [0..reportedPosition]. Overlaps with what
   * we already hold must match exactly (timestamp-checked); anything
   * beyond the reported position is truncated and surfaced via
   * lastError — the feed must NEVER hold a candle past the position.
   */
  private ingestPrefix(incoming: Candle[], reportedPosition: number): void {
    const expected = reportedPosition + 1;
    let usable = incoming;
    if (incoming.length > expected) {
      this.lastError =
        "Server returned candles beyond the sealed position; the extras were discarded.";
      usable = incoming.slice(0, expected);
    }
    if (usable.length < expected) {
      throw new Error(
        "SealedCandleFeed: server returned fewer candles than its reported position.",
      );
    }
    for (let i = 0; i < usable.length; i++) {
      if (i < this.candles.length) {
        if (this.candles[i].t !== usable[i].t) {
          throw new Error(
            "SealedCandleFeed: server prefix disagrees with already-revealed candles.",
          );
        }
      } else {
        this.assertSequence(usable[i]);
        this.candles.push(usable[i]);
      }
    }
  }

  /**
   * Ingest newly revealed candles (old position + 1 .. newPosition).
   * The count must match the position delta exactly: fewer would leave
   * a gap (index corruption), more are truncated + surfaced.
   */
  private ingestIncrement(incoming: Candle[], newPosition: number): number {
    const delta = newPosition - this.position;
    let usable = incoming;
    if (incoming.length > delta) {
      this.lastError =
        "Server returned candles beyond the sealed position; the extras were discarded.";
      usable = incoming.slice(0, delta);
    }
    if (usable.length < delta) {
      throw new Error(
        "SealedCandleFeed: server advanced the position without returning every candle in between.",
      );
    }
    for (const c of usable) {
      this.assertSequence(c);
      this.candles.push(c);
    }
    return usable.length;
  }

  private assertSequence(c: Candle): void {
    const last = this.candles[this.candles.length - 1];
    if (last && !(c.t > last.t)) {
      throw new Error(
        "SealedCandleFeed: server returned candles out of chronological order.",
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Resume hint (non-authoritative UI preference)                       */
/* ------------------------------------------------------------------ */

export interface DailyReplayResumeHint {
  attemptId: string;
  datasetId: string;
  ticker: string;
  tradeDate: string;
  startIndex: number;
}

export function encodeDrResumeHint(h: DailyReplayResumeHint): string {
  return JSON.stringify(h);
}

export function decodeDrResumeHint(
  raw: string | null,
): DailyReplayResumeHint | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DailyReplayResumeHint>;
    if (
      typeof v.attemptId === "string" &&
      typeof v.datasetId === "string" &&
      typeof v.ticker === "string" &&
      typeof v.tradeDate === "string" &&
      typeof v.startIndex === "number" &&
      Number.isFinite(v.startIndex)
    ) {
      return {
        attemptId: v.attemptId,
        datasetId: v.datasetId,
        ticker: v.ticker,
        tradeDate: v.tradeDate,
        startIndex: v.startIndex,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}
