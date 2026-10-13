/**
 * Regression tests for advanceToIndex (saved-session reload fast-forward).
 *
 * The bug: app/replay/page.tsx reloaded saved sessions with
 *   while (eng.index < t.candle_index) eng.step();
 * step() cannot advance past the final candle, so a recorded fill whose
 * candle_index exceeds the loaded session length looped forever and
 * froze the whole page — every control, including Buy, went dead.
 * advanceToIndex must always terminate at the session end.
 */
import { ReplayEngine } from "./engine";
import { advanceToIndex } from "./sessionReload";
import type { Candle } from "./types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

function candles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i * 60000,
    o: 2 + i * 0.01,
    h: 2.05 + i * 0.01,
    l: 1.95 + i * 0.01,
    c: 2.02 + i * 0.01,
    v: 1000,
  }));
}

// 1. Out-of-range target terminates at the last index (the hang case).
{
  const eng = new ReplayEngine(candles(10), 100_000, 0);
  const reached = advanceToIndex(eng, 12);
  check("out-of-range target stops at last index", reached === 9 && eng.index === 9, `reached=${reached}`);
  check("engine is atEnd", eng.atEnd === true);
}

// 2. In-range target advances exactly there.
{
  const eng = new ReplayEngine(candles(20), 100_000, 0);
  const reached = advanceToIndex(eng, 5);
  check("in-range target reached", reached === 5 && eng.index === 5, `reached=${reached}`);
}

// 3. Target behind the current index is a no-op.
{
  const eng = new ReplayEngine(candles(20), 100_000, 0);
  advanceToIndex(eng, 6);
  const reached = advanceToIndex(eng, 3);
  check("backwards target is a no-op", reached === 6, `reached=${reached}`);
}

// 4. Full reload replay incl. an out-of-range final fill completes with
//    the recorded prices applied (P/L fidelity preserved, no hang).
{
  const eng = new ReplayEngine(candles(10), 100_000, 0);
  const fills = [
    { side: "buy" as const, qty: 100, price: 2.5, candle_index: 3, t: 3 * 60000 },
    { side: "sell" as const, qty: 100, price: 3.0, candle_index: 12, t: 12 * 60000 }, // beyond the session
  ];
  for (const t of fills) {
    const reached = advanceToIndex(eng, t.candle_index);
    const idx = Math.min(t.candle_index, reached);
    if (t.side === "buy") eng.buyAt(t.qty, t.price, idx, t.t);
    else eng.sellAt(t.qty, t.price, idx, t.t);
  }
  check("reload replay completes flat", eng.positionQty === 0, `qty=${eng.positionQty}`);
  check("reload realized pnl = +50", Math.abs(eng.realizedPnl - 50) < 1e-9, `pnl=${eng.realizedPnl}`);
  check("out-of-range fill clamped to last index", eng.fills[1].candleIndex === 9, `idx=${eng.fills[1].candleIndex}`);
}

console.log(`\nsessionReload: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
