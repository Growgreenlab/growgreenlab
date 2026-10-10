"use client";

import { useEffect, useState } from "react";
import type { Fill, PendingOrder } from "../lib/types";
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
  pendingOrders: PendingOrder[];
  stopLoss: number | null;
  takeProfit: number | null;
}

interface Props {
  snap: TradingSnapshot;
  qty: string;
  onQtyChange: (qty: string) => void;
  plannedSL: number | null;
  plannedTP: number | null;
  onBuy: (qty: number) => string | null;
  onSell: (qty: number) => string | null;
  onPlaceLimit: (side: "buy" | "sell", qty: number, price: number) => string | null;
  onCancelOrder: (id: number) => void;
  onSetBrackets: (sl: number | null, tp: number | null) => void;
  disabled: boolean;
}

/**
 * Compact Webull-style order entry panel: market/limit toggle, quantity,
 * buy/sell, stop-loss / take-profit brackets, working limit orders, and
 * the fill ledger. Built for a narrow right-hand column.
 */
export default function TradingPanel({ snap, qty, onQtyChange, plannedSL, plannedTP, onBuy, onSell, onPlaceLimit, onCancelOrder, onSetBrackets, disabled }: Props) {
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPx, setLimitPx] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  // clear the "working" notice once the order fills or is cancelled
  useEffect(() => {
    if (snap.pendingOrders.length === 0) {
      setMsg((m) => (m && m.includes("working") ? null : m));
    }
  }, [snap.pendingOrders.length]);

  const effLimit = limitPx ? Number(limitPx) : snap.price;

  const submit = (side: "buy" | "sell") => {
    const q = Number(qty);
    if (orderType === "market") {
      const err = side === "buy" ? onBuy(q) : onSell(q);
      setMsg(err ?? `${side === "buy" ? "Bought" : "Sold"} ${q} @ ${formatMoney(snap.price)} (simulated)`);
    } else {
      const err = onPlaceLimit(side, q, effLimit);
      setMsg(err ?? `Limit ${side} ${q} @ ${formatMoney(effLimit)} working (simulated)`);
      if (!err) setLimitPx("");
    }
  };

  const applyBrackets = () => {
    onSetBrackets(sl ? Number(sl) : null, tp ? Number(tp) : null);
    setMsg("Stop-loss / take-profit updated.");
  };

  return (
    <div className="ws-panel order-panel">
      <div className="ws-panel-head">
        <span className="ws-panel-title">Order</span>
        <span className="badge sim">Simulated</span>
      </div>

      {/* position summary */}
      <div className="pos-line">
        <span className="tk">Position</span>
        <span className="num">
          {snap.qty > 0 ? <><b>{snap.qty} sh</b> @ {formatMoney(snap.avg)}</> : <span className="dim">flat</span>}
        </span>
        <span className={`num ${snap.unreal >= 0 ? "pos" : "neg"}`}>{formatSigned(snap.unreal)}</span>
      </div>

      {/* order type */}
      <div className="seg seg-2" role="tablist" aria-label="Order type">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            className={`seg-btn ${orderType === t ? "on" : ""}`}
            onClick={() => { setOrderType(t); if (t === "limit" && !limitPx) setLimitPx(snap.price.toFixed(2)); }}
            disabled={disabled}
          >
            {t === "market" ? "Market" : "Limit"}
          </button>
        ))}
      </div>

      <div className="field-row">
        <div className="field">
          <label>Qty</label>
          <input className="input num" type="number" min="1" step="1" value={qty}
            onChange={(e) => onQtyChange(e.target.value)} disabled={disabled} />
        </div>
        {orderType === "limit" && (
          <div className="field">
            <label>Limit price</label>
            <input className="input num" type="number" min="0" step="0.01" placeholder={snap.price.toFixed(2)}
              value={limitPx} onChange={(e) => setLimitPx(e.target.value)} disabled={disabled}
              onBlur={() => { if (limitPx) { const n = Number(limitPx); if (isFinite(n)) setLimitPx(n.toFixed(2)); } }} />
          </div>
        )}
      </div>

      <div className="row">
        <button className="btn buy big" onClick={() => submit("buy")} disabled={disabled}>Buy</button>
        <button className="btn sell big" onClick={() => submit("sell")} disabled={disabled || (orderType === "market" && snap.qty <= 0)}>Sell</button>
      </div>

      {/* brackets */}
      <div className="field-row" style={{ marginTop: 10 }}>
        <div className="field">
          <label>Stop-loss</label>
          <input className="input num" type="number" step="0.01" placeholder="e.g. 5.20"
            value={sl} onChange={(e) => setSl(e.target.value)} disabled={disabled} />
        </div>
        <div className="field">
          <label>Take-profit</label>
          <input className="input num" type="number" step="0.01" placeholder="e.g. 5.80"
            value={tp} onChange={(e) => setTp(e.target.value)} disabled={disabled} />
        </div>
      </div>
      <button className="btn ghost" style={{ width: "100%", marginTop: 6 }} onClick={applyBrackets} disabled={disabled}>
        Set brackets
      </button>
      <div className="hint" style={{ marginTop: 4, opacity: 0.7 }}>
        Tip: drag the SL/TP lines directly on the chart.
      </div>
      {(snap.stopLoss != null || snap.takeProfit != null) && (
        <div className="hint" style={{ marginTop: 6 }}>
          Active: {snap.stopLoss != null ? `SL ${formatMoney(snap.stopLoss)}` : ""}
          {snap.takeProfit != null ? ` TP ${formatMoney(snap.takeProfit)}` : ""} — auto-triggers live.
        </div>
      )}
      {(plannedSL != null || plannedTP != null) && (
        <div className="hint" style={{ marginTop: 6, borderLeft: "2px dashed #9ca3af", paddingLeft: 8 }}>
          Planned: {plannedSL != null ? `SL ${formatMoney(plannedSL)}` : ""}
          {plannedTP != null ? ` TP ${formatMoney(plannedTP)}` : ""}
          {(() => {
            const q = Math.floor(Number(qty) || 0);
            const entry = snap.price;
            if (q > 0 && entry > 0 && plannedSL != null && plannedSL < entry && plannedTP != null && plannedTP > entry) {
              const risk = (entry - plannedSL) * q;
              const reward = (plannedTP - entry) * q;
              const rr = risk > 0 ? reward / risk : 0;
              return (
                <span>
                  <br />
                  Risk {formatMoney(risk)} / Reward {formatMoney(reward)} / R:R {rr.toFixed(2)}
                </span>
              );
            }
            return null;
          })()}
          <br />
          <span style={{ opacity: 0.7 }}>Drag the dashed lines on the chart to adjust.</span>
        </div>
      )}

      {/* working limit orders */}
      {snap.pendingOrders.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="tk" style={{ marginBottom: 6 }}>Working orders ({snap.pendingOrders.length})</div>
          {snap.pendingOrders.map((o) => (
            <div key={o.id} className="work-order">
              <span className={o.side === "buy" ? "pos" : "neg"} style={{ fontWeight: 700 }}>
                {o.side === "buy" ? "LMT B" : "LMT S"}
              </span>
              <span className="num">{o.qty} @ {formatMoney(o.limitPrice)}</span>
              <button className="mini-x" onClick={() => { onCancelOrder(o.id); setMsg("Order cancelled."); }} title="Cancel order">✕</button>
            </div>
          ))}
        </div>
      )}

      {msg && <div className="hint" style={{ marginTop: 8 }}>{msg}</div>}

      {/* ledger */}
      <div className="ws-panel-head" style={{ marginTop: 12 }}>
        <span className="ws-panel-title">Ledger</span>
        <span className="tk">{snap.fills.length} fills</span>
      </div>
      {snap.fills.length === 0 ? (
        <div className="hint">No fills yet.</div>
      ) : (
        <div className="ledger-scroll">
          <table className="ledger">
            <thead><tr><th>Side</th><th>Qty</th><th>Price</th><th>P/L</th></tr></thead>
            <tbody>
              {snap.fills.slice().reverse().map((f) => (
                <tr key={f.id} title={f.note ?? ""}>
                  <td style={{ color: f.side === "buy" ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{f.side === "buy" ? "B" : "S"}</td>
                  <td className="num">{f.qty}</td>
                  <td className="num">{formatMoney(f.price)}</td>
                  <td className={`num ${f.realizedPnl >= 0 ? "pos" : "neg"}`}>
                    {f.side === "sell" ? formatSigned(f.realizedPnl) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
