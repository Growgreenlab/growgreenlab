/**
 * Breakout Recognition Drill — HOD scenario library (v3).
 *
 * Scenarios are generated using the platform's own market microstructure
 * approach (same as generateSampleSession): regime-based random walks with
 * realistic wicks and volume. The HOD emerges organically from price action.
 * All seeded — fully deterministic.
 */
import type { Candle } from "../types";
import type { DrillScenario } from "./types";
import { generateScenarioCandles, type RegimeSpec, type BreakoutShaping } from "./candleGen";

const BASE = 10.0;

interface ScenarioDef {
  id: string;
  classification: "clean" | "weak" | "failed" | "ambiguous";
  difficulty: "beginner" | "intermediate" | "advanced";
  title: string;
  description: string;
  seed: number;
  regimes: RegimeSpec[];
  breakout: BreakoutShaping;
  breakoutAt: number;
}

function buildScenario(def: ScenarioDef): DrillScenario {
  const { candles, hod, breakoutIndex } = generateScenarioCandles(
    def.seed, BASE, def.regimes, def.breakout, def.breakoutAt
  );

  const checkpointIndex = breakoutIndex + 1;
  const breakoutCandle = candles[breakoutIndex];
  const preBreakout = candles.slice(0, breakoutIndex);
  const avgVol = preBreakout.reduce((s, c) => s + c.v, 0) / preBreakout.length;
  const volMult = (breakoutCandle.v / avgVol).toFixed(1);

  // Dynamic evidence from actual generated data
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  return {
    id: def.id,
    version: 3,
    setupCategory: "hod-breakout",
    classification: def.classification,
    difficulty: def.difficulty,
    title: def.title,
    description: def.description,
    seed: def.seed,
    candles,
    hod,
    checkpointIndex,
    evidence: buildEvidence(def, candles, hod, breakoutIndex, fmt, volMult),
    teaching: buildTeaching(def, fmt),
  };
}

function buildEvidence(
  def: ScenarioDef,
  candles: Candle[],
  hod: number,
  breakoutIndex: number,
  fmt: (n: number) => string,
  volMult: string
): DrillScenario["evidence"] {
  const bc = candles[breakoutIndex];
  const wickUp = bc.h - Math.max(bc.o, bc.c);
  const bodySize = Math.abs(bc.c - bc.o);

  const base = {
    candleStructure: "",
    volumeBehavior: "",
    priceVsLevel: "",
    resolution: "",
  };

  switch (def.classification) {
    case "clean":
      base.candleStructure = `Price ground upward with natural pullbacks, then coiled tightly beneath ${fmt(hod)}. The breakout candle had a ${fmt(bodySize)} body with minimal upper wick.`;
      base.volumeBehavior = `Volume contracted into the consolidation, then expanded to ${volMult}x average on the breakout — institutional participation.`;
      base.priceVsLevel = `Broke ${fmt(hod)} and closed at ${fmt(bc.c)} near the ${fmt(bc.h)} high. Acceptance, not rejection.`;
      base.resolution = `Held above ${fmt(hod)} and continued higher. Broken resistance became support.`;
      break;
    case "weak":
      base.candleStructure = `Choppy, overlapping approach with no clean trend. The breakout candle had a small ${fmt(bodySize)} body — indecision at the level.`;
      base.volumeBehavior = `Volume on the break was only ${volMult}x average — no conviction. Flat volume into resistance is a warning.`;
      base.priceVsLevel = `Poked above ${fmt(hod)} to ${fmt(bc.h)} but closed at ${fmt(bc.c)}, barely holding the level.`;
      base.resolution = `Faded back under ${fmt(hod)} within a few candles. The break never attracted follow-through.`;
      break;
    case "failed":
      base.candleStructure = `Strong approach, then a violent spike to ${fmt(bc.h)} that closed at ${fmt(bc.c)} — a ${fmt(wickUp)} upper wick. Classic rejection.`;
      base.volumeBehavior = `Volume climaxed at ${volMult}x on the spike — exhaustion, not launch. Elevated volume continued on the decline (distribution).`;
      base.priceVsLevel = `Tagged ${fmt(bc.h)} but couldn't hold ${fmt(hod)} into the close. The level rejected price violently.`;
      base.resolution = `Collapsed well under ${fmt(hod)}. Late breakout buyers were trapped.`;
      break;
    case "ambiguous":
      base.candleStructure = `Decent breakout candle closing at ${fmt(bc.c)} (mid-range, not near the ${fmt(bc.h)} high), followed by overlapping chop. No direction.`;
      base.volumeBehavior = `Volume expanded to ${volMult}x — participation but not conviction. Neither climax nor surge.`;
      base.priceVsLevel = `Held above ${fmt(hod)} but couldn't extend. Above the level, going nowhere.`;
      base.resolution = `Chopped sideways above ${fmt(hod)}. The market said "not yet."`;
      break;
  }
  return base;
}

function buildTeaching(def: ScenarioDef, fmt: (n: number) => string): DrillScenario["teaching"] {
  switch (def.classification) {
    case "clean":
      return {
        lessons: [
          "Contraction before expansion: tight range + shrinking volume under resistance is the highest-probability setup.",
          "A clean break closes near its high on expanding volume — acceptance, not just a poke above the level.",
        ],
        missedByAnswer: {
          weak: "Volume expansion and the strong close rule out weak — weak breaks show hesitation, not conviction.",
          failed: "No long upper wick, no climax-and-reverse. The close held near the high.",
          not_sure: "Three classic tells: tight coil, volume contraction then expansion, strong close. Worth committing.",
        },
        alternativeOutcome: "A failed version would show a long upper wick, volume spike then fade, and a close back under the level.",
      };
    case "weak":
      return {
        lessons: [
          "A break without volume is a warning, not a signal.",
          "Small overlapping bodies after the break = indecision, not strength.",
        ],
        missedByAnswer: {
          clean: "No volume expansion, no strong close. The level was touched, not taken.",
          failed: "Failed implies violent rejection. This just fizzled — weak is the precise read.",
          not_sure: "Volume is the tiebreaker: flat into the break means weak, not clean.",
        },
        alternativeOutcome: "A clean break would close near its high on 2-3x volume with follow-through above the level.",
      };
    case "failed":
      return {
        lessons: [
          "The wick tells the truth: long upper wick = sellers overwhelmed buyers at the highs.",
          "Climax volume + failure to hold = trap. Volume needs price acceptance to confirm.",
        ],
        missedByAnswer: {
          clean: "The close vs high disagreement is the tell. Clean breaks close near highs.",
          weak: "This was violent, not weak. The aggression of the reversal marks the trap.",
          not_sure: "When high and close disagree sharply, trust the close.",
        },
        alternativeOutcome: "A clean break would have closed near the spike high with follow-through holding above the level.",
      };
    case "ambiguous":
      return {
        lessons: [
          "Not every setup deserves a strong opinion. 'No edge here' is a valid read.",
          "When evidence conflicts, wait — don't force a directional bet.",
        ],
        missedByAnswer: {
          clean: "Held the level but never continued. Clean requires follow-through.",
          weak: "Never broke down either. The evidence was genuinely mixed.",
          failed: "Nothing failed — price held the level. 'Not sure' was the honest answer.",
          not_sure: "Correct. Recognizing mixed evidence IS the skill being tested.",
        },
        alternativeOutcome: "Clean would push higher on rising volume; failed would show rejection and a close under the level. This showed neither.",
      };
  }
}

const SCENARIO_DEFS: ScenarioDef[] = [
  {
    id: "hod-clean-001",
    classification: "clean",
    difficulty: "beginner",
    title: "Clean HOD Breakout",
    description: "Price grinds up, consolidates tightly under the high of day, then breaks out.",
    seed: 21001,
    regimes: [
      { candles: 9, drift: 0.0012, volatility: 0.006, volBase: 8000, volRange: 4000, volMoveMult: 2_000_000 },
      { candles: 5, drift: 0.0001, volatility: 0.003, volBase: 5500, volRange: 2000, volMoveMult: 1_000_000 },
      { candles: 1, drift: 0, volatility: 0.004, volBase: 8000, volRange: 3000, volMoveMult: 2_000_000 }, // breakout
      { candles: 6, drift: 0.0008, volatility: 0.005, volBase: 12000, volRange: 5000, volMoveMult: 2_000_000 },
    ],
    breakout: { spikeAboveHod: 0.015, closePosition: 0.8, volMult: 3.0 },
    breakoutAt: 14,
  },
  {
    id: "hod-weak-001",
    classification: "weak",
    difficulty: "beginner",
    title: "Weak HOD Breakout",
    description: "Price edges above the high of day but conviction is missing.",
    seed: 21002,
    regimes: [
      { candles: 9, drift: 0.001, volatility: 0.007, volBase: 7500, volRange: 3000, volMoveMult: 1_500_000 },
      { candles: 4, drift: 0, volatility: 0.004, volBase: 6500, volRange: 2000, volMoveMult: 1_000_000 },
      { candles: 1, drift: 0, volatility: 0.003, volBase: 7500, volRange: 2000, volMoveMult: 1_500_000 }, // breakout
      { candles: 6, drift: -0.0008, volatility: 0.005, volBase: 7000, volRange: 3000, volMoveMult: 1_500_000 },
    ],
    breakout: { spikeAboveHod: 0.008, closePosition: 0.4, volMult: 1.2 },
    breakoutAt: 13,
  },
  {
    id: "hod-failed-001",
    classification: "failed",
    difficulty: "intermediate",
    title: "Failed HOD Breakout (Trap)",
    description: "A strong-looking break that violently reverses. Watch the wick.",
    seed: 21003,
    regimes: [
      { candles: 9, drift: 0.0013, volatility: 0.006, volBase: 8500, volRange: 4000, volMoveMult: 2_000_000 },
      { candles: 3, drift: 0.0002, volatility: 0.003, volBase: 8500, volRange: 2000, volMoveMult: 1_500_000 },
      { candles: 1, drift: 0, volatility: 0.005, volBase: 9000, volRange: 3000, volMoveMult: 2_000_000 }, // trap
      { candles: 6, drift: -0.0015, volatility: 0.007, volBase: 15000, volRange: 6000, volMoveMult: 2_500_000 },
    ],
    breakout: { spikeAboveHod: 0.03, closePosition: 0.25, volMult: 3.5 },
    breakoutAt: 12,
  },
  {
    id: "hod-ambiguous-001",
    classification: "ambiguous",
    difficulty: "advanced",
    title: "Ambiguous HOD Action",
    description: "Mixed signals at the high of day. Not every setup has a clear read.",
    seed: 21004,
    regimes: [
      { candles: 9, drift: 0.001, volatility: 0.006, volBase: 7800, volRange: 3000, volMoveMult: 1_800_000 },
      { candles: 4, drift: 0, volatility: 0.004, volBase: 7500, volRange: 2000, volMoveMult: 1_200_000 },
      { candles: 1, drift: 0, volatility: 0.004, volBase: 8000, volRange: 2500, volMoveMult: 1_800_000 }, // breakout
      { candles: 6, drift: 0, volatility: 0.005, volBase: 10000, volRange: 3000, volMoveMult: 1_500_000 },
    ],
    breakout: { spikeAboveHod: 0.012, closePosition: 0.55, volMult: 1.8 },
    breakoutAt: 13,
  },
];

export const HOD_SCENARIOS: DrillScenario[] = SCENARIO_DEFS.map(buildScenario);

export function getScenario(id: string): DrillScenario | undefined {
  return HOD_SCENARIOS.find((s) => s.id === id);
}
