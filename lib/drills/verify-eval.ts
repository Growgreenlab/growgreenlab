/**
 * Verify Stage B: the decision-evaluation layer (lib/drills/evaluation.ts).
 *
 * Pins: checkpoint-fact derivations per scenario (measured ground
 * truth), timing-basis per scenario, trap-error evidence gating,
 * confidence-calibration thresholds, the teaching structure (didWell /
 * keyMistake / watchFor) incl. positive no-trade framing, checkpoint
 * purity (output identical regardless of post-checkpoint candles), and
 * missing-field robustness (degrade, never invent, never throw).
 */
import { HOD_SCENARIOS } from "./scenarios";
import { buildDecision, type DrillDecision } from "./decision";
import type { DecisionClassification, IntendedAction, DrillScenario } from "./types";
import {
  buildEvaluation, checkpointFacts, EVALUATION_STANDING_LINE,
  type EvaluationReport,
} from "./evaluation";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); }
}

const byId = new Map(HOD_SCENARIOS.map((s) => [s.id, s]));
const APPROPRIATE: Record<string, IntendedAction> = {
  clean: "enter", weak: "wait", failed: "skip", ambiguous: "skip",
};

function decisionFor(
  s: DrillScenario,
  classification: DecisionClassification,
  action: IntendedAction,
  confidence?: number | null
): DrillDecision {
  return buildDecision(
    { classification, action, confidence: confidence === undefined ? 3 : confidence },
    { simTimeMs: 600_000, candleIndex: s.checkpointIndex },
    1
  );
}

function dim(r: EvaluationReport, key: string) {
  return r.dimensions.find((d) => d.key === key);
}

// ── A. Checkpoint facts: measured ground truth per scenario ────────
// (breakout/confirming/rejection indices and volume multiples were
// measured directly from the generated candle data, 2026-10-15.)
const FACTS: Record<string, {
  b: number; cci: number; rej: number; vol: number;
  trap: string | null; last: string;
}> = {
  "hod-clean-001":     { b: 14, cci: 14, rej: -1, vol: 1.90, trap: null, last: "above" },
  "hod-weak-001":      { b: 13, cci: -1, rej: 13, vol: 0.85, trap: null, last: "below" },
  "hod-failed-001":    { b: 12, cci: 12, rej: -1, vol: 2.72, trap: "climaxWick", last: "above" },
  "hod-ambiguous-001": { b: 13, cci: 13, rej: -1, vol: 1.20, trap: null, last: "above" },
  "hod-clean-002":     { b: 17, cci: 17, rej: -1, vol: 2.46, trap: null, last: "above" },
  "hod-clean-003":     { b: 10, cci: 10, rej: -1, vol: 2.57, trap: null, last: "above" },
  "hod-weak-002":      { b: 13, cci: -1, rej: 13, vol: 0.60, trap: null, last: "below" },
  "hod-weak-003":      { b: 11, cci: 12, rej: -1, vol: 0.65, trap: null, last: "above" },
  "hod-failed-002":    { b: 10, cci: -1, rej: 10, vol: 2.71, trap: "rejectionClose", last: "below" },
  "hod-failed-003":    { b: 16, cci: 17, rej: -1, vol: 2.48, trap: "spikeFailedToClose", last: "above" },
  "hod-ambiguous-002": { b: 13, cci: 13, rej: -1, vol: 1.50, trap: null, last: "above" },
  "hod-ambiguous-003": { b: 14, cci: -1, rej: 14, vol: 1.01, trap: null, last: "below" },
};

for (const s of HOD_SCENARIOS) {
  const want = FACTS[s.id];
  check(`facts table covers ${s.id}`, !!want);
  if (!want) continue;
  const f = checkpointFacts(s, s.checkpointIndex);
  check(`breakout index (${s.id})`, f.breakoutIndex === want.b);
  check(`confirming close index (${s.id})`, f.confirmingCloseIndex === want.cci);
  check(`rejection index (${s.id})`, f.rejectionIndex === want.rej);
  check(`volume multiple (${s.id})`,
    f.volMultiple != null && Math.abs(f.volMultiple - want.vol) < 0.02);
  check(`trap kind (${s.id})`, f.trapKind === want.trap);
  check(`last close vs level (${s.id})`, f.lastCloseVsLevel === want.last);
}

// ── B. Timing basis for an Enter decision, per scenario ────────────
for (const s of HOD_SCENARIOS) {
  const r = buildEvaluation(s, decisionFor(s, s.classification as DecisionClassification, "enter", 3), { candleIndex: s.checkpointIndex });
  const t = dim(r, "timing");
  check(`timing dimension present (${s.id})`, !!t);
  if (!t) continue;
  if (s.classification === "failed") {
    check(`failed enter = trap error, weak (${s.id})`,
      t.grade === "weak" && t.note.includes("Trap error"));
  } else if (FACTS[s.id].cci >= 0) {
    check(`enter after confirming close = confirmation, strong (${s.id})`,
      t.grade === "strong" && t.note.includes("Confirmation-based"));
  } else {
    check(`enter with no confirming close = anticipation, developing (${s.id})`,
      t.grade === "developing" && t.note.includes("Anticipation"));
  }
}
// Trap mechanism wording is evidence-specific, never generic.
{
  const f1 = buildEvaluation(byId.get("hod-failed-001")!, decisionFor(byId.get("hod-failed-001")!, "clean", "enter", 3));
  check("failed-001 trap note cites climax wick (no printed rejection existed)",
    (dim(f1, "timing")?.note ?? "").includes("climax volume") &&
    !(dim(f1, "timing")?.note ?? "").includes("closed back below"));
  const f2 = buildEvaluation(byId.get("hod-failed-002")!, decisionFor(byId.get("hod-failed-002")!, "clean", "enter", 3));
  check("failed-002 trap note cites the printed rejection close",
    (dim(f2, "timing")?.note ?? "").includes("closed back below"));
  const f3 = buildEvaluation(byId.get("hod-failed-003")!, decisionFor(byId.get("hod-failed-003")!, "clean", "enter", 3));
  check("failed-003 trap note cites the spike that never closed above",
    (dim(f3, "timing")?.note ?? "").includes("never closed above"));
}

// ── C. Teaching structure on representative decisions ────────────────
for (const s of HOD_SCENARIOS) {
  const cls = s.classification as DecisionClassification;
  const conf = cls === "clean" || cls === "failed" ? 5 : cls === "weak" ? 3 : 2;
  const r = buildEvaluation(s, decisionFor(s, cls, APPROPRIATE[cls], conf), { candleIndex: s.checkpointIndex });
  check(`complete decision: 4 dimensions (${s.id})`, r.dimensions.length === 4);
  check(`complete decision: recognition strong (${s.id})`, dim(r, "recognition")?.grade === "strong");
  check(`complete decision: discipline strong (${s.id})`, dim(r, "discipline")?.grade === "strong");
  check(`complete decision: no key mistake (${s.id})`, r.keyMistake === null);
  check(`complete decision: didWell non-empty (${s.id})`, r.didWell.length >= 1);
  check(`complete decision: headline is the complete-decision text (${s.id})`,
    r.headline.startsWith("A complete decision"));
  check(`complete decision: watchFor present (${s.id})`, r.watchFor.length > 20);
  if (APPROPRIATE[cls] !== "enter") {
    check(`correct no-trade framed as a POSITIVE outcome (${s.id})`,
      r.didWell.some((w) => w.includes("No-trade was the trade")) &&
      !r.didWell.join(" ").toLowerCase().includes("missed"));
  }
}
{
  // Clean + skip: the one inappropriate no-trade.
  const s = byId.get("hod-clean-001")!;
  const r = buildEvaluation(s, decisionFor(s, "clean", "skip", 3), { candleIndex: s.checkpointIndex });
  check("clean+skip: discipline weak", dim(r, "discipline")?.grade === "weak");
  check("clean+skip: timing weak", dim(r, "timing")?.grade === "weak");
  check("clean+skip: key mistake names the missed confirmation",
    (r.keyMistake ?? "").includes("missed confirmation"));
}
{
  // Failed + enter: trap naming across all three trap surfaces.
  const s = byId.get("hod-failed-002")!;
  const r = buildEvaluation(s, decisionFor(s, "clean", "enter", 4), { candleIndex: s.checkpointIndex });
  check("failed+enter: discipline note names the trap error",
    (dim(r, "discipline")?.note ?? "").includes("Trap error"));
  check("failed+enter: key mistake is the trap entry",
    (r.keyMistake ?? "").toLowerCase().includes("trap entry"));
  check("failed+enter: headline is the trap headline",
    r.headline.startsWith("Trap entry"));
  check("failed+enter: didWell has no praise for the entry",
    !r.didWell.some((w) => w.includes("committed")));
}
{
  const s = byId.get("hod-weak-002")!;
  const r = buildEvaluation(s, decisionFor(s, "clean", "enter", 3), { candleIndex: s.checkpointIndex });
  check("weak+enter: key mistake names entering without confirmation",
    (r.keyMistake ?? "").includes("Entering without confirmation"));
}
{
  const s = byId.get("hod-ambiguous-001")!;
  const r = buildEvaluation(s, decisionFor(s, "clean", "enter", 3), { candleIndex: s.checkpointIndex });
  check("ambiguous+enter: key mistake names forcing an entry",
    (r.keyMistake ?? "").includes("Forcing an entry"));
}
{
  // Wrong read, protective action: headline + read-focused key mistake.
  const s = byId.get("hod-clean-002")!;
  const r = buildEvaluation(s, decisionFor(s, "weak", "wait", 3), { candleIndex: s.checkpointIndex });
  check("wrong read + acceptable action: recognition weak", dim(r, "recognition")?.grade === "weak");
  check("wrong read + acceptable action: protective headline",
    r.headline === "The action protected you; the read is the lesson.");
  check("wrong read: key mistake is the missed read, citing evidence",
    (r.keyMistake ?? "").includes("read missed the confirmation"));
}

// ── D. Confidence calibration thresholds ─────────────────────────────
// [scenarioId, answer, confidence, expectedGrade, expectedSubstring]
const CAL: Array<[string, DecisionClassification, number, string, string]> = [
  ["hod-clean-001", "clean", 5, "strong", "matched the strength"],
  ["hod-clean-001", "clean", 1, "developing", "Under-confident"],
  ["hod-clean-001", "weak", 5, "weak", "Overconfident"],
  ["hod-clean-001", "weak", 2, "strong", "well placed"],
  ["hod-weak-001", "weak", 5, "developing", "more certainty than this checkpoint evidence could carry"],
  ["hod-ambiguous-001", "ambiguous", 3, "strong", "matched the strength"],
  ["hod-ambiguous-001", "clean", 3, "strong", "well calibrated"], // partial score, moderate conf = calibrated
  ["hod-ambiguous-001", "clean", 5, "developing", "overreach"],
  ["hod-ambiguous-002", "ambiguous", 5, "developing", "more certainty than this checkpoint evidence could carry"],
  ["hod-failed-001", "clean", 4, "weak", "Overconfident"],
  ["hod-failed-001", "clean", 3, "developing", "firmer than a wrong read earns"],
  ["hod-clean-003", "ambiguous", 5, "developing", "two directions"],
  ["hod-weak-003", "ambiguous", 2, "strong", "honestly calibrated"],
];
for (const [id, answer, conf, grade, substr] of CAL) {
  const s = byId.get(id)!;
  const r = buildEvaluation(s, decisionFor(s, answer, "wait", conf), { candleIndex: s.checkpointIndex });
  const c = dim(r, "calibration");
  check(`calibration ${id} ans=${answer} conf=${conf} → ${grade}`,
    c?.grade === grade && (c?.note ?? "").includes(substr));
}

// ── E. Checkpoint purity: post-checkpoint data cannot move output ──
for (const s of HOD_SCENARIOS) {
  const cls = s.classification as DecisionClassification;
  const d = decisionFor(s, cls, APPROPRIATE[cls], 4);
  const ctx = { candleIndex: s.checkpointIndex };
  const base = JSON.stringify(buildEvaluation(s, d, ctx));
  const tailMutated: DrillScenario = {
    ...s,
    candles: s.candles.map((c, i) =>
      i > s.checkpointIndex ? { ...c, o: 99, h: 999, l: 0.01, c: 500, v: 1_000_000_000 } : c),
    evidence: { candleStructure: "X", volumeBehavior: "X", priceVsLevel: "X", resolution: "FUTURE OUTCOME TEXT" },
    teaching: { lessons: ["X"], missedByAnswer: {}, alternativeOutcome: "X" },
  };
  check(`output identical with mutated tail + outcome text (${s.id})`,
    JSON.stringify(buildEvaluation(tailMutated, d, ctx)) === base);
  const truncated: DrillScenario = { ...s, candles: s.candles.slice(0, s.checkpointIndex + 1) };
  check(`output identical with truncated tail (${s.id})`,
    JSON.stringify(buildEvaluation(truncated, d, ctx)) === base);
  check(`deterministic across calls (${s.id})`,
    JSON.stringify(buildEvaluation(s, d, ctx)) === base);
  check(`no evidence line cites the resolution text (${s.id})`,
    !buildEvaluation(s, d, ctx).evidence.some((e) => e.includes(s.evidence.resolution)));
}

// ── F. Missing-field robustness: degrade, never invent, never throw ─
{
  const s = byId.get("hod-clean-001")!;
  let threw = false;
  let empty: EvaluationReport | null = null;
  try {
    empty = buildEvaluation(s, {} as DrillDecision, undefined);
    buildEvaluation(s, null as unknown as DrillDecision, undefined);
    buildEvaluation(s, undefined as unknown as DrillDecision, {});
  } catch { threw = true; }
  check("empty/null decisions never throw", !threw);
  check("empty decision: all dimensions omitted, nothing invented",
    empty !== null && empty.dimensions.length === 0 && empty.keyMistake === null && empty.didWell.length === 0);
  check("empty decision: report still framed",
    empty !== null && empty.headline.length > 0 && empty.watchFor.length > 0 && empty.standingLine === EVALUATION_STANDING_LINE);

  const classOnly = buildEvaluation(s, { classification: "clean" } as DrillDecision, undefined);
  check("classification-only decision: recognition dimension alone",
    classOnly.dimensions.length === 2 && classOnly.dimensions[0].key === "recognition" &&
    classOnly.dimensions[1].key === "calibration");

  const failed = byId.get("hod-failed-001")!;
  const actionOnly = buildEvaluation(failed, { action: "enter" } as DrillDecision, undefined);
  check("action-only decision on failed: timing+discipline, trap still named",
    actionOnly.dimensions.length === 2 && (actionOnly.keyMistake ?? "").toLowerCase().includes("trap entry"));

  const full = decisionFor(s, "weak", "wait", 3);
  const noConf = buildEvaluation(s, { ...full, confidence: undefined }, { candleIndex: s.checkpointIndex });
  check("missing confidence == the ledger default (3)",
    JSON.stringify(noConf) === JSON.stringify(buildEvaluation(s, full, { candleIndex: s.checkpointIndex })));

  const { candleIndex: _omit, ...noIndex } = full;
  const noIdx = buildEvaluation(s, noIndex as DrillDecision, undefined);
  check("missing candleIndex == scenario checkpoint fallback",
    JSON.stringify(noIdx) === JSON.stringify(buildEvaluation(s, full, { candleIndex: s.checkpointIndex })));

  let garbageThrew = false;
  try {
    buildEvaluation(s, { classification: "bogus", action: "bogus", confidence: NaN, candleIndex: 9999 } as unknown as DrillDecision, { candleIndex: -3 });
    buildEvaluation({ ...s, candles: [] }, full, { candleIndex: 0 });
  } catch { garbageThrew = true; }
  check("garbage fields / empty candle list never throw", !garbageThrew);

  const before = JSON.stringify({ s, d: full });
  buildEvaluation(s, full, { candleIndex: s.checkpointIndex });
  check("buildEvaluation does not mutate its inputs", JSON.stringify({ s, d: full }) === before);
}

// ── G. Content hygiene across a decision matrix ─────────────────────
const PROFIT = /profit|guarantee|win rate|p&l|money back/i;
for (const s of HOD_SCENARIOS) {
  const cls = s.classification as DecisionClassification;
  const variants: DrillDecision[] = [
    decisionFor(s, cls, APPROPRIATE[cls], 4),
    decisionFor(s, cls, "enter", 5),
    decisionFor(s, cls === "clean" ? "failed" : "clean", "wait", 2),
    decisionFor(s, "ambiguous", "skip", 1),
  ];
  for (const [vi, d] of variants.entries()) {
    const r = buildEvaluation(s, d, { candleIndex: s.checkpointIndex });
    const tag = `${s.id} v${vi}`;
    check(`evidence is 2–4 checkpoint lines (${tag})`, r.evidence.length >= 2 && r.evidence.length <= 4);
    check(`dimension keys/grades valid (${tag})`,
      r.dimensions.every((dd) => ["recognition", "timing", "discipline", "calibration"].includes(dd.key) &&
        ["strong", "developing", "weak"].includes(dd.grade)));
    const prose = [
      r.headline, r.watchFor, ...(r.keyMistake ? [r.keyMistake] : []),
      ...r.didWell, ...r.evidence, ...r.dimensions.map((dd) => dd.note),
    ].join(" ");
    check(`no profitability language (${tag})`, !PROFIT.test(prose));
  }
  check(`standing line disclaims outcome/profitability (${s.id})`,
    buildEvaluation(s, variants[0], { candleIndex: s.checkpointIndex }).standingLine
      .includes("not a prediction of real-world profitability"));
}

console.log(`\n=== EVAL RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
