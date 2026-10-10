"use client";

import { useEffect, useRef } from "react";
import type { Candle, Fill } from "../lib/types";
import { formatEtTime } from "../lib/marketData";

// Webull-style palette: bright green/red on deep dark
const UP = "#2ebd85";
const DOWN = "#f6465d";
const GRID = "rgba(148, 163, 184, 0.09)";
const AXIS = "#8b9bab";
const HOD_COLOR = "#fbbf24";

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
  /** Candles before this index are pre-replay history: rendered dimmed. */
  historyCount?: number;
}

/**
 * Hand-rolled canvas candlestick chart in a professional dark style:
 * dense thin candles, full grid, dedicated volume pane below the price
 * pane, crisp time/price axes. Only the revealed prefix of the candle
 * array is ever drawn, so future candles stay hidden.
 */
export default function CandleChart({ candles, revealedCount, overlays, height = 460, historyCount = 0 }: Props) {
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

    const padR = 68; // price axis
    const padB = 24; // time axis
    const padT = 14;
    const plotW = w - padR;
    const volH = Math.floor(h * 0.24);
    const paneGap = 10;
    const priceH = h - padB - padT - volH - paneGap;
    const volTop = padT + priceH + paneGap;

    // backdrop: deep dark, barely-there vertical falloff
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, "#0c1014");
    bgGrad.addColorStop(1, "#090c0f");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    const data = candles.slice(0, Math.max(0, Math.min(revealedCount, candles.length)));
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
    // dense, Webull-like: thin bodies, consistent rhythm, never chunky
    const bodyW = Math.max(1, Math.min(9, slot * 0.65));
    const x = (i: number) => i * slot + slot / 2;

    // volume pane backdrop + separator
    ctx.fillStyle = "rgba(148, 163, 184, 0.03)";
    ctx.fillRect(0, volTop, plotW, volH + padB);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, volTop + 0.5); ctx.lineTo(plotW, volTop + 0.5); ctx.stroke();

    // horizontal grid + price axis
    ctx.strokeStyle = GRID; ctx.fillStyle = AXIS;
    ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
    ctx.lineWidth = 1;
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const p = lo + ((hi - lo) * i) / ticks;
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.fillText(p.toFixed(2), plotW + 8, yy + 4);
    }

    // vertical gridlines (subtle, ~90px rhythm)
    const vStep = Math.max(1, Math.round(90 / slot));
    ctx.strokeStyle = "rgba(148, 163, 184, 0.05)";
    for (let i = 0; i < n; i += vStep) {
      const xx = Math.round(x(i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, volTop + volH); ctx.stroke();
    }

    // time axis: label on 15-minute marks, de-collided
    ctx.fillStyle = AXIS;
    ctx.textAlign = "center";
    let lastLabelX = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = new Date(data[i].t);
      const xx = x(i);
      if (d.getMinutes() % 15 === 0 && xx - lastLabelX > 64) {
        ctx.fillText(formatEtTime(data[i].t), xx, h - 8);
        lastLabelX = xx;
      }
    }
    // always label the last visible candle's time
    const lastX = x(n - 1);
    if (lastX - lastLabelX > 40) {
      ctx.fillStyle = "#a9bcc9";
      ctx.fillText(formatEtTime(data[n - 1].t), Math.min(lastX, plotW - 30), h - 8);
    }
    ctx.textAlign = "left";

    // volume bars — full-height pane, direction-colored (history dimmed)
    for (let i = 0; i < n; i++) {
      const c = data[i];
      const vh = vMax > 0 ? Math.max(1, (c.v / vMax) * (volH - 4)) : 0;
      ctx.globalAlpha = i < historyCount ? 0.28 : 1;
      ctx.fillStyle = c.c >= c.o ? "rgba(46,189,133,0.55)" : "rgba(246,70,93,0.55)";
      ctx.fillRect(x(i) - bodyW / 2, volTop + volH - vh, bodyW, vh);
    }
    ctx.globalAlpha = 1;

    // candles (pre-replay history rendered dimmed for context)
    for (let i = 0; i < n; i++) {
      const c = data[i];
      const isUp = c.c >= c.o;
      const col = isUp ? UP : DOWN;
      const cx = x(i);
      const dimmed = i < historyCount;
      ctx.globalAlpha = dimmed ? 0.42 : 1;
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, bodyW * 0.18);
      ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
      const yo = y(c.o), yc = y(c.c);
      const top = Math.min(yo, yc);
      const bh = Math.max(1.5, Math.abs(yc - yo));
      ctx.fillStyle = col;
      if (i === n - 1 && !dimmed) {
        ctx.shadowColor = col; ctx.shadowBlur = 10;
      }
      ctx.fillRect(cx - bodyW / 2, top, bodyW, bh);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;

    // pill label helper for overlay lines
    const pill = (text: string, color: string, yy: number) => {
      ctx.font = "600 10.5px ui-monospace, monospace";
      const tw = ctx.measureText(text).width;
      const pw = tw + 14, ph = 18;
      const px = 6, py = Math.max(padT + 2, Math.min(padT + priceH - ph - 2, yy - ph - 4));
      ctx.fillStyle = "rgba(6,10,12,0.9)";
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(px, py, pw, ph, 9);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(text, px + 7, py + 12.5);
    };

    const hline = (price: number, color: string, label: string, dashed = true) => {
      const yy = y(price);
      if (yy < padT || yy > padT + priceH) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      pill(label, color, yy);
    };

    if (overlays.hod != null) hline(overlays.hod, HOD_COLOR, `HOD ${overlays.hod.toFixed(2)}`);
    if (overlays.stopLoss != null) hline(overlays.stopLoss, DOWN, `SL ${overlays.stopLoss.toFixed(2)}`);
    if (overlays.takeProfit != null) hline(overlays.takeProfit, UP, `TP ${overlays.takeProfit.toFixed(2)}`);

    // last price: dashed cross-line + Webull-style tag on the axis
    if (overlays.lastPrice != null) {
      const p = overlays.lastPrice;
      const yy = Math.max(padT, Math.min(padT + priceH, y(p)));
      const lastC = data[n - 1];
      const up = p >= lastC.o;
      const tagCol = up ? UP : DOWN;
      ctx.strokeStyle = tagCol; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, Math.round(yy) + 0.5); ctx.lineTo(plotW, Math.round(yy) + 0.5); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const label = p.toFixed(2);
      ctx.font = "700 11.5px ui-monospace, monospace";
      const tw = ctx.measureText(label).width;
      const pw = tw + 14, ph = 22;
      const py = Math.max(2, Math.min(h - ph - 2, yy - ph / 2));
      ctx.fillStyle = tagCol;
      ctx.shadowColor = tagCol; ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.roundRect(plotW + 2, py, padR - 5, ph, 5);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, plotW + 9, py + 15);
    }

    // trade markers
    for (const f of overlays.fills) {
      if (f.candleIndex >= n) continue;
      const cx = x(f.candleIndex);
      if (f.side === "buy") {
        const c = data[f.candleIndex];
        const yy = y(c.l) + 12;
        ctx.fillStyle = UP;
        ctx.beginPath(); ctx.moveTo(cx, yy); ctx.lineTo(cx - 5, yy + 8); ctx.lineTo(cx + 5, yy + 8); ctx.closePath(); ctx.fill();
      } else {
        const c = data[f.candleIndex];
        const yy = y(c.h) - 12;
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
