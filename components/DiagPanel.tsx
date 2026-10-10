/**
 * DiagPanel — visible freeze diagnostics overlay.
 * Shows live pipeline health; detects freezes and offers a copyable report.
 */
"use client";

import { useEffect, useState } from "react";
import { diag, freezeReport, resetDiag } from "../lib/diag";

interface Props {
  playing: boolean;
  candleIndex: number;
  formationProgress: number;
  speed: number;
}

export default function DiagPanel({ playing, candleIndex, formationProgress, speed }: Props) {
  const [, setTick] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    resetDiag();
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  const now = performance.now();
  const timerDead = playing && diag.lastTimerFire !== null && now - diag.lastTimerFire > 2000;
  const engineStuck = playing && diag.lastTick !== null && now - diag.lastTick > 3000 && !timerDead;
  const chartStuck =
    playing && diag.lastChartUpdate !== null && now - diag.lastChartUpdate > 3000 && !timerDead && !engineStuck;
  const frozen = timerDead || engineStuck || chartStuck;

  const copy = async () => {
    const report = freezeReport({ playing, candleIndex, formationProgress, speed });
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be blocked; show the text
      window.prompt("Copy the freeze report:", report);
    }
  };

  const row = (label: string, value: string, bad?: boolean) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "#8b98a9" }}>{label}</span>
      <span style={{ color: bad ? "#f6465d" : "#e2e8f0", fontFamily: "monospace" }}>{value}</span>
    </div>
  );

  const ago = (t: number | null) =>
    t === null ? "never" : `${((now - t) / 1000).toFixed(1)}s ago`;

  return (
    <div
      style={{
        position: "fixed",
        left: 12,
        bottom: 12,
        zIndex: 100,
        background: frozen ? "rgba(80,10,20,0.95)" : "rgba(10,15,25,0.92)",
        border: `1px solid ${frozen ? "#f6465d" : "rgba(255,255,255,0.14)"}`,
        borderRadius: 8,
        padding: "10px 12px",
        fontSize: 12,
        minWidth: 280,
        maxWidth: 340,
        color: "#e2e8f0",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <strong>{frozen ? "⚠ FREEZE DETECTED" : "Diagnostics"}</strong>
        <button
          onClick={copy}
          style={{
            background: "#1e293b",
            color: "#e2e8f0",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 6,
            padding: "2px 10px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {copied ? "Copied!" : "Copy report"}
        </button>
      </div>
      {frozen && (
        <div style={{ marginBottom: 6, color: "#fda4af", fontSize: 11 }}>
          {timerDead
            ? "Replay timer stopped firing."
            : engineStuck
              ? "Timer fires but engine ticks stopped."
              : "Engine ticks but chart stopped updating."}
        </div>
      )}
      {row("Timer fires", String(diag.timerFires), timerDead)}
      {row("Last timer fire", ago(diag.lastTimerFire), timerDead)}
      {row("Max fire gap", `${diag.maxFireGapMs.toFixed(0)}ms`, diag.maxFireGapMs > 500)}
      {row("Engine ticks", String(diag.tickCalls), engineStuck)}
      {row("Last tick", ago(diag.lastTick), engineStuck)}
      {row("Chart updates", String(diag.chartUpdates), chartStuck)}
      {row("Last chart update", ago(diag.lastChartUpdate), chartStuck)}
      {row("OHLC changes", String(diag.ohlcChanges))}
      {row("Timestamp violations", String(diag.timestampViolations), diag.timestampViolations > 0)}
      {row("Errors", diag.errors.length ? diag.errors[diag.errors.length - 1].slice(0, 60) : "none", diag.errors.length > 0)}
    </div>
  );
}
