/**
 * Breakout Recognition Drill — deterministic synthetic order-flow generator.
 *
 * This is the "scenario-driven event timeline" for Phase 3. Every Level 2
 * snapshot and every Time & Sales print is derived from:
 *
 *   (scenario seed, tick index, tick price, tick volume, flow context)
 *
 * Nothing is independently randomized. The same scenario + same tick always
 * produces the same book and the same prints — replay is identical, and
 * panels can never contradict the candles.
 *
 * FLOW ARCHITECTURE (2026-10-15, fixes F1/F2/F5/F9 from the L2/T&S audit):
 *  - F1 — the approach phase uses ONE shared, class-neutral baseline book
 *    and tape bias for every scenario. Class character RAMPS IN (0→1)
 *    across the coil candles / as price nears the level, so no class is
 *    identifiable from base-phase statistics.
 *  - F2 — flow phases are EVENT-TRIGGERED from revealed price/HOD state
 *    (hodMarketState over finalized + forming candles), not scheduled by
 *    candle index: distribution begins on the first close back below the
 *    level, stacked bids never appear while price is coiling below it.
 *  - F5 — the spread is volatility-responsive: half-spread 1–3¢ driven by
 *    a recent-window volatility EMA, so quiet tape quotes 2¢ total and
 *    climactic windows quote wider. Ladder invariants (integer cents,
 *    strictly ordered, no duplicates, book brackets last price) hold.
 *  - F9 — each scenario carries deterministic personality scalars derived
 *    from its seed (depth scale, tape-bias jitter, refill rate, wall
 *    scale), so the three scenarios of a class no longer share one
 *    statistical fingerprint while class means stay in their bands.
 *
 * IMPORTANT: This is synthetic simulation for training, NOT historical
 * exchange data. Panels must be labeled "SIMULATED" in the UI.
 */

import type { HodMarketState } from "./hodState";

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

/**
 * Per-window context DrillSim computes from REVEALED data only (finalized
 * candles + the forming candle + the tick stream so far). Pure functions
 * of tick count, so the determinism contract is untouched: chunking,
 * speed, and pauses cannot change the event sequence.
 */
export interface FlowContext {
  /** 0..1 — how much class character has ramped in (F1). 0 = baseline. */
  ramp: number;
  /** Event state of price vs the level (F2). */
  state: HodMarketState;
  /** Recent per-window volatility, EMA of |Δprice| in cents (F5). */
  volC: number;
}

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

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

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
 * F9 — per-scenario personality, derived deterministically from the
 * scenario seed. These scalars nudge magnitudes WITHIN class-safe bands;
 * they never change which class a scenario behaves like.
 */
export interface FlowPersonality {
  /** Overall depth multiplier (0.85–1.20). */
  depthScale: number;
  /** Touch-size jitter per side (0.90–1.10). */
  touchJitterBid: number;
  touchJitterAsk: number;
  /** Tape-bias jitter (±0.04 probability). */
  buyProbJitter: number;
  /** Evolution step-cap multiplier (0.85–1.15). */
  refillScale: number;
  /** Failed-wall size multiplier (0.85–1.20). */
  wallScale: number;
}

export function personalityFor(seed: number): FlowPersonality {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  return {
    depthScale: 0.85 + rng() * 0.35,
    touchJitterBid: 0.9 + rng() * 0.2,
    touchJitterAsk: 0.9 + rng() * 0.2,
    buyProbJitter: (rng() - 0.5) * 0.08,
    refillScale: 0.85 + rng() * 0.3,
    wallScale: 0.85 + rng() * 0.35,
  };
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
 * F5 — half-spread (cents) from recent window volatility. Quiet tape
 * quotes the historical 2¢ total spread (hs=1); active windows widen to
 * 4¢, climactic ones to 6¢. Pure function of the vol EMA DrillSim feeds.
 */
export function halfSpreadForVol(volC: number): number {
  if (volC < 1.0) return 1;
  if (volC < 2.6) return 2;
  return 3;
}

/** Default context for stateless callers (tests, tooling): full class
 *  character for breakout/resolution, neutral approach, calm spread. */
function defaultCtx(phase: FlowPhase): FlowContext {
  return {
    ramp: phase === "approach" ? 0 : 1,
    state: phase === "approach" ? "approaching" : phase === "breakout" ? "breaking" : "accepting",
    volC: 0.5,
  };
}

const NO_EXTRA = [0, 0, 0, 0, 0];

/** Rung sizes from a touch target: rung i decays with distance. */
function rungSizes(touch: number, extra: number[]): number[] {
  return Array.from({ length: 5 }, (_, i) => (touch + (extra[i] ?? 0)) / (1 + i * 0.6));
}

/**
 * F1 — the shared, class-neutral baseline book: a healthy two-sided
 * market with no story to tell. Every scenario's approach phase starts
 * here; class targets blend in only as the ramp rises.
 */
function baselineTargets(rng: () => number): { bid: number[]; ask: number[] } {
  return {
    bid: rungSizes(420 + rng() * 280, NO_EXTRA),
    ask: rungSizes(420 + rng() * 280, NO_EXTRA),
  };
}

/**
 * Class depth targets for one side of the book: the size the market
 * "wants" to show at the touch for this behavior + phase. Rung i decays
 * with distance. Scenario story-telling lives here:
 *  - clean: thin asks + stacked bids on the break → healthy two-sided
 *    book once price is accepted.
 *  - weak: thin at the break, nobody commits.
 *  - failed: heavy offers (the wall) on the break → bids pulled, offers
 *    stacked in resolution (distribution).
 *  - ambiguous: targets oscillate (flicker) with update index.
 * (Approach-phase values here are only reached at ramp → 1, i.e. in the
 * coil right under the level; early approach is the shared baseline.)
 */
function classTargets(
  p: FlowParams,
  tickIndex: number,
  phase: FlowPhase,
  rng: () => number,
  midC: number
): { bid: number[]; ask: number[] } {
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
      if (phase !== "approach") {
        bidTouch = 150; askTouch = 150; bidVar = 120; askVar = 120;
      }
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

  const bid = rungSizes(bidTouch + rng() * bidVar, bidExtra);
  const ask = rungSizes(askTouch + rng() * askVar, askExtra);
  if (p.behavior === "failed" && phase === "breakout") {
    // Exact wall rung, when the ladder contains level + 2 cents.
    const wallC = Math.round(p.level * 100) + 2;
    const idx = wallC - midC - 1;
    if (idx >= 0 && idx < 5) ask[idx] += 2500;
  }
  return { bid, ask };
}

/**
 * Depth targets for this window: baseline ↔ class blend by the F1 ramp,
 * scaled by the F9 personality. At ramp 0 every scenario shows the same
 * neutral market; at ramp 1 the full class character.
 */
function depthTargets(
  p: FlowParams,
  tickIndex: number,
  phase: FlowPhase,
  rng: () => number,
  midC: number,
  ctx: FlowContext
): { bid: number[]; ask: number[] } {
  const pers = personalityFor(p.seed);
  let { bid, ask } = classTargets(p, tickIndex, phase, rng, midC);
  if (ctx.ramp < 1) {
    const base = baselineTargets(rng);
    bid = bid.map((v, i) => lerp(base.bid[i], v, ctx.ramp));
    ask = ask.map((v, i) => lerp(base.ask[i], v, ctx.ramp));
  }
  const scaleBid = pers.depthScale, scaleAsk = pers.depthScale;
  return {
    bid: bid.map((v, i) => v * scaleBid * (i === 0 ? pers.touchJitterBid : 1)),
    ask: ask.map((v, i) => v * scaleAsk * (i === 0 ? pers.touchJitterAsk : 1)),
  };
}

/**
 * Generate a Level 2 snapshot for a given tick.
 *
 * Ladder construction (audit RC3 + F5): prices are built in INTEGER
 * CENTS around the rounded last price — best bid = mid − hs, best ask =
 * mid + hs, rungs step exactly 1¢, where hs is the volatility-driven
 * half-spread (1–3¢). Strictly ordered, unique, and bracketing the last
 * trade price by construction (|round2(price) − price| ≤ 0.5¢ < hs).
 *
 * Sizes (audit RC3): when `prev` is supplied, each rung EVOLVES from the
 * previous snapshot — bounded steps toward the behavior/phase depth
 * target, with consumption shaving on the side price moved through and
 * replenishment drift back toward target. No teleporting depth.
 *
 * @param p flow params
 * @param tickIndex global tick index (deterministic)
 * @param price current tick price (from the engine — single source of truth)
 * @param phase scenario phase at this tick (event-derived, see sim.ts)
 * @param timestamp ms epoch for display
 * @param prev previous snapshot, when the caller tracks one (DrillSim does)
 * @param ctx flow context (ramp/state/volatility); defaults are neutral
 */
export function generateBook(
  p: FlowParams,
  tickIndex: number,
  price: number,
  phase: FlowPhase,
  timestamp: number,
  prev?: OrderBookSnapshot,
  ctx?: FlowContext
): OrderBookSnapshot {
  const c = ctx ?? defaultCtx(phase);
  const pers = personalityFor(p.seed);
  const rng = mulberry32(p.seed * 7919 + tickIndex * 104729 + 13);
  const midC = Math.round(price * 100); // last price in cents
  const hs = halfSpreadForVol(c.volC);
  const targets = depthTargets(p, tickIndex, phase, rng, midC, c);

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

  const stepCap = 0.35 * pers.refillScale;
  const evolve = (target: number, prevSize: number | undefined, shave: number): number => {
    if (prevSize == null) {
      // Fresh rung: start near target.
      return Math.max(1, Math.round(target * (0.85 + rng() * 0.3)));
    }
    // Bounded step toward target (≤ stepCap of current), then the shave.
    const step = Math.max(-stepCap * prevSize, Math.min(stepCap * prevSize, target - prevSize));
    return Math.max(1, Math.round((prevSize + step) * shave * (0.95 + rng() * 0.1)));
  };

  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let i = 0; i < 5; i++) {
    const bidC = midC - hs - i;
    const askC = midC + hs + i;
    bids.push({ price: bidC / 100, size: evolve(targets.bid[i], prevBidByCents.get(bidC), bidShave) });
    asks.push({ price: askC / 100, size: evolve(targets.ask[i], prevAskByCents.get(askC), askShave) });
  }

  return { bids, asks, timestamp };
}

/**
 * Tape bias for this window (probability a print is buyer-initiated).
 * F1: the approach phase blends from ONE shared neutral baseline
 * (0.5 + direction nudge) into the class bias as the ramp rises; other
 * phases use the class bias directly. F9 jitter applies throughout.
 */
function buyProbFor(
  p: FlowParams,
  tickIndex: number,
  phase: FlowPhase,
  tickDirection: 1 | -1 | 0,
  ctx: FlowContext
): number {
  // Class bias by behavior + phase + tick direction.
  let classP = 0.5;
  let dirWeight = 0.15; // how much tick direction nudges print side
  switch (p.behavior) {
    case "clean":
      classP = phase === "resolution" ? 0.65 : 0.7;
      break;
    case "weak":
      // Weak = indecisive: tick direction barely moves the needle
      classP = 0.5 + tickDirection * 0.05;
      dirWeight = 0.05;
      break;
    case "failed":
      classP = phase === "resolution" ? 0.3 : 0.6;
      break;
    case "ambiguous":
      classP = 0.5 + Math.sin(tickIndex / 23) * 0.2;
      break;
  }
  // Tick direction nudges the print side (uptick = buyer-initiated)
  classP += tickDirection * dirWeight;

  let prob = classP;
  if (phase === "approach") {
    const baseline = 0.5 + tickDirection * 0.15;
    prob = lerp(baseline, classP, ctx.ramp);
  }
  prob += personalityFor(p.seed).buyProbJitter;
  return Math.min(0.92, Math.max(0.08, prob));
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
  tickDirection: 1 | -1 | 0,
  ctx?: FlowContext
): TradePrint[] {
  const c = ctx ?? defaultCtx(phase);
  const rng = mulberry32(p.seed * 104729 + tickIndex * 7919 + 77);
  const prints: TradePrint[] = [];

  let remaining = Math.max(0, Math.floor(tickVolume));
  if (remaining === 0) return prints;

  // One print per window normally; two during the breakout phase when
  // the tape is genuinely active.
  const nPrints = Math.min(remaining, phase === "breakout" && rng() > 0.5 ? 2 : 1);
  const buyProb = buyProbFor(p, tickIndex, phase, tickDirection, c);
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
 *
 * NOTE: DrillSim no longer schedules flow by this index map — it derives
 * phases from revealed price events (flowPhaseForState, F2). This stays
 * as the coarse fallback for stateless callers and phase sanity checks.
 */
export function phaseForCandle(candleIndex: number, checkpointIndex: number): FlowPhase {
  if (candleIndex < checkpointIndex - 2) return "approach";
  if (candleIndex <= checkpointIndex + 1) return "breakout";
  return "resolution";
}

/**
 * F2 — event-triggered flow phase, from the revealed price/HOD state:
 *  - "resolution" the moment price has been rejected back below the
 *    level (failed distribution / weak fade begin with the rejection
 *    itself, not two candles later), and for post-checkpoint
 *    continuation once acceptance is established.
 *  - "breakout" while price is testing / breaking / accepting at the
 *    level around the decision point.
 *  - "approach" otherwise (the shared neutral baseline territory).
 */
export function flowPhaseForState(
  state: HodMarketState,
  candleIndex: number,
  checkpointIndex: number
): FlowPhase {
  if (state === "rejected") return "resolution";
  if (candleIndex > checkpointIndex + 1) return "resolution";
  if (state === "accepting" && candleIndex > checkpointIndex) return "resolution";
  if (state === "breaking" || state === "accepting") return "breakout";
  // "testing" (coiling at the level, no cross yet) stays approach: the
  // class character must emerge through the cross itself, not leak into
  // the coil — the ramp still lets it build partially (see rampFor).
  return "approach";
}

/**
 * F1 — class-character ramp for a candle: 0 deep in the approach, rising
 * across the last five candles before the checkpoint, and forced up by
 * event proximity — testing the level lets character build halfway
 * (0.5), any decisive state (breaking/accepting/rejected) means it has
 * fully emerged (1).
 */
export function rampFor(
  state: HodMarketState,
  candleIndex: number,
  checkpointIndex: number
): number {
  let ramp = clamp01((candleIndex - (checkpointIndex - 5)) / 4);
  if (state === "testing") ramp = Math.max(ramp, 0.5);
  if (state === "breaking" || state === "accepting" || state === "rejected") ramp = 1;
  return ramp;
}
