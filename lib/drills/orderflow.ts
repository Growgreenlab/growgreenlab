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
  price: number,
  phase: FlowPhase,
  rng: () => number
): { bid: number[]; ask: number[] } {
  let bidTouch = 400, askTouch = 400, bidVar = 300, askVar = 300;
  const bidExtra = [0, 0, 0, 0, 0];
  const askExtra = [0, 0, 0, 0, 0];

  switch (p.behavior) {
    case "clean":
      if (phase === "breakout") {
        // F6: strong but credible — depth ratio ≈ 2–2.5, not the old
        // ~6x class constant. Bids stack, asks stay thin ENOUGH to be
        // consumed visibly, but the book no longer decides by itself.
        bidTouch = 700; askTouch = 360; bidVar = 350; askVar = 140;
        bidExtra[0] = 250; bidExtra[1] = 150; // stacked support under the break
      } else if (phase === "resolution") {
        bidTouch = 600; askTouch = 500;
      }
      break;
    case "weak":
      if (phase === "breakout") {
        bidTouch = 180; askTouch = 180; bidVar = 90; askVar = 90;
      } else if (phase === "resolution") {
        bidTouch = 240; askTouch = 240; bidVar = 110; askVar = 110;
      }
      break;
    case "failed":
      if (phase === "breakout") {
        bidTouch = 500; askTouch = 300; bidVar = 300; askVar = 200;
        // Absorption at the top: while price trades at/above the level,
        // heavy supply leans on the near ask rungs — a wall a couple of
        // cents over the market that buyers must chew through. (The
        // pinned wall AT level+2¢ is applied in generateBook, which
        // knows the spread-aware rung index and the previous book — F7.)
        if (price >= p.level) {
          askExtra[0] += 700;
          askExtra[1] += 3000;
          askExtra[2] += 1200;
        }
      } else if (phase === "resolution") {
        bidTouch = 150; askTouch = 900; bidVar = 120; askVar = 500;
      }
      break;
    case "ambiguous": {
      // Redesigned (audit): the old sin(tick/37) "flicker" had a period
      // longer than the whole approach — a slow swell that fingerprinted
      // the class. Now the lean is re-randomized PER CANDLE, wobble is
      // confined within the candle, and approach amplitude is mild.
      const candleIndex = Math.floor(tickIndex / FLOW_UPDATES_PER_CANDLE);
      const updateIndex = tickIndex % FLOW_UPDATES_PER_CANDLE;
      const candleRng = mulberry32(p.seed * 31 + candleIndex * 1013 + 7);
      const leanBid = candleRng() > 0.5;
      const wobble =
        1 + 0.15 * Math.sin((updateIndex / FLOW_UPDATES_PER_CANDLE) * Math.PI * 2 + candleRng() * Math.PI * 2);
      if (phase === "breakout") {
        // Designed conflict: alternate the heavy side candle by candle.
        bidTouch = leanBid ? 640 : 250;
        askTouch = leanBid ? 250 : 640;
        bidVar = 260; askVar = 260;
      } else if (phase === "resolution") {
        bidTouch = (leanBid ? 520 : 330) * wobble;
        askTouch = (leanBid ? 330 : 520) * wobble;
        bidVar = 240; askVar = 240;
      } else {
        bidTouch = 400 * wobble;
        askTouch = 400 / wobble;
      }
      if (phase !== "approach" && rng() > 0.7) {
        // Phantom size (kept — it read as genuinely ambiguous): a target
        // that appears for one update, then goes. Breakout/resolution only.
        const extra = rng() > 0.5 ? bidExtra : askExtra;
        extra[Math.floor(rng() * 3)] += Math.round(1200 * rng());
      }
      break;
    }
  }

  const bid = rungSizes(bidTouch + rng() * bidVar, bidExtra);
  const ask = rungSizes(askTouch + rng() * askVar, askExtra);
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
  price: number,
  phase: FlowPhase,
  rng: () => number,
  ctx: FlowContext
): { bid: number[]; ask: number[] } {
  const pers = personalityFor(p.seed);
  let { bid, ask } = classTargets(p, tickIndex, price, phase, rng);
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
  const targets = depthTargets(p, tickIndex, price, phase, rng, c);

  // F7 — Failed's wall, pinned BY PRICE at level + 2¢. It applies while
  // the ladder actually contains that price (price within a few cents of
  // the level during the breakout), scaled by personality; persistence
  // and slow decay are handled in the evolve step below.
  const wallC = Math.round(p.level * 100) + 2;
  const wallIdx = wallC - midC - hs;
  const wallActive =
    p.behavior === "failed" && phase === "breakout" && wallIdx >= 0 && wallIdx < 5;
  if (wallActive) targets.ask[wallIdx] += 2500 * pers.wallScale;

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
  // F8 — Weak's sellers requote almost instantly: the consumption shave
  // barely applies to its ask side, so "replenishment" is a readable
  // dynamic of its own, not just thinness.
  if (p.behavior === "weak") askShave = Math.max(askShave, 0.92);
  const prevBidByCents = new Map((prev?.bids ?? []).map((l) => [Math.round(l.price * 100), l.size]));
  const prevAskByCents = new Map((prev?.asks ?? []).map((l) => [Math.round(l.price * 100), l.size]));

  const stepCap = 0.35 * pers.refillScale;
  // Weak ask refill cap: faster than the standard cap, but never scaled
  // past 0.45 — beyond that a single-window jump stops looking like
  // requoting and starts looking like teleporting depth.
  const askStepCap = p.behavior === "weak" ? 0.45 * Math.min(pers.refillScale, 1) : stepCap;
  const evolve = (
    target: number,
    prevSize: number | undefined,
    shave: number,
    cap: number,
    isWall: boolean
  ): number => {
    if (prevSize == null) {
      // Fresh rung: start near target.
      return Math.max(1, Math.round(target * (0.85 + rng() * 0.3)));
    }
    // Bounded step toward target (≤ cap of current), then the shave.
    const step = Math.max(-cap * prevSize, Math.min(cap * prevSize, target - prevSize));
    let size = Math.max(1, Math.round((prevSize + step) * shave * (0.95 + rng() * 0.1)));
    // F7: once the wall exists at this price it decays slowly (~5% per
    // window) instead of target-seeking away — a resting order, not a
    // quote that teleports with the ladder.
    if (isWall) size = Math.max(size, Math.round(prevSize * 0.95));
    return size;
  };

  // F7 (cont.): during Failed's breakout at/above the level, large
  // offers near the touch are STICKY — once size shows at a price it
  // decays at ~5%/window rather than stepping down when the ladder
  // re-anchors around it. Absorption you can watch, not a quote that
  // evaporates as price moves a cent.
  const stickyAsk =
    p.behavior === "failed" && phase === "breakout" && price >= p.level;

  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let i = 0; i < 5; i++) {
    const bidC = midC - hs - i;
    const askC = midC + hs + i;
    bids.push({ price: bidC / 100, size: evolve(targets.bid[i], prevBidByCents.get(bidC), bidShave, stepCap, false) });
    asks.push({
      price: askC / 100,
      size: evolve(
        targets.ask[i],
        prevAskByCents.get(askC),
        askShave,
        askStepCap,
        (wallActive && askC === wallC) || (stickyAsk && i <= 2)
      ),
    });
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
  price: number,
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
      if (phase === "resolution" || ctx.state === "rejected") {
        // F8: once price has faded back below the level, the tape leans
        // mildly NET SELL — it must not keep printing buy-skewed bounce
        // tape while the break dies. While still above, stay indecisive.
        classP = price < p.level ? 0.45 : 0.5;
        dirWeight = 0.05;
      } else {
        // Weak = indecisive: tick direction barely moves the needle
        classP = 0.5 + tickDirection * 0.05;
        dirWeight = 0.05;
      }
      break;
    case "failed":
      classP = phase === "resolution" ? 0.3 : 0.6;
      break;
    case "ambiguous": {
      // Per-candle re-randomized phase (audit fix): the old global sine
      // could park near its ceiling for an entire candle, printing the
      // strongest "buy tape" in the system on the cross. Capped at 0.7.
      const candleIndex = Math.floor(tickIndex / FLOW_UPDATES_PER_CANDLE);
      const phaseOff = mulberry32(p.seed * 17 + candleIndex * 6151 + 3)() * Math.PI * 2;
      classP = 0.5 + 0.18 * Math.sin(tickIndex / 5 + phaseOff);
      dirWeight = 0.1;
      break;
    }
  }
  // Tick direction nudges the print side (uptick = buyer-initiated)
  classP += tickDirection * dirWeight;

  let prob = classP;
  if (phase === "approach") {
    const baseline = 0.5 + tickDirection * 0.15;
    prob = lerp(baseline, classP, ctx.ramp);
  }
  prob += personalityFor(p.seed).buyProbJitter;
  // Clean: on up-windows at/above the level during the break, buyers
  // are lifting the offer — floor the bias so the cross-candle tape
  // backs the story instead of coin-flipping (with F4's smaller, more
  // numerous prints this concentrates the candle's buy-share).
  if (p.behavior === "clean" && phase === "breakout" && price >= p.level) {
    prob = Math.max(prob, tickDirection >= 0 ? 0.82 : 0.68);
  }
  if (p.behavior === "ambiguous") {
    return Math.min(0.7, Math.max(0.28, prob));
  }
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
 *
 * F4 — print COUNT scales with the window's traded volume (~650 shares
 * per print, clamped 1–8): quiet windows stay sparse, climactic windows
 * print actively, and per-candle tape statistics concentrate near their
 * bias instead of swinging on 12 coin flips. The underlying window
 * volume is never altered, only grouped.
 *
 * F3 — prints execute AT the prevailing quote, by side: a buyer-
 * initiated print is priced at the current best ask, a seller-initiated
 * print at the current best bid (the book DrillSim just generated for
 * this window). Side and price location can no longer contradict each
 * other. Stateless callers without a book fall back to last ± half-spread.
 * Side classification: scenario behavior/phase bias nudged by the
 * window's actual tick direction (uptick ⇒ buyer-initiated).
 */
export function generatePrints(
  p: FlowParams,
  tickIndex: number,
  price: number,
  tickVolume: number,
  phase: FlowPhase,
  timestamp: number,
  tickDirection: 1 | -1 | 0,
  book?: OrderBookSnapshot,
  ctx?: FlowContext
): TradePrint[] {
  const c = ctx ?? defaultCtx(phase);
  const rng = mulberry32(p.seed * 104729 + tickIndex * 7919 + 77);
  const prints: TradePrint[] = [];

  let remaining = Math.max(0, Math.floor(tickVolume));
  if (remaining === 0) return prints;

  const nPrints = Math.min(
    remaining,
    Math.max(1, Math.min(8, Math.round(tickVolume / 650)))
  );
  const buyProb = buyProbFor(p, tickIndex, price, phase, tickDirection, c);
  const hsC = halfSpreadForVol(c.volC);
  const askPx = book ? book.asks[0].price : round2(price + hsC / 100);
  const bidPx = book ? book.bids[0].price : round2(price - hsC / 100);
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

    const side = rng() < buyProb ? "buy" : "sell";
    prints.push({
      price: side === "buy" ? askPx : bidPx,
      size,
      timestamp: timestamp + i,
      side,
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
  checkpointIndex: number,
  behavior?: FlowBehavior
): FlowPhase {
  if (state === "rejected") return "resolution";
  // Failed's fake acceptance is still the trap being armed: while price
  // holds above the level, flow stays in breakout character (lure +
  // wall) until a rejection confirms — distribution keyed to the event,
  // not to the calendar.
  if (behavior === "failed" && state === "accepting") return "breakout";
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
