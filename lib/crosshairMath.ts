/**
 * crosshairMath — pure coordinate conversions for the canvas chart's
 * crosshair (components/CandleChart.tsx). These are the exact inverses of
 * the forward mappings used inside CandleChart's draw():
 *
 *   y(price) = padTop + (1 - (price - lo) / (hi - lo)) * priceH
 *   x(i)     = scrollX + i * slot + slot / 2        (candle center)
 *
 * where lo/hi are the drawn window AFTER padding and the vertical-pan
 * shift. Keeping the inversion here (instead of inline in the canvas
 * code) makes the round-trip unit-testable — see crosshairMath.test.ts.
 */

export interface PriceScale {
  padTop: number;
  priceH: number;
  lo: number;
  hi: number;
}

/** Forward: price → y pixel (identical to CandleChart's y()). */
export function priceToY(price: number, s: PriceScale): number {
  return s.padTop + (1 - (price - s.lo) / (s.hi - s.lo)) * s.priceH;
}

/** Inverse: y pixel → price at the cursor. */
export function yToPrice(y: number, s: PriceScale): number {
  return s.lo + (1 - (y - s.padTop) / s.priceH) * (s.hi - s.lo);
}

export interface TimeScale {
  scrollX: number;
  slot: number;
}

/** Forward: candle index → center x pixel (identical to CandleChart's x()). */
export function indexToCenterX(i: number, s: TimeScale): number {
  return s.scrollX + i * s.slot + s.slot / 2;
}

/** Inverse: x pixel → index of the candle slot containing it. */
export function xToIndex(x: number, s: TimeScale): number {
  return Math.floor((x - s.scrollX) / s.slot);
}
