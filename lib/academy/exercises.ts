/**
 * Trading Academy — pure exercise evaluation.
 *
 * Deterministic scoring for the structured exercises: choice
 * questions, Evidence Board classifications, and the mastery
 * assessment. No exact-string matching anywhere (spec §5E): open
 * explanations are assessed through structured choices with rubric
 * feedback per option, and free-text reflection lives in the
 * ungraded decision journal.
 */
import type { AssessmentItem, ChoiceQuestion, EvidenceCategory, EvidenceItem } from "./types";

export interface ChoiceScore {
  total: number;
  correct: number;
  /** question id -> was the committed answer correct */
  perItem: Record<string, boolean>;
}

/** Score committed choice-question answers (question id -> option index). */
export function scoreChoiceQuestions(
  questions: readonly ChoiceQuestion[],
  answers: Readonly<Record<string, number>>
): ChoiceScore {
  const perItem: Record<string, boolean> = {};
  let correct = 0;
  for (const q of questions) {
    const idx = answers[q.id];
    const ok = typeof idx === "number" && q.options[idx]?.correct === true;
    perItem[q.id] = ok;
    if (ok) correct++;
  }
  return { total: questions.length, correct, perItem };
}

export interface EvidenceScore {
  total: number;
  correct: number;
  perItem: Record<string, boolean>;
  /** Concepts with at least one wrong first classification. */
  missedConcepts: string[];
}

/** Score Evidence Board classifications (item id -> chosen category). */
export function scoreEvidenceItems(
  items: readonly EvidenceItem[],
  answers: Readonly<Record<string, EvidenceCategory>>
): EvidenceScore {
  const perItem: Record<string, boolean> = {};
  const missed = new Set<string>();
  let correct = 0;
  for (const item of items) {
    const ok = answers[item.id] === item.key;
    perItem[item.id] = ok;
    if (ok) correct++;
    else missed.add(item.concept);
  }
  return { total: items.length, correct, perItem, missedConcepts: [...missed] };
}

export interface AssessmentScore {
  total: number;
  correctCount: number;
  /** 0–100, rounded to the nearest whole percent. */
  scorePct: number;
  passed: boolean;
  perItem: Record<string, boolean>;
}

/**
 * Score a mastery-assessment attempt. `threshold` is a percent
 * (default from the lesson definition; spec default 80). Unanswered
 * items count as incorrect — a score always reflects actual answers.
 */
export function scoreAssessment(
  items: readonly AssessmentItem[],
  answers: Readonly<Record<string, number>>,
  threshold: number
): AssessmentScore {
  const perItem: Record<string, boolean> = {};
  let correctCount = 0;
  for (const item of items) {
    const ok = answers[item.id] === item.correctIndex;
    perItem[item.id] = ok;
    if (ok) correctCount++;
  }
  const total = items.length;
  const scorePct = total === 0 ? 0 : Math.round((correctCount / total) * 100);
  return { total, correctCount, scorePct, passed: total > 0 && scorePct >= threshold, perItem };
}
