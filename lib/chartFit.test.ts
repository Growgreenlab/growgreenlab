/**
 * Unit tests for lib/chartFit.ts — the production spacing/margin math
 * behind the chart's mobile readability settings. Run:
 *   npx -y tsx lib/chartFit.test.ts
 */
import {
  CANDLE_SCALE_MARGINS,
  VOLUME_SCALE_MARGINS,
  NARROW_CONTAINER_MAX_PX,
  readableWindow,
  paddedPriceRange,
  expandPriceRange,
  priceRangesClose,
  visibleFinalizedExtremes,
} from "./chartFit";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL: ${name}`);
  }
}
function eqRange(
  name: string,
  actual: { from: number; to: number } | null,
  from: number,
  to: number,
) {
  check(name, actual !== null && actual.from === from && actual.to === to);
}

/* ---------------- scale margins ---------------- */
{
  const usable = 1 - CANDLE_SCALE_MARGINS.top - CANDLE_SCALE_MARGINS.bottom;
  check("candle range uses 78% of pane height (was 60% at library defaults)",
    Math.abs(usable - 0.78) < 1e-9);
  check("volume strip starts exactly where the candle region ends (no overlap, no gap)",
    Math.abs(VOLUME_SCALE_MARGINS.top - (1 - CANDLE_SCALE_MARGINS.bottom)) < 1e-9);
  check("volume strip is 15% of pane height",
    Math.abs(1 - VOLUME_SCALE_MARGINS.top - VOLUME_SCALE_MARGINS.bottom - 0.15) < 1e-9);
}

/* ---------------- readable window: the reported case ---------------- */
{
  // NFLX full session on a phone: 390 bars, ~300px plot.
  // Window size = floor(300 / 2.2) = 136 bars.
  eqRange("anchor omitted -> session-start window (opening candle visible)",
    readableWindow({ plotWidthPx: 300, barCount: 390, containerWidthPx: 390 }),
    0, 135);
  eqRange("anchor 0 (selected = opening candle) -> session-start window",
    readableWindow({ plotWidthPx: 300, barCount: 390, containerWidthPx: 390, anchorIndex: 0 }),
    0, 135);
  eqRange("anchor 24 (pre-set 09:54 start) -> still the start window, anchor inside",
    readableWindow({ plotWidthPx: 300, barCount: 390, containerWidthPx: 390, anchorIndex: 24 }),
    0, 135);
  eqRange("anchor mid-session -> window contains it with a quarter-window of lead-in",
    readableWindow({ plotWidthPx: 300, barCount: 390, containerWidthPx: 390, anchorIndex: 200 }),
    166, 301);
  eqRange("anchor on the last bar -> window ends exactly at the session end",
    readableWindow({ plotWidthPx: 300, barCount: 390, containerWidthPx: 390, anchorIndex: 389 }),
    254, 389);
  eqRange("out-of-range anchor is clamped into the dataset",
    readableWindow({ plotWidthPx: 300, barCount: 390, containerWidthPx: 390, anchorIndex: 9999 }),
    254, 389);
  eqRange("330px plot -> floor(330/2.2) = 150-bar window",
    readableWindow({ plotWidthPx: 330, barCount: 390, containerWidthPx: 393, anchorIndex: 0 }),
    0, 149);

  // Invariants across a sweep of anchors: range in-bounds, anchor inside.
  for (const a of [0, 1, 50, 135, 136, 200, 300, 388, 389]) {
    const w = readableWindow({ plotWidthPx: 300, barCount: 390, containerWidthPx: 390, anchorIndex: a });
    check(`anchor ${a}: window in-bounds and contains the anchor`,
      w !== null && w.from >= 0 && w.to <= 389 && w.from <= a && a <= w.to && w.to - w.from === 135);
  }
}

/* ---------------- gates: null = plain full fit stands ---------------- */
{
  check("desktop container -> null (full fit unchanged)",
    readableWindow({ plotWidthPx: 1200, barCount: 390, containerWidthPx: 1440, anchorIndex: 0 }) === null);
  check("tablet-width container -> null",
    readableWindow({ plotWidthPx: 300, barCount: 390, containerWidthPx: 800, anchorIndex: 0 }) === null);
  check("container exactly at the narrow boundary still windows",
    readableWindow({ plotWidthPx: 300, barCount: 390, containerWidthPx: NARROW_CONTAINER_MAX_PX, anchorIndex: 0 }) !== null);
  check("bar count that already fits readably (100 bars) -> null",
    readableWindow({ plotWidthPx: 330, barCount: 100, containerWidthPx: 390, anchorIndex: 0 }) === null);
  check("natural spacing exactly at target (200 bars / 440px) -> null",
    readableWindow({ plotWidthPx: 440, barCount: 200, containerWidthPx: 400, anchorIndex: 0 }) === null);
  check("zero bars -> null",
    readableWindow({ plotWidthPx: 300, barCount: 0, containerWidthPx: 390, anchorIndex: 0 }) === null);
  check("zero plot width -> null",
    readableWindow({ plotWidthPx: 0, barCount: 390, containerWidthPx: 390, anchorIndex: 0 }) === null);
  check("premarket-length session (720 bars) windows like any other",
    readableWindow({ plotWidthPx: 300, barCount: 720, containerWidthPx: 390, anchorIndex: 0 }) !== null);
}

/* ---------- Managed price range (playback stability) ---------- */
{
  const { top, bottom } = CANDLE_SCALE_MARGINS;
  const usable = 1 - top - bottom; // 0.78
  // paddedPriceRange: data [70, 71] occupies exactly the usable middle.
  const r = paddedPriceRange(70, 71);
  const total = r.to - r.from;
  check("padded: total span = data span / usable fraction",
    Math.abs(total - 1 / usable) < 1e-9);
  check("padded: lo sits exactly at the bottom-margin boundary",
    Math.abs(r.from + total * bottom - 70) < 1e-9);
  check("padded: hi sits exactly at the top-margin boundary",
    Math.abs(r.to - total * top - 71) < 1e-9);
  check("padded: window contains the data", r.from < 70 && r.to > 71);
  // Zero-span data still yields a finite, containing window.
  const flat = paddedPriceRange(50, 50);
  check("padded: flat data -> finite containing window",
    Number.isFinite(flat.from) && Number.isFinite(flat.to) && flat.from < 50 && flat.to > 50 && flat.to > flat.from);

  // expandPriceRange: no-op while price stays inside the data zone.
  const inside = expandPriceRange(r, 70.2, 70.8);
  check("expand: price inside the zone -> range unchanged",
    priceRangesClose(inside, r) && inside.from === r.from && inside.to === r.to);
  check("expand: price exactly AT the zone edge -> unchanged",
    (() => { const e = expandPriceRange(r, r.from + total * bottom, r.to - total * top); return e.from === r.from && e.to === r.to; })());
  // Genuine exit upward: only `to` grows; hi lands on the new top boundary.
  const up = expandPriceRange(r, 70.2, 72);
  check("expand: upward exit grows only the top", up.from === r.from && up.to > r.to);
  check("expand: exited high lands on the new top-margin boundary",
    Math.abs(up.to - (up.to - up.from) * top - 72) < 1e-9);
  // Genuine exit downward: only `from` drops; lo lands on the new bottom boundary.
  const down = expandPriceRange(r, 69, 70.8);
  check("expand: downward exit grows only the bottom", down.to === r.to && down.from < r.from);
  check("expand: exited low lands on the new bottom-margin boundary",
    Math.abs(down.from + (down.to - down.from) * bottom - 69) < 1e-9);
  // Both sides at once: widens both ways and contains the data zone.
  const both = expandPriceRange(r, 68, 73);
  check("expand: two-sided exit widens both ways",
    both.from < r.from && both.to > r.to && both.from < 68 && both.to > 73);
  // Monotonicity across a wandering tick path: never narrows.
  let w = r;
  let monotone = true;
  for (const [plo, phi] of [[70.1, 70.9], [69.5, 70.4], [70.3, 71.6], [69.8, 71.2], [70.0, 70.5]] as const) {
    const next = expandPriceRange(w, plo, phi);
    if (next.from > w.from || next.to < w.to) monotone = false;
    w = next;
  }
  check("expand: a wandering tick path never narrows the window", monotone);
  // Degenerate input range falls back to a padded window.
  const degen = expandPriceRange({ from: 5, to: 5 }, 4, 6);
  check("expand: degenerate range -> containing padded window", degen.from < 4 && degen.to > 6);

  // priceRangesClose: float noise vs real moves.
  check("close: identical ranges are close", priceRangesClose(r, { ...r }));
  check("close: sub-epsilon jitter is close",
    priceRangesClose(r, { from: r.from + total * 1e-10, to: r.to - total * 1e-10 }));
  check("close: a real user drag is NOT close",
    !priceRangesClose(r, { from: r.from - 0.5, to: r.to }));
}

/* ---------- visibleFinalizedExtremes (boundary + settle refits) ---------- */
{
  // Ten bars: bar i has low = i, high = i + 0.5 — except bar 3, a spike
  // (low 2.5, high 9.5), so subsets are distinguishable.
  const bars = Array.from({ length: 10 }, (_, i) => ({ l: i, h: i + 0.5 }));
  bars[3] = { l: 2.5, h: 9.5 };

  // Null range -> ALL finalized bars (forming bar 9 excluded).
  const all = visibleFinalizedExtremes(bars, 10, null, null);
  check("extremes: null range -> full finalized set, forming bar excluded",
    all !== null && all.lo === 0 && all.hi === 9.5);
  // Non-finite range -> same fallback.
  const nan = visibleFinalizedExtremes(bars, 10, NaN, NaN);
  check("extremes: NaN range -> full finalized fallback",
    nan !== null && nan.lo === 0 && nan.hi === 9.5);
  // A quiet visible subset (bars 4..7) -> only their extremes.
  const sub = visibleFinalizedExtremes(bars, 10, 4.6, 7.0);
  check("extremes: visible subset only",
    sub !== null && sub.lo === 4 && sub.hi === 7.5);
  // Fractional bounds floor/ceil outward (the render path's exact
  // convention): to=7.2 pulls bar 8 into the set.
  const frac = visibleFinalizedExtremes(bars, 10, 4.6, 7.2);
  check("extremes: fractional to ceils into the next bar",
    frac !== null && frac.lo === 4 && frac.hi === 8.5);
  // Subset including the spike bar picks it up.
  const spike = visibleFinalizedExtremes(bars, 10, 2.1, 3.9);
  check("extremes: subset containing the spike bar",
    spike !== null && spike.lo === 2 && spike.hi === 9.5);
  // Range entirely past the finalized set -> fallback to full set.
  const past = visibleFinalizedExtremes(bars, 10, 50, 60);
  check("extremes: range beyond data -> full finalized fallback",
    past !== null && past.lo === 0 && past.hi === 9.5);
  // Range hanging off the left edge clamps to bar 0.
  const left = visibleFinalizedExtremes(bars, 10, -20, 1.2);
  check("extremes: negative from clamps to bar 0 (bars 0..2)",
    left !== null && left.lo === 0 && left.hi === 2.5);
  // Fewer revealed bars than the array holds: n governs (n-2 is last final).
  const early = visibleFinalizedExtremes(bars, 4, null, null);
  check("extremes: n=4 -> only bars 0..2 count as finalized",
    early !== null && early.lo === 0 && early.hi === 2.5);
  // Nothing finalized yet.
  check("extremes: n=1 (only the forming bar) -> null",
    visibleFinalizedExtremes(bars, 1, null, null) === null);
  check("extremes: n=0 -> null",
    visibleFinalizedExtremes(bars, 0, null, null) === null);

  // Composed boundary semantics (the pinned contract): a FRESH window
  // computed from a quiet VISIBLE subset is NARROWER than the standing
  // window computed from the whole session — narrowing at a boundary
  // (or at a gesture settle) is exactly one paddedPriceRange over the
  // visible extremes, while expandPriceRange (the within-candle path)
  // can never produce that narrowing.
  const sessionWin = paddedPriceRange(0, 9.5);
  const quietExt = visibleFinalizedExtremes(bars, 10, 4.6, 7.0);
  const quietWin = quietExt ? paddedPriceRange(quietExt.lo, quietExt.hi) : null;
  check("boundary refit CAN narrow: quiet-subset window < session window",
    quietWin !== null && quietWin.to - quietWin.from < sessionWin.to - sessionWin.from);
  const widenedOnly = expandPriceRange(sessionWin, 4, 7.5);
  check("within-candle path can NOT narrow (expand leaves the wide window)",
    widenedOnly.from === sessionWin.from && widenedOnly.to === sessionWin.to);
  // Padding is derived from the VISIBLE range: the quiet window's span
  // is the visible span / 0.78, not the session span / 0.78.
  check("refit padding derives from the visible range itself",
    quietWin !== null && Math.abs((quietWin.to - quietWin.from) - 3.5 / 0.78) < 1e-9);
}

console.log(`\n=== CHART FIT RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
