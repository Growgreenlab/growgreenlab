/**
 * drawings.ts — Professional drawing model.
 * All drawings use market coordinates (time ms + price), never pixels,
 * so they stay anchored during pan, zoom, replay, and resize.
 */

/**
 * Drawing interaction state machine.
 * Only ONE of these states is active at any moment.
 */
export type DrawingInteractionState =
  | "IDLE"                    // No tool active, no selection, no drawing in progress
  | "TOOL_SELECTED"           // A drawing tool is active, waiting for first click
  | "DRAWING_FIRST_ANCHOR"    // First anchor placed, waiting for second click (with preview)
  | "OBJECT_SELECTED"         // A drawing is selected, showing handles
  | "OBJECT_DRAGGING"         // Dragging a selected drawing's body
  | "ANCHOR_DRAGGING"         // Dragging a drawing's endpoint handle
  | "TEXT_EDITING";           // Editing text annotation

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

/**
 * Which endpoint handle (if any) of a two-point drawing is at pixel (x,y)?
 * Returns "p1" / "p2" when the point is strictly within tol px of that
 * endpoint, else null. Only trendline / arrow / extended / rect have
 * draggable endpoint handles; every other type returns null.
 * Single source of truth for anchor classification — used by pointerdown
 * drag-mode selection AND by hover cursor feedback, so the two can never
 * disagree about what counts as "on a handle".
 */
export function anchorHitZone(
  d: Drawing,
  x: number, y: number,
  timeToX: (t: number) => number | null,
  priceToY: (p: number) => number | null,
  tol: number
): "p1" | "p2" | null {
  if (
    (d.type !== "trendline" && d.type !== "arrow" &&
     d.type !== "extended" && d.type !== "rect") ||
    !d.p1 || !d.p2
  ) return null;
  const x1 = timeToX(d.p1.time); const y1 = priceToY(d.p1.price);
  if (x1 != null && y1 != null && Math.hypot(x - x1, y - y1) < tol) return "p1";
  const x2 = timeToX(d.p2.time); const y2 = priceToY(d.p2.price);
  if (x2 != null && y2 != null && Math.hypot(x - x2, y - y2) < tol) return "p2";
  return null;
}

/**
 * Webull-style cursor for drawing interaction:
 * - while any drawing drag is in progress → "grabbing" (forced for the
 *   whole drag so fast pointer movement doesn't flicker back),
 * - hovering an endpoint handle of the selected drawing → "move"
 *   (matches the handle affordance the layer renders),
 * - hovering a draggable drawing's body → "grab",
 * - otherwise null (caller falls back to its own default, e.g. the
 *   SL/TP ns-resize hover or the plain chart cursor).
 */
export function drawingCursor(args: {
  dragging: boolean;
  zone: "p1" | "p2" | "body" | null;
}): "grabbing" | "move" | "grab" | null {
  if (args.dragging) return "grabbing";
  if (args.zone === "p1" || args.zone === "p2") return "move";
  if (args.zone === "body") return "grab";
  return null;
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
