"use client";

interface Props {
  onCreateAccount: () => void;
  onDismiss: () => void;
}

export default function GuestLimitModal({ onCreateAccount, onDismiss }: Props) {
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
        <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
        <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700, color: "#f1f5f9" }}>
          Daily Guest Limit Reached
        </h2>
        <p style={{ margin: "0 0 20px", fontSize: 14, lineHeight: 1.6, color: "#94a3b8" }}>
          You&rsquo;ve used all 5 free practice trades for today.
          <br /><br />
          Create your free Grow Green Lab account to save your trading progress,
          track your performance, and continue improving your strategy.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={onCreateAccount}
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
            Create Free Account
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
            Maybe Tomorrow
          </button>
        </div>
      </div>
    </div>
  );
}
