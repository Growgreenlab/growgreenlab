/**
 * Breakout Recognition Drill — deterministic synthetic order-flow generator.
 *
 * This is the "scenario-driven event timeline" for Phase 3. Every Level 2
 * snapshot and every Time & Sales print is derived from:
 *
 *   (scenario seed, tick index, tick price, tick volume, scenario phase)
 *
 * Nothing is independently randomized. The same scenario + same tick always
 * produces the same book and the same prints — replay is identical, and
 * panels can never contradict the candles.
 *
 * IMPORTANT: This is synthetic simulation for training, NOT historical
 * exchange data. Panels must be labeled "SIMULATED" in the UI.
 */

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  bids: OrderBookLevel[]; // best bid first, 5 levels
  asks: OrderBookLevel[]; // best ask first, 5 levels
  timestamp: number;
}

export interface TradePrint {
  price: number;
  size: number;
  timestamp: number;
  /** Which side initiated: inferred from scenario rules, not real data. */
  side: "buy" | "sell";
}

export type FlowPhase = "approach" | "breakout" | "resolution";

export type FlowBehavior = "clean" | "weak" | "failed" | "ambiguous";

/** Deterministic PRNG (same algorithm as lib/engine.ts). */
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

export interface FlowParams {
  /** Scenario seed — root of all determinism here. */
  seed: number;
  /** Price level of the breakout (HOD). */
  level: number;
  /** Which flow behavior this scenario uses. */
  behavior: FlowBehavior;
  /** Typical price increment for book levels. */
  tickSize?: number;
}

/**
 * Order-flow cadence: the book and prints update frequently, like a real
 * trading terminal — every few ticks. This feels alive at any playback
 * speed: faster speed = more intense flow, just like a real active market.
 * Still tick-driven (deterministic), not wall-clock.
 */
/** Drill pacing: fewer ticks per candle than the main simulator for snappier formation. */
export const DRILL_TICKS_PER_CANDLE = 120;

/**
 * Order-flow cadence: moderate pace — alive like a real terminal but
 * readable. Tied to tick position (deterministic), not wall-clock.
 * At 8x drill speed this yields ~5 book updates/sec.
 */
export const FLOW_UPDATES_PER_CANDLE = 12;
export const TICKS_PER_FLOW_UPDATE = DRILL_TICKS_PER_CANDLE / FLOW_UPDATES_PER_CANDLE; // 10

/**
 * Deterministic timestamp for a flow update: derived from the candle's
 * timestamp, never Date.now(). Same scenario + same tick = same timestamps.
 */
export function flowTimestamp(candleT: number, updateIndex: number): number {
  return candleT + Math.round((updateIndex / FLOW_UPDATES_PER_CANDLE) * 60_000);
}

/**
 * Generate a Level 2 snapshot for a given tick.
 *
 * @param p flow params
 * @param tickIndex global tick index (deterministic)
 * @param price current tick price (from the engine — single source of truth)
 * @param phase scenario phase at this tick
 * @param timestamp ms epoch for display
 */
export function generateBook(
  p: FlowParams,
  tickIndex: number,
  price: number,
  phase: FlowPhase,
  timestamp: number
): OrderBookSnapshot {
  const tickSize = p.tickSize ?? 0.01;
  const rng = mulberry32(p.seed * 7919 + tickIndex * 104729 + 13);
  const distToLevel = price - p.level; // >0 means above HOD

  // Base sizes — tuned per behavior and phase below
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];

  for (let i = 0; i < 5; i++) {
    const bidPrice = round2(price - tickSize * (i + 1) - rng() * tickSize);
    const askPrice = round2(price + tickSize * (i + 1) + rng() * tickSize);
    bids.push({ price: bidPrice, size: 0 });
    asks.push({ price: askPrice, size: 0 });
  }

  // Scenario-driven size logic
  const setSizes = (
    bidBase: number, askBase: number,
    bidVar: number, askVar: number
  ) => {
    for (let i = 0; i < 5; i++) {
      // Depth decays with distance from touch
      const decay = 1 / (1 + i * 0.6);
      bids[i].size = Math.max(1, Math.round((bidBase + rng() * bidVar) * decay));
      asks[i].size = Math.max(1, Math.round((askBase + rng() * askVar) * decay));
    }
  };

  switch (p.behavior) {
    case "clean":
      if (phase === "approach") {
        // Balanced book, moderate depth both sides
        setSizes(400, 400, 300, 300);
      } else if (phase === "breakout") {
        // Asks being consumed: thin near touch, bids stacking underneath
        setSizes(800, 150, 400, 120);
        // Concentrated bid support just under price
        bids[0].size += 600;
        bids[1].size += 400;
      } else {
        // Resolution: healthy two-sided book, price accepted higher
        setSizes(600, 500, 300, 300);
      }
      break;

    case "weak":
      // Thin book throughout — nobody's committed
      setSizes(150, 150, 120, 120);
      break;

    case "failed":
      if (phase === "approach") {
        setSizes(400, 400, 300, 300);
      } else if (phase === "breakout") {
        // Trap: looks like buying, but a wall sits above
        setSizes(500, 300, 300, 200);
        // The wall — large offer just above the level
        const wallIdx = distToLevel >= 0 ? 1 : 0;
        asks[wallIdx].size += 2500;
        asks[wallIdx].price = round2(p.level + tickSize * 2);
      } else {
        // Resolution: bids pull, offers stack — distribution
        setSizes(150, 900, 120, 500);
      }
      break;

    case "ambiguous":
      // Flickering: depth oscillates, no persistent conviction
      {
        const flicker = Math.sin(tickIndex / 37) > 0 ? 1.6 : 0.6;
        setSizes(400 * flicker, 400 / flicker, 300, 300);
        // Occasional phantom size that appears and vanishes
        if (rng() > 0.7) {
          const side = rng() > 0.5 ? bids : asks;
          side[Math.floor(rng() * 3)].size += Math.round(1200 * rng());
        }
      }
      break;
  }

  // Spread sanity: best ask must exceed best bid
  if (asks[0].price <= bids[0].price) {
    asks[0].price = round2(bids[0].price + tickSize);
  }

  return { bids, asks, timestamp };
}

/**
 * Generate trade prints for a tick, derived from the tick's volume.
 * Print count and side bias follow the scenario behavior and phase.
 */
export function generatePrints(
  p: FlowParams,
  tickIndex: number,
  price: number,
  tickVolume: number,
  phase: FlowPhase,
  timestamp: number,
  tickDirection: 1 | -1 | 0
): TradePrint[] {
  const rng = mulberry32(p.seed * 104729 + tickIndex * 7919 + 77);
  const prints: TradePrint[] = [];

  // One print per update normally; two during the breakout phase when
  // the tape is genuinely active. At 60 updates/candle this streams
  // like a real terminal without flooding.
  const nPrints = phase === "breakout" && rng() > 0.5 ? 2 : 1;
  // Add natural size variation so prints don't look robotic
  let remaining = Math.max(1, Math.round(tickVolume * (0.4 + rng() * 1.2)));
  for (let i = 0; i < nPrints; i++) {
    const isLast = i === nPrints - 1;
    const size = isLast ? remaining : Math.max(1, Math.round(remaining * (0.2 + rng() * 0.5)));
    remaining -= size;

    // Side bias by behavior + phase + tick direction
    let buyProb = 0.5;
    let dirWeight = 0.15; // how much tick direction nudges print side
    switch (p.behavior) {
      case "clean":
        buyProb = phase === "resolution" ? 0.65 : 0.7;
        break;
      case "weak":
        // Weak = indecisive: tick direction barely moves the needle
        buyProb = 0.5 + tickDirection * 0.05;
        dirWeight = 0.05;
        break;
      case "failed":
        buyProb = phase === "resolution" ? 0.3 : 0.6;
        break;
      case "ambiguous":
        buyProb = 0.5 + Math.sin(tickIndex / 23) * 0.2;
        break;
    }
    // Tick direction nudges the print side (uptick = buyer-initiated)
    buyProb += tickDirection * dirWeight;
    buyProb = Math.min(0.9, Math.max(0.1, buyProb));

    prints.push({
      price: round2(price + (rng() - 0.5) * 0.01),
      size,
      timestamp: timestamp + i,
      side: rng() < buyProb ? "buy" : "sell",
    });
  }
  return prints;
}

/**
 * Map a candle index to the scenario phase, given the checkpoint.
 * - approach: well before the decision point
 * - breakout: the 4 candles straddling the checkpoint
 * - resolution: everything after
 */
export function phaseForCandle(candleIndex: number, checkpointIndex: number): FlowPhase {
  if (candleIndex < checkpointIndex - 2) return "approach";
  if (candleIndex <= checkpointIndex + 1) return "breakout";
  return "resolution";
}
