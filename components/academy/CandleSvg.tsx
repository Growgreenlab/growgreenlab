"use client";

/**
 * CandleSvg — purpose-built SVG candlestick renderer for the Academy
 * (audit §5 recommendation: NOT LwcChart — a lesson needs one labeled
 * candle that morphs with sliders, with text labels a canvas cannot
 * expose to screen readers).
 *
 * Accessibility: the SVG is role="img" with an aria-label describing
 * the candle in words; the classification is ALWAYS also printed as
 * text (never color-only); visible O/H/L/C labels sit next to the
 * candle.
 */
import { candleGeometry, classifyCandle, classLabel, type Candle } from "../../lib/academy/candleMath";

const BULL = "#2ebd85";
const BEAR = "#f6465d";
const DOJI = "#9aa4ae";

export function candleColor(c: Candle): string {
  const cls = classifyCandle(c);
  return cls === "bullish" ? BULL : cls === "bearish" ? BEAR : DOJI;
}

/**
 * The candle's accessible description. With `revealClassification`
 * false the label describes the candle structurally only (the four
 * prices, which are also printed on the graphic) and must NOT name
 * the classification — contexts where the learner classifies BEFORE
 * answering (direction practice, the mastery assessment) use it so
 * the aria-label can never hand over the answer.
 */
export function candleAriaLabel(c: Candle, opts: { revealClassification: boolean }): string {
  const prices = `open $${c.open.toFixed(2)}, high $${c.high.toFixed(2)}, low $${c.low.toFixed(2)}, close $${c.close.toFixed(2)}`;
  if (!opts.revealClassification) {
    return `Candlestick: ${prices}.`;
  }
  const cls = classLabel(classifyCandle(c));
  const rel =
    cls === "Bullish"
      ? "the close is above the open"
      : cls === "Bearish"
        ? "the close is below the open"
        : "the open and close are nearly the same price";
  return `Candlestick: ${prices}. Classified as ${cls.toLowerCase()} because ${rel}.`;
}

export function describeCandle(c: Candle): string {
  return candleAriaLabel(c, { revealClassification: true });
}

export type CandleHighlight =
  | "open"
  | "high"
  | "low"
  | "close"
  | "body"
  | "upper-wick"
  | "lower-wick"
  | null;

export default function CandleSvg({
  candle,
  height = 260,
  showValues = true,
  highlight = null,
  revealClassification = true,
}: {
  candle: Candle;
  height?: number;
  showValues?: boolean;
  /**
   * Presentational only: emphasize one element and dim the rest
   * (Meet OHLC / tap-to-reveal lessons). Default null renders the
   * candle exactly as before.
   */
  highlight?: CandleHighlight;
  /**
   * When false, the aria-label describes the candle structurally
   * without naming its classification — for pre-answer contexts
   * (direction practice, assessment items). Default true: teaching
   * contexts keep the full description.
   */
  revealClassification?: boolean;
}) {
  const g = candleGeometry(candle);
  const cls = classifyCandle(candle);
  const color = candleColor(candle);

  const bodyOpacity =
    highlight === "high" || highlight === "low" || highlight === "upper-wick" || highlight === "lower-wick"
      ? 0.3
      : 1;
  const labelStyle = (el: "open" | "high" | "low" | "close") =>
    highlight === el
      ? { fontWeight: 800 as const, fill: "var(--ggl-text)" }
      : { fontWeight: 400 as const, fill: "var(--ggl-text2)" };

  const W = 220;
  const H = height;
  const padTop = 18;
  const padBottom = 18;
  const plotH = H - padTop - padBottom;
  // Domain: candle range plus headroom for flat (zero-range) candles.
  const span = Math.max(g.range, 0.2);
  const mid = (candle.high + candle.low) / 2;
  const top = mid + span * 0.62;
  const y = (price: number) => padTop + ((top - price) / (span * 1.24)) * plotH;

  const cx = 86;
  const bodyW = 54;
  const bodyTopY = y(g.bodyTop);
  const bodyBottomY = y(g.bodyBottom);
  const bodyH = Math.max(2, bodyBottomY - bodyTopY);

  const label = (text: string, ly: number, anchor: "start" | "end", x: number) => {
    const el = text.startsWith("H")
      ? "high"
      : text.startsWith("L")
        ? "low"
        : text.startsWith("O")
          ? "open"
          : "close";
    const st = labelStyle(el);
    return (
      <text x={x} y={ly + 4} fontSize={12} fill={st.fill} fontWeight={st.fontWeight} textAnchor={anchor} fontFamily="inherit">
        {text}
      </text>
    );
  };

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={candleAriaLabel(candle, { revealClassification })}
        style={{ display: "block", maxWidth: 300, margin: "0 auto" }}
      >
        {/* wick (two segments so a lesson can highlight one of them) */}
        <line x1={cx} x2={cx} y1={y(candle.high)} y2={bodyTopY} stroke={color} strokeWidth={3} opacity={highlight === null || highlight === "upper-wick" || highlight === "high" ? 1 : 0.22} />
        <line x1={cx} x2={cx} y1={bodyBottomY} y2={y(candle.low)} stroke={color} strokeWidth={3} opacity={highlight === null || highlight === "lower-wick" || highlight === "low" ? 1 : 0.22} />
        {/* body */}
        <rect
          x={cx - bodyW / 2}
          y={bodyTopY}
          width={bodyW}
          height={bodyH}
          fill={color}
          stroke={color}
          rx={2}
          opacity={bodyOpacity}
        />
        {/* open / close markers, shown only when a lesson highlights them */}
        {highlight === "open" && (
          <g aria-hidden="true">
            <line x1={cx - bodyW / 2 - 30} x2={cx + bodyW / 2 + 30} y1={y(candle.open)} y2={y(candle.open)} stroke="#f0b429" strokeWidth={2} strokeDasharray="5 4" />
            <circle cx={cx - bodyW / 2} cy={y(candle.open)} r={5} fill="#f0b429" />
          </g>
        )}
        {highlight === "close" && (
          <g aria-hidden="true">
            <line x1={cx - bodyW / 2 - 30} x2={cx + bodyW / 2 + 30} y1={y(candle.close)} y2={y(candle.close)} stroke="#f0b429" strokeWidth={2} strokeDasharray="5 4" />
            <circle cx={cx + bodyW / 2} cy={y(candle.close)} r={5} fill="#f0b429" />
          </g>
        )}
        {/* price labels */}
        {label(`H $${candle.high.toFixed(2)}`, y(candle.high), "start", cx + bodyW / 2 + 10)}
        {label(`L $${candle.low.toFixed(2)}`, y(candle.low), "start", cx + bodyW / 2 + 10)}
        {label(`O $${candle.open.toFixed(2)}`, y(candle.open), "end", cx - bodyW / 2 - 10)}
        {label(`C $${candle.close.toFixed(2)}`, y(candle.close), "end", cx - bodyW / 2 - 10)}
      </svg>
      {showValues && (
        <figcaption style={{ textAlign: "center", marginTop: 6 }}>
          <span
            style={{
              display: "inline-block",
              padding: "3px 12px",
              borderRadius: 999,
              border: `1px solid ${color}`,
              color,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {classLabel(cls)} candle
          </span>{" "}
          <span style={{ color: "var(--ggl-text2)", fontSize: 13 }}>
            Range ${g.range.toFixed(2)} · Body ${g.body.toFixed(2)} · Upper wick ${g.upperWick.toFixed(2)} ·
            Lower wick ${g.lowerWick.toFixed(2)}
          </span>
        </figcaption>
      )}
    </figure>
  );
}
