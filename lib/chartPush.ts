/**
 * Pure planner for pushing candle arrays into a Lightweight Charts series.
 *
 * The chart keeps one bar per timestamp; `series.update(bar)` replaces the
 * bar at that timestamp (or appends when newer). The replay feed is a
 * growing array whose LAST element is the live-forming candle. When that
 * candle finalizes, the array grows by one (finalized bar + next forming
 * bar) — so an append-only push that starts at the old length would never
 * re-send the just-finalized bar, leaving its last partial forming values
 * (partial high/low/close/volume) on the chart permanently.
 *
 * This planner therefore starts incremental updates one index BEFORE the
 * previous length: the previously-last bar is always re-pushed with its
 * current (final, source) values before any appended bars. Re-pushing an
 * unchanged bar is a harmless no-op replace in Lightweight Charts.
 *
 * Extracted from components/LwcChart.tsx so the exact production logic is
 * unit-testable (see lib/candleAccuracy.test.ts).
 */
export interface BarPushState {
  key: string;
  n: number;
}

export type BarPushPlan =
  | { mode: "full"; n: number; state: BarPushState }
  | { mode: "updates"; from: number; n: number; state: BarPushState }
  | null;

/**
 * Decide how to push `candles[0..n-1]` given what was pushed before.
 * - Different session, shrink, or first push -> full setData.
 * - Same length -> only the last (forming) bar changed.
 * - Grew -> re-push the previously-last bar (it may have just finalized),
 *   then append the new bars.
 */
export function planBarPush(
  prev: BarPushState | null,
  sessionKey: string,
  n: number
): BarPushPlan {
  if (n <= 0) return null;
  const state: BarPushState = { key: sessionKey, n };
  if (!prev || prev.key !== sessionKey || n < prev.n) {
    return { mode: "full", n, state };
  }
  if (n === prev.n) {
    return { mode: "updates", from: n - 1, n, state };
  }
  return { mode: "updates", from: Math.max(0, prev.n - 1), n, state };
}
