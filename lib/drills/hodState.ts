/**
 * Breakout Drill — HOD market-state derivation.
 *
 * Pure function of REVEALED data only (finalized candles the user has
 * seen + the live forming candle). It never reads scenario candles past
 * the engine's reveal boundary, so the state label can never leak the
 * future. The reference level is the scenario's predefined HOD; the live
 * session high is tracked separately by the caller (engine.hod).
 */
import type { Candle } from "../types";

export type HodMarketState =
  | "approaching" // below the level, not yet close
  | "testing" // at / just under the level, or wicking into it
  | "breaking" // above the level intra-candle, no close above yet
  | "accepting" // above the level with at least one close above it
  | "rejected"; // was above (or wicked above), now back below

export const HOD_STATE_LABEL: Record<HodMarketState, string> = {
  approaching: "Approaching HOD",
  testing: "Testing HOD",
  breaking: "Breaking above HOD",
  accepting: "Accepting above HOD",
  rejected: "Rejected — back below HOD",
};

/** Within this fraction of the level, price counts as "at" it. */
const NEAR = 0.005; // 0.5%

export function hodMarketState(
  level: number,
  revealed: Candle[],
  forming: Candle | null
): HodMarketState {
  const lastFinal = revealed.length > 0 ? revealed[revealed.length - 1] : null;
  const price = forming ? forming.c : lastFinal ? lastFinal.c : level;
  const formingHigh = forming ? forming.h : -Infinity;

  const closedAbove = revealed.some((c) => c.c > level);
  const wickedAbove =
    formingHigh > level || revealed.some((c) => c.h > level);

  if (price > level) {
    return closedAbove ? "accepting" : "breaking";
  }
  // Price is at or below the level.
  if (closedAbove) return "rejected"; // accepted once, lost it since
  if (wickedAbove) return "rejected"; // spiked through and fell back
  if (price >= level * (1 - NEAR) || formingHigh >= level) return "testing";
  return "approaching";
}
