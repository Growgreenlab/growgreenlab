"use client";

/**
 * DrFinalizeConfirm — THE one shared confirmation dialog for Daily
 * Replay draft finalization (2026-10-18 workflow fix). Every finalize
 * entry point — the replay-page Trade Drafts strip, the journal
 * drafts card, and the draft review drawer (replay + journal) —
 * opens this dialog instead of finalizing immediately, so the
 * action, its explanation, and its outcome read identically
 * everywhere.
 *
 * Finalize semantics (unchanged, one-way): the draft row's status
 * flips to "finalized" (lib/drDrafts.finalizeDraft — guarded on
 * status = "draft", so a repeat call affects 0 rows and creates
 * nothing). Under the current visibility rule the trade is in
 * Trade Journal → Daily Replay / Backtest from that moment — the
 * replay session does NOT need to be completed first.
 *
 * The host wires its existing finalize logic (finalize + meta
 * copy-forward + refresh) into onConfirm; this component only owns
 * the confirm → working → success/error presentation. Success is a
 * state, never an auto-navigation: it offers "View in Trade
 * Journal" (the host's handler, or a plain link when no handler is
 * given) and a Close button.
 */
import { useState } from "react";

export interface DrFinalizeSummary {
  ticker?: string | null;
  tradeDate?: string | null;
  cycleIndex: number;
  realizedPnl: number;
}

export default function DrFinalizeConfirm({ summary, onConfirm, onClose, onViewInJournal }: {
  summary: DrFinalizeSummary;
  /** Host finalize logic; resolves when the finalize has landed. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  /** Optional in-app "View in Trade Journal" action (journal hosts
   *  switch tabs instead of navigating). Falls back to a /journal
   *  link when not provided. */
  onViewInJournal?: () => void;
}) {
  const [phase, setPhase] = useState<"confirm" | "working" | "done" | "error">("confirm");
  const [err, setErr] = useState<string | null>(null);

  const confirm = async () => {
    if (phase === "working" || phase === "done") return; // idempotent UI-side too
    setPhase("working");
    setErr(null);
    try {
      await onConfirm();
      setPhase("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Finalize failed.");
      setPhase("error");
    }
  };

  const pnl = summary.realizedPnl;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Finalize this trade?"
      style={{
        position: "fixed", inset: 0, zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.6)", padding: 16,
      }}
      onClick={() => { if (phase !== "working") onClose(); }}
    >
      <div className="card" style={{ padding: 20, maxWidth: 440, width: "100%" }} onClick={(e) => e.stopPropagation()}>
        {phase === "done" ? (
          <>
            <h3 style={{ margin: "0 0 8px" }}>Trade finalized</h3>
            <p style={{ fontSize: 13.5, margin: "0 0 6px" }}>
              This trade is now in <b>Trade Journal → Daily Replay / Backtest</b>, available for analytics and AI Edge export.
            </p>
            <p className="hint" style={{ fontSize: 12.5, margin: "0 0 14px" }}>
              Its draft review, screenshots and fills are preserved exactly as recorded.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {onViewInJournal ? (
                <button className="btn primary" onClick={() => { onViewInJournal(); onClose(); }}>View in Trade Journal</button>
              ) : (
                <a className="btn primary" href="/journal" style={{ textDecoration: "none" }}>View in Trade Journal</a>
              )}
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <h3 style={{ margin: "0 0 8px" }}>Finalize this trade?</h3>
            <p style={{ fontSize: 13.5, margin: "0 0 6px" }}>
              {summary.ticker ? <b>{summary.ticker}</b> : "Daily Replay trade"}
              {summary.tradeDate ? <span className="hint"> · {summary.tradeDate}</span> : null}
              <span className="hint"> · cycle {summary.cycleIndex} · </span>
              <span className="num" style={{ color: pnl > 0 ? "var(--emerald-bright)" : pnl < 0 ? "#f6465d" : "var(--muted)" }}>
                {pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)}
              </span>
            </p>
            <p style={{ fontSize: 13.5, margin: "0 0 6px" }}>
              Finalizing moves this trade into <b>Trade Journal → Daily Replay / Backtest</b>, where it&apos;s available for analytics and AI Edge export — the replay session does not need to be completed first.
            </p>
            <p className="hint" style={{ fontSize: 12.5, margin: "0 0 14px" }}>
              The draft&apos;s review notes, screenshots, fills and plan evidence are preserved exactly. This cannot be undone.
            </p>
            {phase === "error" && err && (
              <p style={{ fontSize: 13, color: "#f6465d", margin: "0 0 10px" }}>{err}</p>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" onClick={confirm} disabled={phase === "working"}>
                {phase === "working" ? "Finalizing…" : "Finalize Trade"}
              </button>
              <button className="btn" onClick={onClose} disabled={phase === "working"}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
