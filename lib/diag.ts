/**
 * diag.ts — Freeze diagnostics. Additive-only instrumentation.
 *
 * Tracks the replay pipeline health so we can identify exactly which layer
 * stops when the chart freezes: timer, engine, data, chart update, or render.
 * No behavior changes; purely observational.
 */

export interface DiagState {
  timerFires: number;
  lastTimerFire: number | null;
  maxFireGapMs: number;
  tickCalls: number;
  lastTick: number | null;
  chartUpdates: number;
  lastChartUpdate: number | null;
  ohlcChanges: number;
  lastUpdateTimeSec: number | null;
  timestampViolations: number;
  errors: string[];
  startedAt: number | null;
  lastOhlc: string | null;
}

export const diag: DiagState = {
  timerFires: 0,
  lastTimerFire: null,
  maxFireGapMs: 0,
  tickCalls: 0,
  lastTick: null,
  chartUpdates: 0,
  lastChartUpdate: null,
  ohlcChanges: 0,
  lastUpdateTimeSec: null,
  timestampViolations: 0,
  errors: [],
  startedAt: null,
  lastOhlc: null,
};

export function resetDiag() {
  diag.timerFires = 0;
  diag.lastTimerFire = null;
  diag.maxFireGapMs = 0;
  diag.tickCalls = 0;
  diag.lastTick = null;
  diag.chartUpdates = 0;
  diag.lastChartUpdate = null;
  diag.ohlcChanges = 0;
  diag.lastUpdateTimeSec = null;
  diag.timestampViolations = 0;
  diag.errors = [];
  diag.startedAt = performance.now();
  diag.lastOhlc = null;
}

function ago(t: number | null): string {
  if (t === null) return "never";
  return `${((performance.now() - t) / 1000).toFixed(1)}s ago`;
}

/** Human-readable freeze report for copy-paste. */
export function freezeReport(ctx: {
  playing: boolean;
  candleIndex: number;
  formationProgress: number;
  speed: number;
}): string {
  const lines = [
    `=== FREEZE REPORT ${new Date().toISOString()} ===`,
    `playing=${ctx.playing} speed=${ctx.speed}x candleIndex=${ctx.candleIndex} formationProgress=${ctx.formationProgress.toFixed(3)}`,
    `timer: fires=${diag.timerFires} last=${ago(diag.lastTimerFire)} maxGap=${diag.maxFireGapMs.toFixed(0)}ms`,
    `engine: tickCalls=${diag.tickCalls} last=${ago(diag.lastTick)}`,
    `chart: updates=${diag.chartUpdates} last=${ago(diag.lastChartUpdate)} ohlcChanges=${diag.ohlcChanges}`,
    `timestampViolations=${diag.timestampViolations}`,
    `errors: ${diag.errors.length ? diag.errors.slice(-3).join(" | ") : "none"}`,
    `userAgent: ${typeof navigator !== "undefined" ? navigator.userAgent : "?"}`,
  ];
  return lines.join("\n");
}
