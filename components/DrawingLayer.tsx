/**
 * DrawingLayer — SVG overlay for user drawings (hlines, trendlines).
 * Positions are computed from LWC coordinate APIs on every render,
 * so drawings stay anchored during pan, zoom, and replay.
 */
"use client";

import { useEffect, useState } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { Drawing } from "../lib/drawings";
import { distToSegment } from "../lib/drawings";

interface Props {
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  drawings: Drawing[];
  selectedId: string | null;
  width: number;
  height: number;
}

export default function DrawingLayer({ chart, series, drawings, selectedId, width, height }: Props) {
  // Re-render when the visible range changes (pan/zoom) or data updates.
  const [, setRev] = useState(0);

  useEffect(() => {
    if (!chart) return;
    const onChange = () => setRev((r) => r + 1);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onChange);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onChange);
    };
  }, [chart]);

  if (!chart || !series || width === 0 || height === 0) return null;

  const timeToX = (timeMs: number): number | null => {
    const x = chart.timeScale().timeToCoordinate((Math.floor(timeMs / 1000) as UTCTimestamp));
    return x;
  };
  const priceToY = (price: number): number | null => series.priceToCoordinate(price);

  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 5,
      }}
      width={width}
      height={height}
    >
      {drawings.map((d) => {
        const isSel = d.id === selectedId;
        const stroke = d.color;
        const sw = isSel ? 2.5 : 1.5;
        const dash = d.type === "hline" ? "6 3" : undefined;

        if (d.type === "hline" && d.price != null) {
          const y = priceToY(d.price);
          if (y == null) return null;
          return (
            <g key={d.id}>
              <line
                x1={0} y1={y} x2={width} y2={y}
                stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
                opacity={0.9}
              />
              {isSel && (
                <circle cx={width - 12} cy={y} r={5} fill={stroke} stroke="#fff" strokeWidth={1.5} />
              )}
              {/* Price label on right edge */}
              <g>
                <rect
                  x={width - 52} y={y - 9}
                  width={52} height={18} rx={3}
                  fill={stroke} opacity={0.9}
                />
                <text
                  x={width - 26} y={y + 4}
                  textAnchor="middle" fontSize={10} fill="#0a0f19" fontWeight={600}
                >
                  {d.price.toFixed(2)}
                </text>
              </g>
            </g>
          );
        }

        if (d.type === "trendline" && d.p1 && d.p2) {
          const x1 = timeToX(d.p1.time);
          const y1 = priceToY(d.p1.price);
          const x2 = timeToX(d.p2.time);
          const y2 = priceToY(d.p2.price);
          if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
          return (
            <g key={d.id}>
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={stroke} strokeWidth={sw}
                opacity={0.9}
              />
              {isSel && (
                <>
                  <circle cx={x1} cy={y1} r={5} fill={stroke} stroke="#fff" strokeWidth={1.5} />
                  <circle cx={x2} cy={y2} r={5} fill={stroke} stroke="#fff" strokeWidth={1.5} />
                </>
              )}
            </g>
          );
        }

        return null;
      })}
    </svg>
  );
}

/** Hit-test a drawing at pixel (x,y). Returns the drawing or null. */
export function hitTestDrawing(
  d: Drawing,
  x: number, y: number,
  timeToX: (t: number) => number | null,
  priceToY: (p: number) => number | null,
  tol = 8
): boolean {
  if (d.type === "hline" && d.price != null) {
    const ly = priceToY(d.price);
    return ly != null && Math.abs(ly - y) <= tol;
  }
  if (d.type === "trendline" && d.p1 && d.p2) {
    const x1 = timeToX(d.p1.time);
    const y1 = priceToY(d.p1.price);
    const x2 = timeToX(d.p2.time);
    const y2 = priceToY(d.p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return false;
    return distToSegment(x, y, x1, y1, x2, y2) <= tol;
  }
  return false;
}
