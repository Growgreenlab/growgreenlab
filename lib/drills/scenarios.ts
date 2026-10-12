/**
 * Breakout Recognition Drill — HOD scenario library (v2).
 *
 * Four hand-designed scenarios with REALISTIC price action: wicks, varying
 * candle sizes, pullbacks, and texture — while preserving each scenario's
 * structural story and intended classification.
 *
 * Each scenario is fully predefined. The deterministic tick engine turns
 * these candles into identical tick sequences on every replay.
 */
import type { Candle } from "../types";
import type { DrillScenario } from "./types";

const BASE = 10.0;
const T = 60_000;
const T0 = 1_700_000_000_000;

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
 * Realistic grind up with pullbacks, tight consolidation, strong break.
 */
function cleanBreakout(): DrillScenario {
  const hod = 0.5;
  const raw: RawCandle[] = [
    // --- Approach: realistic grind with pullbacks (0-8) ---
    { o: 0.10, h: 0.17, l: 0.08, c: 0.14, v: 8200 },
    { o: 0.14, h: 0.20, l: 0.12, c: 0.18, v: 7800 },
    { o: 0.18, h: 0.21, l: 0.14, c: 0.16, v: 8500 },  // pullback
    { o: 0.16, h: 0.24, l: 0.15, c: 0.22, v: 9200 },  // engulfing
    { o: 0.22, h: 0.27, l: 0.20, c: 0.25, v: 8700 },
    { o: 0.25, h: 0.28, l: 0.21, c: 0.23, v: 7900 },  // indecision
    { o: 0.23, h: 0.32, l: 0.22, c: 0.30, v: 9800 },  // strong push
    { o: 0.30, h: 0.35, l: 0.28, c: 0.33, v: 8900 },
    { o: 0.33, h: 0.39, l: 0.31, c: 0.37, v: 9300 },
    // --- Consolidation: tight but with texture (9-13) ---
    { o: 0.37, h: 0.44, l: 0.35, c: 0.41, v: 6200 },
    { o: 0.41, h: 0.45, l: 0.38, c: 0.42, v: 5400 },
    { o: 0.42, h: 0.47, l: 0.40, c: 0.45, v: 5100 },
    { o: 0.45, h: 0.48, l: 0.42, c: 0.44, v: 5300 },  // small red
    { o: 0.44, h: 0.49, l: 0.43, c: 0.47, v: 5900 },
    // --- Breakout (14) — CHECKPOINT ---
    { o: 0.47, h: 0.63, l: 0.46, c: 0.60, v: 24500 },
    // --- Resolution: holds and continues (15-19) ---
    { o: 0.60, h: 0.69, l: 0.58, c: 0.66, v: 18200 },
    { o: 0.66, h: 0.73, l: 0.63, c: 0.70, v: 14800 },
    { o: 0.70, h: 0.75, l: 0.67, c: 0.72, v: 12100 },
    { o: 0.72, h: 0.81, l: 0.70, c: 0.78, v: 16300 },
    { o: 0.78, h: 0.85, l: 0.76, c: 0.82, v: 13200 },
  ];
  return {
    id: "hod-clean-001",
    version: 2,
    setupCategory: "hod-breakout",
    classification: "clean",
    difficulty: "beginner",
    title: "Clean HOD Breakout",
    description: "Price grinds up, consolidates tightly under the high of day, then breaks out.",
    seed: 11001,
    candles: toCandles(raw),
    hod: round2(BASE + hod),
    checkpointIndex: 14,
    evidence: {
      candleStructure: "Nine approach candles showed a healthy grind with two natural pullbacks (candles 3 and 6) — real uptrends breathe. Five consolidation candles coiled tightly between $10.40–$10.48 directly beneath the $10.50 HOD.",
      volumeBehavior: "Volume contracted during consolidation (5k–6k vs 8k–9k on the approach), then expanded to 24.5k on the breakout candle — nearly 4x the consolidation average.",
      priceVsLevel: "The breakout candle opened at $10.47, pushed through $10.50, and closed at $10.60 near its $10.63 high. Minimal upper wick — buyers held control into the close.",
      resolution: "The next five candles held above $10.50 (broken resistance became support) and pushed to $10.82. The HOD was never retested.",
    },
    teaching: {
      lessons: [
        "Contraction before expansion: tight range + shrinking volume under resistance is the highest-probability breakout setup.",
        "A clean break closes near its high on expanding volume — that's acceptance, not just a poke above the level.",
      ],
      missedByAnswer: {
        weak: "The volume expansion (4x) and close-near-high rule out a weak read — weak breaks show hesitation, not conviction.",
        failed: "Nothing in the breakout candle suggested failure: no long upper wick, no volume climax followed by reversal.",
        not_sure: "This one had the three classic tells: tight coil, volume contraction then expansion, and a strong close. Worth committing to the read.",
      },
      alternativeOutcome: "If this had failed, you'd have seen a long upper wick on the breakout candle (rejection), volume spike then immediate fade, and the next candle closing back under $10.50.",
    },
  };
}

/**
 * Scenario 2 — WEAK BREAKOUT (beginner).
 * Choppy grind, indecisive poke above HOD, fades back.
 */
function weakBreakout(): DrillScenario {
  const hod = 0.5;
  const raw: RawCandle[] = [
    // --- Choppy approach (0-8) ---
    { o: 0.10, h: 0.15, l: 0.08, c: 0.13, v: 7200 },
    { o: 0.13, h: 0.19, l: 0.11, c: 0.17, v: 7600 },
    { o: 0.17, h: 0.20, l: 0.13, c: 0.15, v: 7400 },
    { o: 0.15, h: 0.22, l: 0.14, c: 0.20, v: 7900 },
    { o: 0.20, h: 0.26, l: 0.18, c: 0.24, v: 8100 },
    { o: 0.24, h: 0.28, l: 0.21, c: 0.23, v: 7300 },
    { o: 0.23, h: 0.31, l: 0.22, c: 0.29, v: 8000 },
    { o: 0.29, h: 0.34, l: 0.27, c: 0.32, v: 7700 },
    { o: 0.32, h: 0.38, l: 0.30, c: 0.36, v: 7500 },
    // --- Drifting toward HOD, losing momentum (9-12) ---
    { o: 0.36, h: 0.41, l: 0.34, c: 0.39, v: 6800 },
    { o: 0.39, h: 0.44, l: 0.37, c: 0.42, v: 6600 },
    { o: 0.42, h: 0.47, l: 0.40, c: 0.44, v: 6400 },
    { o: 0.44, h: 0.48, l: 0.42, c: 0.46, v: 6200 },
    // --- Weak poke above HOD (13) ---
    { o: 0.46, h: 0.54, l: 0.45, c: 0.51, v: 8100 },
    // --- CHECKPOINT (14): indecisive doji at the level ---
    { o: 0.51, h: 0.55, l: 0.49, c: 0.52, v: 6000 },
    // --- Resolution: stalls and fades (15-19) ---
    { o: 0.52, h: 0.54, l: 0.48, c: 0.50, v: 5800 },
    { o: 0.50, h: 0.53, l: 0.46, c: 0.47, v: 7000 },
    { o: 0.47, h: 0.50, l: 0.43, c: 0.45, v: 7800 },
    { o: 0.45, h: 0.47, l: 0.40, c: 0.42, v: 7400 },
    { o: 0.42, h: 0.44, l: 0.37, c: 0.39, v: 7100 },
  ];
  return {
    id: "hod-weak-001",
    version: 2,
    setupCategory: "hod-breakout",
    classification: "weak",
    difficulty: "beginner",
    title: "Weak HOD Breakout",
    description: "Price edges above the high of day but conviction is missing.",
    seed: 11002,
    candles: toCandles(raw),
    hod: round2(BASE + hod),
    checkpointIndex: 14,
    evidence: {
      candleStructure: "The approach was choppy with overlapping candles — no clean trend. The breakout candle had a small $0.05 body with wicks both sides, followed by a doji. Indecision, not conviction.",
      volumeBehavior: "Volume on the break (8.1k) barely exceeded the approach average (7.5k), then faded to 6k. A real break demands expansion; this was flat to declining.",
      priceVsLevel: "Price poked to $10.54 but closed at $10.51–$10.52 — barely above $10.50. Each subsequent candle closed weaker, sliding back under the level.",
      resolution: "Within five candles price was back at $10.39, under the HOD. The 'breakout' never attracted follow-through buying.",
    },
    teaching: {
      lessons: [
        "A break without volume is a warning, not a signal. Price above the level means nothing if nobody's buying it there.",
        "Small overlapping bodies after the break = indecision. Strong breaks show expanding ranges, not shrinking ones.",
      ],
      missedByAnswer: {
        clean: "Compare the breakout candle here ($0.05 body, 8k volume) to a clean break — no expansion, no strong close. The level was touched, not taken.",
        failed: "Close — but a failed breakout/trap implies sharp rejection. This just fizzled. Weak is the more precise read.",
        not_sure: "The tell was volume: flat into the break. When in doubt, volume is the tiebreaker between weak and clean.",
      },
      alternativeOutcome: "A clean version would have shown the breakout candle closing near its high on 2–3x volume, with the next candles holding above $10.50.",
    },
  };
}

/**
 * Scenario 3 — FAILED BREAKOUT / TRAP (intermediate).
 * Strong run-up, violent spike and rejection, collapse.
 */
function failedBreakout(): DrillScenario {
  const hod = 0.5;
  const raw: RawCandle[] = [
    // --- Strong approach (0-8) ---
    { o: 0.10, h: 0.17, l: 0.08, c: 0.15, v: 8200 },
    { o: 0.15, h: 0.22, l: 0.13, c: 0.20, v: 8600 },
    { o: 0.20, h: 0.24, l: 0.17, c: 0.19, v: 8000 },
    { o: 0.19, h: 0.27, l: 0.18, c: 0.25, v: 9100 },
    { o: 0.25, h: 0.32, l: 0.23, c: 0.30, v: 9400 },
    { o: 0.30, h: 0.35, l: 0.28, c: 0.33, v: 8900 },
    { o: 0.33, h: 0.40, l: 0.32, c: 0.38, v: 9200 },
    { o: 0.38, h: 0.44, l: 0.36, c: 0.42, v: 8800 },
    { o: 0.42, h: 0.48, l: 0.41, c: 0.46, v: 9100 },
    // --- Tightening under HOD (9-11) ---
    { o: 0.46, h: 0.50, l: 0.44, c: 0.48, v: 8700 },
    { o: 0.48, h: 0.51, l: 0.46, c: 0.49, v: 8400 },
    { o: 0.49, h: 0.52, l: 0.47, c: 0.50, v: 8900 },
    // --- Trap candle: violent spike and rejection (12) ---
    { o: 0.50, h: 0.68, l: 0.49, c: 0.54, v: 28500 },
    // --- Immediate weakness (13) ---
    { o: 0.54, h: 0.58, l: 0.50, c: 0.51, v: 20500 },
    // --- CHECKPOINT (14) ---
    { o: 0.51, h: 0.54, l: 0.46, c: 0.47, v: 18500 },
    // --- Collapse (15-19) ---
    { o: 0.47, h: 0.49, l: 0.40, c: 0.42, v: 22000 },
    { o: 0.42, h: 0.44, l: 0.35, c: 0.37, v: 20500 },
    { o: 0.37, h: 0.39, l: 0.30, c: 0.32, v: 18800 },
    { o: 0.32, h: 0.34, l: 0.26, c: 0.28, v: 17200 },
    { o: 0.28, h: 0.30, l: 0.22, c: 0.24, v: 15800 },
  ];
  return {
    id: "hod-failed-001",
    version: 2,
    setupCategory: "hod-breakout",
    classification: "failed",
    difficulty: "intermediate",
    title: "Failed HOD Breakout (Trap)",
    description: "A strong-looking break that violently reverses. Watch the wick.",
    seed: 11003,
    candles: toCandles(raw),
    hod: round2(BASE + hod),
    checkpointIndex: 14,
    evidence: {
      candleStructure: "The trap candle spiked to $10.68 but closed at $10.54 — a $0.14 upper wick on massive range. The next two candles closed at $10.51 then $10.47, already back under $10.50 by the checkpoint.",
      volumeBehavior: "Volume climaxed at 28.5k on the spike (3x average) — climax volume into resistance often marks exhaustion, not launch. Volume stayed elevated on the way down (distribution).",
      priceVsLevel: "Price tagged $10.68 but never held above $10.50 into a close after the spike. By the checkpoint it was $10.47 — the 'breakout' had already failed.",
      resolution: "Five candles later price was $10.24, down $0.44 from the spike high. Late buyers were trapped and the move fully unwound.",
    },
    teaching: {
      lessons: [
        "The wick tells the truth: a long upper wick on the breakout candle means sellers overwhelmed buyers at the highs — even on big volume.",
        "Climax volume + failure to hold = trap signature. Volume alone doesn't confirm; it's volume WITH price acceptance that matters.",
      ],
      missedByAnswer: {
        clean: "The spike looked strong in real time, but the close is what matters — $10.54 vs $10.68 high left a massive rejection wick. Clean breaks close near highs.",
        weak: "This wasn't weak — it was violent. Weak breaks fizzle; this spiked and got slammed. The aggression of the reversal is the trap tell.",
        not_sure: "The wick was the tell: $0.14 of rejection on huge range. When the high and close disagree that much, trust the close.",
      },
      alternativeOutcome: "If this had been clean, the spike candle would have closed near $10.66 (not $10.54), and the next candles would have held above $10.50 instead of fading immediately.",
    },
  };
}

/**
 * Scenario 4 — AMBIGUOUS (advanced).
 * Genuinely mixed: decent break, brief hold, then directionless chop.
 */
function ambiguousBreakout(): DrillScenario {
  const hod = 0.5;
  const raw: RawCandle[] = [
    // --- Grind up (0-8) ---
    { o: 0.10, h: 0.16, l: 0.08, c: 0.14, v: 7600 },
    { o: 0.14, h: 0.20, l: 0.12, c: 0.18, v: 7900 },
    { o: 0.18, h: 0.22, l: 0.15, c: 0.17, v: 7700 },
    { o: 0.17, h: 0.24, l: 0.16, c: 0.22, v: 8100 },
    { o: 0.22, h: 0.28, l: 0.20, c: 0.26, v: 8000 },
    { o: 0.26, h: 0.30, l: 0.23, c: 0.28, v: 7800 },
    { o: 0.28, h: 0.35, l: 0.27, c: 0.33, v: 8200 },
    { o: 0.33, h: 0.39, l: 0.31, c: 0.37, v: 8000 },
    { o: 0.37, h: 0.43, l: 0.35, c: 0.41, v: 7900 },
    // --- Consolidation (9-12) ---
    { o: 0.41, h: 0.46, l: 0.39, c: 0.44, v: 7600 },
    { o: 0.44, h: 0.48, l: 0.42, c: 0.46, v: 7400 },
    { o: 0.46, h: 0.49, l: 0.43, c: 0.45, v: 7500 },
    { o: 0.45, h: 0.49, l: 0.43, c: 0.47, v: 7700 },
    // --- Break: decent but closes mid-range (13) ---
    { o: 0.47, h: 0.59, l: 0.46, c: 0.55, v: 14200 },
    // --- CHECKPOINT (14): holds but choppy ---
    { o: 0.55, h: 0.60, l: 0.52, c: 0.56, v: 11800 },
    // --- Resolution: directionless chop (15-19) ---
    { o: 0.56, h: 0.59, l: 0.51, c: 0.53, v: 10500 },
    { o: 0.53, h: 0.58, l: 0.50, c: 0.56, v: 10200 },
    { o: 0.56, h: 0.59, l: 0.52, c: 0.54, v: 9800 },
    { o: 0.54, h: 0.57, l: 0.50, c: 0.52, v: 10100 },
    { o: 0.52, h: 0.56, l: 0.49, c: 0.53, v: 9900 },
  ];
  return {
    id: "hod-ambiguous-001",
    version: 2,
    setupCategory: "hod-breakout",
    classification: "ambiguous",
    difficulty: "advanced",
    title: "Ambiguous HOD Action",
    description: "Mixed signals at the high of day. Not every setup has a clear read.",
    seed: 11004,
    candles: toCandles(raw),
    hod: round2(BASE + hod),
    checkpointIndex: 14,
    evidence: {
      candleStructure: "The breakout candle ($10.47 → $10.55) was decent but closed mid-range at $10.55 vs $10.59 high. Afterward: five overlapping chop candles between $10.52–$10.58, no direction.",
      volumeBehavior: "Volume expanded to 14.2k (moderate, not convincing), then faded back to ~10k. Neither climax nor conviction — just participation.",
      priceVsLevel: "Price held above $10.50 but couldn't extend — six candles of sideways drift. Above the level, but going nowhere.",
      resolution: "The scenario ends unresolved: $10.53, still above HOD, still chopping. The market is saying 'not yet.'",
    },
    teaching: {
      lessons: [
        "Not every setup deserves a strong opinion. Recognizing 'I don't have an edge here' is itself a trading skill.",
        "When evidence conflicts (decent break + flat follow-through + fading volume), the professional move is to wait, not to force a read.",
      ],
      missedByAnswer: {
        clean: "Reasonable instinct — it did hold above HOD. But clean requires continuation, and chop isn't continuation.",
        weak: "Also reasonable — the follow-through was weak. But it never broke back down either. The honest answer is mixed evidence.",
        failed: "Understandable caution, but nothing actually failed — price never lost the level. This is why 'not sure' exists.",
        not_sure: "Correct instinct. The evidence genuinely didn't support a strong read — and recognizing that IS the skill being tested.",
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
