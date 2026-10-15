/**
 * Breakout Drill — decision evaluation layer (Stage B, upgrade spec §5).
 *
 * ADDITIVE post-decision feedback. The scoring in lib/drills/scoring.ts
 * is untouched and remains the single source of truth for verdicts;
 * this module only re-reads those verdicts alongside the checkpoint
 * evidence to explain the decision dimension by dimension.
 *
 * Purity / no-leak contract:
 *  - buildEvaluation is a pure function of (scenario, decision,
 *    checkpointContext). It is only invoked on the teaching screen,
 *    after the decision has been sealed — it has no pre-decision
 *    surface anywhere.
 *  - It reads ONLY the candles revealed at the lock (indices
 *    0..lockIndex). Post-checkpoint candles, the scenario's resolution
 *    text, and the eventual outcome are never inputs to any grade,
 *    note, or evidence line (pinned by verify-eval's tail-mutation
 *    test: the report is byte-identical whatever the tail contains).
 *  - It grades the quality of the DECISION from the evidence that was
 *    available when it locked — never the trade's outcome, and it
 *    makes no profitability claim of any kind.
 *
 * Robustness: a decision record with missing/invalid fields degrades
 * gracefully — the affected dimension is omitted, no value is invented,
 * and the function never throws. Confidence falls back to the ledger's
 * documented default (decision.ts DEFAULT_CONFIDENCE, via
 * effectiveConfidence); a missing candle index falls back to the
 * scenario's checkpointIndex, which is where decisions lock in this
 * system by construction (the snapshot equality is pinned in
 * verify-blind) — it is a scenario constant, not an invented value.
 */
import type { DrillScenario, DecisionClassification, IntendedAction } from "./types";
import type { DrillDecision } from "./decision";
import { effectiveConfidence } from "./decision";
import {
  scoreClassification, scoreAction,
  type ClassificationVerdict, type ActionVerdict,
} from "./scoring";

export type EvalGrade = "strong" | "developing" | "weak";

export interface EvaluationDimension {
  key: "recognition" | "timing" | "discipline" | "calibration";
  label: string;
  grade: EvalGrade;
  note: string;
}

export interface EvaluationReport {
  dimensions: EvaluationDimension[];
  /** 2–4 short factual lines, checkpoint-time observables only. */
  evidence: string[];
  headline: string;
  /** What the trader did well (a correct no-trade is a positive here). */
  didWell: string[];
  /** The single most important mistake, or null when none is supported. */
  keyMistake: string | null;
  /** The evidence to watch for in a similar future setup. */
  watchFor: string;
  /** Standing framing: decision quality, not outcome or profitability. */
  standingLine: string;
}

export const EVALUATION_STANDING_LINE =
  "This evaluation grades the quality of the decision from the evidence available at the checkpoint — not the trade's outcome, and not a prediction of real-world profitability.";

export interface CheckpointContext {
  /** Engine candle index stamped at the lock (the checkpoint snapshot). */
  candleIndex?: number;
}

// ── Field validation (missing data degrades, never invents) ─────────

const CLASSIFICATIONS: DecisionClassification[] = ["clean", "weak", "failed", "ambiguous"];
const ACTIONS: IntendedAction[] = ["enter", "wait", "skip"];

function asClassification(v: unknown): DecisionClassification | null {
  return typeof v === "string" && (CLASSIFICATIONS as string[]).includes(v)
    ? (v as DecisionClassification)
    : null;
}

function asAction(v: unknown): IntendedAction | null {
  return typeof v === "string" && (ACTIONS as string[]).includes(v)
    ? (v as IntendedAction)
    : null;
}

function asIndex(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

function asConfidence(decision: DrillDecision): number {
  const c = effectiveConfidence(decision);
  return typeof c === "number" && Number.isFinite(c)
    ? Math.min(5, Math.max(1, Math.round(c)))
    : 3;
}

// ── Checkpoint facts: the ONLY market data this module reads ────────

export type TrapKind = "rejectionClose" | "spikeFailedToClose" | "climaxWick";

export interface CheckpointFacts {
  /** Last revealed candle index the facts were derived from. */
  lockIndex: number;
  /** First revealed candle that traded above the level (-1 = none). */
  breakoutIndex: number;
  /** First revealed candle that CLOSED above the level (-1 = none). */
  confirmingCloseIndex: number;
  /** First revealed candle that wicked above and closed back below (-1). */
  rejectionIndex: number;
  /** Breakout candle volume ÷ mean volume of the candles before it. */
  volMultiple: number | null;
  /** Breakout candle upper wick ÷ its full range (0..1). */
  wickShare: number | null;
  /** Breakout candle high, when a breakout candle exists. */
  breakoutHigh: number | null;
  /** Close of the last revealed candle, relative to the level. */
  lastCloseVsLevel: "above" | "below" | "at" | null;
  /**
   * Failed-class trap mechanism, EVIDENCE-GATED: only set when the
   * revealed window actually shows it. "rejectionClose" = a candle
   * wicked above and closed back below; "spikeFailedToClose" = the
   * spike candle could not close above the level (wick share ≥ 0.5);
   * "climaxWick" = the spike closed above but on climax volume (≥ 2×)
   * with a dominant upper wick (share ≥ 0.5). Null = the checkpoint
   * evidence does not support naming a trap mechanism.
   */
  trapKind: TrapKind | null;
}

const EPS = 1e-9;

export function checkpointFacts(
  scenario: DrillScenario,
  lockIndex: number
): CheckpointFacts {
  const candles = scenario.candles ?? [];
  const level = scenario.hod;
  const none: CheckpointFacts = {
    lockIndex: -1, breakoutIndex: -1, confirmingCloseIndex: -1,
    rejectionIndex: -1, volMultiple: null, wickShare: null,
    breakoutHigh: null, lastCloseVsLevel: null, trapKind: null,
  };
  if (candles.length === 0 || typeof level !== "number") return none;

  const li = Math.min(Math.max(0, lockIndex), candles.length - 1);
  const revealed = candles.slice(0, li + 1);

  const breakoutIndex = revealed.findIndex((c) => c.h > level + EPS);
  const confirmingCloseIndex = revealed.findIndex((c) => c.c > level + EPS);
  const rejectionIndex = revealed.findIndex(
    (c) => c.h > level + EPS && c.c < level - EPS
  );

  let volMultiple: number | null = null;
  let wickShare: number | null = null;
  let breakoutHigh: number | null = null;
  if (breakoutIndex >= 0) {
    const bc = revealed[breakoutIndex];
    breakoutHigh = bc.h;
    const range = bc.h - bc.l;
    wickShare = range > 0 ? (bc.h - Math.max(bc.o, bc.c)) / range : null;
    if (breakoutIndex > 0) {
      const pre = revealed.slice(0, breakoutIndex);
      const avg = pre.reduce((s, c) => s + c.v, 0) / pre.length;
      volMultiple = avg > 0 ? bc.v / avg : null;
    }
  }

  const last = revealed[revealed.length - 1];
  const lastCloseVsLevel = !last
    ? null
    : last.c > level + EPS ? "above" : last.c < level - EPS ? "below" : "at";

  let trapKind: TrapKind | null = null;
  if (scenario.classification === "failed" && breakoutIndex >= 0) {
    const bc = revealed[breakoutIndex];
    if (rejectionIndex >= 0) trapKind = "rejectionClose";
    else if (bc.c <= level + EPS && (wickShare ?? 0) >= 0.5) trapKind = "spikeFailedToClose";
    else if ((wickShare ?? 0) >= 0.5 && (volMultiple ?? 0) >= 2) trapKind = "climaxWick";
  }

  return {
    lockIndex: li, breakoutIndex, confirmingCloseIndex, rejectionIndex,
    volMultiple, wickShare, breakoutHigh, lastCloseVsLevel, trapKind,
  };
}

// ── Shared wording helpers ───────────────────────────────────────────

const CLASS_LABEL: Record<DecisionClassification, string> = {
  clean: "Clean Breakout",
  weak: "Weak Breakout",
  failed: "Failed Breakout / Trap",
  ambiguous: "Ambiguous",
};

const ANSWER_LABEL: Record<DecisionClassification, string> = {
  clean: "Clean Breakout",
  weak: "Weak Breakout",
  failed: "Failed Breakout / Trap",
  ambiguous: "Ambiguous / No Trade",
};

const $ = (n: number) => `$${n.toFixed(2)}`;
const x = (n: number) => `${n.toFixed(1)}×`;

/**
 * Confidence band the checkpoint evidence can support, by setup class.
 * Deterministic derivation from scenario structure, cross-checked
 * against the revealed windows of the whole pool: clean checkpoints
 * present a decisive observable (close above the level, expansion —
 * pool volume multiples 1.9–2.6×, wick shares ≤ 0.21) and failed
 * checkpoints a decisive counter-observable (climax spike, multiples
 * 2.5–2.7×, wick shares ≥ 0.69), so high conviction is earnable. Weak
 * checkpoints are directionally clear but thin (multiples ≤ 0.9×).
 * Ambiguous checkpoints conflict by construction (split closes,
 * multiples 1.0–1.5×), so only low-to-moderate confidence is honest.
 */
const EVIDENCE_BAND: Record<DecisionClassification, [number, number]> = {
  clean: [4, 5],
  failed: [4, 5],
  weak: [3, 4],
  ambiguous: [1, 3],
};

const WATCH_FOR: Record<DecisionClassification, string> = {
  clean:
    "Watch for the same pairing at the level: a close above it together with expanding volume — either one alone is a weaker tell.",
  weak:
    "Watch the volume on the poke and the first close: a break that cannot close above the level on expanding volume has not confirmed.",
  failed:
    "Watch the close, not the high: a spike that prints a long upper wick on climax volume is being sold, however strong the push looks.",
  ambiguous:
    "Watch for one side to resolve — a close that extends with volume, or a close back under the level. Until one prints, there is no signal to act on.",
};

// ── Dimensions ───────────────────────────────────────────────────────

function recognitionDimension(
  scenario: DrillScenario,
  answer: DecisionClassification,
  verdict: ClassificationVerdict
): EvaluationDimension {
  const actual = CLASS_LABEL[scenario.classification as DecisionClassification] ?? scenario.classification;
  const art = /^[aeiou]/i.test(actual) ? "an" : "a";
  let note: string;
  if (verdict === "correct") {
    note = `Correct read — this was ${art} ${actual} setup, and you named it before the reveal.`;
  } else if (verdict === "partial" && answer === "ambiguous") {
    note = `You answered "Ambiguous / No Trade" on ${art} ${actual} setup. Honest, and never scored as a confident wrong answer — but the tells were on the tape (see the evidence).`;
  } else if (verdict === "partial") {
    note = `A committed read (${ANSWER_LABEL[answer]}) on a genuinely ambiguous setup. Partial credit: the evidence supported no single answer, so the lesson is in the review, not the label.`;
  } else {
    note = `You read this as ${ANSWER_LABEL[answer]}; the setup was ${actual}. The checkpoint evidence below shows the tells that separated them.`;
  }
  return {
    key: "recognition",
    label: "Setup recognition",
    grade: verdict === "correct" ? "strong" : verdict === "partial" ? "developing" : "weak",
    note,
  };
}

function timingDimension(
  scenario: DrillScenario,
  action: IntendedAction,
  facts: CheckpointFacts,
  actionVerdict: ActionVerdict
): EvaluationDimension {
  const level = scenario.hod;
  if (action === "enter") {
    if (scenario.classification === "failed") {
      // Trap error — named only with its evidence-gated mechanism.
      let note: string;
      if (facts.trapKind === "rejectionClose") {
        note = `Trap error: candle ${facts.rejectionIndex + 1} had already spiked above ${$(level)} and closed back below it before your lock — the rejection had printed, and the entry bought into it.`;
      } else if (facts.trapKind === "spikeFailedToClose") {
        note = `Trap error: the spike candle ran to ${$(facts.breakoutHigh ?? level)} on ${facts.volMultiple != null ? x(facts.volMultiple) : "climax"} volume, but the spike itself never closed above ${$(level)} — it stalled at the level with a long upper wick. The entry treated that stalled spike as confirmation.`;
      } else if (facts.trapKind === "climaxWick") {
        note = `Trap error: the spike to ${$(facts.breakoutHigh ?? level)} came on climax volume (${facts.volMultiple != null ? x(facts.volMultiple) : "2×+"} the prior average) and left a dominant upper wick — exhaustion evidence was on the tape at your lock, and the entry chased the top of it.`;
      } else {
        note = "Trap error: entering committed capital into a failed breakout — the costliest seat in this drill. The checkpoint evidence below is what argued against it.";
      }
      return { key: "timing", label: "Timing basis", grade: "weak", note };
    }
    if (facts.confirmingCloseIndex >= 0) {
      return {
        key: "timing", label: "Timing basis", grade: "strong",
        note: `Confirmation-based: candle ${facts.confirmingCloseIndex + 1} had already closed above ${$(level)} when you locked — the commitment followed a confirming close, not the first poke.`,
      };
    }
    const note = facts.breakoutIndex >= 0
      ? `Anticipation: price had traded above ${$(level)}, but no candle had closed above it by your lock — the last close was ${facts.lastCloseVsLevel ?? "not above"} the level. The entry committed before the break confirmed.`
      : `Anticipation: no candle had even traded above ${$(level)} by your lock. The entry anticipated a break that had not started.`;
    return { key: "timing", label: "Timing basis", grade: "developing", note };
  }
  if (action === "wait") {
    return {
      key: "timing", label: "Timing basis",
      grade: actionVerdict === "appropriate" ? "strong" : "developing",
      note: actionVerdict === "appropriate"
        ? "You held off at the checkpoint and demanded more evidence before risking capital — the disciplined timing for this setup."
        : "You waited rather than committing at the checkpoint. Defensible discipline, though the evidence was closer to complete than the wait implied.",
    };
  }
  // skip
  return {
    key: "timing", label: "Timing basis",
    grade: actionVerdict === "appropriate" ? "strong" : actionVerdict === "acceptable" ? "developing" : "weak",
    note: actionVerdict === "appropriate"
      ? "You stood aside at the checkpoint by decision, not by luck — capital preserved before the reveal."
      : actionVerdict === "acceptable"
        ? "You stood aside at the checkpoint. A defensible pass on a setup that had not earned commitment."
        : `You stood aside after candle ${facts.confirmingCloseIndex + 1} had already closed above ${$(level)} — the confirmation a wait would have demanded had already printed.`,
  };
}

function disciplineDimension(
  scenario: DrillScenario,
  action: IntendedAction,
  verdict: ActionVerdict
): EvaluationDimension {
  const cls = scenario.classification;
  let note: string;
  if (verdict === "appropriate") {
    note =
      cls === "failed" ? "Staying out was the correct trade — the trap only pays the patient." :
      cls === "ambiguous" ? "No edge, no trade. Refusing to force a decision on mixed evidence is the discipline being trained." :
      cls === "weak" ? "Waiting demanded the follow-through this break had not shown — exactly the discipline a thin break requires." :
      "The action matched what the setup's evidence supported at the checkpoint.";
  } else if (verdict === "acceptable") {
    note =
      cls === "clean" ? "Cautious: the evidence supported commitment, but waiting cost nothing except opportunity." :
      cls === "failed" ? "Waiting also avoided the trap entry — the danger was entering, and you didn't." :
      "Passing or waiting on a conviction-less break is defensible; it gives up little and risks nothing.";
  } else {
    note =
      cls === "failed" ? "Trap error: entering a failed breakout buys the exact top of the rejection — the mistake this drill exists to train out." :
      cls === "weak" ? "Entering a break with no volume behind it is chasing, not trading the setup." :
      cls === "ambiguous" ? "Forcing a trade where the evidence gave no edge turns a no-signal setup into a coin flip." :
      "Passing on a confirmed, textbook break leaves the best setups untraded.";
  }
  return {
    key: "discipline",
    label: "Discipline",
    grade: verdict === "appropriate" ? "strong" : verdict === "acceptable" ? "developing" : "weak",
    note,
  };
}

function calibrationDimension(
  scenario: DrillScenario,
  verdict: ClassificationVerdict,
  answer: DecisionClassification | null,
  confidence: number
): EvaluationDimension {
  const cls = (scenario.classification ?? "ambiguous") as DecisionClassification;
  const [lo, hi] = EVIDENCE_BAND[cls] ?? [1, 3];
  let grade: EvalGrade;
  let note: string;

  if (verdict === "incorrect") {
    if (confidence >= 4) {
      grade = "weak";
      note = `Overconfident: ${confidence}/5 on a read the checkpoint evidence didn't support — conviction outran what was knowable at the lock.`;
    } else if (confidence === 3) {
      grade = "developing";
      note = `Confidence ${confidence}/5 was firmer than a wrong read earns — the evidence supported more doubt than you expressed.`;
    } else {
      grade = "strong";
      note = `You kept confidence low (${confidence}/5) on a read that didn't hold up — the uncertainty was honest, and well placed.`;
    }
  } else if (verdict === "correct") {
    if (confidence > hi) {
      grade = "developing";
      note = `Right read — but ${confidence}/5 states more certainty than this checkpoint evidence could carry (it supports about ${lo}–${hi}). Even correct reads should be sized to the evidence.`;
    } else if (confidence < lo) {
      grade = "developing";
      note = `Under-confident: the read was right at only ${confidence}/5 — the checkpoint evidence supported more conviction (about ${lo}–${hi}). Hesitation on clear evidence is its own cost.`;
    } else {
      grade = "strong";
      note = `Confidence ${confidence}/5 matched the strength of the checkpoint evidence.`;
    }
  } else {
    // Partial: either declared uncertainty, or a committed read on a
    // genuinely ambiguous setup. Moderate confidence on mixed evidence
    // is well calibrated even though the classification scores partial.
    if (answer === "ambiguous" && cls !== "ambiguous") {
      if (confidence >= 4) {
        grade = "developing";
        note = `High stated confidence (${confidence}/5) alongside a "not sure" read pulls in two directions — the honest answer and the number should agree.`;
      } else {
        grade = "strong";
        note = `Declining to commit at ${confidence}/5 was honestly calibrated — you said the evidence was unclear, and sized your confidence like it.`;
      }
    } else if (confidence > hi) {
      grade = "developing";
      note = `Confidence ${confidence}/5 on genuinely mixed evidence is overreach, even on a defensible read — this checkpoint supports about ${lo}–${hi}.`;
    } else if (confidence < lo) {
      grade = "developing";
      note = `Low confidence (${confidence}/5) on a mixed read — reasonable caution; the partial credit reflects the setup, not a failure of nerve.`;
    } else {
      grade = "strong";
      note = `Confidence ${confidence}/5 matched genuinely mixed evidence — a moderate number on an unclear setup is well calibrated, partial score or not.`;
    }
  }
  return { key: "calibration", label: "Confidence calibration", grade, note };
}

// ── Evidence lines: checkpoint-time observables ONLY ─────────────────

function evidenceLines(scenario: DrillScenario, facts: CheckpointFacts): string[] {
  const level = scenario.hod;
  const lines: string[] = [];
  if (facts.breakoutIndex >= 0) {
    const bc = scenario.candles[facts.breakoutIndex];
    const rel = bc.c > level + EPS ? "above" : bc.c < level - EPS ? "below" : "at";
    lines.push(
      `Breakout candle (candle ${facts.breakoutIndex + 1}) closed at ${$(bc.c)} — ${rel} the ${$(level)} level.`
    );
    if (facts.volMultiple != null) {
      lines.push(
        `Its volume was ${x(facts.volMultiple)} the average of the ${facts.breakoutIndex} candles before it.`
      );
    }
    if (facts.wickShare != null && facts.wickShare >= 0.4 && facts.breakoutHigh != null) {
      const bcRange = bc.h - bc.l;
      lines.push(
        `Upper wick on that candle was ${$(bc.h - Math.max(bc.o, bc.c))} of a ${$(bcRange)} range — sellers were active at the highs.`
      );
    }
  } else {
    lines.push(`No candle had traded above the ${$(level)} level by the checkpoint.`);
  }
  if (facts.confirmingCloseIndex >= 0) {
    lines.push(
      `A candle had closed above the level (candle ${facts.confirmingCloseIndex + 1}) by the time you locked.`
    );
  } else if (facts.lastCloseVsLevel != null) {
    lines.push(
      `No candle had closed above the level by your lock — the last close sat ${facts.lastCloseVsLevel} it.`
    );
  }
  return lines.slice(0, 4);
}

// ── Teaching structure: did well / key mistake / watch for ──────────

function buildDidWell(
  scenario: DrillScenario,
  answer: DecisionClassification | null,
  action: IntendedAction | null,
  classVerdict: ClassificationVerdict | null,
  actionVerdict: ActionVerdict | null,
  facts: CheckpointFacts,
  calibration: EvaluationDimension | null,
  confidence: number
): string[] {
  const out: string[] = [];
  if (classVerdict === "correct" && answer) {
    out.push(`Your read matched the setup — ${CLASS_LABEL[scenario.classification as DecisionClassification] ?? scenario.classification}.`);
  } else if (classVerdict === "partial" && answer === "ambiguous" && scenario.classification !== "ambiguous") {
    out.push("You declined to force a directional read — honest uncertainty is a skill, not a failure.");
  }
  if (actionVerdict === "appropriate" && action) {
    if (action === "enter") {
      out.push("You committed when the evidence said commit.");
    } else {
      // A correct no-trade is a POSITIVE outcome, never a missed trade.
      out.push("No-trade was the trade here: standing aside on a setup that hadn't earned risk is a positive outcome — the disciplined result, not a consolation prize.");
    }
  } else if (actionVerdict === "acceptable" && scenario.classification === "failed" && action !== "enter" && action != null) {
    out.push("You stayed out of the trap entry.");
  }
  if (
    action === "enter" && actionVerdict === "appropriate" &&
    facts.confirmingCloseIndex >= 0 && scenario.classification !== "failed"
  ) {
    out.push("The entry came after a confirming close above the level — confirmation over anticipation.");
  }
  if (calibration?.grade === "strong" && classVerdict === "correct") {
    out.push(`Your confidence (${confidence}/5) matched the strength of the evidence.`);
  }
  return [...new Set(out)].slice(0, 3);
}

function buildKeyMistake(
  scenario: DrillScenario,
  answer: DecisionClassification | null,
  action: IntendedAction | null,
  classVerdict: ClassificationVerdict | null,
  actionVerdict: ActionVerdict | null,
  facts: CheckpointFacts,
  confidence: number
): string | null {
  const cls = scenario.classification;
  const level = scenario.hod;

  // 1. Trap entry — evidence-gated mechanism wording.
  if (cls === "failed" && action === "enter") {
    if (facts.trapKind === "rejectionClose") {
      return `The trap entry: candle ${facts.rejectionIndex + 1} had already closed back below the level after spiking through it, and the entry bought into that rejection anyway.`;
    }
    if (facts.trapKind === "spikeFailedToClose") {
      return `The trap entry: the spike itself never closed above ${$(level)} — it stalled at the level with a long upper wick — and the entry chased it as if the test had confirmed.`;
    }
    if (facts.trapKind === "climaxWick") {
      return `The trap entry: chasing a climax-volume spike whose upper wick showed sellers unloading at the highs — the costliest seat in this drill.`;
    }
    return "The trap entry: entering the failed break committed capital at the moment the setup least deserved it.";
  }

  // 2. An inappropriate action (other than the trap).
  if (actionVerdict === "inappropriate" && action === "enter" && cls === "weak") {
    return `Entering without confirmation: volume on the break was ${facts.volMultiple != null ? x(facts.volMultiple) : "flat against"} the prior average and ${facts.confirmingCloseIndex < 0 ? "no candle had closed above the level" : "the close above came on that same thin volume"} — nothing at the checkpoint paid for the risk.`;
  }
  if (actionVerdict === "inappropriate" && action === "enter" && cls === "ambiguous") {
    return `Forcing an entry on conflicting evidence: ${facts.confirmingCloseIndex < 0 ? "no candle had closed above the level by the lock" : "the break had not extended away from the level"} and volume was ${facts.volMultiple != null ? x(facts.volMultiple) : "unremarkable"} — there was no edge to buy.`;
  }
  if (actionVerdict === "inappropriate" && action === "skip" && cls === "clean") {
    return `The missed confirmation: candle ${facts.confirmingCloseIndex + 1} had closed above the level on ${facts.volMultiple != null ? x(facts.volMultiple) : "expanding"} volume — the setup had done everything asked of it, and standing aside left it untraded.`;
  }

  // 3. A wrong read (action itself defensible).
  if (classVerdict === "incorrect" && answer) {
    if (cls === "clean") {
      return `The read missed the confirmation: the breakout candle closed above the level on ${facts.volMultiple != null ? x(facts.volMultiple) : "expanding"} volume — both tells of a clean break were present at the checkpoint.`;
    }
    if (cls === "weak") {
      return `The read missed the thinness: ${facts.volMultiple != null ? x(facts.volMultiple) : "flat"} volume and ${facts.confirmingCloseIndex < 0 ? "no close above the level" : "a bare close with no expansion behind it"} marked this as weak, not ${ANSWER_LABEL[answer]}.`;
    }
    if (cls === "failed") {
      return `The read missed the exhaustion: a dominant upper wick on ${facts.volMultiple != null ? x(facts.volMultiple) : "climax"} climax volume is rejection behaviour, not continuation.`;
    }
    return "The read forced a single answer on mixed evidence — closes and volume pointed in different directions at the checkpoint, and no directional label was earnable.";
  }

  // 4. Overconfidence on a wrong read, when nothing above applies.
  if (classVerdict === "incorrect" && confidence >= 4) {
    return `Conviction outran the read: ${confidence}/5 confidence on a classification the checkpoint evidence didn't support.`;
  }

  return null;
}

function buildHeadline(
  classVerdict: ClassificationVerdict | null,
  actionVerdict: ActionVerdict | null,
  isTrap: boolean,
  dimensions: EvaluationDimension[]
): string {
  if (isTrap) return "Trap entry — the checkpoint evidence argued against chasing this break.";
  if (classVerdict === "correct" && actionVerdict === "appropriate") {
    return dimensions.every((d) => d.grade === "strong")
      ? "A complete decision: read, action, and confidence all matched the evidence."
      : "Right read, right decision.";
  }
  if (classVerdict === "incorrect" && (actionVerdict === "appropriate" || actionVerdict === "acceptable")) {
    return "The action protected you; the read is the lesson.";
  }
  if ((classVerdict === "correct" || classVerdict === "partial") && actionVerdict === "inappropriate") {
    return "The read was there — the decision didn't follow it.";
  }
  if (classVerdict === "incorrect") {
    return "The read missed this one — the checkpoint evidence below tells the story.";
  }
  return "Decision reviewed against the checkpoint evidence.";
}

// ── The builder ──────────────────────────────────────────────────────

export function buildEvaluation(
  scenario: DrillScenario,
  decision: DrillDecision,
  checkpointContext?: CheckpointContext
): EvaluationReport {
  const d = (decision ?? {}) as Partial<DrillDecision>;
  const answer = asClassification(d.classification);
  const action = asAction(d.action);
  const confidence = asConfidence(d as DrillDecision);

  const maxIndex = (scenario.candles?.length ?? 0) - 1;
  const rawIndex =
    asIndex(checkpointContext?.candleIndex, maxIndex) ??
    asIndex(d.candleIndex, maxIndex) ??
    asIndex(scenario.checkpointIndex, maxIndex) ??
    maxIndex;
  const facts = checkpointFacts(scenario, rawIndex);

  const classResult = answer ? scoreClassification(scenario, answer) : null;
  const actionResult = action ? scoreAction(scenario, action) : null;
  const classVerdict = classResult?.verdict ?? null;
  const actionVerdict = actionResult?.verdict ?? null;

  const dimensions: EvaluationDimension[] = [];
  if (answer && classResult) {
    dimensions.push(recognitionDimension(scenario, answer, classResult.verdict));
  }
  let calibration: EvaluationDimension | null = null;
  if (action && actionResult) {
    dimensions.push(timingDimension(scenario, action, facts, actionResult.verdict));
    dimensions.push(disciplineDimension(scenario, action, actionResult.verdict));
  }
  if (answer && classResult) {
    calibration = calibrationDimension(scenario, classResult.verdict, answer, confidence);
    dimensions.push(calibration);
  }

  const isTrap = scenario.classification === "failed" && action === "enter";
  const cls = (scenario.classification ?? "ambiguous") as DecisionClassification;

  return {
    dimensions,
    evidence: evidenceLines(scenario, facts),
    headline: buildHeadline(classVerdict, actionVerdict, isTrap, dimensions),
    didWell: buildDidWell(
      scenario, answer, action, classVerdict, actionVerdict, facts, calibration, confidence
    ),
    keyMistake: buildKeyMistake(
      scenario, answer, action, classVerdict, actionVerdict, facts, confidence
    ),
    watchFor: WATCH_FOR[cls] ?? WATCH_FOR.ambiguous,
    standingLine: EVALUATION_STANDING_LINE,
  };
}
