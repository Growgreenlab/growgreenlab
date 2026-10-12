/**
 * Breakout Recognition Drill — scenario type definitions.
 *
 * A scenario is a fully predefined market sequence. Everything the user
 * sees (candles, volume, and later Level 2 / Time & Sales) is derived
 * from this definition. Nothing is decided at runtime — the outcome is
 * fixed before the drill begins, and replaying the same scenario ID
 * always produces the same sequence.
 */
import type { Candle } from "../types";

export type BreakoutClassification =
  | "clean"
  | "weak"
  | "failed"
  | "continuation"
  | "ambiguous";

export type DrillDifficulty = "beginner" | "intermediate" | "advanced";

export interface ScenarioEvidence {
  /** What the candles showed before the checkpoint. */
  candleStructure: string;
  /** How volume behaved into the breakout. */
  volumeBehavior: string;
  /** Price position relative to the HOD level. */
  priceVsLevel: string;
  /** Follow-through or rejection after the break (hidden until resolved). */
  resolution: string;
}

export interface ScenarioTeaching {
  /** 1-2 specific lessons tied to this scenario's evidence. */
  lessons: string[];
  /** What the user most likely overlooked, keyed by wrong answer. */
  missedByAnswer: Partial<Record<BreakoutClassification | "not_sure", string>>;
  /** How the evidence would differ in the opposite outcome. */
  alternativeOutcome: string;
}

export interface DrillScenario {
  /** Stable identifier, e.g. "hod-clean-001". */
  id: string;
  /** Increment when the scenario definition changes. */
  version: number;
  /** e.g. "hod-breakout" — extensible for future strategies. */
  setupCategory: string;
  /** The intended classification (hidden from the user until resolved). */
  classification: BreakoutClassification;
  difficulty: DrillDifficulty;
  /** Human-readable title shown in the drill picker. */
  title: string;
  /** One-line description shown before starting. */
  description: string;
  /** Deterministic seed — same seed + same definition = same ticks. */
  seed: number;
  /** Full candle sequence: pre-breakout, breakout, and resolution. */
  candles: Candle[];
  /** Index of the HOD level candle range (for drawing the level line). */
  hod: number;
  /**
   * Candle index where the recognition checkpoint fires.
   * The user sees candles[0..checkpoint], nothing beyond.
   */
  checkpointIndex: number;
  /** Evidence supporting the teaching screen (from the definition). */
  evidence: ScenarioEvidence;
  /** Teaching content. */
  teaching: ScenarioTeaching;
}

export type DrillAnswer =
  | BreakoutClassification
  | "not_sure";

export interface DrillAttempt {
  scenarioId: string;
  scenarioVersion: number;
  answer: DrillAnswer;
  /** Optional 1-5 self-assessed confidence. */
  confidence?: number;
  /** Whether the classification was correct. */
  correct: boolean;
  /** Epoch ms when the answer was submitted. */
  answeredAt: number;
  /** Epoch ms when the drill completed (user saw the result). */
  completedAt?: number;
}

/**
 * Grade an answer against the scenario's intended classification.
 * "not_sure" is never wrong — it records uncertainty honestly.
 * "ambiguous" scenarios accept any non-"not_sure" answer as partially correct.
 */
export function gradeAnswer(
  scenario: DrillScenario,
  answer: DrillAnswer
): { correct: boolean; partial: boolean } {
  if (answer === "not_sure") return { correct: false, partial: true };
  if (scenario.classification === "ambiguous") {
    // Ambiguous scenarios have no single right answer; any committed
    // read is "partially correct" — the lesson is in the evidence review.
    return { correct: false, partial: true };
  }
  if (answer === scenario.classification) return { correct: true, partial: false };
  return { correct: false, partial: false };
}
