/**
 * Phase 4 E2E: simulate the complete drill user journey for every scenario.
 * intro → running → checkpoint (no future leak) → answer → resolving → teaching.
 */
import { HOD_SCENARIOS } from "./scenarios";
import { gradeAnswer, type DrillAnswer } from "./types";
import { generateBook, generatePrints, phaseForCandle, type FlowBehavior } from "./orderflow";
import { ReplayEngine, TICKS_PER_CANDLE } from "../engine";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); }
}

const BEHAVIOR_FOR: Record<string, FlowBehavior> = {
  "hod-clean-001": "clean",
  "hod-weak-001": "weak",
  "hod-failed-001": "failed",
  "hod-ambiguous-001": "ambiguous",
};

for (const s of HOD_SCENARIOS) {
  console.log(`\n=== E2E: ${s.id} ===`);
  const behavior = BEHAVIOR_FOR[s.id];
  const fp = { seed: s.seed, level: s.hod, behavior };

  // --- Phase: running — tick until checkpoint ---
  const eng = new ReplayEngine(s.candles, 100_000, 0);
  let ticks = 0;
  const maxTicks = (s.checkpointIndex + 1) * TICKS_PER_CANDLE + 10;
  while (eng.index < s.checkpointIndex && ticks < maxTicks) {
    eng.tick();
    ticks++;
    // Every tick: generate order flow (like the UI does)
    const flowPhase = phaseForCandle(eng.index, s.checkpointIndex);
    const book = generateBook(fp, ticks, eng.displayPrice, flowPhase, 1000 + ticks);
    const prints = generatePrints(fp, ticks, eng.displayPrice, 500, flowPhase, 1000 + ticks, 0);
    // Panels must never crash or produce invalid data mid-run
    if (!(book.asks[0].price > book.bids[0].price)) { check("mid-run book valid", false); break; }
  }
  check("reached checkpoint", eng.index >= s.checkpointIndex);

  // --- Checkpoint: NO future data visible ---
  const revealed = eng.revealed;
  check("revealed stops at checkpoint", revealed.length === s.checkpointIndex + 1);
  check("no future candles leaked", !revealed.some((c, i) => s.candles.indexOf(c) > s.checkpointIndex));
  // The chart would render displayCandles — includes forming candle only
  const display = eng.displayCandles;
  check("display has no resolved future", display.length <= s.checkpointIndex + 2);

  // --- Answer ---
  const testAnswer: DrillAnswer = "clean"; // simulate a user picking "clean"
  const grading = gradeAnswer(s, testAnswer);
  const expectedCorrect = s.classification === "clean";
  const expectedPartial = s.classification === "ambiguous";
  check("grading correct for clean answer",
    grading.correct === expectedCorrect && grading.partial === (expectedPartial || (!expectedCorrect && testAnswer === "clean" && false)));
  // Simpler: just verify grading doesn't crash and returns booleans
  check("grading returns booleans", typeof grading.correct === "boolean" && typeof grading.partial === "boolean");

  // --- Resolving: tick to end ---
  let endTicks = 0;
  while (!eng.atEnd && endTicks < s.candles.length * TICKS_PER_CANDLE + 100) {
    eng.tick();
    endTicks++;
    const flowPhase = phaseForCandle(eng.index, s.checkpointIndex);
    generateBook(fp, 100000 + endTicks, eng.displayPrice, flowPhase, 2000 + endTicks);
  }
  check("reached end of scenario", eng.atEnd);
  check("all candles revealed at end", eng.revealed.length === s.candles.length);

  // --- Teaching: content exists and references real scenario data ---
  check("evidence present", !!s.evidence.candleStructure && !!s.evidence.resolution);
  check("lessons present", s.teaching.lessons.length >= 1);
  check("missed-by-answer covers wrong answers",
    s.classification === "ambiguous" ||
    testAnswer === s.classification || // right answer needs no "missed" content
    !!s.teaching.missedByAnswer[testAnswer]);
  check("alternative outcome present", !!s.teaching.alternativeOutcome);

  // --- Determinism of full journey: re-run and compare final price ---
  const eng2 = new ReplayEngine(s.candles, 100_000, 0);
  while (!eng2.atEnd) eng2.tick();
  check("full journey deterministic", eng2.displayPrice === eng.displayPrice);
}

console.log(`\n=== E2E RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
