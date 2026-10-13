import type { ReplayEngine } from "./engine";

/**
 * Advance an engine to a target candle index while reloading a saved
 * session's recorded fills.
 *
 * Bounded by the end of the session: step() does not advance the index
 * once the engine is atEnd, so an unbounded `while (index < target)`
 * loop never terminates when a recorded fill's candle_index exceeds
 * the loaded session length (mismatched or truncated candle data) —
 * it freezes the whole page and every control (including Buy) dies
 * with it. This helper always terminates.
 *
 * Returns the index actually reached (<= target). Callers clamp the
 * fill's candle index to it and still apply the fill at its recorded
 * price/time, preserving P/L fidelity.
 */
export function advanceToIndex(eng: ReplayEngine, targetIndex: number): number {
  const target = Math.max(0, Math.floor(targetIndex));
  let guard = 0;
  // The guard cap is a belt-and-braces bound: index strictly increases
  // on every non-final step(), so atEnd is the real terminator.
  while (eng.index < target && !eng.atEnd && guard++ < 1_000_000) {
    eng.step();
  }
  return eng.index;
}
