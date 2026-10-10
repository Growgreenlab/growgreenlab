/**
 * drawings.ts — Drawing tool model and utilities.
 * Drawings are stored as price/time coordinates (not pixels) so they
 * stay anchored during pan, zoom, and replay.
 */

export type DrawingTool = "select" | "hline" | "trendline";
export type DrawingType = "hline" | "trendline";

export interface TrendPoint {
  time: number; // ms epoch (candle timestamp)
  price: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  /** For hline: the price level. */
  price?: number;
  /** For trendline: two anchor points. */
  p1?: TrendPoint;
  p2?: TrendPoint;
  color: string;
}

let idCounter = 0;
export function newDrawingId(): string {
  idCounter += 1;
  return `d${Date.now().toString(36)}${idCounter}`;
}

export const DRAWING_COLORS: Record<DrawingType, string> = {
  hline: "#f59e0b", // amber for S/R levels
  trendline: "#38bdf8", // sky blue for trendlines
};

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
