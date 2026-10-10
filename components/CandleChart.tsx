"use client";

import { useEffect, useRef } from "react";
import type { Candle, Fill } from "../lib/types";
import { formatEtTime } from "../lib/marketData";

const UP = "#26a69a";
const DOWN = "#ef5350";
const GRID = "#1a2233";
const AXIS = "#8b94a7";
const HOD_COLOR = "#f5a623";

export interface ChartOverlays {
  hod: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  fills: Fill[];
  lastPrice: number | null;
}

interface Props {
  candles: Candle[];
  revealedCount: number; // render candles[0..revealedCount-1] only
  overlays: ChartOverlays;
  height?: number;
}

/**
 * Hand-rolled canvas candlestick chart. Only the revealed prefix of the
 * candle array is ever drawn, so future candles stay hidden.
 */
export default function CandleChart({ candles, revealedCount, overlays, height = 420 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    draw();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, revealedCount, overlays, height]);

  function draw() {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = wrap.clientWidth;
    const h = height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const data = candles.slice(0, Math.max(0, Math.min(revealedCount, candles.length)));
    const padR = 64; // price axis
    const padB = 22; // time axis
    const padT = 12;
    const plotW = w - padR;
    const volH = Math.floor(h * 0.18);
    const priceH = h - padB - padT - volH - 8;

    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, w, h);

    if (data.length === 0) {
      ctx.fillStyle = AXIS;
      ctx.font = "13px system-ui";
      ctx.fillText("Load a session to begin the replay.", 16, 40);
      return;
    }

    let lo = Infinity, hi = -Infinity, vMax = 0;
    for (const c of data) {
      lo = Math.min(lo, c.l);
      hi = Math.max(hi, c.h);
      vMax = Math.max(vMax, c.v);
    }
    const pad = (hi - lo) * 0.08 || 1;
    hi += pad; lo -= pad;
    const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * priceH;
    const n = data.length;
    const slot = plotW / n;
    const bodyW = Math.max(1, Math.min(14, slot * 0.62));
    const x = (i: number) => i * slot + slot / 2;

    // grid + price axis
    ctx.strokeStyle = GRID; ctx.fillStyle = AXIS;
    ctx.font = "11px ui-monospace, monospace"; ctx.lineWidth = 1;
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const p = lo + ((hi - lo) * i) / ticks;
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.fillText(p.toFixed(2), plotW + 6, yy + 4);
    }
    // time axis
    const step = Math.max(1, Math.floor(n / 6));
    ctx.textAlign = "center";
    for (let i = 0; i < n; i += step) {
      ctx.fillText(formatEtTime(data[i].t), x(i), h - 7);
    }
    ctx.textAlign = "left";

    // volume bars
    const volTop = padT + priceH + 8;
    for (let i = 0; i < n; i++) {
      const c = data[i];
      const vh = vMax > 0 ? (c.v / vMax) * volH : 0;
      ctx.fillStyle = c.c >= c.o ? "rgba(38,166,154,.45)" : "rgba(239,83,80,.45)";
      ctx.fillRect(x(i) - bodyW / 2, volTop + volH - vh, bodyW, vh);
    }

    // candles
    for (let i = 0; i < n; i++) {
      const c = data[i];
      const col = c.c >= c.o ? UP : DOWN;
      const cx = x(i);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
      const yo = y(c.o), yc = y(c.c);
      const top = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(cx - bodyW / 2, top, bodyW, bh);
    }

    const hline = (price: number, color: string, label: string, dashed = true) => {
      const yy = y(price);
      if (yy < padT || yy > padT + priceH) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = "11px ui-monospace, monospace";
      ctx.fillText(label, 4, yy - 5);
    };

    if (overlays.hod != null) hline(overlays.hod, HOD_COLOR, `HOD ${overlays.hod.toFixed(2)}`);
    if (overlays.stopLoss != null) hline(overlays.stopLoss, DOWN, `SL ${overlays.stopLoss.toFixed(2)}`);
    if (overlays.takeProfit != null) hline(overlays.takeProfit, UP, `TP ${overlays.takeProfit.toFixed(2)}`);
    if (overlays.lastPrice != null) {
      const p = overlays.lastPrice;
      const yy = Math.max(padT, Math.min(padT + priceH, y(p)));
      ctx.fillStyle = "#4da3ff";
      ctx.fillRect(plotW, yy - 10, padR, 20);
      ctx.fillStyle = "#fff"; ctx.font = "bold 11px ui-monospace, monospace";
      ctx.fillText(p.toFixed(2), plotW + 6, yy + 4);
    }

    // trade markers
    for (const f of overlays.fills) {
      if (f.candleIndex >= n) continue;
      const cx = x(f.candleIndex);
      if (f.side === "buy") {
        const c = data[f.candleIndex];
        const yy = y(c.l) + 10;
        ctx.fillStyle = UP;
        ctx.beginPath(); ctx.moveTo(cx, yy); ctx.lineTo(cx - 5, yy + 8); ctx.lineTo(cx + 5, yy + 8); ctx.closePath(); ctx.fill();
      } else {
        const c = data[f.candleIndex];
        const yy = y(c.h) - 10;
        ctx.fillStyle = DOWN;
        ctx.beginPath(); ctx.moveTo(cx, yy); ctx.lineTo(cx - 5, yy - 8); ctx.lineTo(cx + 5, yy - 8); ctx.closePath(); ctx.fill();
      }
    }
  }

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
