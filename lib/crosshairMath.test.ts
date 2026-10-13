/**
 * crosshairMath.test.ts — round-trip tests for the canvas crosshair
 * coordinate inversions. Run: npx tsx lib/crosshairMath.test.ts
 *
 * The canvas chart (CandleChart) draws with forward mappings
 *   y = padTop + (1 - (price - lo) / (hi - lo)) * priceH
 *   x = scrollX + i * slot + slot / 2
 * and the crosshair reads values back with the inverses in
 * lib/crosshairMath. If the two ever drift apart, the price/time labels
 * would lie about the cursor position — these tests pin them together.
 */
import { priceToY, yToPrice, indexToCenterX, xToIndex, type PriceScale, type TimeScale } from "./crosshairMath";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`); }
}
const approx = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

/* ---------------- price scale round-trips ---------------- */
// Scales mirroring real draw() windows: PAD_T = 14, various priceH,
// ranges and vertical-pan shifts baked into lo/hi.
const scales: PriceScale[] = [
  { padTop: 14, priceH: 412, lo: 3.42, hi: 5.61 },   // ordinary MNDR-like window
  { padTop: 14, priceH: 300, lo: 0.85, hi: 0.92 },   // sub-dollar tight range
  { padTop: 14, priceH: 518, lo: 9.97, hi: 10.04 },  // drill-like, tiny range
  { padTop: 14, priceH: 256, lo: -1.5, hi: 4.25 },   // window after a big pan shift
];
for (const [si, s] of scales.entries()) {
  for (const f of [0, 0.13, 0.5, 0.87, 1]) {
    const price = s.lo + (s.hi - s.lo) * f;
    check(`scale ${si}: price→y→price @${f}`, approx(yToPrice(priceToY(price, s), s), price));
    const y = s.padTop + s.priceH * f;
    check(`scale ${si}: y→price→y @${f}`, approx(priceToY(yToPrice(y, s), s), y));
  }
  // Window edges map to the pane edges exactly.
  check(`scale ${si}: hi → top edge`, approx(priceToY(s.hi, s), s.padTop));
  check(`scale ${si}: lo → bottom edge`, approx(priceToY(s.lo, s), s.padTop + s.priceH));
  check(`scale ${si}: top edge → hi`, approx(yToPrice(s.padTop, s), s.hi));
  check(`scale ${si}: bottom edge → lo`, approx(yToPrice(s.padTop + s.priceH, s), s.lo));
}

/* ---------------- time scale round-trips ---------------- */
const timeScales: TimeScale[] = [
  { scrollX: 0, slot: 6 },        // default rest view
  { scrollX: -1234.5, slot: 6 },  // panned into history
  { scrollX: 212.25, slot: 48 },  // max zoom, positive margin scroll
  { scrollX: -87.75, slot: 1.5 }, // min zoom
];
for (const [si, s] of timeScales.entries()) {
  for (const i of [0, 1, 17, 120, 381]) {
    const cx = indexToCenterX(i, s);
    check(`time ${si}: center of ${i} → index ${i}`, xToIndex(cx, s) === i);
    // Any x inside the slot maps to the same candle.
    check(`time ${si}: slot start of ${i}`, xToIndex(cx - s.slot / 2 + 0.01, s) === i);
    check(`time ${si}: slot end of ${i}`, xToIndex(cx + s.slot / 2 - 0.01, s) === i);
  }
  // The label x for a hovered candle is its drawn center.
  check(`time ${si}: center formula`, approx(indexToCenterX(3, s), s.scrollX + 3 * s.slot + s.slot / 2));
}

console.log(`crosshairMath tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
