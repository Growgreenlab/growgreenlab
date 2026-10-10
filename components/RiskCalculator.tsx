/**
 * RiskCalculator — Position sizing panel (Feature #3).
 * Pure estimates; clearly labeled. Short = math only (engine is long-only).
 */
"use client";

import { useMemo, useState } from "react";
import { calculateRisk } from "../lib/risk";

interface Props {
  currentPrice: number;
  cash: number;
  plannedSL: number | null;
  plannedTP: number | null;
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
  onApplyBrackets,
  onBuySized,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState("100000");
  const [riskPct, setRiskPct] = useState("1");
  const [entry, setEntry] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [fees, setFees] = useState("0");
  const [slippage, setSlippage] = useState("0");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [msg, setMsg] = useState<string | null>(null);

  // Sync from planned brackets / current price when opened or when they change.
  const effEntry = entry !== "" ? Number(entry) : currentPrice;
  const effSL = sl !== "" ? Number(sl) : plannedSL;
  const effTP = tp !== "" ? Number(tp) : plannedTP;

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
    placeholder?: string
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
            {field("Entry $", entry, setEntry, currentPrice ? currentPrice.toFixed(2) : "—")}
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
            {field("Stop-loss $", sl, setSl, plannedSL != null ? plannedSL.toFixed(2) : "—")}
            {field("Take-profit $", tp, setTp, plannedTP != null ? plannedTP.toFixed(2) : "—")}
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
                  <span className="dim">Suggested size</span>
                  <b>{result.suggestedQty.toLocaleString()} sh</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="dim">Risk budget</span>
                  <span>{money(result.riskBudget)}</span>
                </div>
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
