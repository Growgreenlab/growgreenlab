/**
 * Trading Academy — typed content model (Stage 2 foundation).
 *
 * Content is typed TypeScript data, following the platform's existing
 * content-as-data pattern (lib/drills/scenarios.ts): lessons are
 * definitions compiled/validated at load, never free-form markup, so a
 * malformed definition fails loudly (see validate* in content.ts)
 * instead of silently rendering a broken lesson.
 *
 * The Fact / Interpretation / Overreach / Needs-More-Data taxonomy from
 * the Academy spec is a first-class part of the schema: every Evidence
 * Board item carries its context, its key, the reasoning behind the
 * key, and the misconception it targets.
 */
import type { CandleInput } from "./candleMath";

/* ------------------------------------------------------------------ */
/* Worlds                                                              */
/* ------------------------------------------------------------------ */

export type WorldStatus = "available" | "planned";

export interface WorldDef {
  /** 1–12, matching the master spec's curriculum order. */
  number: number;
  slug: string;
  title: string;
  tagline: string;
  /** Short topic list shown on the learning map. */
  topics: string[];
  status: WorldStatus;
  /** Human-readable prerequisite note ("" when none). */
  prerequisites: string;
  /** Lesson slug for an available world; null while planned. */
  lessonSlug: string | null;
}

/* ------------------------------------------------------------------ */
/* Evidence Board                                                      */
/* ------------------------------------------------------------------ */

export type EvidenceCategory = "fact" | "interpretation" | "overreach" | "needs-data";

export const EVIDENCE_CATEGORIES: readonly {
  id: EvidenceCategory;
  label: string;
  blurb: string;
}[] = [
  {
    id: "fact",
    label: "Observed Fact",
    blurb: "Directly supported by the displayed data.",
  },
  {
    id: "interpretation",
    label: "Reasonable Interpretation",
    blurb: "A plausible explanation the evidence is consistent with — not proven by it.",
  },
  {
    id: "overreach",
    label: "Overreach",
    blurb: "Claims more than the evidence supports: certainty, intent, or a guaranteed outcome.",
  },
  {
    id: "needs-data",
    label: "Needs More Data",
    blurb: "Cannot be answered confidently from the information shown.",
  },
];

export function evidenceCategoryLabel(id: EvidenceCategory): string {
  return EVIDENCE_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export interface EvidenceItem {
  id: string;
  /** Concept tag — feeds the misconception tracker in progress.ts. */
  concept: string;
  /** The displayed evidence the statement is judged against. */
  context: string;
  statement: string;
  key: EvidenceCategory;
  /** Why the key is correct, grounded in the context. */
  rationale: string;
  /** The common misconception this item is designed to surface. */
  misconception: string;
}

/* ------------------------------------------------------------------ */
/* Structured choice questions (explanations + assessment)             */
/* ------------------------------------------------------------------ */

export interface ChoiceOption {
  text: string;
  correct: boolean;
  /** Rubric feedback: which part is supported / needs revision. */
  feedback: string;
}

export interface ChoiceQuestion {
  id: string;
  concept: string;
  prompt: string;
  options: ChoiceOption[];
}

/* ------------------------------------------------------------------ */
/* Builder challenges                                                  */
/* ------------------------------------------------------------------ */

export type ChallengeKind =
  | "bullish"
  | "bearish"
  | "doji"
  | "long-upper-wick"
  | "long-lower-wick"
  | "small-body-large-range";

export interface ChallengeDef {
  id: string;
  kind: ChallengeKind;
  title: string;
  instruction: string;
  concept: string;
  /** Seeds the (deterministic) starting candle so values vary. */
  startSeed: number;
  /** For small-body-large-range: candidate minimum ranges ($), one is
   *  picked deterministically from the seed and shown to the learner. */
  rangeOptions: number[];
}

/* ------------------------------------------------------------------ */
/* Mastery assessment                                                  */
/* ------------------------------------------------------------------ */

export type AssessmentItemKind = "classify" | "choice" | "categorize";

export interface AssessmentItem {
  id: string;
  kind: AssessmentItemKind;
  concept: string;
  prompt: string;
  /** Set for "classify" items (rendered with CandleSvg). */
  candle: CandleInput | null;
  options: string[];
  correctIndex: number;
  rationale: string;
}

/* ------------------------------------------------------------------ */
/* Lessons                                                             */
/* ------------------------------------------------------------------ */

export type SectionKind =
  | "objectives"
  | "concept"
  | "formation-demo"
  | "candle-builder"
  | "challenges"
  | "evidence-board"
  | "explanation"
  | "assessment"
  | "journal"
  | "summary";

export interface LessonSection {
  id: string;
  kind: SectionKind;
  title: string;
  paragraphs: string[];
  bullets: string[];
}

export interface LessonDef {
  /** Stable id used as the progress key (matches academy_progress.lesson_id). */
  id: string;
  slug: string;
  worldNumber: number;
  title: string;
  tagline: string;
  objectives: string[];
  estimatedMinutes: number;
  difficulty: string;
  prerequisites: string;
  /** Percent required for "mastered" (spec default 80). */
  masteryThreshold: number;
  sections: LessonSection[];
}

/* ------------------------------------------------------------------ */
/* Decision journal                                                    */
/* ------------------------------------------------------------------ */

export interface JournalPrompt {
  key: string;
  label: string;
}
