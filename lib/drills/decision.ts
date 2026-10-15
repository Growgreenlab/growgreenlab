/**
 * Breakout Drill — decision checkpoint ledger.
 *
 * The decision (classification + intended action) is recorded at the
 * checkpoint, BEFORE any outcome is revealed, and is then immutable:
 *
 *  - record() succeeds exactly once per attempt; later calls are
 *    rejected and never alter the locked decision.
 *  - seal() marks the reveal; recording after the seal is rejected.
 *  - startNewAttempt() (Reset / Replay / next drill) archives the
 *    locked decision into the session history and clears the lock, so
 *    a new attempt starts clean — the archived record of a completed
 *    attempt is never resurrected or mutated by a later attempt.
 *
 * Decisions are frozen objects. History is in-session only, matching
 * the existing attempt-history/privacy behavior (nothing persisted).
 */
import type { DecisionClassification, IntendedAction } from "./types";

export interface DrillDecision {
  classification: DecisionClassification;
  action: IntendedAction;
  /** 1-5 self-assessed confidence (the default is stamped when untouched). */
  confidence?: number;
  /** Simulation time (ms on the sim timeline) when the decision locked. */
  simTimeMs: number;
  /** Engine candle index when the decision locked (the checkpoint). */
  candleIndex: number;
  /** Epoch ms when the decision was recorded. */
  recordedAt: number;
}

/**
 * The confidence slider's resting position. A decision locked without
 * touching the slider still carries this value — the effective
 * confidence is part of the locked record, never absent, so the review
 * can always display it.
 */
export const DEFAULT_CONFIDENCE = 3;

/** The confidence in force for a decision (default when none was set). */
export function effectiveConfidence(d: DrillDecision): number {
  return d.confidence ?? DEFAULT_CONFIDENCE;
}

/** The one formatter for sim-timeline ms, shared by every display. */
export function formatSimTimeMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Canonical rendering of WHEN a decision locked, derived only from the
 * ledger record ("10:00 · candle 15"). Every surface that reports the
 * lock time (review header, reproducibility footer) renders this exact
 * string, so the recorded timestamp can never appear as two different
 * values for the same decision. (The live header clock is a different,
 * running quantity and is labelled simply "Sim time".)
 */
export function decisionLockLabel(d: DrillDecision): string {
  return `${formatSimTimeMs(d.simTimeMs)} · candle ${d.candleIndex + 1}`;
}

export interface DecisionDraft {
  classification: DecisionClassification;
  action: IntendedAction;
  /** Null/undefined = slider untouched → the default is stamped. */
  confidence?: number | null;
}

/**
 * Build the record the ledger locks. `at` must be the sim's checkpoint
 * snapshot (DrillSim.checkpointSnapshot) so the stamped time is the
 * checkpoint candle's close, not the frame-dependent live clock.
 */
export function buildDecision(
  draft: DecisionDraft,
  at: { simTimeMs: number; candleIndex: number },
  recordedAt: number = Date.now()
): DrillDecision {
  return {
    classification: draft.classification,
    action: draft.action,
    confidence: draft.confidence ?? DEFAULT_CONFIDENCE,
    simTimeMs: at.simTimeMs,
    candleIndex: at.candleIndex,
    recordedAt,
  };
}

export class DecisionLedger {
  private locked: DrillDecision | null = null;
  private sealedFlag = false;
  private completed: DrillDecision[] = [];

  /** The current attempt's locked decision, or null before the checkpoint. */
  get current(): DrillDecision | null {
    return this.locked;
  }

  /** True once the outcome has been revealed for the current attempt. */
  get isSealed(): boolean {
    return this.sealedFlag;
  }

  /** Locked decisions of completed attempts, oldest first. Read-only. */
  get archive(): readonly DrillDecision[] {
    return this.completed;
  }

  /**
   * Lock in a decision. Returns true on success. Returns false — and
   * changes nothing — if a decision is already locked or the outcome
   * has been revealed.
   */
  record(d: DrillDecision): boolean {
    if (this.locked !== null || this.sealedFlag) return false;
    this.locked = Object.freeze({ ...d });
    return true;
  }

  /** Mark the outcome as revealed. Irreversible for this attempt. */
  seal(): void {
    this.sealedFlag = true;
  }

  /**
   * Begin a new attempt: the locked decision (if any) moves to the
   * session archive unchanged, and the lock + seal clear.
   */
  startNewAttempt(): void {
    if (this.locked !== null) this.completed.push(this.locked);
    this.locked = null;
    this.sealedFlag = false;
  }
}
