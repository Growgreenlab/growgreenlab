/**
 * LwcChart — Phase 1 prototype: Lightweight Charts rendering layer.
 *
 * Renders historical candlesticks + volume only. No replay integration yet
 * (no tick updates, no follow mode, no overlays). Exists alongside the
 * hand-rolled CandleChart.tsx; selected via ?chart=lwc.
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

const UP = "#2ebd85";
const DOWN = "#f6465d";

interface Props {
  candles: Candle[];
  revealedCount: number;
}

export default function LwcChart({ candles, revealedCount }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  // Create the chart once.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
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
        // US equities trade in US Eastern; force the axis into ET so
        // premarket labels read correctly regardless of browser timezone.
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

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Push data when it changes.
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const vs = volumeSeriesRef.current;
    if (!cs || !vs) return;
    const n = Math.max(0, Math.min(revealedCount, candles.length));
    const bars = [];
    const vols = [];
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const time = Math.floor(c.t / 1000) as UTCTimestamp;
      bars.push({ time, open: c.o, high: c.h, low: c.l, close: c.c });
      vols.push({
        time,
        value: c.v,
        color: c.c >= c.o ? "rgba(46,189,133,0.45)" : "rgba(246,70,93,0.45)",
      });
    }
    cs.setData(bars);
    vs.setData(vols);
  }, [candles, revealedCount]);

  return <div ref={wrapRef} style={{ width: "100%", height: "100%" }} />;
}
