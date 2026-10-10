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
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/types";
import { diag } from "../lib/diag";
import { normalizePrice, formatPrice } from "../lib/price";
import type { Drawing, DrawingTool } from "../lib/drawings";
import { newDrawingId, DRAWING_COLORS } from "../lib/drawings";
import DrawingToolbar from "./DrawingToolbar";
import DrawingLayer, { hitTestDrawing } from "./DrawingLayer";

const UP = "#2ebd85";
const DOWN = "#f6465d";
const UP_VOL = "rgba(46,189,133,0.45)";
const DOWN_VOL = "rgba(246,70,93,0.45)";

interface BracketLevels {
  plannedSL: number | null;
  plannedTP: number | null;
  activeSL: number | null;
  activeTP: number | null;
}

interface Props {
  candles: Candle[];
  revealedCount: number;
  sessionKey: string;
  countdown: string | null;
  lastPrice: number;
  brackets: BracketLevels;
  onPlannedDrag: (sl: number | null, tp: number | null) => void;
  onActiveDrag: (sl: number | null, tp: number | null) => void;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  drawingTool: DrawingTool;
  onDrawingToolChange: (tool: DrawingTool) => void;
}

export default function LwcChart({ candles, revealedCount, sessionKey, countdown, lastPrice, brackets, onPlannedDrag, onActiveDrag, drawings, onDrawingsChange, drawingTool, onDrawingToolChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  // Tracks what we've pushed so we can use update() instead of setData().
  const pushedRef = useRef<{ key: string; n: number } | null>(null);
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
  // Drawing state.
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const toolRef = useRef(drawingTool);
  toolRef.current = drawingTool;
  // Pending first point for trendline placement; drag state for drawings.
  const pendingTrendRef = useRef<{ time: number; price: number } | null>(null);
  const drawingDragRef = useRef<{
    id: string;
    mode: "move" | "p1" | "p2";
    startX: number;
    startY: number;
  } | null>(null);
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
      crosshair: {
        vertLine: { color: "rgba(255,255,255,0.25)", labelBackgroundColor: "#334155" },
        horzLine: { color: "rgba(255,255,255,0.25)", labelBackgroundColor: "#334155" },
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

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      setChartSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(wrap);
    setChartSize({ w: el.clientWidth, h: el.clientHeight });
    return () => {
      ro.disconnect();
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

    const prev = pushedRef.current;
    try {
      if (!prev || prev.key !== sessionKey || n < prev.n) {
        // New session, reset, or dataset shrank: full replace.
        const bars = [];
        const vols = [];
        for (let i = 0; i < n; i++) {
          bars.push(toBar(candles[i]));
          vols.push(toVol(candles[i]));
        }
        cs.setData(bars);
        vs.setData(vols);
        pushedRef.current = { key: sessionKey, n };
      } else if (n === prev.n) {
        // Same bars; only the forming (last) candle changed: efficient update.
        const c = candles[n - 1];
        cs.update(toBar(c));
        vs.update(toVol(c));
      } else {
        // New candle(s) appended: update() appends when the time is newer.
        for (let i = prev.n; i < n; i++) {
          cs.update(toBar(candles[i]));
          vs.update(toVol(candles[i]));
        }
        pushedRef.current = { key: sessionKey, n };
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

  // Hover feedback: show ns-resize cursor when over a draggable line.
  const onPointerMoveHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return; // already handled by drag move
    const el = elRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const hit = hitTestBracket(y);
    if (wrapRef.current) {
      wrapRef.current.style.cursor = hit ? "ns-resize" : "";
    }
  };

  // Drawing coordinate helpers. All coordinates are element-relative
  // (relative to the chart div), matching e.clientX - rect.left.
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
        // coordinateToTime returns UTCTimestamp (seconds) or null
        return t == null ? null : Number(t) * 1000;
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

    // Drawing placement modes: disable pan, place on click.
    if (tool === "hline") {
      e.preventDefault();
      e.stopPropagation();
      const price = dc.toPrice(y);
      if (price != null && isFinite(price) && price > 0) {
        const clean = normalizePrice(price);
        const d: Drawing = {
          id: newDrawingId(),
          type: "hline",
          price: clean,
          color: DRAWING_COLORS.hline,
        };
        onDrawingsChange([...drawingsRef.current, d]);
        setSelectedDrawingId(d.id);
      }
      return;
    }
    if (tool === "trendline") {
      e.preventDefault();
      e.stopPropagation();
      const price = dc.toPrice(y);
      const time = dc.toTime(x);
      if (price == null || !isFinite(price) || price <= 0 || time == null) return;
      const cleanPrice = normalizePrice(price);
      if (!pendingTrendRef.current) {
        // First point.
        pendingTrendRef.current = { time, price: cleanPrice };
      } else {
        // Second point: create the trendline.
        const p1 = pendingTrendRef.current;
        pendingTrendRef.current = null;
        const d: Drawing = {
          id: newDrawingId(),
          type: "trendline",
          p1,
          p2: { time, price: cleanPrice },
          color: DRAWING_COLORS.trendline,
        };
        onDrawingsChange([...drawingsRef.current, d]);
        setSelectedDrawingId(d.id);
      }
      return;
    }

    // Select mode: hit-test drawings first, then SL/TP lines.
    if (tool === "select") {
      const toX = (t: number) => dc.toX(t);
      const toY = (p: number) => dc.toY(p);
      for (const d of drawingsRef.current) {
        if (hitTestDrawing(d, x, y, toX, toY)) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedDrawingId(d.id);
          // Check if hitting an endpoint (for trendline).
          let mode: "move" | "p1" | "p2" = "move";
          if (d.type === "trendline" && d.p1 && d.p2) {
            const x1 = toX(d.p1.time); const y1 = toY(d.p1.price);
            const x2 = toX(d.p2.time); const y2 = toY(d.p2.price);
            if (x1 != null && y1 != null && Math.hypot(x - x1, y - y1) < 10) mode = "p1";
            else if (x2 != null && y2 != null && Math.hypot(x - x2, y - y2) < 10) mode = "p2";
          }
          drawingDragRef.current = { id: d.id, mode, startX: x, startY: y };
          disableChartNav();
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          return;
        }
      }
      // Clicked empty space: deselect.
      if (selectedDrawingId) setSelectedDrawingId(null);
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

    // Drawing drag in progress.
    if (dDrag && cs && el) {
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
        if (d.type === "hline") {
          return { ...d, price: cleanPrice };
        }
        if (d.type === "trendline" && d.p1 && d.p2) {
          if (dDrag.mode === "p1") return { ...d, p1: { time: time ?? d.p1.time, price: cleanPrice } };
          if (dDrag.mode === "p2") return { ...d, p2: { time: time ?? d.p2.time, price: cleanPrice } };
          // Move whole line: shift both points by delta.
          const dx = x - dDrag.startX;
          const dy = y - dDrag.startY;
          // Convert pixel delta to time/price delta via current scale.
          const p1x = dc.toX(d.p1.time); const p1y = dc.toY(d.p1.price);
          const p2x = dc.toX(d.p2.time); const p2y = dc.toY(d.p2.price);
          if (p1x == null || p1y == null || p2x == null || p2y == null) return d;
          const newP1Time = dc.toTime(p1x + dx); const newP1Price = dc.toPrice(p1y + dy);
          const newP2Time = dc.toTime(p2x + dx); const newP2Price = dc.toPrice(p2y + dy);
          if (newP1Time == null || newP1Price == null || newP2Time == null || newP2Price == null) return d;
          dDrag.startX = x; dDrag.startY = y; // update for incremental moves
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
    // End drawing drag.
    if (drawingDragRef.current) {
      drawingDragRef.current = null;
      enableChartNav();
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

  // Keyboard: Delete/Backspace removes selected drawing, Esc exits tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedDrawingId) {
        e.preventDefault();
        onDrawingsChange(drawingsRef.current.filter((d) => d.id !== selectedDrawingId));
        setSelectedDrawingId(null);
      }
      if (e.key === "Escape") {
        pendingTrendRef.current = null;
        if (toolRef.current !== "select") onDrawingToolChange("select");
        setSelectedDrawingId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedDrawingId, onDrawingsChange, onDrawingToolChange]);

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: "100%", height: "100%" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div ref={elRef} style={{ width: "100%", height: "100%" }} />
      <DrawingLayer
        chart={chartRef.current}
        series={candleSeriesRef.current}
        drawings={drawings}
        selectedId={selectedDrawingId}
        width={chartSize.w}
        height={chartSize.h}
      />
      <DrawingToolbar
        tool={drawingTool}
        onToolChange={onDrawingToolChange}
        onDeleteSelected={() => {
          if (selectedDrawingId) {
            onDrawingsChange(drawings.filter((d) => d.id !== selectedDrawingId));
            setSelectedDrawingId(null);
          }
        }}
        hasSelection={selectedDrawingId != null}
      />
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
