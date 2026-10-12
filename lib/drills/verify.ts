/** Phase 2 verification: scenario integrity, determinism, grading. */
import { HOD_SCENARIOS, getScenario } from "./scenarios";
import { gradeAnswer } from "./types";
import { ReplayEngine } from "../engine";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}`); }
}

console.log("=== Scenario integrity ===");
for (const s of HOD_SCENARIOS) {
  check(`${s.id}: has candles`, s.candles.length > 0);
  check(`${s.id}: checkpoint in bounds`, s.checkpointIndex >= 0 && s.checkpointIndex < s.candles.length - 1);
  check(`${s.id}: post-checkpoint candles exist`, s.candles.length - s.checkpointIndex - 1 >= 3);
  check(`${s.id}: hod is a number`, typeof s.hod === "number" && s.hod > 0);
  check(`${s.id}: candles are OHLC-valid`, s.candles.every(c => c.h >= c.o && c.h >= c.c && c.l <= c.o && c.l <= c.c && c.v > 0));
  // HOD level should be touched/broken near the checkpoint
  const preCheckpoint = s.candles.slice(0, s.checkpointIndex + 1);
  const maxHigh = Math.max(...preCheckpoint.map(c => c.h));
  check(`${s.id}: HOD touched before checkpoint`, maxHigh >= s.hod);
}

console.log("\n=== Determinism: engine ticks ===");
for (const s of HOD_SCENARIOS) {
  // Run the engine twice over the same candles; tick sequences must match
  const runTicks = () => {
    const eng = new ReplayEngine(s.candles, 100_000, 0);
    const prices: number[] = [];
    // tick through first 3 candles fully
    for (let i = 0; i < 3 * 360; i++) {
      const r = eng.tick();
      prices.push(eng.displayPrice);
      if (r.atEnd) break;
    }
    return prices;
  };
  const a = runTicks();
  const b = runTicks();
  const same = a.length === b.length && a.every((p, i) => p === b[i]);
  check(`${s.id}: identical tick sequences across runs`, same);
}

console.log("\n=== Grading logic ===");
const clean = getScenario("hod-clean-001")!;
check("clean + clean = correct", gradeAnswer(clean, "clean").correct === true);
check("clean + failed = wrong", gradeAnswer(clean, "failed").correct === false);
check("clean + not_sure = partial", gradeAnswer(clean, "not_sure").partial === true);
const amb = getScenario("hod-ambiguous-001")!;
check("ambiguous + clean = partial", gradeAnswer(amb, "clean").partial === true && gradeAnswer(amb, "clean").correct === false);
check("ambiguous + not_sure = partial", gradeAnswer(amb, "not_sure").partial === true);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
