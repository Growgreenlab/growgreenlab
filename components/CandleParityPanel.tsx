/**
 * CandleParityPanel — DEV-ONLY candle parity diagnostic (investigation branch).
 *
 * Rendered by the replay page ONLY when the URL has ?diag=parity. Invisible
 * and inert otherwise: no layout, no state, no cost in normal use.
 *
 * For a selected candle it shows, side by side:
 *   - Loader OHLCV      (the session array exactly as loaded — Twelve Data /
 *                        CSV / sample output, untouched by the engine)
 *   - Engine OHLCV      (finalized value once the engine has finalized the
 *                        candle; live forming values while it forms)
 *   - Chart-series OHLCV(the exact bars the chart component delivered to its
 *                        series — captured from LwcChart's own push path;
 *                        for the canvas fallback, the props it draws from)
 *   - Webull reference  (manual inputs, persisted to localStorage only —
 *                        never sent anywhere, never treated as truth)
 * plus per-field differences vs the loader and a first-divergent-layer
 * classification. Full-session comparison exports as CSV / JSON.
 */
"use client";

import { useMemo, useState } from "react";
import type { Candle, SessionMeta } from "../lib/types";
import type { ReplayEngine } from "../lib/engine";
import { formatEtTime } from "../lib/marketData";

interface Props {
  meta: SessionMeta;
  candles: Candle[];
  getEngine: () => ReplayEngine | null;
  getChartBars: () => Candle[];
  chartKind: "lwc" | "canvas";
}

type LayerVals = { o: number; h: number; l: number; c: number; v: number } | null;
type WebullRef = { o: string; h: string; l: string; c: string; v: string };

const EMPTY_REF: WebullRef = { o: "", h: "", l: "", c: "", v: "" };
const FIELDS = ["o", "h", "l", "c", "v"] as const;

function vals(c: Candle | undefined | null): LayerVals {
  return c ? { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v } : null;
}
function refVals(r: WebullRef): LayerVals {
  const n = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const o = { o: n(r.o), h: n(r.h), l: n(r.l), c: n(r.c), v: n(r.v) };
  return FIELDS.some((f) => Number.isFinite(o[f])) ? (o as LayerVals) : null;
}
/** diff of a layer vs loader, per field; NaN where either side is absent. */
function diffs(layer: LayerVals, loader: LayerVals): Record<(typeof FIELDS)[number], number> {
  const out = {} as Record<(typeof FIELDS)[number], number>;
  for (const f of FIELDS) out[f] = layer && loader ? layer[f] - loader[f] : NaN;
  return out;
}
const sameVals = (a: LayerVals, b: LayerVals) =>
  a && b && FIELDS.every((f) => a[f] === b[f]);

export default function CandleParityPanel({ meta, candles, getEngine, getChartBars, chartKind }: Props) {
  const eng = getEngine();
  const chartBars = getChartBars();
  const lastFinalized = eng ? eng.index : -1;
  const [picked, setPicked] = useState<number | null>(null);
  const [timeInput, setTimeInput] = useState("");
  const idx = Math.max(0, Math.min(picked ?? Math.max(0, lastFinalized), candles.length - 1));

  const storeKey = `ggl-parity-webull:${meta.ticker}:${meta.tradeDate}`;
  const [refs, setRefs] = useState<Record<string, WebullRef>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? "{}") as Record<string, WebullRef>;
    } catch {
      return {};
    }
  });
  const loader = candles[idx];
  const ref: WebullRef = (loader && refs[String(loader.t)]) || EMPTY_REF;
  const setRef = (r: WebullRef) => {
    if (!loader) return;
    const next = { ...refs, [String(loader.t)]: r };
    setRefs(next);
    try {
      localStorage.setItem(storeKey, JSON.stringify(next));
    } catch { /* storage unavailable */ }
  };

  const chartByTime = useMemo(() => new Map(chartBars.map((b) => [b.t, b])), [chartBars]);

  const engineState = (i: number): { kind: "finalized" | "forming" | "pending"; v: LayerVals } => {
    if (!eng) return { kind: "pending", v: null };
    if (i <= eng.index) return { kind: "finalized", v: vals(eng.revealed[i]) };
    const dc = eng.displayCandles;
    if (i === eng.index + 1 && dc.length === eng.index + 2) return { kind: "forming", v: vals(dc[dc.length - 1]) };
    return { kind: "pending", v: null };
  };

  const classify = (i: number): string => {
    const L = vals(candles[i]);
    const E = engineState(i);
    const C = vals(chartByTime.get(candles[i].t));
    const W = refVals(refs[String(candles[i].t)] ?? EMPTY_REF);
    if (E.kind === "finalized" && !sameVals(E.v, L)) return "ENGINE BUG";
    if (E.kind === "finalized" && C && !sameVals(C, L)) return "RENDERER BUG";
    if (W) {
      const complete = FIELDS.every((f) => Number.isFinite(W[f]));
      if (complete && !sameVals(W, L)) return "PROVIDER DIFFERENCE";
      if (!complete && FIELDS.some((f) => Number.isFinite(W[f]) && W[f] !== (L as LayerVals)![f]))
        return "PROVIDER DIFFERENCE (partial reference)";
    }
    if (E.kind === "pending") return "UNRESOLVED — candle not reached yet";
    if (E.kind === "forming") return "NO DIVERGENCE — forming (synthetic path, in progress)";
    return "NO DIVERGENCE in-pipeline";
  };

  const buildRows = () =>
    candles.map((c, i) => {
      const E = engineState(i);
      const C = vals(chartByTime.get(c.t));
      const W = refVals(refs[String(c.t)] ?? EMPTY_REF);
      return {
        index: i,
        timeEt: formatEtTime(c.t),
        timestampMs: c.t,
        loader: vals(c),
        engine: E.v,
        engineState: E.kind,
        chart: C,
        webull: W,
        diffEngine: diffs(E.kind === "finalized" ? E.v : null, vals(c)),
        diffChart: diffs(C, vals(c)),
        diffWebull: diffs(W, vals(c)),
        classification: classify(i),
      };
    });

  const download = (kind: "csv" | "json") => {
    const rows = buildRows();
    let body: string;
    if (kind === "json") {
      body = JSON.stringify({ symbol: meta.ticker, date: meta.tradeDate, source: meta.source, chartKind, rows }, null, 2);
    } else {
      const head = "index,time_et,loader_o,loader_h,loader_l,loader_c,loader_v,engine_state,engine_o,engine_h,engine_l,engine_c,engine_v,chart_o,chart_h,chart_l,chart_c,chart_v,webull_o,webull_h,webull_l,webull_c,webull_v,d_chart_h,d_chart_l,d_chart_c,d_webull_l,d_webull_c,d_webull_v,classification";
      const cell = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? "" : String(v));
      body = [head, ...rows.map((r) => [
        r.index, r.timeEt,
        cell(r.loader?.o), cell(r.loader?.h), cell(r.loader?.l), cell(r.loader?.c), cell(r.loader?.v),
        r.engineState,
        cell(r.engine?.o), cell(r.engine?.h), cell(r.engine?.l), cell(r.engine?.c), cell(r.engine?.v),
        cell(r.chart?.o), cell(r.chart?.h), cell(r.chart?.l), cell(r.chart?.c), cell(r.chart?.v),
        cell(r.webull?.o), cell(r.webull?.h), cell(r.webull?.l), cell(r.webull?.c), cell(r.webull?.v),
        cell(r.diffChart.h), cell(r.diffChart.l), cell(r.diffChart.c),
        cell(r.diffWebull.l), cell(r.diffWebull.c), cell(r.diffWebull.v),
        r.classification,
      ].join(","))].join("\n");
    }
    const blob = new Blob([body], { type: kind === "json" ? "application/json" : "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `parity-${meta.ticker}-${meta.tradeDate}.${kind}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!loader || !eng) return null;
  const L = vals(loader)!;
  const E = engineState(idx);
  const C = vals(chartByTime.get(loader.t));
  const W = refVals(ref);
  const dE = diffs(E.kind === "finalized" ? E.v : null, L);
  const dC = diffs(C, L);
  const dW = diffs(W, L);
  const classification = classify(idx);

  const num = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));
  const dnum = (v: number) => (Number.isNaN(v) ? "—" : v === 0 ? "0" : v.toFixed(4));
  const rowStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "86px repeat(5, 1fr)", gap: 4, fontFamily: "monospace", fontSize: 11 };
  const jumpToTime = () => {
    const i = candles.findIndex((c) => formatEtTime(c.t) === timeInput.trim());
    if (i >= 0) setPicked(i);
  };

  return (
    <div
      style={{
        position: "fixed", right: 12, bottom: 12, zIndex: 100, width: 460, maxWidth: "94vw",
        maxHeight: "82vh", overflowY: "auto", background: "rgba(10,15,25,0.96)",
        border: "1px solid rgba(250,200,80,0.5)", borderRadius: 8, padding: "10px 12px",
        fontSize: 12, color: "#e2e8f0",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <strong style={{ color: "#facc15" }}>Candle Parity Diagnostic — dev only</strong>
        <span style={{ color: "#8b98a9" }}>{chartKind.toUpperCase()}</span>
      </div>
      <div style={{ color: "#8b98a9", marginBottom: 8 }}>
        {meta.ticker} · {meta.tradeDate} · source: {meta.source} · {candles.length} candles ·
        first {formatEtTime(candles[0].t)} ET · last {formatEtTime(candles[candles.length - 1].t)} ET
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <button onClick={() => setPicked(idx - 1)} disabled={idx <= 0}>‹</button>
        <span style={{ fontFamily: "monospace" }}>
          candle #{idx} · {formatEtTime(loader.t)} ET · {new Date(loader.t).toISOString()}
        </span>
        <button onClick={() => setPicked(idx + 1)} disabled={idx >= candles.length - 1}>›</button>
        <input
          value={timeInput} onChange={(e) => setTimeInput(e.target.value)} placeholder="HH:MM"
          style={{ width: 64, background: "#1e293b", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "2px 6px" }}
        />
        <button onClick={jumpToTime}>Go (ET)</button>
        <button onClick={() => setPicked(lastFinalized)}>Last finalized</button>
      </div>

      <div style={{ ...rowStyle, color: "#8b98a9" }}>
        <span>layer</span><span>O</span><span>H</span><span>L</span><span>C</span><span>V</span>
      </div>
      <div style={rowStyle}><span>Loader</span><span>{num(L.o)}</span><span>{num(L.h)}</span><span>{num(L.l)}</span><span>{num(L.c)}</span><span>{num(L.v)}</span></div>
      <div style={rowStyle}><span>Engine ({E.kind})</span><span>{num(E.v?.o)}</span><span>{num(E.v?.h)}</span><span>{num(E.v?.l)}</span><span>{num(E.v?.c)}</span><span>{num(E.v?.v)}</span></div>
      <div style={rowStyle}><span>Δ engine</span><span>{dnum(dE.o)}</span><span>{dnum(dE.h)}</span><span>{dnum(dE.l)}</span><span>{dnum(dE.c)}</span><span>{dnum(dE.v)}</span></div>
      <div style={rowStyle}><span>Chart series</span><span>{num(C?.o)}</span><span>{num(C?.h)}</span><span>{num(C?.l)}</span><span>{num(C?.c)}</span><span>{num(C?.v)}</span></div>
      <div style={rowStyle}><span>Δ chart</span><span>{dnum(dC.o)}</span><span>{dnum(dC.h)}</span><span>{dnum(dC.l)}</span><span>{dnum(dC.c)}</span><span>{dnum(dC.v)}</span></div>
      <div style={rowStyle}><span>Webull ref</span><span>{num(W?.o)}</span><span>{num(W?.h)}</span><span>{num(W?.l)}</span><span>{num(W?.c)}</span><span>{num(W?.v)}</span></div>
      <div style={rowStyle}><span>Δ Webull</span><span>{dnum(dW.o)}</span><span>{dnum(dW.h)}</span><span>{dnum(dW.l)}</span><span>{dnum(dW.c)}</span><span>{dnum(dW.v)}</span></div>

      <div style={{ marginTop: 8 }}>
        <span style={{ color: "#8b98a9" }}>Webull reference for this candle (manual, localStorage only): </span>
        <span style={{ display: "inline-flex", gap: 4 }}>
          {FIELDS.map((f) => (
            <input
              key={f} value={ref[f]} placeholder={f.toUpperCase()}
              onChange={(e) => setRef({ ...ref, [f]: e.target.value })}
              style={{ width: 58, background: "#1e293b", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "2px 4px" }}
            />
          ))}
        </span>
      </div>

      <div style={{ marginTop: 8, fontWeight: 700, color: classification.includes("BUG") ? "#f6465d" : classification.includes("PROVIDER") ? "#facc15" : "#2ebd85" }}>
        Classification: {classification}
      </div>
      <div style={{ color: "#8b98a9", marginTop: 2 }}>
        Engine state: {E.kind}. Forming values are the synthetic intrabar path (in progress) — only
        finalized candles are authoritative. Δ rows are layer − loader.
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button onClick={() => download("csv")}>Export comparison CSV</button>
        <button onClick={() => download("json")}>Export comparison JSON</button>
      </div>
    </div>
  );
}
