"use client";

/**
 * Time & Sales panel for Breakout Recognition drills.
 *
 * Displays SIMULATED trade prints derived from the scenario's deterministic
 * event timeline. Aggressor side is inferred from scenario rules, not real
 * market data — the "SIMULATED" badge is mandatory and must not be removed.
 */
import { useEffect, useRef } from "react";
import type { TradePrint } from "../lib/drills/orderflow";

interface Props {
  /** Newest prints first. Parent manages the rolling window. */
  prints: TradePrint[];
  maxRows?: number;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export default function TimeSalesPanel({ prints, maxRows = 30 }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const rows = prints.slice(0, maxRows);

  // Auto-scroll to newest (top)
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [prints.length]);

  return (
    <div className="drill-panel">
      <div className="drill-panel-header">
        <span>Time &amp; Sales</span>
        <span className="sim-badge">SIMULATED</span>
      </div>
      <div className="ts-rows" ref={listRef}>
        {rows.length === 0 && (
          <div className="drill-panel-empty">Waiting for prints…</div>
        )}
        {rows.map((p, i) => (
          <div key={`${p.timestamp}-${i}`} className={`ts-row ${p.side}`}>
            <span className="ts-time">{fmtTime(p.timestamp)}</span>
            <span className="ts-price">{p.price.toFixed(2)}</span>
            <span className="ts-size">{p.size.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
