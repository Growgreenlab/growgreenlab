/**
 * Pure viewport math for chart readability (extracted from
 * components/LwcChart.tsx so the exact production numbers are
 * unit-testable — see lib/chartFit.test.ts).
 *
 * Two independent readability problems on narrow screens, neither of
 * which distorts data:
 *
 * 1. VERTICAL: lightweight-charts' default price-scale margins
 *    (top 0.2 / bottom 0.2) map the session's price range into the
 *    middle 60% of the pane height. The margins below map it into
 *    [0.07, 0.85] = 78% of the pane, with the volume strip occupying
 *    [0.85, 1.0] — the two regions share the 0.85 boundary exactly,
 *    so volume never overlaps candles and no height is wasted.
 *    The price→pixel mapping stays linear and exact.
 *
 * 2. HORIZONTAL: fitContent() on a full session (390 bars) in a
 *    ~300px phone plot yields ~0.77px per bar — bodies are sub-pixel
 *    hairlines. For parents that OPT IN (Daily Replay's preview,
 *    which passes its selected-candle index), the initial view on
 *    narrow containers instead opens on a readable window of bars
 *    (~2.2px spacing) that CONTAINS the selected candle — session
 *    start when the selection is the opening candle — with the rest
 *    of the day one pan away and a "Fit all" control to return to
 *    the full-session view. Parents that don't opt in (drills,
 *    standard Trade Lab) keep the plain full fit, and desktop
 *    containers always fit everything.
 */

/** Candle (right) price-scale margins: range uses 78% of pane height. */
export const CANDLE_SCALE_MARGINS = { top: 0.07, bottom: 0.15 } as const;

/** Volume overlay-scale margins: bottom 15% strip, boundary-aligned. */
export const VOLUME_SCALE_MARGINS = { top: 0.85, bottom: 0 } as const;

/** Containers at or below this width count as narrow (phones). */
export const NARROW_CONTAINER_MAX_PX = 560;

/** Bar spacing (px) the readable window targets. */
export const READABLE_WINDOW_TARGET_SPACING_PX = 2.2;

export interface ReadableWindowInput {
  /** Width of the plotting area (time-scale width, excl. price axis), px. */
  plotWidthPx: number;
  /** Number of bars in the dataset being fitted. */
  barCount: number;
  /** Width of the whole chart container, px (the narrow-screen gate). */
  containerWidthPx: number;
  /**
   * Index of the candle the window must contain (the parent's
   * selected starting candle). Defaults to 0 — the session start —
   * so the opening candle is visible and selectable immediately.
   */
  anchorIndex?: number;
}

export interface LogicalRange {
  from: number;
  to: number;
}

/**
 * The initial visible logical range for the readable window, or null
 * when the plain full fit should stand. Null unless ALL of:
 *  - the container is narrow (<= NARROW_CONTAINER_MAX_PX), and
 *  - fitting every bar would squeeze spacing below
 *    READABLE_WINDOW_TARGET_SPACING_PX.
 * The window holds floor(plotWidth / TARGET) bars (never more than
 * the dataset), positioned so the anchor index is inside it — a
 * quarter-window of context before the anchor where possible,
 * clamped to the dataset at both ends.
 */
export function readableWindow(input: ReadableWindowInput): LogicalRange | null {
  const { plotWidthPx, barCount, containerWidthPx } = input;
  if (!Number.isFinite(barCount) || barCount <= 0) return null;
  if (!Number.isFinite(plotWidthPx) || plotWidthPx <= 0) return null;
  if (
    !Number.isFinite(containerWidthPx) ||
    containerWidthPx > NARROW_CONTAINER_MAX_PX
  ) {
    return null;
  }
  if (plotWidthPx / barCount >= READABLE_WINDOW_TARGET_SPACING_PX) return null;
  const count = Math.max(
    1,
    Math.floor(plotWidthPx / READABLE_WINDOW_TARGET_SPACING_PX),
  );
  if (count >= barCount) return null;
  const anchorRaw = input.anchorIndex ?? 0;
  const anchor = Number.isFinite(anchorRaw) ? Math.floor(anchorRaw) : 0;
  const clampedAnchor = Math.min(Math.max(anchor, 0), barCount - 1);
  const start = Math.min(
    Math.max(clampedAnchor - Math.floor(count / 4), 0),
    barCount - count,
  );
  return { from: start, to: start + count - 1 };
}

/* ---------- Managed price range (Daily Replay playback stability) ----------
 * During tick-by-tick playback, lightweight-charts' autoscale re-derives
 * the price range from the visible bars on EVERY update — including the
 * still-forming candle's evolving extremes — and re-chooses its axis
 * tick set as the range breathes. On a phone that reads as the whole
 * chart shaking: finalized candles jump vertically in small steps, and
 * because the price axis width is recomputed from live label text, the
 * plot width changes too, re-deriving the visible time range and
 * sliding every candle horizontally (measured: plot width oscillating
 * 280–296px and a fixed candle drifting 16px inside ONE forming candle).
 *
 * The helpers below implement the managed alternative used when a
 * parent opts in (Daily Replay only): the price window is computed
 * once per candle from the VISIBLE FINALIZED extremes (exactly the
 * autoscale margins above, applied manually), and within a candle it
 * may only WIDEN — monotonically, and only when price genuinely exits
 * the window — so nothing ever clips and nothing oscillates. No future
 * data is used: every input is a bar already pushed to the chart. */

export interface PriceRange {
  from: number;
  to: number;
}

/** Padded price window for data extremes [lo, hi]: the data occupies
 *  the middle (1 - top - bottom) of the window, mirroring what
 *  autoscale + CANDLE_SCALE_MARGINS would produce for the same data. */
export function paddedPriceRange(lo: number, hi: number): PriceRange {
  const { top, bottom } = CANDLE_SCALE_MARGINS;
  let span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) {
    span = Math.max(Math.abs(hi) * 0.002, 0.01);
    lo = hi - span / 2;
    hi = lo + span;
  }
  const total = span / (1 - top - bottom);
  return { from: lo - total * bottom, to: hi + total * top };
}

/** Widen `range` just enough that [lo, hi] sits inside its
 *  margin-free zone (the same proportions paddedPriceRange applies).
 *  Monotone: the result never narrows the input range, and it equals
 *  the input when [lo, hi] is already comfortably inside — so calling
 *  it on every tick is a no-op until price genuinely exits. */
export function expandPriceRange(range: PriceRange, lo: number, hi: number): PriceRange {
  const { top, bottom } = CANDLE_SCALE_MARGINS;
  let { from, to } = range;
  const total = to - from;
  if (!Number.isFinite(total) || total <= 0) return paddedPriceRange(lo, hi);
  // Data zone: prices render inside [from + total*bottom, to - total*top].
  if (hi > to - total * top) {
    // Expand upward only, `from` fixed: solve hi == newTo - newTotal*top.
    const newTotal = (hi - from) / (1 - top);
    to = from + newTotal;
  }
  const total2 = to - from;
  if (lo < from + total2 * bottom) {
    // Expand downward only, `to` fixed: solve lo == newFrom + newTotal*bottom.
    const newTotal = (to - lo) / (1 - bottom);
    from = to - newTotal;
  }
  return { from, to };
}

/** Epsilon comparison for price ranges (ownership detection: did the
 *  range move since the manager last set it, beyond float noise?). */
export function priceRangesClose(a: PriceRange, b: PriceRange): boolean {
  const span = Math.max(1, Math.abs(a.to - a.from), Math.abs(b.to - b.from));
  const eps = span * 1e-9;
  return Math.abs(a.from - b.from) <= eps && Math.abs(a.to - b.to) <= eps;
}
