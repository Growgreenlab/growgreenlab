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
 * At the 8x default (16 ticks/sec) this yields ~1.6 book updates/sec;
 * the windows are tick-indexed, so the sequence is identical at any speed.
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
 * Depth target for one side of the book: the size the market "wants" to
 * show at the touch for this behavior + phase. Rung i decays with distance.
 * Scenario story-telling lives here and ONLY here:
 *  - clean: balanced approach → thin asks + stacked bids on the break →
 *    healthy two-sided book once price is accepted.
 *  - weak: thin everywhere, nobody commits.
 *  - failed: normal approach → heavy offers (the wall) on the break →
 *    bids pulled, offers stacked in resolution (distribution).
 *  - ambiguous: targets oscillate (flicker) with update index.
 */
function depthTargets(
  p: FlowParams,
  tickIndex: number,
  phase: FlowPhase,
  rng: () => number,
  midC: number
): { bid: number[]; ask: number[] } {
  const rung = (touch: number, extra: number[]) =>
    Array.from({ length: 5 }, (_, i) => (touch + (extra[i] ?? 0)) / (1 + i * 0.6));
  let bidTouch = 400, askTouch = 400, bidVar = 300, askVar = 300;
  const bidExtra = [0, 0, 0, 0, 0];
  const askExtra = [0, 0, 0, 0, 0];

  switch (p.behavior) {
    case "clean":
      if (phase === "breakout") {
        bidTouch = 800; askTouch = 150; bidVar = 400; askVar = 120;
        bidExtra[0] = 600; bidExtra[1] = 400; // stacked support under the break
      } else if (phase === "resolution") {
        bidTouch = 600; askTouch = 500;
      }
      break;
    case "weak":
      bidTouch = 150; askTouch = 150; bidVar = 120; askVar = 120;
      break;
    case "failed":
      if (phase === "breakout") {
        bidTouch = 500; askTouch = 300; bidVar = 300; askVar = 200;
        // The wall: a large offer two cents above the HOD level. If that
        // exact rung exists in this ladder its target grows; otherwise the
        // second ask rung carries extra size (price never moves to fake it).
        askExtra[1] += 1200;
      } else if (phase === "resolution") {
        bidTouch = 150; askTouch = 900; bidVar = 120; askVar = 500;
      }
      break;
    case "ambiguous": {
      const flicker = Math.sin(tickIndex / 37) > 0 ? 1.6 : 0.6;
      bidTouch = 400 * flicker; askTouch = 400 / flicker;
      if (rng() > 0.7) {
        // Phantom size: a target that appears for one update, then goes.
        const extra = rng() > 0.5 ? bidExtra : askExtra;
        extra[Math.floor(rng() * 3)] += Math.round(1200 * rng());
      }
      break;
    }
  }

  const bid = rung(bidTouch + rng() * bidVar, bidExtra);
  const ask = rung(askTouch + rng() * askVar, askExtra);
  if (p.behavior === "failed" && phase === "breakout") {
    // Exact wall rung, when the ladder contains level + 2 cents.
    const wallC = Math.round(p.level * 100) + 2;
    const idx = wallC - midC - 1;
    if (idx >= 0 && idx < 5) ask[idx] += 2500;
  }
  return { bid, ask };
}

/**
 * Generate a Level 2 snapshot for a given tick.
 *
 * Ladder construction (audit RC3): prices are built in INTEGER CENTS
 * around the rounded last price — best bid = mid − 1¢, best ask = mid + 1¢,
 * rungs step exactly 1¢. Strictly ordered, unique, and bracketing the last
 * trade price by construction (|round2(price) − price| ≤ 0.5¢ < 1¢).
 *
 * Sizes (audit RC3): when `prev` is supplied, each rung EVOLVES from the
 * previous snapshot — bounded steps toward the behavior/phase depth
 * target, with consumption shaving on the side price moved through and
 * replenishment drift back toward target. No teleporting depth.
 *
 * @param p flow params
 * @param tickIndex global tick index (deterministic)
 * @param price current tick price (from the engine — single source of truth)
 * @param phase scenario phase at this tick
 * @param timestamp ms epoch for display
 * @param prev previous snapshot, when the caller tracks one (DrillSim does)
 */
export function generateBook(
  p: FlowParams,
  tickIndex: number,
  price: number,
  phase: FlowPhase,
  timestamp: number,
  prev?: OrderBookSnapshot
): OrderBookSnapshot {
  const rng = mulberry32(p.seed * 7919 + tickIndex * 104729 + 13);
  const midC = Math.round(price * 100); // last price in cents
  const targets = depthTargets(p, tickIndex, phase, rng, midC);

  // Consumption: if price moved up since the previous book, offers near
  // the touch were eaten into; if it moved down, bids were. Shave the
  // affected side's evolution this update (replenishment is the drift
  // back toward target on later updates).
  let askShave = 1, bidShave = 1;
  if (prev) {
    const prevMidC = Math.round(((prev.bids[0].price + prev.asks[0].price) / 2) * 100);
    const moved = midC - prevMidC;
    if (moved > 0) askShave = Math.max(0.4, 1 - 0.12 * moved);
    if (moved < 0) bidShave = Math.max(0.4, 1 + 0.12 * moved);
  }
  const prevBidByCents = new Map((prev?.bids ?? []).map((l) => [Math.round(l.price * 100), l.size]));
  const prevAskByCents = new Map((prev?.asks ?? []).map((l) => [Math.round(l.price * 100), l.size]));

  const evolve = (target: number, prevSize: number | undefined, shave: number): number => {
    if (prevSize == null) {
      // Fresh rung: start near target.
      return Math.max(1, Math.round(target * (0.85 + rng() * 0.3)));
    }
    // Bounded step toward target (≤ ±35% of current), then the shave.
    const step = Math.max(-0.35 * prevSize, Math.min(0.35 * prevSize, target - prevSize));
    return Math.max(1, Math.round((prevSize + step) * shave * (0.95 + rng() * 0.1)));
  };

  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let i = 0; i < 5; i++) {
    const bidC = midC - (i + 1);
    const askC = midC + (i + 1);
    bids.push({ price: bidC / 100, size: evolve(targets.bid[i], prevBidByCents.get(bidC), bidShave) });
    asks.push({ price: askC / 100, size: evolve(targets.ask[i], prevAskByCents.get(askC), askShave) });
  }

  return { bids, asks, timestamp };
}

/**
 * Generate trade prints for one flow window, from the volume the engine
 * ACTUALLY traded in that window.
 *
 * Accounting contract (audit RC4): the returned print sizes partition
 * `tickVolume` EXACTLY — sum(sizes) === floor(tickVolume) — so Time &
 * Sales always reconciles with candle volume. A window with no traded
 * volume produces no prints (an honest quiet tape, not invented prints).
 * Print count is display aggregation: 1 print per window, 2 during the
 * breakout phase — the underlying window volume is never altered, only
 * grouped. Side classification: scenario behavior/phase bias nudged by
 * the window's actual tick direction (uptick ⇒ buyer-initiated).
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

  let remaining = Math.max(0, Math.floor(tickVolume));
  if (remaining === 0) return prints;

  // One print per window normally; two during the breakout phase when
  // the tape is genuinely active.
  const nPrints = Math.min(remaining, phase === "breakout" && rng() > 0.5 ? 2 : 1);
  for (let i = 0; i < nPrints; i++) {
    const printsLeft = nPrints - i;
    const size =
      printsLeft === 1
        ? remaining
        : Math.min(
            remaining - (printsLeft - 1), // keep ≥1 share for each later print
            Math.max(1, Math.round(remaining * (0.2 + rng() * 0.5)))
          );
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
