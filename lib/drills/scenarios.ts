/**
 * Breakout Recognition Drill — HOD scenario library (v1).
 *
 * Four hand-designed scenarios. Each is fully predefined: the candle
 * array IS the scenario. The deterministic tick engine (mulberry32 in
 * lib/engine.ts) turns these candles into identical tick sequences on
 * every replay — no runtime randomness anywhere.
 *
 * Candle construction: prices are authored in "ticks" of $0.01 around a
 * base price so shapes are intentional, not accidental. Volume is authored
 * per candle to tell the volume story (expansion on real breaks, weak
 * volume on traps).
 */
import type { Candle } from "../types";
import type { DrillScenario } from "./types";

const BASE = 10.0; // base price; scenarios are price-agnostic shapes
const T = 60_000; // 1-minute candles
const T0 = 1_700_000_000_000; // fixed epoch so timestamps are deterministic

interface RawCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function toCandles(raw: RawCandle[], startT = T0): Candle[] {
  return raw.map((r, i) => ({
    t: startT + i * T,
    o: round2(BASE + r.o),
    h: round2(BASE + r.h),
    l: round2(BASE + r.l),
    c: round2(BASE + r.c),
    v: Math.round(r.v),
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Scenario 1 — CLEAN BREAKOUT (beginner).
 * Tight consolidation under HOD, breakout candle closes near highs on
 * 3x average volume, next candles hold above the broken level and push
 * higher. The textbook read.
 */
function cleanBreakout(): DrillScenario {
  const hod = 0.5; // HOD is $10.50
  const raw: RawCandle[] = [
    // --- Approach: grinding up toward HOD ---
    { o: 0.10, h: 0.18, l: 0.08, c: 0.15, v: 8000 },
    { o: 0.15, h: 0.24, l: 0.13, c: 0.22, v: 9000 },
    { o: 0.22, h: 0.30, l: 0.20, c: 0.28, v: 8500 },
    { o: 0.28, h: 0.36, l: 0.26, c: 0.34, v: 9500 },
    // --- Consolidation: tight range just under HOD ---
    { o: 0.34, h: 0.42, l: 0.33, c: 0.40, v: 6000 },
    { o: 0.40, h: 0.44, l: 0.37, c: 0.42, v: 5500 },
    { o: 0.42, h: 0.46, l: 0.39, c: 0.44, v: 5200 },
    { o: 0.44, h: 0.47, l: 0.41, c: 0.45, v: 5000 },
    { o: 0.45, h: 0.48, l: 0.43, c: 0.47, v: 5800 },
    // --- Breakout: strong candle through HOD, closes near high, 3x volume ---
    { o: 0.47, h: 0.62, l: 0.46, c: 0.60, v: 24000 },
    // --- CHECKPOINT (index 10): user sees up to here ---
    // --- Follow-through: holds above broken level, pushes higher ---
    { o: 0.60, h: 0.68, l: 0.57, c: 0.66, v: 18000 },
    { o: 0.66, h: 0.72, l: 0.62, c: 0.70, v: 15000 },
    { o: 0.70, h: 0.74, l: 0.66, c: 0.72, v: 12000 },
    { o: 0.72, h: 0.80, l: 0.70, c: 0.78, v: 16000 },
    { o: 0.78, h: 0.84, l: 0.75, c: 0.82, v: 13000 },
  ];
  return {
    id: "hod-clean-001",
    version: 1,
    setupCategory: "hod-breakout",
    classification: "clean",
    difficulty: "beginner",
    title: "Clean HOD Breakout",
    description: "Price consolidates tightly under the high of day, then breaks out.",
    seed: 11001,
    candles: toCandles(raw),
    hod: round2(BASE + hod),
    checkpointIndex: 10,
    evidence: {
      candleStructure: "Five tight consolidation candles (each under $0.05 range) formed directly beneath the $10.50 HOD — classic coiling before expansion.",
      volumeBehavior: "Volume contracted during consolidation (5k-6k vs 8k-9k on the approach), then expanded to 24k on the breakout candle — roughly 3x the consolidation average.",
      priceVsLevel: "The breakout candle opened at $10.47, pushed through $10.50, and closed at $10.60 near its high. No long upper wick — buyers held control into the close.",
      resolution: "The next five candles held above $10.50 (the broken level became support) and pushed to $10.82. No retest even touched the HOD.",
    },
    teaching: {
      lessons: [
        "Contraction before expansion: tight range + shrinking volume under resistance is the highest-probability breakout setup.",
        "A clean break closes near its high on expanding volume — that's acceptance, not just a poke above the level.",
      ],
      missedByAnswer: {
        weak: "The volume expansion (3x) and close-near-high rule out a weak read — weak breaks show hesitation, not conviction.",
        failed: "Nothing in the breakout candle suggested failure: no long upper wick, no volume climax followed by reversal.",
        not_sure: "This one had the three classic tells: tight coil, volume contraction then expansion, and a strong close. Worth committing to the read.",
      },
      alternativeOutcome: "If this had failed, you'd have seen a long upper wick on the breakout candle (rejection), volume spike then immediate fade, and the next candle closing back under $10.50.",
    },
  };
}

/**
 * Scenario 2 — WEAK BREAKOUT (beginner).
 * Price drifts above HOD on thin volume, small-bodied candles, no
 * follow-through. Stalls and fades back under the level.
 */
function weakBreakout(): DrillScenario {
  const hod = 0.5;
  const raw: RawCandle[] = [
    { o: 0.10, h: 0.16, l: 0.08, c: 0.14, v: 7000 },
    { o: 0.14, h: 0.22, l: 0.12, c: 0.20, v: 7500 },
    { o: 0.20, h: 0.28, l: 0.18, c: 0.26, v: 7000 },
    { o: 0.26, h: 0.34, l: 0.24, c: 0.32, v: 8000 },
    { o: 0.32, h: 0.40, l: 0.30, c: 0.38, v: 7500 },
    { o: 0.38, h: 0.44, l: 0.36, c: 0.42, v: 7000 },
    { o: 0.42, h: 0.47, l: 0.40, c: 0.45, v: 6500 },
    // --- Weak poke above HOD: small body, no volume ---
    { o: 0.45, h: 0.53, l: 0.44, c: 0.51, v: 8000 },
    { o: 0.51, h: 0.54, l: 0.48, c: 0.52, v: 6000 },
    { o: 0.52, h: 0.55, l: 0.49, c: 0.50, v: 5500 },
    // --- CHECKPOINT (index 10) ---
    // --- Stalls, drifts back under HOD ---
    { o: 0.50, h: 0.53, l: 0.46, c: 0.47, v: 7000 },
    { o: 0.47, h: 0.49, l: 0.42, c: 0.44, v: 8000 },
    { o: 0.44, h: 0.46, l: 0.39, c: 0.41, v: 7500 },
    { o: 0.41, h: 0.43, l: 0.36, c: 0.38, v: 7000 },
  ];
  return {
    id: "hod-weak-001",
    version: 1,
    setupCategory: "hod-breakout",
    classification: "weak",
    difficulty: "beginner",
    title: "Weak HOD Breakout",
    description: "Price edges above the high of day but something feels off.",
    seed: 11002,
    candles: toCandles(raw),
    hod: round2(BASE + hod),
    checkpointIndex: 10,
    evidence: {
      candleStructure: "The breakout candles had small bodies ($0.02-$0.03) with overlapping ranges — no conviction, just drift.",
      volumeBehavior: "Volume on the break (8k) was barely above the approach average (7k). A real break demands expansion; this was flat.",
      priceVsLevel: "Price poked to $10.55 but couldn't hold — each candle after the break closed weaker, sliding back toward and under $10.50.",
      resolution: "Within four candles price was back under the HOD at $10.38. The 'breakout' never attracted follow-through buying.",
    },
    teaching: {
      lessons: [
        "A break without volume is a warning, not a signal. Price above the level means nothing if nobody's buying it there.",
        "Small overlapping bodies after the break = indecision. Strong breaks show expanding ranges, not shrinking ones.",
      ],
      missedByAnswer: {
        clean: "Compare the breakout candle here ($0.03 body, 8k volume) to a clean break — no expansion, no strong close. The level was touched, not taken.",
        failed: "Close — but a failed breakout/trap implies a sharp rejection. This just fizzled. Weak is the more precise read.",
        not_sure: "The tell was volume: flat into the break. When in doubt, volume is the tiebreaker between weak and clean.",
      },
      alternativeOutcome: "A clean version of this would have shown the breakout candle closing near its high on 2-3x volume, with the next candles holding above $10.50.",
    },
  };
}

/**
 * Scenario 3 — FAILED BREAKOUT / TRAP (intermediate).
 * Strong-looking break that immediately reverses — long upper wick,
 * volume climax, then collapse back through the HOD.
 */
function failedBreakout(): DrillScenario {
  const hod = 0.5;
  const raw: RawCandle[] = [
    { o: 0.10, h: 0.18, l: 0.08, c: 0.16, v: 8000 },
    { o: 0.16, h: 0.24, l: 0.14, c: 0.22, v: 8500 },
    { o: 0.22, h: 0.30, l: 0.20, c: 0.28, v: 9000 },
    { o: 0.28, h: 0.36, l: 0.26, c: 0.34, v: 9500 },
    { o: 0.34, h: 0.42, l: 0.32, c: 0.40, v: 9000 },
    { o: 0.40, h: 0.46, l: 0.38, c: 0.44, v: 8500 },
    { o: 0.44, h: 0.49, l: 0.42, c: 0.47, v: 9000 },
    // --- Trap candle: spikes well above HOD then collapses ---
    { o: 0.47, h: 0.66, l: 0.46, c: 0.52, v: 28000 },
    { o: 0.52, h: 0.56, l: 0.48, c: 0.49, v: 20000 },
    { o: 0.49, h: 0.52, l: 0.44, c: 0.45, v: 18000 },
    // --- CHECKPOINT (index 10) ---
    // --- Collapse: back under HOD, selling accelerates ---
    { o: 0.45, h: 0.47, l: 0.38, c: 0.40, v: 22000 },
    { o: 0.40, h: 0.42, l: 0.33, c: 0.35, v: 20000 },
    { o: 0.35, h: 0.37, l: 0.28, c: 0.30, v: 18000 },
    { o: 0.30, h: 0.32, l: 0.24, c: 0.26, v: 16000 },
  ];
  return {
    id: "hod-failed-001",
    version: 1,
    setupCategory: "hod-breakout",
    classification: "failed",
    difficulty: "intermediate",
    title: "Failed HOD Breakout (Trap)",
    description: "A strong-looking break that doesn't hold. Watch the wick.",
    seed: 11003,
    candles: toCandles(raw),
    hod: round2(BASE + hod),
    checkpointIndex: 10,
    evidence: {
      candleStructure: "The breakout candle spiked to $10.66 but closed at $10.52 — a $0.14 upper wick. That's rejection, not acceptance. The next two candles closed progressively weaker.",
      volumeBehavior: "Volume climaxed at 28k on the spike candle (3x average) — climax volume into resistance often marks the trap, not the launch.",
      priceVsLevel: "Price tagged $10.66 but couldn't hold above $10.50 into any close. By the checkpoint, it was already back to $10.45 — under the level it 'broke.'",
      resolution: "Four candles later price was at $10.26, down $0.40 from the spike high. The breakout trapped late buyers and unwound completely.",
    },
    teaching: {
      lessons: [
        "The wick tells the truth: a long upper wick on the breakout candle means sellers overwhelmed buyers at the highs — even on big volume.",
        "Climax volume + failure to hold = trap signature. Volume alone doesn't confirm; it's volume WITH price acceptance that matters.",
      ],
      missedByAnswer: {
        clean: "The spike looked strong in real time, but the close is what matters — $10.52 close vs $10.66 high left a rejection wick. Clean breaks close near highs.",
        weak: "This wasn't weak — it was violent. Weak breaks fizzle; this spiked and got slammed. The aggression of the reversal is the trap tell.",
        not_sure: "The wick was the tell: $0.14 of rejection on the breakout candle. When the high and close disagree that much, trust the close.",
      },
      alternativeOutcome: "If this had been clean, the spike candle would have closed near $10.64 (not $10.52), and the next candles would have held above $10.50 instead of fading immediately.",
    },
  };
}

/**
 * Scenario 4 — AMBIGUOUS (advanced).
 * Genuinely mixed evidence: decent break, holds briefly, then choppy
 * two-way action. No single correct read — the lesson is recognizing
 * when the evidence doesn't support a strong opinion.
 */
function ambiguousBreakout(): DrillScenario {
  const hod = 0.5;
  const raw: RawCandle[] = [
    { o: 0.10, h: 0.17, l: 0.08, c: 0.15, v: 7500 },
    { o: 0.15, h: 0.23, l: 0.13, c: 0.21, v: 8000 },
    { o: 0.21, h: 0.29, l: 0.19, c: 0.27, v: 7800 },
    { o: 0.27, h: 0.35, l: 0.25, c: 0.33, v: 8200 },
    { o: 0.33, h: 0.41, l: 0.31, c: 0.39, v: 8000 },
    { o: 0.39, h: 0.45, l: 0.37, c: 0.43, v: 7800 },
    { o: 0.43, h: 0.48, l: 0.41, c: 0.46, v: 8200 },
    // --- Break: decent candle, moderate volume, closes mid-range ---
    { o: 0.46, h: 0.58, l: 0.45, c: 0.54, v: 14000 },
    { o: 0.54, h: 0.60, l: 0.51, c: 0.56, v: 12000 },
    { o: 0.56, h: 0.59, l: 0.52, c: 0.53, v: 11000 },
    // --- CHECKPOINT (index 10) ---
    // --- Choppy: holds, dips, recovers — no clear verdict ---
    { o: 0.53, h: 0.57, l: 0.50, c: 0.55, v: 10000 },
    { o: 0.55, h: 0.58, l: 0.51, c: 0.52, v: 10500 },
    { o: 0.52, h: 0.56, l: 0.49, c: 0.54, v: 9800 },
    { o: 0.54, h: 0.57, l: 0.50, c: 0.51, v: 10200 },
  ];
  return {
    id: "hod-ambiguous-001",
    version: 1,
    setupCategory: "hod-breakout",
    classification: "ambiguous",
    difficulty: "advanced",
    title: "Ambiguous HOD Action",
    description: "Mixed signals at the high of day. Not every setup has a clear read.",
    seed: 11004,
    candles: toCandles(raw),
    hod: round2(BASE + hod),
    checkpointIndex: 10,
    evidence: {
      candleStructure: "The breakout candle ($10.46 → $10.54) was decent but closed mid-range, not near the high. Afterward: overlapping chop, no direction.",
      volumeBehavior: "Volume expanded to 14k (moderate, not convincing 2-3x), then faded back to average. Neither climax nor conviction.",
      priceVsLevel: "Price held above $10.50 but couldn't extend — four candles of sideways drift between $10.50 and $10.58.",
      resolution: "The scenario ends unresolved: price is still above HOD but going nowhere. This is the market saying 'not yet.'",
    },
    teaching: {
      lessons: [
        "Not every setup deserves a strong opinion. Recognizing 'I don't have an edge here' is itself a trading skill.",
        "When evidence conflicts (decent break + flat follow-through + fading volume), the professional move is to wait, not to force a read.",
      ],
      missedByAnswer: {
        clean: "Reasonable instinct — it did hold above HOD. But clean requires continuation, and four candles of chop isn't continuation.",
        weak: "Also reasonable — the follow-through was weak. But it never broke back down either. The honest answer is that the evidence was mixed.",
        failed: "Understandable caution, but nothing actually failed — price never lost the level. This is why 'not sure' exists.",
        not_sure: "Correct instinct. The evidence genuinely didn't support a strong read in either direction — and recognizing that IS the skill being tested.",
      },
      alternativeOutcome: "A clean version would have shown the next candles pushing to $10.70+ on rising volume. A failed version would have shown a rejection wick and a close back under $10.50. This showed neither.",
    },
  };
}

export const HOD_SCENARIOS: DrillScenario[] = [
  cleanBreakout(),
  weakBreakout(),
  failedBreakout(),
  ambiguousBreakout(),
];

export function getScenario(id: string): DrillScenario | undefined {
  return HOD_SCENARIOS.find((s) => s.id === id);
}
