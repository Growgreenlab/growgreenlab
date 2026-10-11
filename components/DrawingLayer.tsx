/**
 * DrawingLayer — SVG overlay for professional chart drawings.
 * Positions computed from LWC coordinate APIs on every render,
 * so drawings stay anchored during pan, zoom, and replay.
 * All drawings use market coordinates (time + price), never pixels.
 */
"use client";

import { useEffect, useState } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { Drawing, LineStyle } from "../lib/drawings";
import { distToSegment, distToLine, distToRectBorder, pointInRect } from "../lib/drawings";

interface Props {
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  drawings: Drawing[];
  selectedId: string | null;
  width: number;
  height: number;
}

function dashArray(style: LineStyle): string | undefined {
  if (style === "dashed") return "6 3";
  if (style === "dotted") return "2 3";
  return undefined;
}

export default function DrawingLayer({ chart, series, drawings, selectedId, width, height }: Props) {
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
    const x = chart.timeScale().timeToCoordinate(Math.floor(timeMs / 1000) as UTCTimestamp);
    return x;
  };
  const priceToY = (price: number): number | null => series.priceToCoordinate(price);

  const renderDrawing = (d: Drawing) => {
    if (!d.visible) return null;
    const isSel = d.id === selectedId;
    const sw = isSel ? d.lineWidth + 1 : d.lineWidth;
    const dash = dashArray(d.lineStyle);
    const opacity = d.locked ? 0.6 : 0.9;
    const selColor = "#fff";

    // Selection handles
    const handle = (cx: number, cy: number, key: string) => (
      <circle key={key} cx={cx} cy={cy} r={5}
        fill={d.color} stroke={selColor} strokeWidth={1.5}
        style={{ cursor: "move" }} />
    );

    if (d.type === "hline" && d.price != null) {
      const y = priceToY(d.price);
      if (y == null) return null;
      return (
        <g key={d.id} opacity={opacity}>
          <line x1={0} y1={y} x2={width} y2={y}
            stroke={d.color} strokeWidth={sw} strokeDasharray={dash} />
          {isSel && handle(width - 14, y, "h")}
          <g>
            <rect x={width - 54} y={y - 9} width={54} height={18} rx={3}
              fill={d.color} opacity={0.92} />
            <text x={width - 27} y={y + 4} textAnchor="middle"
              fontSize={10} fill="#0a0f19" fontWeight={600}>
              {d.price.toFixed(2)}
            </text>
          </g>
        </g>
      );
    }

    if (d.type === "hray" && d.p1) {
      const x1 = timeToX(d.p1.time);
      const y = priceToY(d.p1.price);
      if (x1 == null || y == null) return null;
      return (
        <g key={d.id} opacity={opacity}>
          <line x1={x1} y1={y} x2={width + 50} y2={y}
            stroke={d.color} strokeWidth={sw} strokeDasharray={dash} />
          {isSel && handle(x1, y, "h")}
          <g>
            <rect x={width - 54} y={y - 9} width={54} height={18} rx={3}
              fill={d.color} opacity={0.92} />
            <text x={width - 27} y={y + 4} textAnchor="middle"
              fontSize={10} fill="#0a0f19" fontWeight={600}>
              {d.p1.price.toFixed(2)}
            </text>
          </g>
        </g>
      );
    }

    if (d.type === "vline" && d.time != null) {
      const x = timeToX(d.time);
      if (x == null) return null;
      return (
        <g key={d.id} opacity={opacity}>
          <line x1={x} y1={0} x2={x} y2={height}
            stroke={d.color} strokeWidth={sw} strokeDasharray={dash} />
          {isSel && handle(x, 14, "h")}
        </g>
      );
    }

    if ((d.type === "trendline" || d.type === "arrow" || d.type === "extended") && d.p1 && d.p2) {
      const x1 = timeToX(d.p1.time);
      const y1 = priceToY(d.p1.price);
      const x2 = timeToX(d.p2.time);
      const y2 = priceToY(d.p2.price);
      if (x1 == null || y1 == null || x2 == null || y2 == null) return null;

      let lx1 = x1, ly1 = y1, lx2 = x2, ly2 = y2;
      if (d.type === "extended") {
        // Extend line infinitely in both directions
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const ext = 2000;
        lx1 = x1 - (dx / len) * ext;
        ly1 = y1 - (dy / len) * ext;
        lx2 = x2 + (dx / len) * ext;
        ly2 = y2 + (dy / len) * ext;
      }

      // Arrowhead for arrow type
      const arrowHead = d.type === "arrow" ? (() => {
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const size = 10;
        const ax1 = x2 - size * Math.cos(angle - Math.PI / 6);
        const ay1 = y2 - size * Math.sin(angle - Math.PI / 6);
        const ax2 = x2 - size * Math.cos(angle + Math.PI / 6);
        const ay2 = y2 - size * Math.sin(angle + Math.PI / 6);
        return <polygon points={`${x2},${y2} ${ax1},${ay1} ${ax2},${ay2}`}
          fill={d.color} opacity={opacity} />;
      })() : null;

      return (
        <g key={d.id} opacity={opacity}>
          <line x1={lx1} y1={ly1} x2={lx2} y2={ly2}
            stroke={d.color} strokeWidth={sw} strokeDasharray={dash} />
          {arrowHead}
          {isSel && (
            <>
              {handle(x1, y1, "p1")}
              {handle(x2, y2, "p2")}
            </>
          )}
        </g>
      );
    }

    if (d.type === "rect" && d.p1 && d.p2) {
      const x1 = timeToX(d.p1.time);
      const y1 = priceToY(d.p1.price);
      const x2 = timeToX(d.p2.time);
      const y2 = priceToY(d.p2.price);
      if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
      const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
      const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
      return (
        <g key={d.id} opacity={opacity}>
          <rect x={rx} y={ry} width={rw} height={rh}
            fill={d.color} fillOpacity={0.12}
            stroke={d.color} strokeWidth={sw} strokeDasharray={dash} />
          {isSel && (
            <>
              {handle(x1, y1, "p1")}
              {handle(x2, y2, "p2")}
              {handle((x1 + x2) / 2, (y1 + y2) / 2, "c")}
            </>
          )}
        </g>
      );
    }

    if (d.type === "text" && d.p1 && d.text) {
      const x = timeToX(d.p1.time);
      const y = priceToY(d.p1.price);
      if (x == null || y == null) return null;
      return (
        <g key={d.id} opacity={opacity}>
          <rect x={x - 4} y={y - 18} width={d.text.length * 7 + 12} height={22} rx={4}
            fill="rgba(10,15,25,0.85)" stroke={isSel ? selColor : d.color}
            strokeWidth={isSel ? 1.5 : 1} />
          <text x={x + 2} y={y - 3} fontSize={12} fill={d.color} fontWeight={500}>
            {d.text}
          </text>
          {isSel && handle(x - 4, y - 18, "h")}
        </g>
      );
    }

    return null;
  };

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
      {drawings.map(renderDrawing)}
    </svg>
  );
}

/** Get touch-aware hit tolerance */
export function hitTolerance(): number {
  if (typeof window !== "undefined" && "ontouchstart" in window) return 16;
  return 8;
}

/** Hit-test a drawing at pixel (x,y). Returns true if hit. */
export function hitTestDrawing(
  d: Drawing,
  x: number, y: number,
  timeToX: (t: number) => number | null,
  priceToY: (p: number) => number | null,
  tol?: number
): boolean {
  if (!d.visible || d.locked) return false;
  const t = tol ?? hitTolerance();

  if (d.type === "hline" && d.price != null) {
    const ly = priceToY(d.price);
    return ly != null && Math.abs(ly - y) <= t;
  }
  if (d.type === "hray" && d.p1) {
    const x1 = timeToX(d.p1.time);
    const y = priceToY(d.p1.price);
    if (x1 == null || y == null) return false;
    return Math.abs(y - y) <= t && x >= x1 - t;
  }
  if (d.type === "vline" && d.time != null) {
    const lx = timeToX(d.time);
    return lx != null && Math.abs(lx - x) <= t;
  }
  if ((d.type === "trendline" || d.type === "arrow") && d.p1 && d.p2) {
    const x1 = timeToX(d.p1.time);
    const y1 = priceToY(d.p1.price);
    const x2 = timeToX(d.p2.time);
    const y2 = priceToY(d.p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return false;
    return distToSegment(x, y, x1, y1, x2, y2) <= t;
  }
  if (d.type === "extended" && d.p1 && d.p2) {
    const x1 = timeToX(d.p1.time);
    const y1 = priceToY(d.p1.price);
    const x2 = timeToX(d.p2.time);
    const y2 = priceToY(d.p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return false;
    return distToLine(x, y, x1, y1, x2, y2) <= t;
  }
  if (d.type === "rect" && d.p1 && d.p2) {
    const x1 = timeToX(d.p1.time);
    const y1 = priceToY(d.p1.price);
    const x2 = timeToX(d.p2.time);
    const y2 = priceToY(d.p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return false;
    return distToRectBorder(x, y, x1, y1, x2, y2) <= t;
  }
  if (d.type === "text" && d.p1 && d.text) {
    const tx = timeToX(d.p1.time);
    const ty = priceToY(d.p1.price);
    if (tx == null || ty == null) return false;
    return pointInRect(x, y, tx - 4, ty - 18, tx + d.text.length * 7 + 8, ty + 4, t);
  }
  return false;
}

/** Find all drawings hit at (x,y), sorted by most recent first */
export function hitTestAll(
  drawings: Drawing[],
  x: number, y: number,
  timeToX: (t: number) => number | null,
  priceToY: (p: number) => number | null,
  tol?: number
): Drawing[] {
  return drawings
    .filter((d) => hitTestDrawing(d, x, y, timeToX, priceToY, tol))
    .reverse(); // most recent first
}
