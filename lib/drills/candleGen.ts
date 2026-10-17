/**
 * Breakout Drill — realistic scenario candle generator.
 *
 * Uses the SAME statistical approach as the main simulator's
 * generateSampleSession (lib/marketData.ts): regime-based random walk
 * with realistic wicks and volume correlated to price movement.
 *
 * Scenarios are defined by market regimes (drift/volatility/volume per
 * phase), not hand-authored candles. The HOD emerges organically from
 * the generated price action. All seeded — fully deterministic.
 */
import type { Candle } from "../types";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface RegimeSpec {
  /** Number of candles in this regime. */
  candles: number;
  /** Per-candle directional drift (e.g. 0.001 = 0.1% up bias). */
  drift: number;
  /** Shock size — random volatility per candle. */
  volatility: number;
  /** Base volume for the regime. */
  volBase: number;
  /** Extra volume range. */
  volRange: number;
  /** Volume multiplier applied to large moves. */
  volMoveMult: number;
}

export interface BreakoutShaping {
  /** How far above HOD the spike reaches (as fraction, e.g. 0.02 = 2%). */
  spikeAboveHod: number;
  /** Where the breakout candle closes, as fraction of spike range (0=open, 1=high). */
  closePosition: number;
  /** Volume multiplier for the breakout candle. */
  volMult: number;
}

const T = 60_000;
const T0 = 1_700_000_000_000;

/**
 * Generate scenario candles from regime specs.
 * Returns candles and the index where the breakout regime starts.
 */
export function generateScenarioCandles(
  seed: number,
  startPrice: number,
  regimes: RegimeSpec[],
  breakout: BreakoutShaping,
  breakoutAt: number // candle index where breakout regime starts
): { candles: Candle[]; hod: number; breakoutIndex: number } {
  const rand = mulberry32(seed);
  const candles: Candle[] = [];
  let price = startPrice;
  let t = T0;
  let idx = 0;

  const pushCandle = (o: number, c: number, h: number, l: number, v: number) => {
    candles.push({ t, o: round2(o), h: round2(h), l: round2(l), c: round2(c), v: Math.round(v) });
    t += T;
    idx++;
  };

  // Generate regime candles
  for (const r of regimes) {
    for (let i = 0; i < r.candles; i++) {
      // The breakout candle gets special shaping
      if (idx === breakoutAt) {
        // HOD is the max high so far
        const hod = Math.max(...candles.map((c) => c.h));
        const spikeHigh = hod * (1 + breakout.spikeAboveHod);
        const o = price;
        const c = o + (spikeHigh - o) * breakout.closePosition;
        // Realistic wicks: small lower wick, upper wick depends on close position
        const l = Math.min(o, c) * (1 - rand() * 0.002);
        const h = spikeHigh;
        const v = (r.volBase + rand() * r.volRange) * breakout.volMult;
        pushCandle(o, c, h, l, v);
        price = c;
        continue;
      }

      const o = price;
      const shock = (rand() - 0.5) * 2 * r.volatility;
      const c = Math.max(0.5, o * (1 + r.drift + shock));
      // Same wick formula as the main simulator's sample generator
      const h = Math.max(o, c) * (1 + rand() * 0.003);
      const l = Math.min(o, c) * (1 - rand() * 0.003);
      const move = Math.abs(c - o) / o;
      const v = r.volBase + rand() * r.volRange + move * r.volMoveMult;
      pushCandle(o, c, h, l, v);
      price = c;
    }
  }

  // HOD = highest high before the breakout candle
  const preBreakout = candles.slice(0, breakoutAt);
  const hod = Math.max(...preBreakout.map((c) => c.h));

  return { candles, hod: round2(hod), breakoutIndex: breakoutAt };
}
