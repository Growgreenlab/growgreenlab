/**
 * RiskCalculator — Position sizing panel (Feature #3).
 * Pure estimates; clearly labeled. Short = math only (engine is long-only).
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { calculateRisk } from "../lib/risk";

interface Props {
  currentPrice: number;
  cash: number;
  plannedSL: number | null;
  plannedTP: number | null;
  plannedEntry: number | null;
  activeSL: number | null;
  activeTP: number | null;
  hasPosition: boolean;
  positionAvg: number;
  positionQty: number;
  positionRealized: number;
  unrealizedPnl: number;
  onPlannedChange: (sl: number | null, tp: number | null) => void;
  onActiveChange: (sl: number | null, tp: number | null) => void;
  onApplyBrackets: (sl: number | null, tp: number | null) => void;
  onBuySized: (qty: number) => string | null;
  disabled: boolean;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function RiskCalculator({
  currentPrice,
  cash,
  plannedSL,
  plannedTP,
  plannedEntry,
  activeSL,
  activeTP,
  hasPosition,
  positionAvg,
  positionQty,
  positionRealized,
  unrealizedPnl,
  onPlannedChange,
  onActiveChange,
  onApplyBrackets,
  onBuySized,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState("100000");
  const [riskPct, setRiskPct] = useState("1");
  const [entry, setEntry] = useState("");
  const [entryEdited, setEntryEdited] = useState(false);

  // Auto-expand when a position opens; stay expanded while open.
  useEffect(() => {
    if (hasPosition) setOpen(true);
  }, [hasPosition]);
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [fees, setFees] = useState("0");
  const [slippage, setSlippage] = useState("0");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [msg, setMsg] = useState<string | null>(null);

  // Two-way sync: the source of truth is planned (flat) or active (position).
  // When lines are dragged, props update → inputs follow. When inputs are
  // typed, handlers push to the source. Guard prevents feedback loops.
  const sourceSL = hasPosition ? activeSL : plannedSL;
  const sourceTP = hasPosition ? activeTP : plannedTP;

  useEffect(() => {
    const wantSL = sourceSL != null ? sourceSL.toFixed(2) : "";
    const wantTP = sourceTP != null ? sourceTP.toFixed(2) : "";
    if (sl !== wantSL) setSl(wantSL);
    if (tp !== wantTP) setTp(wantTP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSL, sourceTP, hasPosition]);

  const handleSLInput = (v: string) => {
    // Update local state only while typing; commit on blur to avoid
    // the sync effect overwriting in-progress input (e.g. "3" -> "3.00").
    setSl(v);
  };

  const handleTPInput = (v: string) => {
    setTp(v);
  };

  const commitSL = () => {
    const n = sl === "" ? null : Number(sl);
    if (sl !== "" && (!isFinite(n!) || n! <= 0)) return;
    if (hasPosition) onActiveChange(n, activeTP);
    else onPlannedChange(n, plannedTP);
  };

  const commitTP = () => {
    const n = tp === "" ? null : Number(tp);
    if (tp !== "" && (!isFinite(n!) || n! <= 0)) return;
    if (hasPosition) onActiveChange(activeSL, n);
    else onPlannedChange(plannedSL, n);
  };

  // Entry price source:
  // - Active position: actual average fill from engine (locked, matches ledger).
  // - Planning: user-typed value, else planned entry (captured), else live price.
  //   The field is pre-filled so the source is always visible, never hidden.
  const activeEntry = hasPosition && positionAvg > 0 ? positionAvg : null;

  useEffect(() => {
    if (!hasPosition && !entryEdited) {
      const def = plannedEntry ?? (currentPrice > 0 ? currentPrice : null);
      if (def != null) setEntry(def.toFixed(2));
    }
    if (hasPosition) setEntryEdited(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannedEntry, currentPrice, hasPosition]);

  const effEntry = activeEntry ?? (entry !== "" ? Number(entry) : 0);
  const effSL = sl !== "" ? Number(sl) : null;
  const effTP = tp !== "" ? Number(tp) : null;
  // In active mode, use actual position qty (not suggested size).
  const effQty = hasPosition ? positionQty : undefined;

  const result = useMemo(
    () =>
      calculateRisk({
        balance: Number(balance) || 0,
        riskPct: Number(riskPct) || 0,
        entry: effEntry || 0,
        stopLoss: effSL ?? 0,
        takeProfit: effTP ?? 0,
        fees: Number(fees) || 0,
        slippagePct: Number(slippage) || 0,
        direction,
        fixedQty: effQty,
      }),
    [balance, riskPct, effEntry, effSL, effTP, fees, slippage, direction]
  );

  const applyToChart = () => {
    if (effSL == null || effTP == null) {
      setMsg("Enter SL and TP first.");
      return;
    }
    onApplyBrackets(effSL, effTP);
    setMsg("Brackets applied to chart (planned).");
  };

  const buySized = () => {
    if (!result.valid) {
      setMsg("Fix the errors first.");
      return;
    }
    if (direction === "short") {
      setMsg("Short is calculation-only — the simulator executes long positions.");
      return;
    }
    const err = onBuySized(result.suggestedQty);
    setMsg(err ?? `Bought ${result.suggestedQty} shares (simulated).`);
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder?: string,
    onBlur?: () => void
  ) => (
    <div className="field">
      <label>{label}</label>
      <input
        className="input num"
        type="number"
        step="any"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        disabled={disabled}
      />
    </div>
  );

  return (
    <div className="ws-panel" style={{ marginTop: 8 }}>
      <div
        className="ws-panel-head"
        style={{ cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ws-panel-title">Risk Calculator</span>
        <span className="badge sim">Estimates</span>
        <span style={{ marginLeft: "auto", opacity: 0.7 }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ padding: "0 2px" }}>
          <div className="field-row">
            {field("Balance $", balance, setBalance)}
            {field("Risk %", riskPct, setRiskPct)}
          </div>
          <div className="field-row" style={{ marginTop: 6 }}>
            {hasPosition ? (
              <div className="field">
                <label>Entry $ (avg fill)</label>
                <input
                  className="input num"
                  type="text"
                  value={activeEntry != null ? activeEntry.toFixed(2) : "—"}
                  disabled
                  readOnly
                  style={{ opacity: 0.8 }}
                />
              </div>
            ) : (
              field("Entry $ (planned)", entry, (v) => { setEntry(v); setEntryEdited(true); }, currentPrice ? currentPrice.toFixed(2) : "—", () => {})
            )}
            <div className="field">
              <label>Direction</label>
              <div style={{ display: "flex", gap: 4 }}>
                {(["long", "short"] as const).map((d) => (
                  <button
                    key={d}
                    className={`btn ${direction === d ? "" : "ghost"}`}
                    style={{ flex: 1, padding: "4px 0", fontSize: 12 }}
                    onClick={() => setDirection(d)}
                    disabled={disabled}
                  >
                    {d === "long" ? "Long" : "Short"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="field-row" style={{ marginTop: 6 }}>
            {field("Stop-loss $", sl, handleSLInput, "—", commitSL)}
            {field("Take-profit $", tp, handleTPInput, "—", commitTP)}
          </div>
          <div className="field-row" style={{ marginTop: 6 }}>
            {field("Fees $", fees, setFees)}
            {field("Slippage %", slippage, setSlippage)}
          </div>

          {result.errors.length > 0 ? (
            <div className="hint" style={{ marginTop: 8, color: "#f6465d" }}>
              {result.errors.map((e, i) => (
                <div key={i}>• {e}</div>
              ))}
            </div>
          ) : (
            result.valid && (
              <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.7 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">Entry {hasPosition ? "(avg fill)" : "(planned)"}</span>
                  <b>{money(effEntry)}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">{hasPosition ? "Position size" : "Suggested size"}</span>
                  <b>{result.suggestedQty.toLocaleString()} sh</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">Risk / share</span>
                  <span>{money(result.stopDistance)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">Reward / share</span>
                  <span>{money(Math.abs((effTP ?? 0) - effEntry))}</span>
                </div>
                {!hasPosition && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className="dim">Risk budget</span>
                    <span>{money(result.riskBudget)}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">Max planned loss*</span>
                  <span style={{ color: "#f6465d" }}>{money(result.maxLoss)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">Potential profit*</span>
                  <span style={{ color: "#2ebd85" }}>{money(result.grossProfit)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">Risk : Reward</span>
                  <b>1 : {result.riskReward.toFixed(2)}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">Buying power needed</span>
                  <span>{money(result.requiredBuyingPower)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">Buying power left</span>
                  <span style={{ color: result.remainingBuyingPower < 0 ? "#f6465d" : undefined }}>
                    {money(result.remainingBuyingPower)}
                  </span>
                </div>
                {hasPosition && (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                      <span className="dim">Realized P&L (sold)</span>
                      <span style={{ color: positionRealized >= 0 ? "#2ebd85" : "#f6465d" }}>
                        {positionRealized >= 0 ? "+" : ""}{money(positionRealized)}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span className="dim">Unrealized P&L (open)</span>
                      <span style={{ color: unrealizedPnl >= 0 ? "#2ebd85" : "#f6465d" }}>
                        {unrealizedPnl >= 0 ? "+" : ""}{money(unrealizedPnl)}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span className="dim"><b>Total P&L</b></span>
                      <b style={{ color: (positionRealized + unrealizedPnl) >= 0 ? "#2ebd85" : "#f6465d" }}>
                        {(positionRealized + unrealizedPnl) >= 0 ? "+" : ""}{money(positionRealized + unrealizedPnl)}
                      </b>
                    </div>
                    <div className="hint" style={{ marginTop: 6, fontSize: 11 }}>
                      Position open — entry and size locked to actual fills. Dragging SL/TP recalculates risk/reward only.
                    </div>
                  </>
                )}
                <div className="hint" style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>
                  *Estimates only. Real fills may differ — gaps and slippage can exceed planned risk.
                </div>
              </div>
            )
          )}

          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button className="btn ghost" style={{ flex: 1 }} onClick={applyToChart} disabled={disabled}>
              Chart SL/TP
            </button>
            <button className="btn" style={{ flex: 1 }} onClick={buySized} disabled={disabled || direction === "short"}>
              Buy {result.valid ? result.suggestedQty : "—"}
            </button>
          </div>
          {direction === "short" && (
            <div className="hint" style={{ marginTop: 6, fontSize: 11 }}>
              Short math shown for planning; the simulator executes long positions only.
            </div>
          )}
          {msg && <div className="hint" style={{ marginTop: 6 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}
