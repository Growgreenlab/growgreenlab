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
import { ReplayEngine } from "./engine";

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

const etTimeParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Minutes since midnight in America/New_York for an epoch-ms instant. */
export function etMinutesOfDay(ms: number): number {
  const parts = etTimeParts.formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (h % 24) * 60 + m; // hour can read "24" at midnight in some runtimes
}

/** 09:30 ET in minutes-of-day: the regular-session open. A dataset has
 *  premarket data iff at least one candle on the trade date starts
 *  before this minute. */
export const REGULAR_SESSION_OPEN_MINUTES_ET = 9 * 60 + 30;

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
    /** True iff at least one candle on the trade date starts before
     *  09:30 ET (premarket coverage). Purely descriptive — it never
     *  changes the ok/errors verdicts. */
    premarketAvailable: boolean;
    /** ET wall-clock time ("HH:MM") of the first candle, or null. */
    firstCandleEt: string | null;
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
    premarketAvailable: false,
    firstCandleEt: null as string | null,
  };

  if (candles.length === 0) {
    errors.push(
      `No candles returned for ${opts.ticker.toUpperCase()} on ${opts.tradeDate} — nothing to replay.`,
    );
    return { ok: false, errors, warnings, gaps, stats };
  }

  // Premarket coverage, known the moment the dataset is loaded: any
  // candle on the trade date before the 09:30 ET regular-session open.
  // (The fetch window is 04:00–16:00 ET, so a dataset whose first
  // candle is the 09:30 open is regular-session only.)
  stats.firstCandleEt = formatEtTime(candles[0].t);
  stats.premarketAvailable = candles.some(
    (c) =>
      Number.isFinite(c.t) &&
      etDateString(c.t) === opts.tradeDate &&
      etMinutesOfDay(c.t) < REGULAR_SESSION_OPEN_MINUTES_ET,
  );

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
/* 1b. Locked-candle highlight + premarket warning gate                */
/* ------------------------------------------------------------------ */

export interface HighlightBand {
  /** Band start: the highlighted candle's timestamp, epoch seconds. */
  timeSec: number;
  /** Band width in seconds: exactly one candle interval, so the band
   *  covers the target candle and neither neighbor. */
  spanSec: number;
}

/**
 * The highlight band for `candles[index]` (the selected candle in the
 * preview; the locked starting candle once an attempt is active,
 * including after resume, where index is the attempt's startIndex into
 * the same dataset-ordered candle array). Purely presentational:
 * returns null for an out-of-range index and never touches replay
 * state. The span is the distance to the next candle (the previous
 * candle's spacing for the last one; 60s for a lone candle).
 */
export function highlightBandFor(
  candles: Candle[],
  index: number,
): HighlightBand | null {
  if (!Number.isFinite(index)) return null;
  const i = Math.floor(index);
  if (i < 0 || i >= candles.length) return null;
  const c = candles[i];
  let spanMs = 60_000;
  if (i + 1 < candles.length) spanMs = candles[i + 1].t - c.t;
  else if (i > 0) spanMs = c.t - candles[i - 1].t;
  if (!(spanMs > 0)) spanMs = 60_000;
  return { timeSec: Math.floor(c.t / 1000), spanSec: spanMs / 1000 };
}

/** One bar as actually DISPLAYED on the chart (after any timeframe
 *  aggregation the parent applied): its own timestamp in epoch
 *  seconds plus its price extent. */
export interface HighlightDisplayBar {
  timeSec: number;
  high: number;
  low: number;
}

export interface ResolvedHighlightBar {
  /** The displayed bar containing the target time, epoch seconds. */
  barTime: number;
  high: number;
  low: number;
  /** The bar's own span in seconds (distance to the next displayed
   *  bar; the previous bar's spacing for the last one; 60 if alone). */
  spanSec: number;
}

/**
 * Resolve the DISPLAYED bar that contains `targetTimeSec` — the bar
 * with barTime <= target < barTime + spanSec. On a 1-minute view that
 * is exactly the target candle; on an aggregated timeframe it is the
 * visible aggregated bar the target minute falls inside, so a glow
 * outline can hug the candle the user actually sees. Returns null
 * when the target precedes the first displayed bar or falls at/after
 * the end of the last displayed bar. Purely presentational.
 */
export function resolveHighlightBar(
  bars: HighlightDisplayBar[],
  targetTimeSec: number,
): ResolvedHighlightBar | null {
  if (bars.length === 0 || !Number.isFinite(targetTimeSec)) return null;
  // Candidate: the last bar starting at or before the target.
  let i = -1;
  for (let k = 0; k < bars.length; k++) {
    if (bars[k].timeSec <= targetTimeSec) i = k;
    else break;
  }
  if (i < 0) return null; // target before the first displayed bar
  const bar = bars[i];
  let spanSec = 60;
  if (i + 1 < bars.length) spanSec = bars[i + 1].timeSec - bar.timeSec;
  else if (i > 0) spanSec = bar.timeSec - bars[i - 1].timeSec;
  if (!(spanSec > 0)) spanSec = 60;
  // At/after the candidate bar's end (only reachable for the last bar,
  // whose end no later bar delimits): the target is not displayed.
  if (targetTimeSec >= bar.timeSec + spanSec) return null;
  return { barTime: bar.timeSec, high: bar.high, low: bar.low, spanSec };
}

/** Stable identity of one loaded dataset, for per-dataset UI state
 *  (e.g. "the premarket warning was dismissed for THIS dataset"). */
export function drDatasetKey(
  ticker: string,
  tradeDate: string,
  candleCount: number,
): string {
  return `${ticker.toUpperCase()}|${tradeDate}|${candleCount}`;
}

export interface PremarketWarningGate {
  /** Show the PREMARKET DATA UNAVAILABLE banner. */
  showWarning: boolean;
  /** While true, starting-candle selection + the Lock button stay
   *  disabled (the chart itself remains viewable/pannable). */
  blockSelection: boolean;
}

/**
 * Premarket warning gate for the Daily Replay preview. The warning is
 * owed exactly when the loaded dataset has no premarket candles and
 * the user has not dismissed it for this dataset. Dismissal is keyed
 * by dataset, so switching ticker/date (a new key) re-evaluates and
 * re-shows; ordinary interactions within the same dataset never do.
 */
export function premarketWarningGate(input: {
  premarketAvailable: boolean;
  datasetKey: string;
  dismissedKey: string | null;
}): PremarketWarningGate {
  const showWarning =
    !input.premarketAvailable && input.dismissedKey !== input.datasetKey;
  return { showWarning, blockSelection: showWarning };
}

/**
 * Visibility of the in-replay (chart-overlay) PREMARKET DATA
 * UNAVAILABLE notice. That overlay is a STANDARD-replay surface: it
 * shows while a standard session whose premarket data is unavailable
 * is running, until the user dismisses it.
 *
 * Daily Replay has exactly one premarket surface — the load-time
 * preview gate above (premarketWarningGate). Once a DR attempt exists
 * (phase "active" or "done"; resumed attempts re-enter "active"), the
 * user has already seen the warning, dismissed it to unlock selection,
 * and confirmed the start, so the overlay NEVER renders in those
 * phases — regardless of the overlay's own dismissal state, which is
 * a separate standard-replay state the preview gate never touches.
 * Phases "off" (standard replay) and "preview" (no attempt yet)
 * follow the standard rule unchanged.
 */
export function premarketOverlayVisible(input: {
  phase: "off" | "preview" | "active" | "done";
  premarketUnavailable: boolean;
  dismissed: boolean;
}): boolean {
  if (input.phase === "active" || input.phase === "done") return false;
  return input.premarketUnavailable && !input.dismissed;
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
   * Ensure candle `index` is held — the STRICT release gate.
   *
   * Release-on-consume: the server position advances exactly ONE
   * candle per transport call, and the loop stops the moment `index`
   * is held, so this method can never leave the array holding a
   * candle beyond `index`. Callers (the page's play loop and Step
   * button) pass only the index of the candle the engine is about to
   * form, which keeps the invariant: at any moment the array holds
   * nothing beyond the currently forming candle. No batch prefetch
   * exists anywhere in the Daily Replay flow.
   *
   * Returns whether the candle is held (false only when the dataset
   * ended first). A transport failure propagates to the caller with
   * the feed untouched — the failed candle is not partially ingested —
   * so a later retry is safe.
   */
  async ensure(index: number): Promise<boolean> {
    while (!this.has(index) && !this.finished) {
      const before = this.position;
      await this.advance(1);
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
/* Attempt engine construction (the locked-candle boundary)            */
/* ------------------------------------------------------------------ */

/**
 * Build the ReplayEngine for a Daily Replay attempt whose LOCKED
 * candle is `lockIndex` (the attempt's stored start_index).
 *
 * Boundary contract: the locked candle is the LAST COMPLETED
 * historical candle — it stands fully revealed as history — and the
 * NEXT candle (lockIndex + 1) is the first one that forms
 * tick-by-tick. ReplayEngine's own startIndex means "first LIVE
 * candle", so the engine is constructed with lockIndex + 1. For the
 * engine to form that candle it must already hold it, so exactly one
 * more candle is released from the server first (feed.advance(1)) —
 * after create() the server position sits AT the locked candle.
 *
 * Degenerate case — the locked candle is the dataset's final candle:
 * nothing exists after it. advance() is then a no-op (the feed is
 * finished), the engine constructor clamps its startIndex onto the
 * locked candle and begins forming it; that formation is finalized
 * instantly here (the engine is flat with no orders at construction,
 * so step() can produce no fills) so the locked candle stands as
 * completed history and the attempt opens already at its end instead
 * of re-forming its final candle.
 */
export async function buildDrEngine(
  feed: SealedCandleFeed,
  lockIndex: number,
  startingBalance: number,
): Promise<ReplayEngine> {
  if (!feed.finished && feed.position <= lockIndex) {
    await feed.advance(1);
  }
  const engine = new ReplayEngine(feed.candles, startingBalance, lockIndex + 1);
  if (
    feed.finished &&
    lockIndex >= feed.candles.length - 1 &&
    engine.index < lockIndex
  ) {
    engine.step();
  }
  return engine;
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
