/**
 * Verify Phase 4 fixes: throttled deterministic flow, historical context,
 * deterministic timestamps.
 */
import { HOD_SCENARIOS } from "./scenarios";
import {
  generateBook, generatePrints, flowTimestamp,
  FLOW_UPDATES_PER_CANDLE, TICKS_PER_FLOW_UPDATE,
  type FlowBehavior,
} from "./orderflow";
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

check("8 flow updates per candle", FLOW_UPDATES_PER_CANDLE === 8);
check("45 ticks per flow update", TICKS_PER_FLOW_UPDATE === 45);

for (const s of HOD_SCENARIOS) {
  console.log(`\n=== ${s.id} ===`);
  const behavior = BEHAVIOR_FOR[s.id];
  const fp = { seed: s.seed, level: s.hod, behavior };

  // Historical context: engine starts with history revealed
  const historyCount = Math.max(2, Math.floor(s.checkpointIndex * 0.4));
  const eng = new ReplayEngine(s.candles, 100_000, historyCount);
  check("history revealed at start", eng.revealed.length === historyCount);
  check("history < checkpoint", historyCount < s.checkpointIndex);
  check("no future beyond history", eng.revealed.every((c) => s.candles.indexOf(c) < historyCount));

  // Deterministic timestamps
  const t1 = flowTimestamp(1000000, 3);
  const t2 = flowTimestamp(1000000, 3);
  const t3 = flowTimestamp(1000000, 4);
  check("flow timestamp deterministic", t1 === t2);
  check("flow timestamp varies by update", t1 !== t3);
  check("flow timestamp within candle", t1 >= 1000000 && t1 < 1060000);

  // Throttled flow: simulate the runner's cadence for one candle
  // and verify exactly 8 updates happen, all deterministic
  const updates: string[] = [];
  for (let tick = 1; tick <= TICKS_PER_CANDLE; tick++) {
    if (tick % TICKS_PER_FLOW_UPDATE === 0) {
      const updateIndex = Math.min(FLOW_UPDATES_PER_CANDLE - 1, Math.floor(tick / TICKS_PER_FLOW_UPDATE));
      const flowTick = 5 * 1000 + updateIndex;
      const book = generateBook(fp, flowTick, 10.55, "breakout", flowTimestamp(s.candles[5].t, updateIndex));
      updates.push(JSON.stringify(book));
    }
  }
  check("exactly 8 flow updates per candle", updates.length === 8);

  // Same cadence re-run → identical
  const updates2: string[] = [];
  for (let tick = 1; tick <= TICKS_PER_CANDLE; tick++) {
    if (tick % TICKS_PER_FLOW_UPDATE === 0) {
      const updateIndex = Math.min(FLOW_UPDATES_PER_CANDLE - 1, Math.floor(tick / TICKS_PER_FLOW_UPDATE));
      const flowTick = 5 * 1000 + updateIndex;
      const book = generateBook(fp, flowTick, 10.55, "breakout", flowTimestamp(s.candles[5].t, updateIndex));
      updates2.push(JSON.stringify(book));
    }
  }
  check("throttled flow deterministic", JSON.stringify(updates) === JSON.stringify(updates2));

  // Prints at throttled cadence are bounded (readable pace)
  const prints = generatePrints(fp, 5003, 10.55, 2000, "breakout", flowTimestamp(s.candles[5].t, 3), 1);
  check("prints bounded per update", prints.length >= 1 && prints.length <= 4);
}

console.log(`\n=== FIX RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
