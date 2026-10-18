/**
 * LwcChart — Lightweight Charts prototype (Phase 1 + replay integration).
 *
 * - Historical candles via setData() on dataset changes only.
 * - Tick-by-tick forming-candle updates via series.update() (efficient).
 * - Countdown pill driven by the parent's deadline-based clock.
 * - Native LWC pan/zoom/price-scale. Exists alongside CandleChart.tsx.
 */
"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesPrimitive,
  type IPrimitivePaneView,
  type IPrimitivePaneRenderer,
  type SeriesAttachedParameter,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Candle } from "../lib/types";
import { planBarPush, type BarPushState, type BarPushPlan } from "../lib/chartPush";
import {
  CANDLE_SCALE_MARGINS,
  VOLUME_SCALE_MARGINS,
  readableWindow,
  initialActiveWindow,
  paddedPriceRange,
  expandPriceRange,
  priceRangesClose,
  visibleFinalizedExtremes,
  type PriceRange,
  type LogicalRange,
} from "../lib/chartFit";
import { resolveHighlightBar, type HighlightDisplayBar } from "../lib/dailyReplay";
import { diag } from "../lib/diag";
import { normalizePrice, formatPrice } from "../lib/price";
import type { Drawing, DrawingTool, DrawingType, DrawingInteractionState } from "../lib/drawings";
import { createDrawing, anchorHitZone, drawingCursor } from "../lib/drawings";
import DrawingToolbar from "./DrawingToolbar";
import DrawingLayer, { hitTestAll, hitTolerance } from "./DrawingLayer";

const UP = "#2ebd85";
const DOWN = "#f6465d";
const UP_VOL = "rgba(46,189,133,0.45)";
const DOWN_VOL = "rgba(246,70,93,0.45)";

/* ---------- Single-candle highlight (optional; Daily Replay) ----------
 * A series primitive marking exactly one candle two ways:
 *  1. a faint translucent emerald band behind that candle's time slot
 *     (pane background, z-order bottom) as time-slot context;
 *  2. a GLOW outline hugging the displayed candle itself (foreground,
 *     z-order top): a bright emerald rounded-rect stroke, expanded
 *     ~2px past the bar's [high..low] extent and its body-slot width,
 *     drawn with a canvas shadow in the same emerald so the candle
 *     visibly glows. The stroke only touches the candle's border
 *     region — body and wick stay fully visible.
 * The outlined bar is the DISPLAYED bar containing the target time
 * (lib/dailyReplay's resolveHighlightBar): on a 1-minute view that is
 * the target candle itself; on an aggregated timeframe it is the
 * visible aggregated candle the target minute falls inside.
 * All geometry is recomputed from TIMES and PRICES via the chart's
 * time scale and the series' price scale on every draw — no pixel
 * state — so both marks stay glued to their candle across pan/zoom,
 * and neither touches axes or scales. The primitive exists only while
 * a parent passes a highlight target — every other parent is
 * completely unaffected. */
const HIGHLIGHT_FILL = "rgba(46,189,133,0.07)";
const HIGHLIGHT_GLOW = "#2ebd85"; // the chart's UP emerald
const HIGHLIGHT_GLOW_BLUR = 14;
const HIGHLIGHT_GLOW_WIDTH = 2;
const HIGHLIGHT_EXPAND_PX = 2;

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

class CandleHighlightPrimitive implements ISeriesPrimitive {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Candlestick"> | null = null;
  private requestUpdate: (() => void) | null = null;
  private timeSec: number | null = null;
  private spanSec = 60;
  private bars: HighlightDisplayBar[] = [];
  private readonly views: IPrimitivePaneView[];

  constructor() {
    const bandRenderer: IPrimitivePaneRenderer = {
      draw: () => {
        /* painted in the background pass instead */
      },
      drawBackground: (target) => this.paintBand(target),
    };
    const glowRenderer: IPrimitivePaneRenderer = {
      draw: (target) => this.paintGlow(target),
    };
    this.views = [
      { zOrder: () => "bottom", renderer: () => bandRenderer },
      { zOrder: () => "top", renderer: () => glowRenderer },
    ];
  }

  attached(param: SeriesAttachedParameter) {
    this.chart = param.chart;
    this.series = param.series as ISeriesApi<"Candlestick">;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return this.views;
  }

  setTarget(timeSec: number | null, spanSec: number) {
    this.timeSec = timeSec;
    this.spanSec = spanSec > 0 ? spanSec : 60;
    this.requestUpdate?.();
  }

  /** The bars currently on the series (post-aggregation), for
   *  resolving which displayed candle the glow outline hugs. */
  setBars(bars: HighlightDisplayBar[]) {
    this.bars = bars;
    this.requestUpdate?.();
  }

  private paintBand(target: CanvasRenderingTarget2D) {
    const chart = this.chart;
    const t0 = this.timeSec;
    if (!chart || t0 == null) return;
    const ts = chart.timeScale();
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const x1: number | null = ts.timeToCoordinate(t0 as UTCTimestamp);
      if (x1 == null) return; // band's candle is off-screen
      let x2: number | null = ts.timeToCoordinate((t0 + this.spanSec) as UTCTimestamp);
      if (x2 == null) {
        // Band end is past the last bar (highlighting the final
        // candle): estimate one bar's width from the visible logical
        // range so the band still spans exactly one slot.
        const range = ts.getVisibleLogicalRange();
        if (!range || range.to <= range.from) return;
        x2 = x1 + mediaSize.width / (range.to - range.from);
      }
      if (x2 == null || x2 <= x1) return;
      context.fillStyle = HIGHLIGHT_FILL;
      context.fillRect(x1, 0, x2 - x1, mediaSize.height);
    });
  }

  private paintGlow(target: CanvasRenderingTarget2D) {
    const chart = this.chart;
    const series = this.series;
    const t0 = this.timeSec;
    if (!chart || !series || t0 == null) return;
    const bar = resolveHighlightBar(this.bars, t0);
    if (!bar) return; // no displayed bar contains the target time
    const ts = chart.timeScale();
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const xCenter: number | null = ts.timeToCoordinate(bar.barTime as UTCTimestamp);
      if (xCenter == null) return; // the bar is off-screen
      let xNext: number | null = ts.timeToCoordinate((bar.barTime + bar.spanSec) as UTCTimestamp);
      if (xNext == null) {
        // Bar end is past the last bar: estimate one bar's spacing
        // from the visible logical range, as the band does.
        const range = ts.getVisibleLogicalRange();
        if (!range || range.to <= range.from) return;
        xNext = xCenter + mediaSize.width / (range.to - range.from);
      }
      const spacing = xNext - xCenter;
      if (!(spacing > 0)) return;
      const yHigh = series.priceToCoordinate(bar.high);
      const yLow = series.priceToCoordinate(bar.low);
      if (yHigh == null || yLow == null) return;
      // Horizontal expansion past the body slot: ~2px, capped at 40%
      // of the bar spacing per side so narrow mobile slots keep the
      // outline from swallowing neighboring candles.
      const expandX = Math.min(HIGHLIGHT_EXPAND_PX, spacing * 0.4);
      const left = xCenter - spacing / 2 - expandX;
      const width = spacing + expandX * 2;
      const top = Math.min(yHigh, yLow) - HIGHLIGHT_EXPAND_PX;
      const height = Math.abs(yLow - yHigh) + HIGHLIGHT_EXPAND_PX * 2;
      context.save();
      context.beginPath();
      roundedRectPath(context, left, top, width, height, 4);
      context.strokeStyle = HIGHLIGHT_GLOW;
      context.lineWidth = HIGHLIGHT_GLOW_WIDTH;
      context.shadowColor = HIGHLIGHT_GLOW;
      context.shadowBlur = HIGHLIGHT_GLOW_BLUR;
      // Two passes: the second stroke deepens the shadow glow so the
      // outline stays unmistakable at phone widths.
      context.stroke();
      context.stroke();
      context.restore();
    });
  }
}

interface BracketLevels {
  plannedSL: number | null;
  plannedTP: number | null;
  activeSL: number | null;
  activeTP: number | null;
}

/**
 * A labeled horizontal reference level on the chart (e.g. HOD).
 * Extensible: future strategies can pass Premarket High, Opening Range
 * High, Consolidation Resistance, etc. as additional entries.
 */
export interface ChartReferenceLevel {
  price: number;
  label: string;
  color: string;
}

interface Props {
  candles: Candle[];
  revealedCount: number;
  sessionKey: string;
  countdown: string | null;
  lastPrice: number;
  brackets: BracketLevels;
  /** Optional reference levels (HOD etc.). Omit = no lines (replay page). */
  referenceLevels?: ChartReferenceLevel[];
  /** If true, fit the time scale to content on initial data load (drills). */
  fitOnLoad?: boolean;
  /** Optional (Daily Replay preview): index of the candle the initial
   *  fit must keep visible — the selected starting candle. Passing it
   *  opts into the narrow-screen readable window (lib/chartFit): when
   *  a full fit would squeeze bars below readable spacing on a phone,
   *  the initial view opens on a window containing this index
   *  (session start when the index is the opening candle) instead of
   *  the whole session at sub-pixel spacing. Omit = fitContent
   *  exactly as before (drills, every existing parent). Read at
   *  full-load time only; later selection changes never re-window. */
  fitAnchorIndex?: number;
  /** Optional (Daily Replay): render a "Fit all" pill, bottom-left
   *  above the time axis, that fits the whole (revealed) dataset on
   *  tap — the way back from the readable window or any zoom.
   *  Omit = no control (drills, standard Trade Lab). */
  showFitAll?: boolean;
  /** Optional (Daily Replay active/done only): viewport stability
   *  during tick-by-tick playback. Library autoscale re-derives the
   *  price range from the visible bars on every tick — including the
   *  forming candle's evolving extremes — and the price axis width is
   *  recomputed from live label text; together they made finalized
   *  candles jump vertically and slide horizontally mid-candle on
   *  phones (the chart "shake"). With this on:
   *   - candle-scale autoscale is OFF; the price window is managed
   *     (lib/chartFit): recomputed once per candle from the visible
   *     finalized extremes with the usual margins, and within a
   *     candle it may only WIDEN — monotonically, only when price
   *     genuinely exits it — so price never clips and never jitters;
   *   - the volume overlay scale's axis is hidden AND its series'
   *     last-value tag is switched off (the tag renders on the axis
   *     even with the scale hidden, and its text grows from "0" to
   *     e.g. "18.47K" as the forming candle's volume accumulates —
   *     the axis widened to fit it mid-candle; the volume bars
   *     still render in their strip);
   *   - the price axis gets a minimum width just above its measured
   *     width at the first managed push, so residual label-width
   *     variance can't resize the plot and re-derive the visible
   *     time range mid-candle;
   *   - a manual axis drag takes ownership of the range: the
   *     manager's AUTOMATIC recomputes then only widen on genuine
   *     exits, until the next full load, Fit-all tap, or TIME-scale
   *     gesture settle;
   *   - when the user zooms/pans the TIME scale, the window refits
   *     ONCE when the gesture settles (pointer-up / wheel-idle),
   *     recomputed from the newly visible extremes, and the settle
   *     re-takes ownership even after a manual axis adjustment —
   *     otherwise a pinch into a quiet stretch left the wide
   *     pre-zoom window standing (candles squashed in a thin band)
   *     until the next candle boundary, or indefinitely while
   *     paused, and a stray axis adjustment poisoned every later
   *     settle the same way. Playback itself never triggers a
   *     refit: within-candle changes remain widen-only.
   *  Omit/false = library autoscale exactly as before (drills,
   *  standard Trade Lab, the Daily Replay preview). */
  stableScale?: boolean;
  /** Optional: notified with the clicked candle's time (seconds) on chart
   *  click. Used by Daily Replay's full-day preview to pick the starting
   *  candle. Omit = no behavior (all existing parents). */
  onCandleClick?: (timeSec: number) => void;
  /** Optional (Daily Replay trade drafts): a capture handle the parent
   *  owns. On chart creation the chart assigns `current` a function
   *  returning `chart.takeScreenshot()` (null on any failure), and
   *  clears it again on teardown — so the parent can snapshot the
   *  chart exactly as rendered at an entry/exit fill. Purely additive:
   *  parents that never pass it (all existing ones) are unaffected,
   *  and nothing about rendering, data, scales or events changes. */
  captureHandleRef?: MutableRefObject<(() => HTMLCanvasElement | null) | null>;
  /** Optional (Daily Replay preview): notified on every visible
   *  logical-range change with the range and the bar spacing derived
   *  from it (plot width / range span). The parent records the latest
   *  spacing so the workspace chart that replaces this one at lock
   *  time can preserve the user's candle size via `initialView`.
   *  Omit = no subscription, no behavior (all other parents). */
  onViewChange?: (view: { spacingPx: number; from: number; to: number }) => void;
  /** Optional (Daily Replay workspace): the initial visible window
   *  for this mount's first full data load under a new `viewKey`
   *  (the attempt id). Without it, a fresh chart falls back to the
   *  library default view — 6px/bar, right-anchored, extending into
   *  whitespace before the first bar whenever the revealed prefix is
   *  narrower than the plot — discarding the framing and candle size
   *  the user had in the preview at lock time. With it, the first
   *  full load opens on lib/chartFit's initialActiveWindow: the
   *  preview's bar spacing preserved (floored at readable spacing),
   *  the window ending at the forming candle (always the last pushed
   *  bar for this parent) for deep locks and starting at the session
   *  start for early ones. Applied at most once per viewKey, so
   *  timeframe switches (same attempt, new session key) and later
   *  full loads keep the user's own zoom. Omit = library default
   *  exactly as before (drills, standard Trade Lab, DR resume). */
  initialView?: { targetSpacingPx: number; viewKey: string };
  /** Optional: epoch-seconds timestamp of ONE candle to mark (Daily
   *  Replay's selected/locked starting candle): a faint emerald band
   *  behind its time slot plus a glowing emerald outline hugging the
   *  displayed candle containing that time. Omit or null = no
   *  highlight (all existing parents). Purely presentational — never
   *  affects data or scales. */
  highlightTimeSec?: number | null;
  /** Highlight band width in seconds (one candle interval, from
   *  lib/dailyReplay's highlightBandFor). Defaults to 60. */
  highlightSpanSec?: number;
  onPlannedDrag: (sl: number | null, tp: number | null) => void;
  onActiveDrag: (sl: number | null, tp: number | null) => void;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  drawingTool: DrawingTool;
  onDrawingToolChange: (tool: DrawingTool) => void;
}

export default function LwcChart({ candles, revealedCount, sessionKey, countdown, lastPrice, brackets, referenceLevels, fitOnLoad, fitAnchorIndex, showFitAll, stableScale, onCandleClick, captureHandleRef, onViewChange, initialView, highlightTimeSec, highlightSpanSec, onPlannedDrag, onActiveDrag, drawings, onDrawingsChange, drawingTool, onDrawingToolChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  // Tracks what we've pushed so we can use update() instead of setData().
  const pushedRef = useRef<BarPushState | null>(null);
  // Bracket price lines: planned (dashed) vs active (solid, engine-linked).
  const plannedSLRef = useRef<IPriceLine | null>(null);
  const plannedTPRef = useRef<IPriceLine | null>(null);
  const activeSLRef = useRef<IPriceLine | null>(null);
  const activeTPRef = useRef<IPriceLine | null>(null);
  // Drag state: which line is being dragged.
  const dragRef = useRef<{ kind: "plannedSL" | "plannedTP" | "activeSL" | "activeTP" } | null>(null);
  // Latest brackets for use in pointer handlers (avoids stale closures).
  const bracketsRef = useRef(brackets);
  bracketsRef.current = brackets;
  // Latest candle-click callback (read inside the chart-creation effect,
  // which runs once — a ref keeps inline parent closures safe).
  const onCandleClickRef = useRef(onCandleClick);
  onCandleClickRef.current = onCandleClick;
  // Latest capture-handle ref (read inside the chart-creation effect,
  // which runs once — a ref keeps inline parent refs safe, mirroring
  // onCandleClickRef above).
  const captureHandleRefRef = useRef(captureHandleRef);
  captureHandleRefRef.current = captureHandleRef;
  // Latest fit anchor (read inside the data-push effect at full-load
  // time only — a ref keeps later selection changes from re-windowing).
  const fitAnchorIndexRef = useRef(fitAnchorIndex);
  fitAnchorIndexRef.current = fitAnchorIndex;
  // Latest view-change callback (read inside the chart-creation
  // effect's range subscription, which is installed once).
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  // Latest initial-view request (Daily Replay workspace) + the viewKey
  // it was last applied for: applied at most once per key, on a full
  // data load, so later loads under the same attempt (timeframe
  // switches) never reset the user's zoom.
  const initialViewRef = useRef(initialView);
  initialViewRef.current = initialView;
  const initialViewAppliedKeyRef = useRef<string | null>(null);
  // Stable-scale (Daily Replay) state: read through refs inside the
  // data-push effect (which re-runs on every parent bump) so the
  // manager never depends on effect ordering or stale closures.
  const stableScaleRef = useRef(stableScale);
  stableScaleRef.current = stableScale;
  const revealedCountRef = useRef(revealedCount);
  revealedCountRef.current = revealedCount;
  // The last price window the manager itself set (null = not managing
  // yet / just reset). Compared against the live range on each candle
  // boundary: a mismatch means the user dragged the axis and owns the
  // range until the next full load or Fit-all tap.
  const scaleWinRef = useRef<{ lastSet: PriceRange | null }>({ lastSet: null });
  // Whether the price-axis minimum-width floor has been applied for
  // this stable-scale activation (applied at the first managed push,
  // when the axis has real labels to measure — at activation time the
  // scale may still report width 0).
  const axisFloorRef = useRef(false);
  // Whether stable-scale mode has ever been entered on this mount —
  // keeps the activation effect a literal no-op for parents that
  // never opt in (drills, standard Trade Lab, DR preview).
  const stableActiveRef = useRef(false);
  // Drawing state.
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const toolRef = useRef(drawingTool);
  toolRef.current = drawingTool;
  // Pending first point for two-click tools; drag state for drawings.
  const pendingTrendRef = useRef<{ time: number; price: number; tool: DrawingTool } | null>(null);
  const [pendingPoint, setPendingPoint] = useState<{ time: number; price: number; tool: DrawingTool } | null>(null);
  // Live preview endpoint for two-click tools (updates on pointermove).
  const [previewPoint, setPreviewPoint] = useState<{ time: number; price: number } | null>(null);
  // Candles ref for time-snapping in drawingCoords (avoids stale closures).
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  /* ---- Stable-scale window management (Daily Replay only) ----
   * applyStableWindow is THE managed-window recompute, shared by the
   * candle-boundary path in the data-push effect and the gesture-settle
   * refit below: when the manager owns the range it refits FRESH from
   * the currently VISIBLE finalized extremes (lib/chartFit
   * visibleFinalizedExtremes) folded with the forming bar's printed
   * extremes, padded by paddedPriceRange — so the window (and its
   * padding) always derives from what is on screen, never from the
   * whole session. When the user has dragged the price axis (the live
   * range no longer matches what the manager last set) the AUTOMATIC
   * recomputes (candle boundaries, intra-candle updates) limit
   * themselves to anti-clip widening — the user's axis stays theirs.
   *
   * A TIME-scale gesture settle is different (opts.fromTimeGesture):
   * the user has just deliberately reframed WHICH candles are on
   * screen, so the settle ALWAYS refits fresh to the newly visible
   * extremes and re-takes ownership — axis ownership governs the
   * manager's automatic behavior, never the user's own time gestures.
   * Without this distinction, a single price-axis adjustment (a drag
   * on the ~57px axis strip beside the forming candle, an axis wheel
   * scroll) silently poisoned ownership for the rest of the attempt:
   * every later zoom/pan settle — and every candle boundary — took
   * the expand-only branch and the wide pre-gesture window stood
   * forever while paused, candles crushed in a thin band (measured:
   * axis drag, then wheel-zoom to 15 bars — apply ran with
   * owned=false and the 0.35-wide window never refit to the 0.07 the
   * visible bars needed). The axis drag's OWN settle never reaches
   * this path — the settle gates on the TIME range having changed,
   * and an axis drag doesn't move it — so a manual axis adjustment
   * is still never overridden by its own gesture, and boundaries
   * keep respecting it until the next time gesture or Fit-all.
   * Reads only refs, so it is safe from effects and event handlers. */
  const applyStableWindow = (opts?: { fromTimeGesture?: boolean }) => {
    const chart = chartRef.current;
    const cs = candleSeriesRef.current;
    if (!chart || !cs || !stableScaleRef.current) return;
    const arr = candlesRef.current;
    const n = Math.max(0, Math.min(revealedCountRef.current, arr.length));
    if (n === 0) return;
    try {
      const ps = cs.priceScale();
      const forming = arr[n - 1];
      const vlr = chart.timeScale().getVisibleLogicalRange();
      const ext = visibleFinalizedExtremes(
        arr,
        n,
        vlr?.from ?? null,
        vlr?.to ?? null,
      );
      const cur = ps.getVisibleRange();
      const owned =
        opts?.fromTimeGesture === true ||
        scaleWinRef.current.lastSet === null ||
        (cur !== null && priceRangesClose(cur, scaleWinRef.current.lastSet));
      if (owned) {
        const win = paddedPriceRange(
          ext ? Math.min(ext.lo, forming.l) : forming.l,
          ext ? Math.max(ext.hi, forming.h) : forming.h,
        );
        ps.setVisibleRange(win);
        scaleWinRef.current.lastSet = win;
      } else if (cur) {
        const win = expandPriceRange(cur, forming.l, forming.h);
        if (!priceRangesClose(win, cur)) {
          ps.setVisibleRange(win);
          scaleWinRef.current.lastSet = win;
        }
      }
    } catch {
      /* scale management must never break the data path */
    }
  };

  /* Settle refit (stable-scale only): the boundary recompute keeps the
   * window fitted to the visible bars as candles roll, but it cannot
   * see a USER zooming/panning the TIME scale mid-candle — and before
   * the managed scale existed, library autoscale refit the instant the
   * visible set changed, so candles always filled the pane after a
   * zoom. Without a reaction, a pinch into a quiet stretch leaves the
   * wide pre-zoom window standing (candles squashed in a thin band)
   * until the next candle boundary — or indefinitely while paused.
   * So: snapshot the visible logical range when a pointer gesture
   * starts on the chart wrapper; when the last pointer lifts (+250ms
   * settle), refit ONCE via applyStableWindow — but only if the time
   * range actually changed, which keeps plain clicks, drawing drags,
   * and price-axis drags (none of which move the time range) from
   * ever triggering it. Wheel bursts are debounced (300ms idle) into
   * one refit, gated by a snapshot taken at the burst's first event:
   * the refit re-takes ownership only when the TIME range actually
   * moved during the burst; a burst that left it unmoved (a wheel
   * scroll over the price axis scales the axis instead) gets the
   * standard ownership-respecting recompute, so the user's axis
   * scaling stands. Both settle paths therefore distinguish a time
   * gesture from an axis adjustment precisely — the distinction the
   * ownership guard alone could not make (see applyStableWindow).
   * Programmatic range changes (Fit-all, the initial fit, the
   * library's boundary follow-shift) produce no pointer/wheel
   * events, so they can't trigger a refit either, and the refit
   * itself only writes the PRICE scale, so there is no feedback
   * loop. Playback never calls this: within-candle window changes
   * remain limited to genuine-exit widening, as shipped. */
  const gesturePtrsRef = useRef<Set<number>>(new Set());
  const gestureSnapRef = useRef<LogicalRange | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const wheelTimerRef = useRef<number | null>(null);
  // Visible range when the current wheel burst began (first event
  // after idle): at fire time it tells a TIME-zoom burst (range
  // moved — the settle may re-take ownership and refit fresh) from
  // an axis-wheel burst (range unmoved — the user's axis scaling is
  // manual ownership and the settle must respect it).
  const wheelSnapRef = useRef<LogicalRange | null>(null);
  const snapVisibleRange = (): LogicalRange | null => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return null;
    const r = ts.getVisibleLogicalRange();
    return r ? { from: r.from, to: r.to } : null;
  };
  const timeRangeChanged = (
    a: LogicalRange | null,
    b: LogicalRange | null,
  ): boolean =>
    a !== null &&
    b !== null &&
    (Math.abs(a.from - b.from) > 1e-3 || Math.abs(a.to - b.to) > 1e-3);
  const clearSettleTimers = () => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (wheelTimerRef.current !== null) {
      window.clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = null;
    }
  };
  // Wheel zoom (stable-scale only): debounce the burst; 300ms after
  // the last tick the gesture has settled and the window refits once.
  // The burst's start range is snapshotted on its first event: if the
  // TIME range moved during the burst it was a time zoom and the
  // refit re-takes ownership (applyStableWindow's fromTimeGesture);
  // if it didn't move — a wheel burst over the price axis scales the
  // axis instead — the refit keeps the standard ownership-respecting
  // behavior, so the user's axis scaling is never overridden.
  const onStableWheel = () => {
    if (!stableScaleRef.current) return;
    if (wheelTimerRef.current === null) {
      wheelSnapRef.current = snapVisibleRange();
    } else {
      window.clearTimeout(wheelTimerRef.current);
    }
    wheelTimerRef.current = window.setTimeout(() => {
      wheelTimerRef.current = null;
      const timeMoved = timeRangeChanged(wheelSnapRef.current, snapVisibleRange());
      wheelSnapRef.current = null;
      if (stableScaleRef.current) {
        applyStableWindow(timeMoved ? { fromTimeGesture: true } : undefined);
      }
    }, 300);
  };
  // AUTHORITATIVE INTERACTION STATE MACHINE (Phase 2).
  // Only one state is active at any moment. All drawing interactions
  // must check and update this state — no scattered independent flags.
  const interactionRef = useRef<DrawingInteractionState>("IDLE");
  const setInteraction = (s: DrawingInteractionState) => {
    interactionRef.current = s;
  };

  // Drawing hover/drag cursor (Webull-style grab / grabbing / move),
  // applied to the wrapper element — the same mechanism as the SL/TP
  // ns-resize hover. The SVG drawing layer is pointerEvents:none, so
  // per-element cursors can't work; the wrapper cursor is the one the
  // user sees. cursorRef avoids a style write on every pointermove.
  const cursorRef = useRef("");
  const setWrapCursor = (c: string) => {
    if (cursorRef.current === c) return;
    cursorRef.current = c;
    if (wrapRef.current) wrapRef.current.style.cursor = c;
  };

  // Wrapped tool change: cancels any in-progress drawing (Phase 2 + Phase 5).
  // When user selects another tool mid-drawing: cancel unfinished drawing,
  // clear pending anchor and preview, activate new tool. Never create
  // a drawing from the tool-selection interaction itself.
  const handleToolChange = (tool: DrawingTool) => {
    // Cancel any in-progress two-click drawing
    if (pendingTrendRef.current) {
      pendingTrendRef.current = null;
      setPendingPoint(null);
      setPreviewPoint(null);
    }
    // Cancel any drag in progress
    if (drawingDragRef.current) {
      drawingDragRef.current = null;
      enableChartNav();
      setWrapCursor("");
    }
    // Update interaction state
    if (tool === "select") {
      setInteraction(selectedDrawingId ? "OBJECT_SELECTED" : "IDLE");
    } else {
      setInteraction("TOOL_SELECTED");
    }
    onDrawingToolChange(tool);
  };
  const drawingDragRef = useRef<{
    id: string;
    mode: "move" | "p1" | "p2";
    startX: number;
    startY: number;
  } | null>(null);
  // Undo/redo history
  const historyRef = useRef<Drawing[][]>([[]]);
  const historyIdxRef = useRef(0);
  const pushHistory = (next: Drawing[]) => {
    const h = historyRef.current.slice(0, historyIdxRef.current + 1);
    h.push(next);
    if (h.length > 50) h.shift();
    historyRef.current = h;
    historyIdxRef.current = h.length - 1;
  };
  const undo = () => {
    if (historyIdxRef.current > 0) {
      historyIdxRef.current -= 1;
      const prev = historyRef.current[historyIdxRef.current];
      onDrawingsChange([...prev]);
      setSelectedDrawingId(null);
    }
  };
  const redo = () => {
    if (historyIdxRef.current < historyRef.current.length - 1) {
      historyIdxRef.current += 1;
      const next = historyRef.current[historyIdxRef.current];
      onDrawingsChange([...next]);
      setSelectedDrawingId(null);
    }
  };
  const [chartSize, setChartSize] = useState({ w: 0, h: 0 });

  // Create the chart once.
  useEffect(() => {
    const el = elRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { color: "#0b0f14" },
        textColor: "#8b98a9",
        fontFamily: "Inter, system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
        // Readability: the library default margins (0.2/0.2) squeeze the
        // session's price range into the middle 60% of the pane. These
        // margins (lib/chartFit) give it 78%, boundary-aligned with the
        // volume strip below. Mapping stays linear and exact.
        scaleMargins: CANDLE_SCALE_MARGINS,
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: number) =>
          new Date(time * 1000).toLocaleTimeString("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
      },
      localization: {
        timeFormatter: (time: number) =>
          new Date(time * 1000).toLocaleString("en-US", {
            timeZone: "America/New_York",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
      },
      // Webull-style crosshair: free-moving (Normal — the LWC default,
      // Magnet, snaps the horizontal line to the hovered bar's close and
      // shows THAT price on the axis instead of the cursor's price),
      // dashed 1px lines, axis labels on both scales.
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(255,255,255,0.35)",
          width: 1,
          style: LineStyle.Dashed,
          labelVisible: true,
          labelBackgroundColor: "#334155",
        },
        horzLine: {
          color: "rgba(255,255,255,0.35)",
          width: 1,
          style: LineStyle.Dashed,
          labelVisible: true,
          labelBackgroundColor: "#334155",
        },
      },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
    });
    chart.priceScale("").applyOptions({ scaleMargins: VOLUME_SCALE_MARGINS });
    chartRef.current = chart;
    // Optional capture handle (Daily Replay trade drafts): hand the
    // parent a screenshot function bound to THIS chart instance.
    if (captureHandleRefRef.current) {
      captureHandleRefRef.current.current = () => {
        try { return chart.takeScreenshot(); } catch { return null; }
      };
    }
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    pushedRef.current = null;

    // Optional candle-click notifications (Daily Replay preview). The
    // handler reads the callback through a ref; when no parent passes
    // one this is a no-op.
    const handleChartClick = (param: MouseEventParams) => {
      const cb = onCandleClickRef.current;
      if (cb && typeof param.time === "number") cb(param.time);
    };
    chart.subscribeClick(handleChartClick);

    // Optional visible-range reporting (Daily Replay preview): the
    // parent records the bar spacing so the workspace chart that
    // replaces this one at lock time can preserve the candle size
    // (see the initialView prop). Installed only when a parent
    // actually passed a callback at creation — every other parent
    // keeps literally zero added behavior.
    const handleViewChange = (range: LogicalRange | null) => {
      const cb = onViewChangeRef.current;
      if (!cb || !range || !(range.to > range.from)) return;
      const w = chart.timeScale().width();
      if (w > 0) {
        cb({ spacingPx: w / (range.to - range.from), from: range.from, to: range.to });
      }
    };
    const viewSubscribed = onViewChangeRef.current != null;
    if (viewSubscribed) {
      chart.timeScale().subscribeVisibleLogicalRangeChange(handleViewChange);
    }

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      setChartSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(wrap);
    setChartSize({ w: el.clientWidth, h: el.clientHeight });
    return () => {
      ro.disconnect();
      clearSettleTimers();
      chart.unsubscribeClick(handleChartClick);
      if (viewSubscribed) {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleViewChange);
      }
      chart.remove();
      if (captureHandleRefRef.current) captureHandleRefRef.current.current = null;
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Stable-scale activation (Daily Replay only; see the prop docs).
  // Runs after creation (declaration order) and whenever the parent
  // toggles the mode: entering takes the candle scale off autoscale,
  // hides the volume scale's axis labels, and floors the price axis
  // width just above its current width; leaving restores the library
  // defaults exactly, so a shared mount never leaks the mode into a
  // standard session or the drills.
  useEffect(() => {
    const chart = chartRef.current;
    const cs = candleSeriesRef.current;
    const vs = volumeSeriesRef.current;
    if (!chart || !cs) return;
    // Parents that never opt in must see literally zero calls: the
    // restore branch runs only if this mount was previously active.
    if (!stableScale && !stableActiveRef.current) return;
    if (stableScale) {
      stableActiveRef.current = true;
      cs.priceScale().setAutoScale(false);
      chart.priceScale("").applyOptions({ visible: false });
      // The volume series' last-value tag renders on the shared axis
      // even with its scale hidden, and its text grows from "0" to
      // e.g. "18.47K" as the forming candle's volume accumulates —
      // the axis widened to fit it mid-candle, resizing the plot and
      // sliding every candle (measured). Kill the tag in this mode;
      // the volume bars themselves still render.
      if (vs) vs.applyOptions({ lastValueVisible: false });
      scaleWinRef.current.lastSet = null;
      axisFloorRef.current = false;
    } else {
      stableActiveRef.current = false;
      cs.priceScale().setAutoScale(true);
      chart.priceScale("").applyOptions({ visible: true });
      if (vs) vs.applyOptions({ lastValueVisible: true });
      cs.priceScale().applyOptions({ minimumWidth: 0 });
      scaleWinRef.current.lastSet = null;
      axisFloorRef.current = false;
    }
  }, [stableScale]);

  // Sync bracket price lines (planned = dashed gray, active = solid red/green).
  // Depends on individual values, not the brackets object identity, so the
  // 50ms re-render cycle doesn't re-apply unchanged lines.
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;

    const syncLine = (
      ref: React.MutableRefObject<IPriceLine | null>,
      price: number | null,
      color: string,
      title: string,
      dashed: boolean
    ) => {
      if (price == null) {
        if (ref.current) {
          cs.removePriceLine(ref.current);
          ref.current = null;
        }
        return;
      }
      const label = `${title} ${formatPrice(price)}`;
      if (ref.current) {
        ref.current.applyOptions({ price, title: label });
      } else {
        ref.current = cs.createPriceLine({
          price,
          color,
          lineWidth: 2,
          lineStyle: dashed ? 2 : 0,
          axisLabelVisible: true,
          title: label,
        });
      }
    };

    const dragging = dragRef.current?.kind;
    if (dragging !== "plannedSL") syncLine(plannedSLRef, brackets.plannedSL, "#9ca3af", "SL (planned)", true);
    if (dragging !== "plannedTP") syncLine(plannedTPRef, brackets.plannedTP, "#9ca3af", "TP (planned)", true);
    if (dragging !== "activeSL") syncLine(activeSLRef, brackets.activeSL, "#f6465d", "SL", false);
    if (dragging !== "activeTP") syncLine(activeTPRef, brackets.activeTP, "#2ebd85", "TP", false);
  }, [brackets.plannedSL, brackets.plannedTP, brackets.activeSL, brackets.activeTP]);

  // Reference levels (HOD etc.): labeled horizontal lines, synced like brackets.
  // Uses a ref array keyed by index; levels are static per session.
  const refLevelsRef = useRef<IPriceLine[]>([]);
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;
    const levels = referenceLevels ?? [];
    // Remove stale lines beyond the current count
    while (refLevelsRef.current.length > levels.length) {
      const line = refLevelsRef.current.pop();
      if (line) cs.removePriceLine(line);
    }
    levels.forEach((lv, i) => {
      const label = `${lv.label} ${formatPrice(lv.price)}`;
      const existing = refLevelsRef.current[i];
      if (existing) {
        existing.applyOptions({ price: lv.price, title: label, color: lv.color });
      } else {
        refLevelsRef.current[i] = cs.createPriceLine({
          price: lv.price,
          color: lv.color,
          lineWidth: 2,
          lineStyle: 2, // dashed
          axisLabelVisible: true,
          title: label,
        });
      }
    });
  }, [referenceLevels, sessionKey]);

  // Push data: setData() only on dataset changes; update() per tick.
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const vs = volumeSeriesRef.current;
    if (!cs || !vs) return;
    const n = Math.max(0, Math.min(revealedCount, candles.length));
    if (n === 0) return;

    const toBar = (c: Candle) => ({
      time: Math.floor(c.t / 1000) as UTCTimestamp,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    });
    const toVol = (c: Candle) => ({
      time: Math.floor(c.t / 1000) as UTCTimestamp,
      value: c.v,
      color: c.c >= c.o ? UP_VOL : DOWN_VOL,
    });

    let plan: BarPushPlan = null;
    const prevPushed = pushedRef.current;
    try {
      // Push planning lives in lib/chartPush (pure + unit-tested). The key
      // property: when the array grows, the previously-last bar is re-pushed
      // FIRST — it was the forming candle and may have finalized mid-batch,
      // so without this its partial forming OHLCV would stay on the chart.
      plan = planBarPush(pushedRef.current, sessionKey, n);
      if (plan?.mode === "full") {
        // New session, reset, or dataset shrank: full replace.
        const bars = [];
        const vols = [];
        for (let i = 0; i < n; i++) {
          bars.push(toBar(candles[i]));
          vols.push(toVol(candles[i]));
        }
        cs.setData(bars);
        vs.setData(vols);
        // For drills: fit the viewport to the revealed data so history
        // fills the chart instead of clustering on the right.
        if (fitOnLoad && chartRef.current) {
          const ts = chartRef.current.timeScale();
          ts.fitContent();
          // Opt-in readable window (Daily Replay preview passes
          // fitAnchorIndex): on a narrow screen, a full-session fit
          // squeezes bars to sub-pixel spacing and hairline candles,
          // so open instead on a readable window that contains the
          // selected candle — the session start when the selection
          // is the opening candle. The rest of the day is one pan
          // away, and the "Fit all" pill restores the full view.
          // Parents that don't pass an anchor (drills) and desktop
          // widths keep the plain full fit above, untouched.
          const anchor = fitAnchorIndexRef.current;
          if (anchor != null) {
            const win = readableWindow({
              plotWidthPx: ts.width(),
              barCount: n,
              containerWidthPx: wrapRef.current?.clientWidth ?? 0,
              anchorIndex: anchor,
            });
            if (win) ts.setVisibleLogicalRange(win);
          }
        }
        // Opt-in initial window (Daily Replay workspace): open on a
        // window that preserves the bar spacing the user had in the
        // preview at lock time instead of the library default view
        // (6px/bar, right-anchored, extending into leading whitespace
        // whenever the revealed prefix is narrower than the plot).
        // Applied at most once per viewKey, so timeframe switches and
        // later full loads under the same attempt never reset the
        // user's own zoom. The anchor is the last pushed bar — for
        // this parent always the forming candle.
        const iv = initialViewRef.current;
        if (
          iv &&
          iv.viewKey !== initialViewAppliedKeyRef.current &&
          chartRef.current
        ) {
          const ts = chartRef.current.timeScale();
          const win = initialActiveWindow({
            plotWidthPx: ts.width(),
            barCount: n,
            anchorIndex: n - 1,
            targetSpacingPx: iv.targetSpacingPx,
          });
          if (win) {
            ts.setVisibleLogicalRange(win);
            initialViewAppliedKeyRef.current = iv.viewKey;
          }
        }
        pushedRef.current = plan.state;
      } else if (plan) {
        // Incremental: re-push from plan.from (the possibly-just-finalized
        // previous bar, or only the forming bar when length is unchanged),
        // then any appended bars. update() replaces same-time bars.
        for (let i = plan.from; i < plan.n; i++) {
          cs.update(toBar(candles[i]));
          vs.update(toVol(candles[i]));
        }
        pushedRef.current = plan.state;
      }
      // Diagnostics: track chart update health.
      diag.chartUpdates++;
      diag.lastChartUpdate = performance.now();
      const lastC = candles[n - 1];
      const tSec = Math.floor(lastC.t / 1000);
      if (diag.lastUpdateTimeSec !== null && tSec < diag.lastUpdateTimeSec) {
        diag.timestampViolations++;
      }
      diag.lastUpdateTimeSec = tSec;
      const ohlc = `${lastC.o}|${lastC.h}|${lastC.l}|${lastC.c}`;
      if (diag.lastOhlc !== ohlc) {
        diag.ohlcChanges++;
        diag.lastOhlc = ohlc;
      }
    } catch (e) {
      diag.errors.push(e instanceof Error ? e.message : String(e));
    }

    // Stable-scale management (Daily Replay only; see the prop docs).
    // Runs after the push, on the same effect cycle, so the window is
    // set before the browser paints the new bar: full loads and candle
    // boundaries recompute the window from the VISIBLE FINALIZED
    // extremes (plus the forming bar's already-printed extremes);
    // intra-candle updates only widen it on a genuine exit. A live
    // range that no longer matches what the manager last set means
    // the user dragged the axis — they own it, and the manager limits
    // itself to anti-clip widening until the next recompute trigger.
    if (stableScaleRef.current && chartRef.current && plan) {
      try {
        const ps = cs.priceScale();
        // Floor the axis width once, now that real labels exist:
        // any residual label-width variance then can't resize the
        // plot (and re-derive the visible time range) mid-candle.
        if (!axisFloorRef.current) {
          const w = ps.width();
          if (w > 0) {
            ps.applyOptions({ minimumWidth: w + 2 });
            axisFloorRef.current = true;
          }
        }
        const forming = candles[n - 1];
        const appended = plan.mode === "updates" && plan.state.n > (prevPushed?.n ?? 0);
        if (plan.mode === "full" || appended) {
          // Candle boundary (or full load): fresh refit from the
          // visible finalized extremes — shared with the gesture-settle
          // refit (applyStableWindow reads the same refs/props this
          // effect just pushed: candlesRef/revealedCountRef are already
          // current for this render).
          applyStableWindow();
        } else {
          const cur = ps.getVisibleRange();
          if (cur) {
            const win = expandPriceRange(cur, forming.l, forming.h);
            if (!priceRangesClose(win, cur)) {
              ps.setVisibleRange(win);
              scaleWinRef.current.lastSet = win;
            }
          }
        }
      } catch {
        /* scale management must never break the data path */
      }
    }

    // Position the countdown pill under the last-price tag.
    const pill = countdownRef.current;
    if (pill) {
      if (countdown) {
        const y = cs.priceToCoordinate(lastPrice);
        if (y !== null) {
          pill.style.display = "block";
          pill.style.top = `${y + 22}px`;
        } else {
          pill.style.display = "none";
        }
      } else {
        pill.style.display = "none";
      }
    }
  }, [candles, revealedCount, sessionKey, countdown, lastPrice]);

  // Single-candle highlight primitive (Daily Replay only): attach
  // lazily on first target, retarget in place while one is set, and
  // detach when the target clears — parents that never pass a target
  // never create it. The displayed bars are re-fed whenever the data
  // changes so the glow outline hugs the bar currently on screen
  // (including while the highlighted candle is still forming).
  const highlightRef = useRef<CandleHighlightPrimitive | null>(null);
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;
    if (highlightTimeSec == null) {
      if (highlightRef.current) {
        cs.detachPrimitive(highlightRef.current);
        highlightRef.current = null;
      }
      return;
    }
    if (!highlightRef.current) {
      highlightRef.current = new CandleHighlightPrimitive();
      cs.attachPrimitive(highlightRef.current);
    }
    const n = Math.max(0, Math.min(revealedCount, candles.length));
    const bars: HighlightDisplayBar[] = [];
    for (let i = 0; i < n; i++) {
      bars.push({
        timeSec: Math.floor(candles[i].t / 1000),
        high: candles[i].h,
        low: candles[i].l,
      });
    }
    highlightRef.current.setTarget(highlightTimeSec, highlightSpanSec ?? 60);
    highlightRef.current.setBars(bars);
  }, [highlightTimeSec, highlightSpanSec, candles, revealedCount]);

  // Bracket line dragging: hit-test on pointerdown, drag the price line,
  // commit on pointerup. Disables chart pan/zoom while a line is dragged.
  const getLineY = (price: number | null): number | null => {
    const cs = candleSeriesRef.current;
    if (cs == null || price == null) return null;
    return cs.priceToCoordinate(price);
  };

  const hitTestBracket = (y: number): "plannedSL" | "plannedTP" | "activeSL" | "activeTP" | null => {
    const b = bracketsRef.current;
    const TOL = 16; // px — generous for high-DPI screens
    const candidates: Array<[string, number | null]> = [
      ["activeSL", b.activeSL],
      ["activeTP", b.activeTP],
      ["plannedSL", b.plannedSL],
      ["plannedTP", b.plannedTP],
    ];
    for (const [kind, price] of candidates) {
      const lineY = getLineY(price);
      if (lineY != null && Math.abs(lineY - y) <= TOL) {
        return kind as "plannedSL" | "plannedTP" | "activeSL" | "activeTP";
      }
    }
    return null;
  };

  // Hover feedback: grab cursor over a draggable drawing (Select mode —
  // the only mode where a drag can start), ns-resize over a draggable
  // SL/TP line. Drawings win over bracket lines, the same precedence as
  // the pointerdown hit-testing below. The drawing hit test is the exact
  // one a click uses (hitTestAll, 8px mouse / 16px touch tolerance), so
  // the grab zone is identical to the drag zone — and much wider than
  // the 1.5px visible line.
  const onPointerMoveHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current || drawingDragRef.current) return; // a drag owns the cursor
    const el = elRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (toolRef.current === "select") {
      const dc = drawingCoords();
      if (dc) {
        const toX = (t: number) => dc.toX(t);
        const toY = (p: number) => dc.toY(p);
        const hits = hitTestAll(drawingsRef.current, x, y, toX, toY);
        if (hits.length > 0) {
          const top = hits[0];
          // Endpoint handles exist only on the selected drawing.
          const zone = top.id === selectedDrawingId
            ? anchorHitZone(top, x, y, toX, toY, hitTolerance()) ?? "body"
            : "body";
          setWrapCursor(drawingCursor({ dragging: false, zone }) ?? "");
          return;
        }
      }
    }
    const hit = hitTestBracket(y);
    setWrapCursor(hit ? "ns-resize" : "");
  };

  // Drawing coordinate helpers. All coordinates are element-relative
  // (relative to the chart div), matching e.clientX - rect.left.
  // Phase 3: Centralized coordinate adapter (single source of truth).
  // All drawing interactions — creation, preview, selection, dragging,
  // anchor editing, labels, hit-testing — use these conversions.
  // Pointer coordinates are measured relative to the chart element's
  // bounding rect (not viewport), matching e.clientX - rect.left.
  const drawingCoords = () => {
    const chart = chartRef.current;
    const cs = candleSeriesRef.current;
    const el = elRef.current;
    if (!chart || !cs || !el) return null;
    const rect = el.getBoundingClientRect();
    return {
      chart, cs, rect,
      toPrice: (y: number) => cs.coordinateToPrice(y),
      toTime: (x: number) => {
        const t = chart.timeScale().coordinateToTime(x);
        if (t == null) return null;
        const timeMs = Number(t) * 1000;
        // Snap to nearest candle timestamp for reliable timeToCoordinate.
        // Uses binary search (O(log n)) instead of linear scan.
        const arr = candlesRef.current;
        if (arr.length === 0) return timeMs;
        let lo = 0, hi = arr.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (arr[mid].t < timeMs) lo = mid + 1;
          else hi = mid;
        }
        // lo is the insertion point; check neighbors for closest
        let best = arr[lo].t;
        let bestDiff = Math.abs(best - timeMs);
        if (lo > 0) {
          const diff = Math.abs(arr[lo - 1].t - timeMs);
          if (diff < bestDiff) { bestDiff = diff; best = arr[lo - 1].t; }
        }
        if (lo + 1 < arr.length) {
          const diff = Math.abs(arr[lo + 1].t - timeMs);
          if (diff < bestDiff) best = arr[lo + 1].t;
        }
        return best;
      },
      toY: (price: number) => cs.priceToCoordinate(price),
      toX: (timeMs: number) => chart.timeScale().timeToCoordinate(Math.floor(timeMs / 1000) as UTCTimestamp),
    };
  };

  const disableChartNav = () => {
    const chart = chartRef.current;
    if (chart) chart.applyOptions({ handleScroll: false, handleScale: false });
    if (wrapRef.current) wrapRef.current.style.touchAction = "none";
  };
  const enableChartNav = () => {
    const chart = chartRef.current;
    if (chart) chart.applyOptions({ handleScroll: true, handleScale: true });
    if (wrapRef.current) wrapRef.current.style.touchAction = "";
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const chart = chartRef.current;
    const el = elRef.current;
    if (!chart || !el) return;
    // Settle-refit tracking (stable-scale only; see the manager block):
    // snapshot the time range when the FIRST pointer of a gesture
    // lands, before any drawing logic below can return early.
    if (stableScaleRef.current) {
      if (gesturePtrsRef.current.size === 0) {
        gestureSnapRef.current = snapVisibleRange();
      }
      gesturePtrsRef.current.add(e.pointerId);
    }
    const dc = drawingCoords();
    if (!dc) return;
    const rect = dc.rect;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const tool = toolRef.current;

    // Helper to get clean market coords
    const getCoords = () => {
      const price = dc.toPrice(y);
      const time = dc.toTime(x);
      if (price == null || !isFinite(price) || price <= 0 || time == null) return null;
      return { time, price: normalizePrice(price) };
    };

    // Single-click placement tools
    if (tool === "hline") {
      e.preventDefault(); e.stopPropagation();
      const price = dc.toPrice(y);
      if (price != null && isFinite(price) && price > 0) {
        const d = createDrawing("hline", { price: normalizePrice(price) });
        const next = [...drawingsRef.current, d];
        onDrawingsChange(next);
        setSelectedDrawingId(d.id);
        pushHistory(next);
        setInteraction("OBJECT_SELECTED");
        handleToolChange("select");
      }
      return;
    }
    if (tool === "vline") {
      e.preventDefault(); e.stopPropagation();
      const c = getCoords();
      if (!c) return;
      const d = createDrawing("vline", { time: c.time, p1: { time: c.time, price: c.price } });
      const next = [...drawingsRef.current, d];
      onDrawingsChange(next);
      setSelectedDrawingId(d.id);
      pushHistory(next);
      setInteraction("OBJECT_SELECTED");
      handleToolChange("select");
      return;
    }
    if (tool === "hray") {
      e.preventDefault(); e.stopPropagation();
      const c = getCoords();
      if (!c) return;
      const d = createDrawing("hray", { p1: { time: c.time, price: c.price } });
      const next = [...drawingsRef.current, d];
      onDrawingsChange(next);
      setSelectedDrawingId(d.id);
      pushHistory(next);
      setInteraction("OBJECT_SELECTED");
      handleToolChange("select");
      return;
    }
    if (tool === "text") {
      e.preventDefault(); e.stopPropagation();
      const c = getCoords();
      if (!c) return;
      const text = prompt("Enter text:", "");
      if (text == null || text.trim() === "") return;
      const d = createDrawing("text", {
        p1: { time: c.time, price: c.price },
        text: text.trim(),
      });
      const next = [...drawingsRef.current, d];
      onDrawingsChange(next);
      setSelectedDrawingId(d.id);
      pushHistory(next);
      setInteraction("OBJECT_SELECTED");
      handleToolChange("select");
      return;
    }
    // Two-click tools: trendline, extended, arrow, rect
    if (tool === "trendline" || tool === "extended" || tool === "arrow" || tool === "rect") {
      e.preventDefault(); e.stopPropagation();
      const c = getCoords();
      if (!c) return;
      if (!pendingTrendRef.current) {
        // STATE: TOOL_SELECTED -> DRAWING_FIRST_ANCHOR
        pendingTrendRef.current = { time: c.time, price: c.price, tool };
        setPendingPoint({ time: c.time, price: c.price, tool });
        setInteraction("DRAWING_FIRST_ANCHOR");
      } else {
        // STATE: DRAWING_FIRST_ANCHOR -> complete -> return to Select (Phase 4)
        const p1 = pendingTrendRef.current;
        pendingTrendRef.current = null;
        setPendingPoint(null);
        setPreviewPoint(null);
        const type = p1.tool as DrawingType;
        const d = createDrawing(type, {
          p1: { time: p1.time, price: p1.price },
          p2: { time: c.time, price: c.price },
        });
        const next = [...drawingsRef.current, d];
        onDrawingsChange(next);
        setSelectedDrawingId(d.id);
        pushHistory(next);
        setInteraction("OBJECT_SELECTED");
        // Return to Select mode after completing a drawing (Phase 4 spec)
        handleToolChange("select");
      }
      return;
    }
    // Select mode: hit-test drawings (with overlap cycling), then SL/TP lines.
    if (tool === "select") {
      const toX = (t: number) => dc.toX(t);
      const toY = (p: number) => dc.toY(p);
      const hits = hitTestAll(drawingsRef.current, x, y, toX, toY);
      if (hits.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        // Cycle through overlapping drawings on repeated clicks
        let d: Drawing;
        const currentIdx = hits.findIndex((h) => h.id === selectedDrawingId);
        if (currentIdx >= 0 && hits.length > 1) {
          d = hits[(currentIdx + 1) % hits.length];
        } else {
          d = hits[0];
        }
        setSelectedDrawingId(d.id);
        setInteraction("OBJECT_SELECTED");
        // Check if hitting an endpoint handle (for line-type drawings) —
        // same classification the hover cursor uses, so press feedback
        // always matches hover feedback.
        const mode = anchorHitZone(d, x, y, toX, toY, hitTolerance()) ?? "move";
        drawingDragRef.current = { id: d.id, mode, startX: x, startY: y };
        // STATE: OBJECT_SELECTED -> OBJECT_DRAGGING or ANCHOR_DRAGGING (on move)
        setWrapCursor(drawingCursor({ dragging: true, zone: null }) ?? "");
        disableChartNav();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        return;
      }
      // Clicked empty space: deselect.
      if (selectedDrawingId) {
        setSelectedDrawingId(null);
        setInteraction("IDLE");
      }
    }

    // SL/TP line drag (existing behavior).
    const hit = hitTestBracket(y);
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = { kind: hit };
      disableChartNav();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const dDrag = drawingDragRef.current;
    const cs = candleSeriesRef.current;
    const el = elRef.current;

    // Phase 4: Live preview for two-click tools (DRAWING_FIRST_ANCHOR state).
    // Update preview endpoint as cursor moves, so user sees exactly where
    // the second click will place the line.
    if (interactionRef.current === "DRAWING_FIRST_ANCHOR" && pendingTrendRef.current && cs && el) {
      const dc = drawingCoords();
      if (dc) {
        const rect = dc.rect;
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const price = dc.toPrice(y);
        const time = dc.toTime(x);
        if (price != null && isFinite(price) && price > 0 && time != null) {
          setPreviewPoint({ time, price: normalizePrice(price) });
        }
      }
      return;
    }

    // Drawing drag in progress.
    if (dDrag && cs && el) {
      // STATE: OBJECT_SELECTED -> OBJECT_DRAGGING (body) / ANCHOR_DRAGGING (endpoint)
      if (interactionRef.current === "OBJECT_SELECTED") {
        setInteraction(dDrag.mode === "move" ? "OBJECT_DRAGGING" : "ANCHOR_DRAGGING");
      }
      // Keep the grabbing cursor for the whole drag (set at pointerdown;
      // re-asserted here in case anything else touched it).
      setWrapCursor(drawingCursor({ dragging: true, zone: null }) ?? "");
      const dc = drawingCoords();
      if (!dc) return;
      const rect = dc.rect;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const price = dc.toPrice(y);
      const time = dc.toTime(x);
      if (price == null || !isFinite(price) || price <= 0) return;
      const cleanPrice = normalizePrice(price);
      const updated = drawingsRef.current.map((d) => {
        if (d.id !== dDrag.id) return d;
        if (d.locked) return d;
        if (d.type === "hline") {
          return { ...d, price: cleanPrice };
        }
        if (d.type === "hray" && d.p1) {
          return { ...d, p1: { ...d.p1, price: cleanPrice } };
        }
        if (d.type === "vline" && d.time != null) {
          return { ...d, time: time ?? d.time, p1: d.p1 ? { ...d.p1, time: time ?? d.p1.time } : d.p1 };
        }
        if (d.type === "text" && d.p1) {
          // Move text anchor
          return { ...d, p1: { time: time ?? d.p1.time, price: cleanPrice } };
        }
        if ((d.type === "trendline" || d.type === "arrow" || d.type === "extended" || d.type === "rect") && d.p1 && d.p2) {
          if (dDrag.mode === "p1") return { ...d, p1: { time: time ?? d.p1.time, price: cleanPrice } };
          if (dDrag.mode === "p2") return { ...d, p2: { time: time ?? d.p2.time, price: cleanPrice } };
          // Move whole shape: shift both points by delta.
          const dx = x - dDrag.startX;
          const dy = y - dDrag.startY;
          const p1x = dc.toX(d.p1.time); const p1y = dc.toY(d.p1.price);
          const p2x = dc.toX(d.p2.time); const p2y = dc.toY(d.p2.price);
          if (p1x == null || p1y == null || p2x == null || p2y == null) return d;
          const newP1Time = dc.toTime(p1x + dx); const newP1Price = dc.toPrice(p1y + dy);
          const newP2Time = dc.toTime(p2x + dx); const newP2Price = dc.toPrice(p2y + dy);
          if (newP1Time == null || newP1Price == null || newP2Time == null || newP2Price == null) return d;
          dDrag.startX = x; dDrag.startY = y;
          return {
            ...d,
            p1: { time: newP1Time, price: normalizePrice(newP1Price) },
            p2: { time: newP2Time, price: normalizePrice(newP2Price) },
          };
        }
        return d;
      });
      onDrawingsChange(updated);
      return;
    }

    if (!drag || !cs || !el) {
      // Not dragging: just update hover cursor.
      onPointerMoveHover(e);
      return;
    }
    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const price = cs.coordinateToPrice(y);
    if (price == null || !isFinite(price) || price <= 0) return;
    // Update the visual line live during drag.
    const refMap = {
      plannedSL: plannedSLRef,
      plannedTP: plannedTPRef,
      activeSL: activeSLRef,
      activeTP: activeTPRef,
    };
    const line = refMap[drag.kind].current;
    if (line) {
      line.applyOptions({ price, title: `${drag.kind.includes("SL") ? "SL" : "TP"} ${price.toFixed(2)}` });
    }
    // Store the pending price for commit on pointerup.
    (drag as { pendingPrice?: number }).pendingPrice = price;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    // Settle-refit tracking (stable-scale only): when the LAST pointer
    // of a gesture lifts, refit once if the time range actually moved.
    if (
      stableScaleRef.current &&
      gesturePtrsRef.current.delete(e.pointerId) &&
      gesturePtrsRef.current.size === 0
    ) {
      const snap = gestureSnapRef.current;
      gestureSnapRef.current = null;
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        const ch = timeRangeChanged(snap, snapVisibleRange());
        if (stableScaleRef.current && ch) {
          // The gate just proved the TIME range moved during the
          // gesture: this is a time zoom/pan settle, which always
          // refits fresh and re-takes ownership (see applyStableWindow).
          applyStableWindow({ fromTimeGesture: true });
        }
      }, 250);
    }
    // End drawing drag — push to history for undo.
    if (drawingDragRef.current) {
      drawingDragRef.current = null;
      enableChartNav();
      setWrapCursor("");
      // STATE: OBJECT_DRAGGING / ANCHOR_DRAGGING -> OBJECT_SELECTED
      if (interactionRef.current === "OBJECT_DRAGGING" || interactionRef.current === "ANCHOR_DRAGGING") {
        setInteraction("OBJECT_SELECTED");
      }
      pushHistory([...drawingsRef.current]);
    }
    const drag = dragRef.current;
    const chart = chartRef.current;
    if (!drag) return;
    const pendingPrice = (drag as { pendingPrice?: number }).pendingPrice;
    dragRef.current = null;
    enableChartNav();
    if (pendingPrice != null && isFinite(pendingPrice) && pendingPrice > 0) {
      // Normalize to valid tick increment to avoid float artifacts.
      const clean = normalizePrice(pendingPrice);
      const b = bracketsRef.current;
      if (drag.kind === "plannedSL") onPlannedDrag(clean, b.plannedTP);
      else if (drag.kind === "plannedTP") onPlannedDrag(b.plannedSL, clean);
      else if (drag.kind === "activeSL") onActiveDrag(clean, b.activeTP);
      else if (drag.kind === "activeTP") onActiveDrag(b.activeSL, clean);
    }
  };

  // Keyboard: Delete/Backspace removes selected drawing, Esc exits tool, Ctrl+Z/Y for undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedDrawingId) {
        e.preventDefault();
        const next = drawingsRef.current.filter((d) => d.id !== selectedDrawingId);
        onDrawingsChange(next);
        pushHistory(next);
        setSelectedDrawingId(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      if (e.key === "Escape") {
        // STATE: any -> IDLE (cancel drawing, clear selection)
        pendingTrendRef.current = null;
        setPendingPoint(null);
        setPreviewPoint(null);
        if (drawingDragRef.current) {
          drawingDragRef.current = null;
          enableChartNav();
          setWrapCursor("");
        }
        setSelectedDrawingId(null);
        setInteraction("IDLE");
        if (toolRef.current !== "select") handleToolChange("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // handleToolChange is stable (uses refs + stable setState from parent)
  }, [selectedDrawingId, onDrawingsChange, onDrawingToolChange]);

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: "100%", height: "100%" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onStableWheel}
      onPointerLeave={() => {
        // Pointer left the chart: drop hover feedback. An active drag
        // holds pointer capture and keeps its grabbing cursor until
        // pointerup/cancel, so don't clear while one is running.
        if (!dragRef.current && !drawingDragRef.current) setWrapCursor("");
      }}
    >
      <div ref={elRef} style={{ width: "100%", height: "100%" }} />
      <DrawingLayer
        chart={chartRef.current}
        series={candleSeriesRef.current}
        drawings={drawings}
        selectedId={selectedDrawingId}
        width={chartSize.w}
        height={chartSize.h}
        pendingPoint={pendingPoint}
        previewPoint={previewPoint}
      />
      <DrawingToolbar
        tool={drawingTool}
        onToolChange={handleToolChange}
        onDeleteSelected={() => {
          if (selectedDrawingId) {
            const next = drawings.filter((d) => d.id !== selectedDrawingId);
            onDrawingsChange(next);
            pushHistory(next);
            setSelectedDrawingId(null);
          }
        }}
        hasSelection={selectedDrawingId != null}
        onUndo={undo}
        onRedo={redo}
        canUndo={historyIdxRef.current > 0}
        canRedo={historyIdxRef.current < historyRef.current.length - 1}
      />
      {/* Floating delete button for selected drawing — easy deletion */}
      {selectedDrawingId && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const next = drawings.filter((d) => d.id !== selectedDrawingId);
            onDrawingsChange(next);
            pushHistory(next);
            setSelectedDrawingId(null);
          }}
          title="Delete selected drawing"
          style={{
            position: "absolute",
            right: 8,
            top: 8,
            zIndex: 25,
            background: "rgba(220,38,38,0.92)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          🗑 Delete
        </button>
      )}
      {/* "Fit all" pill (opt-in, Daily Replay): bottom-left above the
          time axis — clear of the drawing toolbar (top-left), the
          countdown pill (right), and the attribution logo (axis row).
          Returns from the readable window / any zoom to the full
          (revealed) session. stopPropagation mirrors the floating
          delete button so the tap never reaches chart pointer logic. */}
      {showFitAll && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            chartRef.current?.timeScale().fitContent();
            // Stable-scale (Daily Replay): the time fit changes which
            // bars are visible, so recompute the managed price window
            // from ALL revealed extremes immediately — otherwise the
            // per-candle window could clip the full-session range the
            // user just asked to see. This also re-takes ownership
            // from any manual axis drag.
            if (stableScaleRef.current) {
              const cs2 = candleSeriesRef.current;
              const arr = candlesRef.current;
              const n2 = Math.max(0, Math.min(revealedCountRef.current, arr.length));
              if (cs2 && n2 > 0) {
                let lo = Infinity;
                let hi = -Infinity;
                for (let i = 0; i < n2; i++) {
                  if (arr[i].l < lo) lo = arr[i].l;
                  if (arr[i].h > hi) hi = arr[i].h;
                }
                if (Number.isFinite(lo) && Number.isFinite(hi)) {
                  const win = paddedPriceRange(lo, hi);
                  cs2.priceScale().setVisibleRange(win);
                  scaleWinRef.current.lastSet = win;
                }
              }
            }
          }}
          title="Fit the whole session"
          style={{
            position: "absolute",
            left: 8,
            bottom: 30,
            zIndex: 6,
            background: "rgba(15,23,42,0.92)",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 11,
            color: "#e2e8f0",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          ⤢ Fit all
        </button>
      )}
      <div
        ref={countdownRef}
        style={{
          position: "absolute",
          right: 72,
          top: 0,
          display: "none",
          background: "rgba(15,23,42,0.92)",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 6,
          padding: "2px 8px",
          fontSize: 11,
          fontFamily: "ui-monospace, monospace",
          color: "#e2e8f0",
          pointerEvents: "none",
          zIndex: 5,
          whiteSpace: "nowrap",
        }}
      >
        {countdown}
      </div>
    </div>
  );
}
