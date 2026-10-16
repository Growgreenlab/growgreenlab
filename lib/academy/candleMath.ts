/**
 * Trading Academy — pure candlestick mathematics (Stage 3 core).
 *
 * Everything in this module is a pure function of its inputs: candle
 * construction with the OHLC invariant enforced, classification,
 * geometry, formation from a price path, challenge evaluation, and the
 * deterministic price-path generator used by the formation demo.
 * Answer keys in the lesson content are DERIVED from these functions
 * (see content.ts), never hand-typed, so the teaching copy cannot
 * drift from the math the tests pin.
 *
 * INVARIANT: for every candle this module returns,
 *   Low ≤ min(Open, Close) ≤ max(Open, Close) ≤ High.
 * Enforcement policy is CLAMPING (spec §5A): setting any field pulls
 * the dependent fields with it (a High below the close becomes the
 * close; a Low above the open becomes the open). No input path —
 * slider, numeric input, challenge preset, programmatic update — can
 * produce an invalid candle. Non-finite inputs are the one rejection:
 * makeCandle throws a TypeError rather than fabricating numbers.
 *
 * PRECISION: all prices are rounded to cents (2dp) after clamping,
 * and the invariant is re-applied after rounding.
 *
 * CLASSIFICATION (stated identically in code and UI copy):
 *   bullish — Close > Open (and not a doji, below);
 *   bearish — Close < Open (and not a doji);
 *   doji    — the body is at most DOJI_BODY_RATIO (5%) of the total
 *             range, i.e. open and close are nearly the same price.
 *             A zero-range candle (O = H = L = C) is a doji.
 * Bullish/bearish describe ONLY the open→close relationship of the
 * finished candle. They say nothing about who "controlled" the
 * interval and nothing about the next candle.
 */
import { mulberry32 } from "./rng";

export interface CandleInput {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A validated candle: same shape, guaranteed to satisfy the invariant. */
export type Candle = CandleInput;

export type CandleClass = "bullish" | "bearish" | "doji";

/** Doji tolerance: body ≤ 5% of range classifies as a doji. */
export const DOJI_BODY_RATIO = 0.05;

/** Sanity domain for a lesson price. Inputs outside are clamped in. */
export const PRICE_FLOOR = 0;
export const PRICE_CEILING = 100000;

const r2 = (n: number): number => Math.round(n * 100) / 100;

function assertFinite(input: CandleInput): void {
  for (const k of ["open", "high", "low", "close"] as const) {
    if (typeof input[k] !== "number" || !Number.isFinite(input[k])) {
      throw new TypeError(`makeCandle: ${k} must be a finite number, got ${String(input[k])}`);
    }
  }
}

/**
 * Build a valid candle from arbitrary inputs by clamping.
 * Throws TypeError on any non-finite field (transparent rejection).
 */
export function makeCandle(input: CandleInput): Candle {
  assertFinite(input);
  const clampDomain = (n: number) => Math.min(PRICE_CEILING, Math.max(PRICE_FLOOR, n));
  let open = clampDomain(input.open);
  let close = clampDomain(input.close);
  let high = clampDomain(input.high);
  let low = clampDomain(input.low);
  // Enforce the invariant, then round to cents, then re-enforce
  // (rounding can move a boundary value by a cent).
  high = Math.max(high, open, close);
  low = Math.min(low, open, close);
  open = r2(open);
  close = r2(close);
  high = Math.max(r2(high), open, close);
  low = Math.min(r2(low), open, close);
  return { open, high, low, close };
}

/**
 * Return a new valid candle with one field replaced — the single entry
 * point the builder's sliders, numeric inputs, and presets all use, so
 * every input path inherits the clamping policy.
 */
export function setCandleField(candle: Candle, field: keyof CandleInput, value: number): Candle {
  return makeCandle({ ...candle, [field]: value });
}

/** True when the candle satisfies the OHLC invariant (within a cent). */
export function isValidCandle(c: CandleInput): boolean {
  const eps = 0.011;
  return (
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    c.low <= Math.min(c.open, c.close) + eps &&
    Math.max(c.open, c.close) <= c.high + eps &&
    c.low <= c.high + eps
  );
}

export interface CandleGeometry {
  range: number;
  body: number;
  bodyTop: number;
  bodyBottom: number;
  upperWick: number;
  lowerWick: number;
  /** body / range (0 when range is 0). */
  bodyRatio: number;
  upperWickRatio: number;
  lowerWickRatio: number;
}

export function candleGeometry(c: Candle): CandleGeometry {
  const range = r2(c.high - c.low);
  const body = r2(Math.abs(c.close - c.open));
  const bodyTop = Math.max(c.open, c.close);
  const bodyBottom = Math.min(c.open, c.close);
  const upperWick = r2(c.high - bodyTop);
  const lowerWick = r2(bodyBottom - c.low);
  const ratio = (part: number) => (range > 0 ? part / range : 0);
  return {
    range,
    body,
    bodyTop,
    bodyBottom,
    upperWick,
    lowerWick,
    bodyRatio: ratio(body),
    upperWickRatio: ratio(upperWick),
    lowerWickRatio: ratio(lowerWick),
  };
}

export function classifyCandle(c: Candle): CandleClass {
  const g = candleGeometry(c);
  if (g.range === 0 || g.bodyRatio <= DOJI_BODY_RATIO) return "doji";
  return c.close > c.open ? "bullish" : "bearish";
}

export function classLabel(cls: CandleClass): string {
  return cls === "bullish" ? "Bullish" : cls === "bearish" ? "Bearish" : "Doji";
}

/* ------------------------------------------------------------------ */
/* Formation: deriving a candle from a price path                      */
/* ------------------------------------------------------------------ */

export interface FormationFrame {
  /** The latest price in the path prefix. */
  price: number;
  /** The candle formed by the path so far. */
  candle: Candle;
}

/**
 * Reduce a price path to per-step forming candles: the Open is the
 * first price of the interval, High/Low are the running extremes, and
 * the current price is the forming Close. The final frame's candle is
 * the completed candle. The path itself is NOT recoverable from the
 * final candle — only these four numbers survive (the lesson says so).
 */
export function formationFromPath(path: readonly number[]): FormationFrame[] {
  if (path.length === 0) throw new Error("formationFromPath: empty path");
  for (const p of path) {
    if (typeof p !== "number" || !Number.isFinite(p)) {
      throw new TypeError(`formationFromPath: non-finite price ${String(p)}`);
    }
  }
  const open = path[0];
  let high = path[0];
  let low = path[0];
  return path.map((price) => {
    high = Math.max(high, price);
    low = Math.min(low, price);
    return { price, candle: makeCandle({ open, high, low, close: price }) };
  });
}

/**
 * Deterministic simulated price path for the formation demo: a seeded
 * random walk. Clearly simulated educational data — never presented
 * as a real market path anywhere in the UI.
 */
export function generatePricePath(seed: number, startPrice: number, steps: number): number[] {
  if (steps < 2) throw new Error("generatePricePath: steps must be >= 2");
  const rng = mulberry32(seed);
  const path: number[] = [r2(startPrice)];
  let price = startPrice;
  for (let i = 1; i < steps; i++) {
    // Mean-reverting-ish walk so paths wander both ways around the open.
    const drift = (startPrice - price) * 0.02;
    price = Math.max(0.25, price + drift + (rng() - 0.5) * 0.14);
    path.push(r2(price));
  }
  return path;
}

/* ------------------------------------------------------------------ */
/* Builder challenges                                                  */
/* ------------------------------------------------------------------ */

/** Deterministic starting candle for a challenge attempt (values vary by seed). */
export function challengeStartCandle(seed: number): Candle {
  const rng = mulberry32(seed * 7919 + 13);
  const open = r2(9.5 + rng() * 1.0);
  const close = r2(open + (rng() - 0.5) * 0.3);
  const high = r2(Math.max(open, close) + rng() * 0.15);
  const low = r2(Math.min(open, close) - rng() * 0.15);
  return makeCandle({ open, high, low, close });
}

export interface ChallengeVerdict {
  passed: boolean;
  /** Feedback lines built from the candle's actual numbers. */
  reasons: string[];
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Evaluate a builder challenge from the candle's geometry alone.
 * `minRange` applies only to small-body-large-range. Rules (stated in
 * the lesson copy, word for word):
 *  - long upper/lower wick: the wick is at least 50% of the total
 *    range AND at least twice the body size;
 *  - small body / large range: body at most 25% of the range AND the
 *    range at least `minRange` dollars.
 */
export function evaluateCandleChallenge(
  kind: "bullish" | "bearish" | "doji" | "long-upper-wick" | "long-lower-wick" | "small-body-large-range",
  candle: Candle,
  minRange: number | null
): ChallengeVerdict {
  const g = candleGeometry(candle);
  const cls = classifyCandle(candle);
  const o = money(candle.open);
  const c = money(candle.close);
  switch (kind) {
    case "bullish":
      return cls === "bullish"
        ? { passed: true, reasons: [`Close ${c} is above open ${o} — that open-to-close relationship is what "bullish" means.`] }
        : { passed: false, reasons: [`This candle is ${classLabel(cls).toLowerCase()}: close ${c} is not above open ${o} by more than the doji tolerance. Raise the close above the open (body more than 5% of the range).`] };
    case "bearish":
      return cls === "bearish"
        ? { passed: true, reasons: [`Close ${c} is below open ${o} — that open-to-close relationship is what "bearish" means.`] }
        : { passed: false, reasons: [`This candle is ${classLabel(cls).toLowerCase()}: close ${c} is not below open ${o} by more than the doji tolerance. Lower the close below the open (body more than 5% of the range).`] };
    case "doji":
      return cls === "doji"
        ? { passed: true, reasons: [`Body ${money(g.body)} is ${(g.bodyRatio * 100).toFixed(0)}% of the ${money(g.range)} range — within the 5% doji tolerance, so open and close count as nearly the same price.`] }
        : { passed: false, reasons: [`Body ${money(g.body)} is ${(g.bodyRatio * 100).toFixed(0)}% of the ${money(g.range)} range — too big for a doji (needs ≤ 5%). Bring the close to within a few cents of the open.`] };
    case "long-upper-wick": {
      const ok = g.range > 0 && g.upperWickRatio >= 0.5 && g.upperWick >= 2 * g.body;
      return ok
        ? { passed: true, reasons: [`Upper wick ${money(g.upperWick)} is ${(g.upperWickRatio * 100).toFixed(0)}% of the ${money(g.range)} range and at least twice the ${money(g.body)} body — a long upper wick. Price reached ${money(candle.high)} and closed well below it.`] }
        : { passed: false, reasons: [`Upper wick ${money(g.upperWick)} is ${(g.upperWickRatio * 100).toFixed(0)}% of the range (needs ≥ 50%) and must also be at least twice the body (${money(g.body)}). Push the high well above both open and close.`] };
    }
    case "long-lower-wick": {
      const ok = g.range > 0 && g.lowerWickRatio >= 0.5 && g.lowerWick >= 2 * g.body;
      return ok
        ? { passed: true, reasons: [`Lower wick ${money(g.lowerWick)} is ${(g.lowerWickRatio * 100).toFixed(0)}% of the ${money(g.range)} range and at least twice the ${money(g.body)} body — a long lower wick. Price fell to ${money(candle.low)} and closed well above it.`] }
        : { passed: false, reasons: [`Lower wick ${money(g.lowerWick)} is ${(g.lowerWickRatio * 100).toFixed(0)}% of the range (needs ≥ 50%) and must also be at least twice the body (${money(g.body)}). Push the low well below both open and close.`] };
    }
    case "small-body-large-range": {
      const need = minRange ?? 0.5;
      const okBody = g.range > 0 && g.bodyRatio <= 0.25;
      const okRange = g.range >= need;
      return okBody && okRange
        ? { passed: true, reasons: [`Body ${money(g.body)} is only ${(g.bodyRatio * 100).toFixed(0)}% of a ${money(g.range)} range — a small body inside a large range. Most of this candle is wicks.`] }
        : {
            passed: false,
            reasons: [
              `Body is ${(g.bodyRatio * 100).toFixed(0)}% of the range (needs ≤ 25%) and the range is ${money(g.range)} (needs ≥ ${money(need)}). Keep open and close close together and stretch the high and low apart.`,
            ],
          };
    }
  }
}
