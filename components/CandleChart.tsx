"use client";

import { useEffect, useRef, useState } from "react";
import type { Candle, Fill } from "../lib/types";
import { formatEtTime } from "../lib/marketData";

// Webull-style palette: bright green/red on deep dark
const UP = "#2ebd85";
const DOWN = "#f6465d";
const GRID = "rgba(148, 163, 184, 0.09)";
const AXIS = "#8b9bab";
const HOD_COLOR = "#fbbf24";

// Viewport limits: px per candle slot
const MIN_SLOT = 1.5;
const MAX_SLOT = 48;
const DEFAULT_SLOT = 6; // ~150 candles visible at rest, like a pro terminal

export interface ChartOverlays {
  hod: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  fills: Fill[];
  lastPrice: number | null;
  pendingOrders: Array<{ side: "buy" | "sell"; price: number }>;
  /** MM:SS countdown to the forming candle's close (null when not playing). */
  countdown?: string | null;
}

interface Props {
  candles: Candle[];
  revealedCount: number; // render candles[0..revealedCount-1] only
  overlays: ChartOverlays;
  /** Fixed height; when omitted the chart fills its container. */
  height?: number;
  /** Candles before this index are pre-replay history: rendered dimmed. */
  historyCount?: number;
  /** Identity of the loaded session — the view refits when it changes. */
  sessionKey?: string;
}

/**
 * Hand-rolled canvas candlestick chart in a professional dark style with a
 * real viewport model: mouse-wheel / pinch zoom (anchored at the cursor),
 * drag to pan through history, double-click to reset. Candle width and
 * spacing scale together with zoom; volume bars share the same x-mapping
 * so everything stays aligned. Only the revealed prefix is ever drawn.
 */
export default function CandleChart({ candles, revealedCount, overlays, height, historyCount = 0, sessionKey = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ slot: DEFAULT_SLOT, scrollX: 0, priceShift: 0 });
  const userZoomedRef = useRef(false);
  const prevNRef = useRef(0);
  const prevKeyRef = useRef("");
  const drawRef = useRef<() => void>(() => {});
  const fitViewRef = useRef<() => void>(() => {});
  const priceHRef = useRef(0);
  const propsRef = useRef({ candles, revealedCount, overlays, height, historyCount });
  propsRef.current = { candles, revealedCount, overlays, height, historyCount };
  const [canReset, setCanReset] = useState(false);

  const markZoomed = () => {
    if (!userZoomedRef.current) {
      userZoomedRef.current = true;
      setCanReset(true);
    }
  };

  // Mount-once: define draw/fit, attach listeners.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const PAD_R = 68, PAD_B = 24, PAD_T = 14, PANE_GAP = 10;
    const plotW = () => wrap.clientWidth - PAD_R;
    const dataOf = () => {
      const p = propsRef.current;
      return p.candles.slice(0, Math.max(0, Math.min(p.revealedCount, p.candles.length)));
    };
    const clampScroll = (sx: number, slot: number, n: number) => {
      const w = plotW();
      if (n * slot <= w) return (w - n * slot) / 2; // center narrow content
      // Allow up to ~60% of a screen of empty space past either data edge,
      // so the live edge can be dragged to the center/left like Webull.
      const m = w * 0.6;
      return Math.min(m, Math.max(w - n * slot - m, sx));
    };
    // (vertical pan uses priceShift; see the drag handler)

    const fitView = () => {
      const w = plotW();
      const n = Math.max(1, dataOf().length);
      const slot = n * DEFAULT_SLOT <= w
        ? Math.min(MAX_SLOT, Math.max(MIN_SLOT, w / n))
        : DEFAULT_SLOT;
      viewRef.current = { slot, scrollX: clampScroll(w - n * slot, slot, n), priceShift: 0 };
      userZoomedRef.current = false;
      setCanReset(false);
    };
    fitViewRef.current = fitView;

    const zoomAt = (_cx: number, factor: number) => {
      const n = dataOf().length;
      if (n === 0) return;
      const v = viewRef.current;
      const w = plotW();
      // Anchor the midpoint of the visible DATA (not the screen center, which
      // includes empty margins). The candles you're looking at stay exactly
      // where they are while the zoom expands/contracts around them — the
      // view never slides sideways on its own.
      const i0 = Math.max(0, -v.scrollX / v.slot);
      const i1 = Math.min(n - 1, (w - v.scrollX) / v.slot);
      const midIdx = (i0 + i1) / 2;
      const midX = midIdx * v.slot + v.scrollX; // its current screen x
      // Never zoom out past "fit to width": at that point every candle is
      // visible, so horizontal panning would have nowhere to go (a dead end
      // that feels like broken dragging). The floor keeps pan always alive.
      const fitSlot = Math.min(MAX_SLOT, w / n);
      const slot = Math.min(MAX_SLOT, Math.max(Math.max(MIN_SLOT, fitSlot), v.slot * factor));
      if (slot === v.slot) return;
      v.slot = slot;
      v.scrollX = clampScroll(midX - midIdx * slot, slot, n); // keep data midpoint fixed
      markZoomed();
      drawRef.current();
    };

    const draw = () => {
      const p = propsRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth;
      const h = p.height ?? Math.max(240, wrap.clientHeight);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const pw = plotW();
      const volH = Math.floor(h * 0.24);
      const priceH = h - PAD_B - PAD_T - volH - PANE_GAP;
      priceHRef.current = priceH;
      const volTop = PAD_T + priceH + PANE_GAP;
      const v = viewRef.current;
      const slot = v.slot;
      const x = (i: number) => v.scrollX + i * slot + slot / 2;
      const bodyW = Math.max(1, Math.min(slot * 0.7, 22));

      const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
      bgGrad.addColorStop(0, "#0c1014");
      bgGrad.addColorStop(1, "#090c0f");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      const data = dataOf();
      const n = data.length;
      if (n === 0) {
        ctx.fillStyle = AXIS;
        ctx.font = "13px system-ui";
        ctx.fillText("Load a session to begin the replay.", 16, 40);
        return;
      }

      // visible window
      const i0 = Math.max(0, Math.floor((0 - v.scrollX) / slot));
      const i1 = Math.min(n - 1, Math.ceil((pw - v.scrollX) / slot));
      const d0 = Math.max(0, i0 - 1), d1 = Math.min(n - 1, i1 + 1);

      let lo = Infinity, hi = -Infinity, vMax = 0;
      for (let i = i0; i <= i1; i++) {
        const c = data[i];
        lo = Math.min(lo, c.l); hi = Math.max(hi, c.h);
        vMax = Math.max(vMax, c.v);
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      const pad = (hi - lo) * 0.08 || 1;
      hi += pad; lo -= pad;
      // Manual vertical pan (drag up/down): shifts the price window. Reset
      // by double-click / Reset zoom / new session.
      const range = hi - lo;
      const shift = Math.max(-range * 2, Math.min(range * 2, viewRef.current.priceShift));
      lo += shift; hi += shift;
      const y = (pr: number) => PAD_T + (1 - (pr - lo) / (hi - lo)) * priceH;
      const histN = Math.min(p.historyCount, n);

      // volume pane backdrop + separator
      ctx.fillStyle = "rgba(148, 163, 184, 0.03)";
      ctx.fillRect(0, volTop, pw, volH + PAD_B);
      ctx.strokeStyle = "rgba(148, 163, 184, 0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, volTop + 0.5); ctx.lineTo(pw, volTop + 0.5); ctx.stroke();

      // horizontal grid + price axis (decimals adapt to tight ranges)
      ctx.strokeStyle = GRID; ctx.fillStyle = AXIS;
      ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
      ctx.lineWidth = 1;
      const ticks = 6;
      const tickStep = (hi - lo) / ticks;
      const dec = tickStep >= 0.05 ? 2 : tickStep >= 0.005 ? 3 : 4;
      for (let i = 0; i <= ticks; i++) {
        const pr = lo + ((hi - lo) * i) / ticks;
        const yy = Math.round(y(pr)) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(pw, yy); ctx.stroke();
        ctx.fillText(pr.toFixed(dec), pw + 8, yy + 4);
      }

      // vertical gridlines (~90px rhythm)
      ctx.strokeStyle = "rgba(148, 163, 184, 0.05)";
      const firstGrid = Math.ceil((0 - v.scrollX) / 90);
      for (let gx = firstGrid * 90; gx < pw; gx += 90) {
        const xx = Math.round(gx) + 0.5;
        ctx.beginPath(); ctx.moveTo(xx, PAD_T); ctx.lineTo(xx, volTop + volH); ctx.stroke();
      }

      // time axis: adaptive minute steps, aligned to marks, de-collided
      const stepMin = slot >= 28 ? 1 : slot >= 10 ? 5 : slot >= 3.5 ? 15 : 30;
      ctx.fillStyle = AXIS;
      ctx.textAlign = "center";
      let lastLabelX = -Infinity;
      for (let i = d0; i <= d1; i++) {
        const d = new Date(data[i].t);
        const xx = x(i);
        if (d.getMinutes() % stepMin === 0 && xx - lastLabelX > 56 && xx > 34 && xx < pw - 10) {
          ctx.fillText(formatEtTime(data[i].t), xx, h - 8);
          lastLabelX = xx;
        }
      }
      const lastX = x(i1);
      if (lastX - lastLabelX > 40 && lastX < pw - 20) {
        ctx.fillStyle = "#a9bcc9";
        ctx.fillText(formatEtTime(data[i1].t), lastX, h - 8);
      }
      ctx.textAlign = "left";

      // watermark when leading candles are simulated premarket context
      if (data.some((c) => c.syn)) {
        ctx.font = "600 10px ui-monospace, monospace";
        const label = "SIMULATED PREMARKET CONTEXT";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(251, 191, 36, 0.10)";
        ctx.strokeStyle = "rgba(251, 191, 36, 0.45)";
        ctx.lineWidth = 1;
        const bx = 8, by = PAD_T + 4, bw = tw + 16, bh = 20;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 6);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = "rgba(251, 191, 36, 0.9)";
        ctx.fillText(label, bx + 8, by + 13.5);
      }

      // volume bars — same x-mapping as candles, always aligned
      for (let i = d0; i <= d1; i++) {
        const c = data[i];
        const vh = vMax > 0 ? Math.max(1, (c.v / vMax) * (volH - 4)) : 0;
        ctx.globalAlpha = i < histN ? 0.28 : 1;
        ctx.fillStyle = c.c >= c.o ? "rgba(46,189,133,0.55)" : "rgba(246,70,93,0.55)";
        ctx.fillRect(x(i) - bodyW / 2, volTop + volH - vh, bodyW, vh);
      }
      ctx.globalAlpha = 1;

      // candles
      for (let i = d0; i <= d1; i++) {
        const c = data[i];
        const isUp = c.c >= c.o;
        const col = isUp ? UP : DOWN;
        const cx = x(i);
        const dimmed = i < histN;
        ctx.globalAlpha = dimmed ? 0.42 : 1;
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1, bodyW * 0.16);
        ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
        const yo = y(c.o), yc = y(c.c);
        const top = Math.min(yo, yc);
        const bh = Math.max(1.5, Math.abs(yc - yo));
        ctx.fillStyle = col;
        if (i === n - 1 && !dimmed) { ctx.shadowColor = col; ctx.shadowBlur = 10; }
        ctx.fillRect(cx - bodyW / 2, top, bodyW, bh);
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;

      const pill = (text: string, color: string, yy: number) => {
        ctx.font = "600 10.5px ui-monospace, monospace";
        const tw = ctx.measureText(text).width;
        const pw2 = tw + 14, ph = 18;
        const px = 6, py = Math.max(PAD_T + 2, Math.min(PAD_T + priceH - ph - 2, yy - ph - 4));
        ctx.fillStyle = "rgba(6,10,12,0.9)";
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(px, py, pw2, ph, 9);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(text, px + 7, py + 12.5);
      };

      const hline = (price: number, color: string, label: string, dashed = true) => {
        const yy = y(price);
        if (yy < PAD_T || yy > PAD_T + priceH) return;
        ctx.strokeStyle = color; ctx.lineWidth = 1.2;
        ctx.setLineDash(dashed ? [6, 4] : []);
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(pw, yy); ctx.stroke();
        ctx.setLineDash([]);
        pill(label, color, yy);
      };

      const ov = p.overlays;
      if (ov.hod != null) hline(ov.hod, HOD_COLOR, `HOD ${ov.hod.toFixed(2)}`);
      if (ov.stopLoss != null) hline(ov.stopLoss, DOWN, `SL ${ov.stopLoss.toFixed(2)}`);
      if (ov.takeProfit != null) hline(ov.takeProfit, UP, `TP ${ov.takeProfit.toFixed(2)}`);
      // working limit orders: sky-blue dashed lines
      const LMT = "#38bdf8";
      for (const o of ov.pendingOrders) {
        hline(o.price, LMT, `LMT ${o.side === "buy" ? "B" : "S"} ${o.price.toFixed(2)}`);
      }

      if (ov.lastPrice != null) {
        const pr = ov.lastPrice;
        const yy = Math.max(PAD_T, Math.min(PAD_T + priceH, y(pr)));
        const lastC = data[n - 1];
        const tagCol = pr >= lastC.o ? UP : DOWN;
        ctx.strokeStyle = tagCol; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, Math.round(yy) + 0.5); ctx.lineTo(pw, Math.round(yy) + 0.5); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        const label = pr.toFixed(2);
        ctx.font = "700 11.5px ui-monospace, monospace";
        const tw = ctx.measureText(label).width;
        const pw2 = tw + 14, ph = 22;
        const py = Math.max(2, Math.min(h - ph - 2, yy - ph / 2));
        ctx.fillStyle = tagCol;
        ctx.shadowColor = tagCol; ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.roundRect(pw + 2, py, PAD_R - 5, ph, 5);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, pw + 9, py + 15);
        // Webull-style countdown: time left in the forming candle, pinned
        // just under the last-price tag in the axis.
        if (ov.countdown) {
          ctx.font = "700 11px ui-monospace, monospace";
          const ctw = ctx.measureText(ov.countdown).width;
          const cph = 20, cpw = ctw + 14;
          const cpy = Math.max(2, Math.min(h - cph - 2, py + ph + 4));
          ctx.fillStyle = "rgba(10, 14, 20, 0.92)";
          ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(pw + 2, cpy, PAD_R - 5, cph, 5);
          ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#e2e8f0";
          ctx.fillText(ov.countdown, pw + 2 + (PAD_R - 5 - ctw) / 2, cpy + 14);
        }
      }

      for (const f of ov.fills) {
        if (f.candleIndex < d0 - 2 || f.candleIndex > d1 + 2 || f.candleIndex >= n) continue;
        const cx = x(f.candleIndex);
        const c = data[f.candleIndex];
        if (f.side === "buy") {
          const yy = y(c.l) + 12;
          ctx.fillStyle = UP;
          ctx.beginPath(); ctx.moveTo(cx, yy); ctx.lineTo(cx - 5, yy + 8); ctx.lineTo(cx + 5, yy + 8); ctx.closePath(); ctx.fill();
        } else {
          const yy = y(c.h) - 12;
          ctx.fillStyle = DOWN;
          ctx.beginPath(); ctx.moveTo(cx, yy); ctx.lineTo(cx - 5, yy - 8); ctx.lineTo(cx + 5, yy - 8); ctx.closePath(); ctx.fill();
        }
      }
    };
    drawRef.current = draw;

    // ---- interactions ----
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, Math.pow(1.0015, -e.deltaY));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; midX: number } | null = null;
    let drag: { x: number; y: number; scrollX: number; priceShift: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
      const rect = canvas.getBoundingClientRect();
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = {
          dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          midX: (a.x + b.x) / 2 - rect.left,
        };
        drag = null;
      } else if (pointers.size === 1) {
        drag = { x: e.clientX, y: e.clientY, scrollX: viewRef.current.scrollX, priceShift: viewRef.current.priceShift };
        canvas.style.cursor = "grabbing";
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const rect = canvas.getBoundingClientRect();
      const n = dataOf().length;
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const midX = (a.x + b.x) / 2 - rect.left;
        if (dist !== pinch.dist) {
          zoomAt(midX, dist / pinch.dist);
          pinch = { dist, midX };
        }
      } else if (pointers.size === 1 && drag) {
        const v = viewRef.current;
        // Grab-style (Webull/TradingView): the candles follow your cursor.
        // Drag left to pull the live edge toward the center/left of the
        // screen. Hard clamp: the chart stays exactly where you leave it.
        v.scrollX = clampScroll(drag.scrollX + (e.clientX - drag.x), v.slot, n);
        // Vertical drag pans the price scale (grab-style: content follows
        // the cursor). Convert pixels to price using the last drawn range.
        const dy = e.clientY - drag.y;
        if (dy !== 0 && priceHRef.current > 0) {
          const p = propsRef.current;
          const data = p.candles.slice(0, Math.max(0, Math.min(p.revealedCount, p.candles.length)));
          let vlo = Infinity, vhi = -Infinity;
          for (const c of data) { if (c.l < vlo) vlo = c.l; if (c.h > vhi) vhi = c.h; }
          if (isFinite(vlo) && vhi > vlo) {
            v.priceShift = drag.priceShift + (dy / priceHRef.current) * (vhi - vlo);
          }
        }
        markZoomed();
        drawRef.current();
      }
    };
    const endPointer = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        drag = null;
        canvas.style.cursor = "grab";
        // No snap-back: the chart stays exactly where the user left it.
      }
    };
    const onDblClick = () => { fitViewRef.current(); drawRef.current(); };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("dblclick", onDblClick);

    const ro = new ResizeObserver(() => {
      if (!userZoomedRef.current) fitViewRef.current();
      drawRef.current();
    });
    ro.observe(wrap);

    draw();
    return () => {
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      canvas.removeEventListener("dblclick", onDblClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to data/prop changes: refit on a new session, keep the live
  // edge pinned while playing (unless the user zoomed/panned away).
  useEffect(() => {
    const n = Math.max(0, Math.min(revealedCount, candles.length));
    const prevN = prevNRef.current;
    if (prevKeyRef.current !== sessionKey) {
      prevKeyRef.current = sessionKey;
      fitViewRef.current(); // fresh session (ticker/date/source reload)
    } else if (prevNRef.current === 0 || n < prevN - 5) {
      fitViewRef.current();
    } else if (n > prevN && userZoomedRef.current) {
      // New candles arrived while panned: keep the live edge's screen
      // position (Webull-style follow). If the user dragged the forming
      // candles to the center, they stay centered as new ones form.
      const w = (wrapRef.current?.clientWidth ?? 800) - 68;
      const v = viewRef.current;
      const prevLiveX = (prevN - 1) * v.slot + v.scrollX;
      const gap = w - prevLiveX; // empty space that was right of the live edge
      if (gap >= -v.slot * 1.5 && gap <= w * 0.65) {
        const m = w * 0.6;
        const target = w - gap - (n - 1) * v.slot;
        v.scrollX = Math.min(m, Math.max(w - n * v.slot - m, target));
      }
      // else: user panned far from the live edge — leave the view alone.
    } else if (n > prevN && !userZoomedRef.current) {
      fitViewRef.current();
    }
    prevNRef.current = n;
    drawRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, revealedCount, overlays, height, sessionKey]);

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", position: "relative", minHeight: 240 }}>
      <canvas ref={canvasRef} style={{ touchAction: "none", cursor: "grab", display: "block" }} />
      {canReset && (
        <button
          onClick={() => { fitViewRef.current(); drawRef.current(); }}
          title="Reset zoom (or double-click the chart)"
          style={{
            position: "absolute", top: 8, right: 76,
            background: "rgba(10, 15, 18, 0.85)", color: "#a9bcc9",
            border: "1px solid rgba(148, 163, 184, 0.25)", borderRadius: 8,
            fontSize: 11, padding: "5px 10px", cursor: "pointer",
          }}
        >
          Reset zoom
        </button>
      )}
    </div>
  );
}
