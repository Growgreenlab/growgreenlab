/**
 * Phase 3 verification: order-flow determinism, panel sync,
 * scenario-appropriate behavior, and checkpoint integrity.
 */
import { HOD_SCENARIOS } from "./scenarios";
import {
  generateBook, generatePrints, phaseForCandle,
  type FlowBehavior, type FlowParams,
} from "./orderflow";
import { ReplayEngine, TICKS_PER_CANDLE } from "../engine";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${name}`); }
}

const behaviorFor: Record<string, FlowBehavior> = {
  "hod-clean-001": "clean",
  "hod-weak-001": "weak",
  "hod-failed-001": "failed",
  "hod-ambiguous-001": "ambiguous",
};

for (const s of HOD_SCENARIOS) {
  const behavior = behaviorFor[s.id];
  const params: FlowParams = { seed: s.seed, level: s.hod, behavior };
  console.log(`\n=== ${s.id} (${behavior}) ===`);

  // 1. Determinism: same inputs → identical book and prints
  const book1 = generateBook(params, 1234, 10.55, "breakout", 1000);
  const book2 = generateBook(params, 1234, 10.55, "breakout", 1000);
  check("book deterministic", JSON.stringify(book1) === JSON.stringify(book2));
  const prints1 = generatePrints(params, 1234, 10.55, 800, "breakout", 1000, 1);
  const prints2 = generatePrints(params, 1234, 10.55, 800, "breakout", 1000, 1);
  check("prints deterministic", JSON.stringify(prints1) === JSON.stringify(prints2));

  // 2. Different ticks → different (non-trivial) output
  const book3 = generateBook(params, 5678, 10.55, "breakout", 1000);
  check("book varies by tick", JSON.stringify(book1) !== JSON.stringify(book3));

  // 3. Book sanity: 5 bids, 5 asks, ask > bid, positive sizes
  check("book has 5x5 levels", book1.bids.length === 5 && book1.asks.length === 5);
  check("spread positive", book1.asks[0].price > book1.bids[0].price);
  check("sizes positive", [...book1.bids, ...book1.asks].every(l => l.size > 0 && l.price > 0));

  // 4. Scenario-appropriate behavior: sample resolution-phase prints
  //    across many ticks and check buy/sell skew matches the story
  let buys = 0, sells = 0;
  for (let t = 0; t < 200; t++) {
    // Weak resolution = price fading: mostly downticks. Others: upticks.
    const dir: 1 | -1 = behavior === "weak" || behavior === "failed" ? -1 : 1;
    const ps = generatePrints(params, 90000 + t, 10.60, 1000, "resolution", 2000 + t, dir);
    for (const pr of ps) { if (pr.side === "buy") buys++; else sells++; }
  }
  const buyRatio = buys / (buys + sells);
  console.log(`  resolution buy ratio: ${buyRatio.toFixed(2)}`);
  if (behavior === "clean") check("clean: buy-skewed in resolution", buyRatio > 0.55);
  if (behavior === "failed") check("failed: sell-skewed in resolution", buyRatio < 0.45);
  if (behavior === "weak") check("weak: roughly balanced", buyRatio > 0.35 && buyRatio < 0.65);

  // 5. Failed scenario: ask wall present during breakout
  if (behavior === "failed") {
    const wallBook = generateBook(params, 42, s.hod + 0.01, "breakout", 1000);
    const maxAsk = Math.max(...wallBook.asks.map(a => a.size));
    check("failed: large ask wall in breakout", maxAsk > 1500);
  }
  // 6. Clean scenario: bids stacked during breakout
  if (behavior === "clean") {
    const cleanBook = generateBook(params, 42, s.hod + 0.01, "breakout", 1000);
    check("clean: stacked bids in breakout", cleanBook.bids[0].size > 800);
  }
  // 7. Weak scenario: thin book
  if (behavior === "weak") {
    const weakBook = generateBook(params, 42, s.hod + 0.01, "breakout", 1000);
    const maxSize = Math.max(...weakBook.bids.map(b => b.size), ...weakBook.asks.map(a => a.size));
    check("weak: thin book", maxSize < 600);
  }

  // 8. Phase mapping sanity
  check("phase approach", phaseForCandle(0, s.checkpointIndex) === "approach");
  check("phase breakout at checkpoint", phaseForCandle(s.checkpointIndex, s.checkpointIndex) === "breakout");
  check("phase resolution after", phaseForCandle(s.candles.length - 1, s.checkpointIndex) === "resolution");

  // 9. Sync with engine: book price tracks tick price
  const eng = new ReplayEngine(s.candles, 100_000, 0);
  let synced = true;
  for (let i = 0; i < 50; i++) {
    eng.tick();
    const px = eng.displayPrice;
    const b = generateBook(params, i, px, "approach", 1000 + i);
    // best bid < price < best ask (book brackets the last price)
    if (!(b.bids[0].price < px && px < b.asks[0].price)) { synced = false; break; }
  }
  check("book brackets tick price (sync)", synced);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
