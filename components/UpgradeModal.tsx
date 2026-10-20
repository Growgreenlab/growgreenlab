"use client";

/**
 * UpgradeModal — the subscription wall shown at the moment a
 * signed-in Free user tries to open a position past the daily
 * free-trade limit (3/day). The buy does NOT execute; this modal
 * is the upgrade path: plan summary + a primary action to the
 * pricing page, where the existing checkout flow takes over.
 * Styling mirrors GuestLimitModal (the guest-limit sibling).
 */
import { FREE_TRADES_PER_DAY } from "../lib/entitlements";

interface Props {
  /** Free trades already counting against today (server + this session). */
  used?: number;
  /** The daily free cap. */
  limit?: number;
  onDismiss: () => void;
}

export default function UpgradeModal({ used, limit, onDismiss }: Props) {
  const lim = limit ?? FREE_TRADES_PER_DAY;
  const usd = used ?? lim;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onClick={onDismiss}
      role="dialog"
      aria-label="Daily free limit reached"
    >
      <div
        style={{
          background: "#0f172a",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 16,
          padding: 28,
          maxWidth: 400,
          width: "100%",
          textAlign: "center",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 40, marginBottom: 12 }}>📈</div>
        <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700, color: "#f1f5f9" }}>
          Daily Free Limit Reached
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 14, lineHeight: 1.6, color: "#94a3b8" }}>
          You&rsquo;ve used {usd} of {lim} free trades today.
          Limits reset at 12:00 AM ET.
        </p>
        <div
          style={{
            textAlign: "left",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 12,
            padding: "12px 16px",
            marginBottom: 20,
            fontSize: 14,
            color: "#e2e8f0",
            display: "grid",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span>Grow Green Lab Pro — Monthly</span>
            <strong className="num">CA$9.99/mo</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span>Grow Green Lab Pro — Yearly</span>
            <strong className="num">CA$99.99/yr</strong>
          </div>
          <p className="hint" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
            Unlimited trades and journal entries, plus the AI Edge Analysis export.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={() => { window.location.href = "/pricing"; }}
            style={{
              padding: "12px 20px",
              fontSize: 15,
              fontWeight: 700,
              background: "linear-gradient(180deg, #10b981, #059669)",
              color: "#fff",
              border: "none",
              borderRadius: 10,
              cursor: "pointer",
              boxShadow: "0 4px 16px rgba(16,185,129,0.35)",
            }}
          >
            Upgrade to Pro
          </button>
          <button
            onClick={onDismiss}
            style={{
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              background: "transparent",
              color: "#64748b",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 10,
              cursor: "pointer",
            }}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
