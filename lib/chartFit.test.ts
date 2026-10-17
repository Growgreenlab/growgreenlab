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

console.log(`\n=== CHART FIT RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
