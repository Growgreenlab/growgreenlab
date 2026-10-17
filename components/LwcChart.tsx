/**
 * LwcChart — Lightweight Charts prototype (Phase 1 + replay integration).
 *
 * - Historical candles via setData() on dataset changes only.
 * - Tick-by-tick forming-candle updates via series.update() (efficient).
 * - Countdown pill driven by the parent's deadline-based clock.
 * - Native LWC pan/zoom/price-scale. Exists alongside CandleChart.tsx.
 */
"use client";

import { useEffect, useRef, useState } from "react";
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
import { planBarPush, type BarPushState } from "../lib/chartPush";
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
  /** Optional: notified with the clicked candle's time (seconds) on chart
   *  click. Used by Daily Replay's full-day preview to pick the starting
   *  candle. Omit = no behavior (all existing parents). */
  onCandleClick?: (timeSec: number) => void;
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

export default function LwcChart({ candles, revealedCount, sessionKey, countdown, lastPrice, brackets, referenceLevels, fitOnLoad, onCandleClick, highlightTimeSec, highlightSpanSec, onPlannedDrag, onActiveDrag, drawings, onDrawingsChange, drawingTool, onDrawingToolChange }: Props) {
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
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
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
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
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

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      setChartSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(wrap);
    setChartSize({ w: el.clientWidth, h: el.clientHeight });
    return () => {
      ro.disconnect();
      chart.unsubscribeClick(handleChartClick);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

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

    try {
      // Push planning lives in lib/chartPush (pure + unit-tested). The key
      // property: when the array grows, the previously-last bar is re-pushed
      // FIRST — it was the forming candle and may have finalized mid-batch,
      // so without this its partial forming OHLCV would stay on the chart.
      const plan = planBarPush(pushedRef.current, sessionKey, n);
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
          chartRef.current.timeScale().fitContent();
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
