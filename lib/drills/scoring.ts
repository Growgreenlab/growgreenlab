/**
 * Breakout Drill — scoring rules (single source of truth).
 *
 * Recognition and decision quality are scored SEPARATELY, then combined
 * as their simple average. A decision is judged only on information
 * available at the checkpoint — never on how the trade would have
 * paid (there is no P/L in the drill, by design).
 *
 * CLASSIFICATION (scoreClassification):
 *   exact match ............................ correct   1.0
 *   "ambiguous / no-trade" on a genuinely
 *     ambiguous scenario ................... correct   1.0  (it IS the read)
 *   "ambiguous / no-trade" (uncertainty) on
 *     any other scenario ................... partial   0.5  (historical
 *     contract: an honest "not sure" is never a confident wrong answer)
 *   a committed directional read on an
 *     ambiguous scenario ................... partial   0.5  (no single
 *     right answer exists; the lesson is the evidence review)
 *   anything else .......................... incorrect 0.0
 *
 * ACTION (scoreAction) — predefined per scenario classification:
 *   clean:     Enter = appropriate (1.0) — the setup earned commitment.
 *              Wait  = acceptable  (0.5) — cautious; the evidence was there.
 *              Skip  = inappropriate (0) — no reason to pass a textbook break.
 *   weak:      Wait  = appropriate (1.0) — demand follow-through first.
 *              Skip  = acceptable  (0.5) — passing a conviction-less break is fine.
 *              Enter = inappropriate (0) — chasing a break with no volume.
 *   failed:    Skip  = appropriate (1.0) — stay out of the trap.
 *              Wait  = acceptable  (0.5) — also avoids the trap entry.
 *              Enter = inappropriate (0) — buying the rejection top IS the trap error.
 *   ambiguous: Wait  = appropriate (1.0) ┐ no edge = no trade; both
 *              Skip  = appropriate (1.0) ┘ preserve capital and optionality.
 *              Enter = inappropriate (0) — forcing a trade on mixed evidence.
 *
 * OVERALL: round(100 × (classification + action) / 2).
 */
import type { DrillScenario } from "./types";
import type { DecisionClassification, IntendedAction } from "./types";
import type { DrillDecision } from "./decision";

export type ClassificationVerdict = "correct" | "partial" | "incorrect";
export type ActionVerdict = "appropriate" | "acceptable" | "inappropriate";

export interface ClassificationScore {
  verdict: ClassificationVerdict;
  score: number;
}

export interface ActionScore {
  verdict: ActionVerdict;
  score: number;
}

export interface DecisionScore {
  classification: ClassificationScore;
  action: ActionScore;
  /** 0–100, the average of the two component scores. */
  overall: number;
}

export function scoreClassification(
  scenario: DrillScenario,
  answer: DecisionClassification
): ClassificationScore {
  if (answer === scenario.classification) {
    return { verdict: "correct", score: 1 };
  }
  if (answer === "ambiguous") {
    // Uncertainty declared on a non-ambiguous setup: honest, not wrong.
    return { verdict: "partial", score: 0.5 };
  }
  if (scenario.classification === "ambiguous") {
    // Committed read on a genuinely ambiguous setup: partially correct.
    return { verdict: "partial", score: 0.5 };
  }
  return { verdict: "incorrect", score: 0 };
}

/** Actions that earn full decision credit, per scenario classification. */
export const APPROPRIATE_ACTIONS: Record<string, IntendedAction[]> = {
  clean: ["enter"],
  weak: ["wait"],
  failed: ["skip"],
  ambiguous: ["wait", "skip"],
};

/** Actions that earn half decision credit, per scenario classification. */
export const ACCEPTABLE_ACTIONS: Record<string, IntendedAction[]> = {
  clean: ["wait"],
  weak: ["skip"],
  failed: ["wait"],
  ambiguous: [],
};

/**
 * Why the action rules are what they are for this scenario, framed on
 * the information available AT the checkpoint (never on the outcome).
 */
export const ACTION_RATIONALE: Record<string, string> = {
  clean:
    "At the checkpoint the evidence was complete: tight coil, contracted-then-expanding volume, and a close near the high above the level. That is the moment the setup pays for commitment — entering was the decision the information supported.",
  weak:
    "At the checkpoint the break had poked above the level with flat volume and a small, indecisive body. Nothing yet justified risk: waiting for follow-through (or passing entirely) was the disciplined decision; entering was chasing.",
  failed:
    "At the checkpoint the trap candle had already printed: a violent spike with a long upper wick closing back under the level on climax volume. Entering buys the exact top of the rejection — skipping (or waiting) keeps you out of the trap.",
  ambiguous:
    "At the checkpoint the evidence genuinely conflicted — the level was held but never extended, with neither climax nor surge. With no edge, waiting or skipping is the correct trade; entering forces a bet the information didn't support.",
};

export function scoreAction(
  scenario: DrillScenario,
  action: IntendedAction
): ActionScore {
  const cls = scenario.classification;
  if ((APPROPRIATE_ACTIONS[cls] ?? []).includes(action)) {
    return { verdict: "appropriate", score: 1 };
  }
  if ((ACCEPTABLE_ACTIONS[cls] ?? []).includes(action)) {
    return { verdict: "acceptable", score: 0.5 };
  }
  return { verdict: "inappropriate", score: 0 };
}

export function scoreDecision(
  scenario: DrillScenario,
  decision: DrillDecision
): DecisionScore {
  const classification = scoreClassification(scenario, decision.classification);
  const action = scoreAction(scenario, decision.action);
  return {
    classification,
    action,
    overall: Math.round(((classification.score + action.score) / 2) * 100),
  };
}

/**
 * Which teaching "what you missed" entry applies to a classification
 * answer. An uncertainty answer reads the scenario's "not_sure" entry
 * (for a genuinely ambiguous scenario that entry is the "correct"
 * text); committed answers read their own entry.
 */
export function missedKeyFor(
  scenario: DrillScenario,
  answer: DecisionClassification
): DecisionClassification | "not_sure" {
  if (answer === "ambiguous") return "not_sure";
  return answer;
}

/** Everything the post-drill review screen renders. Review-stage only. */
export interface ReviewModel {
  classification: DrillScenario["classification"];
  decision: DrillDecision;
  scores: DecisionScore;
  actionRationale: string;
  missed: string | null;
}

export function buildReviewModel(
  scenario: DrillScenario,
  decision: DrillDecision
): ReviewModel {
  const key = missedKeyFor(scenario, decision.classification);
  return {
    classification: scenario.classification,
    decision,
    scores: scoreDecision(scenario, decision),
    actionRationale: ACTION_RATIONALE[scenario.classification] ?? "",
    missed: scenario.teaching.missedByAnswer[key] ?? null,
  };
}
