"use client";

import { useState } from "react";
import type { Fill } from "../lib/types";
import { formatMoney, formatSigned } from "../lib/engine";

export interface TradingSnapshot {
  price: number;
  cash: number;
  qty: number;
  avg: number;
  unreal: number;
  realized: number;
  equity: number;
  fills: Fill[];
  stopLoss: number | null;
  takeProfit: number | null;
}

interface Props {
  snap: TradingSnapshot;
  onBuy: (qty: number) => string | null;
  onSell: (qty: number) => string | null;
  onSetBrackets: (sl: number | null, tp: number | null) => void;
  disabled: boolean;
}

export default function TradingPanel({ snap, onBuy, onSell, onSetBrackets, disabled }: Props) {
  const [qty, setQty] = useState("100");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const doBuy = () => {
    const err = onBuy(Number(qty));
    setMsg(err ?? `Bought ${qty} @ ${formatMoney(snap.price)} (simulated)`);
  };
  const doSell = () => {
    const err = onSell(Number(qty));
    setMsg(err ?? `Sold ${qty} @ ${formatMoney(snap.price)} (simulated)`);
  };
  const applyBrackets = () => {
    onSetBrackets(sl ? Number(sl) : null, tp ? Number(tp) : null);
    setMsg("Stop-loss / take-profit updated.");
  };

  return (
    <div className="card">
      <h3>
        Simulated trading{" "}
        <span className="badge sim" style={{ marginLeft: 6 }}>
          Simulated — not real orders
        </span>
      </h3>
      <div className="tiles">
        <div className="tile">
          <div className="tk">Cash</div>
          <div className="tv num">{formatMoney(snap.cash)}</div>
        </div>
        <div className="tile">
          <div className="tk">Position</div>
          <div className="tv num">{snap.qty} <span style={{ fontSize: 12, color: "var(--muted)" }}>sh</span></div>
          <div className="hint num" style={{ fontSize: 11 }}>{snap.qty > 0 ? `@ ${formatMoney(snap.avg)}` : "flat"}</div>
        </div>
        <div className="tile">
          <div className="tk">Unrealized</div>
          <div className={`tv num ${snap.unreal >= 0 ? "pos" : "neg"}`}>{formatSigned(snap.unreal)}</div>
        </div>
        <div className="tile">
          <div className="tk">Realized</div>
          <div className={`tv num ${snap.realized >= 0 ? "pos" : "neg"}`}>{formatSigned(snap.realized)}</div>
        </div>
        <div className="tile hero-tile">
          <div className="tk">Equity</div>
          <div className="tv num">{formatMoney(snap.equity)}</div>
        </div>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>Share quantity</label>
        <input className="input num" type="number" min="1" step="1" value={qty}
          onChange={(e) => setQty(e.target.value)} disabled={disabled} />
      </div>
      <div className="row">
        <button className="btn buy big" onClick={doBuy} disabled={disabled}>Buy</button>
        <button className="btn sell big" onClick={doSell} disabled={disabled || snap.qty <= 0}>Sell</button>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Stop-loss</label>
          <input className="input num" type="number" step="0.01" placeholder="e.g. 5.20"
            value={sl} onChange={(e) => setSl(e.target.value)} disabled={disabled} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Take-profit</label>
          <input className="input num" type="number" step="0.01" placeholder="e.g. 5.80"
            value={tp} onChange={(e) => setTp(e.target.value)} disabled={disabled} />
        </div>
      </div>
      <button className="btn" style={{ marginTop: 8, width: "100%" }} onClick={applyBrackets} disabled={disabled}>
        Set brackets
      </button>
      {(snap.stopLoss != null || snap.takeProfit != null) && (
        <div className="hint" style={{ marginTop: 6 }}>
          Active: {snap.stopLoss != null ? `SL ${formatMoney(snap.stopLoss)}` : ""}{" "}
          {snap.takeProfit != null ? `TP ${formatMoney(snap.takeProfit)}` : ""} — auto-triggers as candles advance.
        </div>
      )}
      {msg && <div className="hint" style={{ marginTop: 8 }}>{msg}</div>}

      <h3 style={{ marginTop: 16 }}>Trade ledger</h3>
      {snap.fills.length === 0 ? (
        <div className="hint">No fills yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="ledger">
            <thead><tr><th>Side</th><th>Qty</th><th>Price</th><th>P/L</th><th>Note</th></tr></thead>
            <tbody>
              {snap.fills.slice().reverse().map((f) => (
                <tr key={f.id}>
                  <td style={{ color: f.side === "buy" ? "var(--green)" : "var(--red)" }}>{f.side.toUpperCase()}</td>
                  <td className="num">{f.qty}</td>
                  <td className="num">{formatMoney(f.price)}</td>
                  <td className={`num ${f.realizedPnl >= 0 ? "pos" : "neg"}`}>
                    {f.side === "sell" ? formatSigned(f.realizedPnl) : "—"}
                  </td>
                  <td>{f.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
