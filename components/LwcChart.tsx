/**
 * LwcChart — Lightweight Charts prototype (Phase 1 + replay integration).
 *
 * - Historical candles via setData() on dataset changes only.
 * - Tick-by-tick forming-candle updates via series.update() (efficient).
 * - Countdown pill driven by the parent's deadline-based clock.
 * - Native LWC pan/zoom/price-scale. Exists alongside CandleChart.tsx.
 */
"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/types";
import { diag } from "../lib/diag";

const UP = "#2ebd85";
const DOWN = "#f6465d";
const UP_VOL = "rgba(46,189,133,0.45)";
const DOWN_VOL = "rgba(246,70,93,0.45)";

interface Props {
  candles: Candle[];
  revealedCount: number;
  sessionKey: string;
  countdown: string | null;
  lastPrice: number;
}

export default function LwcChart({ candles, revealedCount, sessionKey, countdown, lastPrice }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  // Tracks what we've pushed so we can use update() instead of setData().
  const pushedRef = useRef<{ key: string; n: number } | null>(null);

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
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

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

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={elRef} style={{ width: "100%", height: "100%" }} />
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
