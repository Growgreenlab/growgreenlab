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

export function describeCandle(c: Candle): string {
  const cls = classLabel(classifyCandle(c));
  const rel =
    cls === "Bullish"
      ? "the close is above the open"
      : cls === "Bearish"
        ? "the close is below the open"
        : "the open and close are nearly the same price";
  return `Candlestick: open $${c.open.toFixed(2)}, high $${c.high.toFixed(2)}, low $${c.low.toFixed(2)}, close $${c.close.toFixed(2)}. Classified as ${cls.toLowerCase()} because ${rel}.`;
}

export default function CandleSvg({
  candle,
  height = 260,
  showValues = true,
}: {
  candle: Candle;
  height?: number;
  showValues?: boolean;
}) {
  const g = candleGeometry(candle);
  const cls = classifyCandle(candle);
  const color = candleColor(candle);

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

  const label = (text: string, ly: number, anchor: "start" | "end", x: number) => (
    <text x={x} y={ly + 4} fontSize={12} fill="var(--ggl-text2)" textAnchor={anchor} fontFamily="inherit">
      {text}
    </text>
  );

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={describeCandle(candle)}
        style={{ display: "block", maxWidth: 300, margin: "0 auto" }}
      >
        {/* wick */}
        <line x1={cx} x2={cx} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth={3} />
        {/* body */}
        <rect
          x={cx - bodyW / 2}
          y={bodyTopY}
          width={bodyW}
          height={bodyH}
          fill={color}
          stroke={color}
          rx={2}
        />
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
