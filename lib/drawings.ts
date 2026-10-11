/**
 * drawings.ts — Professional drawing model.
 * All drawings use market coordinates (time ms + price), never pixels,
 * so they stay anchored during pan, zoom, replay, and resize.
 */

export type DrawingTool =
  | "select"
  | "trendline"
  | "hline"
  | "hray"       // horizontal ray (extends right)
  | "vline"      // vertical line at time
  | "extended"   // extended line (infinite both directions)
  | "rect"       // rectangle
  | "text"       // text annotation
  | "arrow";     // arrow (trendline with arrowhead)

export type DrawingType =
  | "trendline"
  | "hline"
  | "hray"
  | "vline"
  | "extended"
  | "rect"
  | "text"
  | "arrow";

export type LineStyle = "solid" | "dashed" | "dotted";

export interface TrendPoint {
  time: number; // ms epoch (candle timestamp)
  price: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  /** Anchor points in market coordinates */
  p1?: TrendPoint;  // start / top-left / anchor
  p2?: TrendPoint;  // end / bottom-right
  /** For hline: the price level (p1.price also works, but price is simpler) */
  price?: number;
  /** For vline: the time (p1.time also works) */
  time?: number;
  /** For text: the content */
  text?: string;
  /** Styling */
  color: string;
  lineWidth: number;      // 1-4
  lineStyle: LineStyle;
  /** State */
  visible: boolean;
  locked: boolean;
}

let idCounter = 0;
export function newDrawingId(): string {
  idCounter += 1;
  return `d${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export const DRAWING_COLORS: Record<DrawingType, string> = {
  trendline: "#38bdf8",
  hline: "#f59e0b",
  hray: "#f59e0b",
  vline: "#a78bfa",
  extended: "#38bdf8",
  rect: "#34d399",
  text: "#e2e8f0",
  arrow: "#f472b6",
};

export const DEFAULT_LINE_WIDTH = 1.5;
export const DEFAULT_LINE_STYLE: LineStyle = "solid";

/** Create a new drawing with sensible defaults */
export function createDrawing(
  type: DrawingType,
  partial: Partial<Drawing> = {}
): Drawing {
  return {
    id: newDrawingId(),
    type,
    color: DRAWING_COLORS[type],
    lineWidth: DEFAULT_LINE_WIDTH,
    lineStyle: DEFAULT_LINE_STYLE,
    visible: true,
    locked: false,
    ...partial,
  };
}

/** Distance from point (px,py) to line segment (x1,y1)-(x2,y2), in pixels. */
export function distToSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Distance from point to infinite line through (x1,y1)-(x2,y2) */
export function distToLine(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(px - x1, py - y1);
  return Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len;
}

/** Check if point is inside rect defined by two corners */
export function pointInRect(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
  tol = 0
): boolean {
  const minX = Math.min(x1, x2) - tol;
  const maxX = Math.max(x1, x2) + tol;
  const minY = Math.min(y1, y2) - tol;
  const maxY = Math.max(y1, y2) + tol;
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/** Distance from point to rect border (for selection) */
export function distToRectBorder(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  // Distance to each edge
  const dTop = distToSegment(px, py, minX, minY, maxX, minY);
  const dBottom = distToSegment(px, py, minX, maxY, maxX, maxY);
  const dLeft = distToSegment(px, py, minX, minY, minX, maxY);
  const dRight = distToSegment(px, py, maxX, minY, maxX, maxY);
  const dBorder = Math.min(dTop, dBottom, dLeft, dRight);
  // If inside, also consider it a hit (for selection)
  if (pointInRect(px, py, x1, y1, x2, y2)) return Math.min(dBorder, 0);
  return dBorder;
}
