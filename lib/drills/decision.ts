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
  /** Optional 1-5 self-assessed confidence. */
  confidence?: number;
  /** Simulation time (ms on the sim timeline) when the decision locked. */
  simTimeMs: number;
  /** Engine candle index when the decision locked (the checkpoint). */
  candleIndex: number;
  /** Epoch ms when the decision was recorded. */
  recordedAt: number;
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
