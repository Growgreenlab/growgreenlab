/**
 * PsychologyGuardPanel — Position-based loss guard.
 * Shows account, position baseline, live P&L, loss %, and lockout status.
 * No allocation concept; the $100k account is unchanged.
 */
"use client";

import { useState } from "react";
import type { GuardThreshold, PositionBaseline, LockoutState } from "../lib/psychGuard";
import { DEFAULT_THRESHOLDS, formatCountdown } from "../lib/psychGuard";

interface Props {
  accountBalance: number;
  baseline: PositionBaseline | null;
  positionQty: number;
  positionAvg: number;
  positionPnl: number | null;
  lossPct: number | null;
  lockout: LockoutState | null;
  warned: boolean;
  thresholds: GuardThreshold[];
  onThresholdsChange: (t: GuardThreshold[]) => void;
}

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PsychologyGuardPanel({
  accountBalance,
  baseline,
  positionQty,
  positionAvg,
  positionPnl,
  lossPct,
  lockout,
  warned,
  thresholds,
  onThresholdsChange,
}: Props) {
  const [showConfig, setShowConfig] = useState(false);

  const now = Date.now();
  const locked = lockout != null && lockout.expiry > now;
  const remaining = locked ? lockout.expiry - now : 0;

  const statusColor = locked ? "#f6465d" : warned ? "#f59e0b" : "#2ebd85";
  const statusText = locked
    ? `Locked — new entries blocked`
    : warned
      ? `Warning — approaching lockout`
      : baseline
        ? "Monitoring"
        : "No open position";

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Psychology Guard</h3>
        <span
          className="badge"
          style={{ background: statusColor + "22", color: statusColor, border: `1px solid ${statusColor}55` }}
        >
          {statusText}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: 13 }}>
        <span className="dim">Account</span>
        <span style={{ textAlign: "right" }}>{money(accountBalance)}</span>

        {baseline ? (
          <>
            <span className="dim">Position</span>
            <span style={{ textAlign: "right" }}>{positionQty} sh @ {money(positionAvg)}</span>
            <span className="dim">Initial value</span>
            <span style={{ textAlign: "right" }}>{money(baseline.value)}</span>
            <span className="dim">Position P&L</span>
            <span style={{ textAlign: "right", color: (positionPnl ?? 0) >= 0 ? "#2ebd85" : "#f6465d" }}>
              {(positionPnl ?? 0) >= 0 ? "+" : ""}{money(positionPnl ?? 0)}
            </span>
            <span className="dim">Position loss</span>
            <span style={{ textAlign: "right", color: (lossPct ?? 0) >= 5 ? "#f6465d" : "inherit" }}>
              {(lossPct ?? 0).toFixed(2)}%
            </span>
          </>
        ) : (
          <span className="dim" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "8px 0" }}>
            Open a position to start monitoring.
          </span>
        )}

        {locked && (
          <>
            <span className="dim">Cooldown</span>
            <span style={{ textAlign: "right", color: "#f6465d", fontWeight: 600 }}>
              {formatCountdown(remaining)} remaining
            </span>
            <span className="dim" style={{ gridColumn: "1 / -1", fontSize: 12 }}>
              Triggered at {lockout.threshold}% loss. Exits still allowed.
            </span>
          </>
        )}
      </div>

      <button
        onClick={() => (showConfig ? setShowConfig(false) : setShowConfig(true))}
        style={{ marginTop: 8, fontSize: 12, background: "none", border: "none", color: "#38bdf8", cursor: "pointer", padding: 0 }}
      >
        {showConfig ? "Hide thresholds" : "Configure thresholds"}
      </button>

      {showConfig && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          {thresholds.map((t, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <span className="dim" style={{ width: 60 }}>Loss ≥</span>
              <span>{t.lossPct}% → {t.lockMinutes === 0 ? "warning" : `${t.lockMinutes} min lock`}</span>
            </div>
          ))}
          <div className="hint" style={{ marginTop: 6, fontSize: 11 }}>
            Highest applicable threshold wins. Cooldowns use real time and survive refresh.
          </div>
        </div>
      )}
    </div>
  );
}
