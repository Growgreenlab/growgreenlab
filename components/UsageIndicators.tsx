"use client";

/**
 * UsageIndicators — the Free-plan counters (daily trades remaining,
 * monthly journal entries remaining) with the ET reset times.
 * Renders NOTHING when billing is not configured on this database
 * (entitlement === null, the dark state) — pre-rollout the product
 * looks exactly as it did before subscriptions. Pro users see a
 * simple "Pro — unlimited" line instead of counters.
 */
import Link from "next/link";
import { entitlementSourceLabel, type UsageStatus } from "../lib/entitlements";

function fmtReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) + " ET";
}

export default function UsageIndicators({ entitlement }: { entitlement: UsageStatus | null }) {
  if (!entitlement) return null;
  if (entitlement.is_pro) {
    const label = entitlementSourceLabel(entitlement);
    return (
      <div className="card" style={{ padding: "10px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, color: "var(--emerald-bright)" }}>
          {label && label !== "Pro" ? label : "Grow Green Lab Pro"}
        </span>
        <span className="hint" style={{ margin: 0 }}>Unlimited trades and journal entries.</span>
        <Link href="/billing" style={{ marginLeft: "auto", fontSize: 13 }}>Billing</Link>
      </div>
    );
  }
  const tradesLeft = entitlement.trades_remaining ?? 0;
  const entriesLeft = entitlement.entries_remaining ?? 0;
  return (
    <div className="card" style={{ padding: "10px 14px", display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontWeight: 700 }}>Free plan</span>
      <span className="num" style={{ fontSize: 13 }}>
        Trades today: <strong>{entitlement.trades_used}/{entitlement.trades_limit}</strong>
        <span className="hint"> · {tradesLeft} left · resets {fmtReset(entitlement.day_reset_at)}</span>
      </span>
      <span className="num" style={{ fontSize: 13 }}>
        Journal entries this month: <strong>{entitlement.entries_used}/{entitlement.entries_limit}</strong>
        <span className="hint"> · {entriesLeft} left · resets {fmtReset(entitlement.month_reset_at)}</span>
      </span>
      {(tradesLeft === 0 || entriesLeft === 0) && (
        <Link href="/pricing" className="btn primary" style={{ marginLeft: "auto", fontSize: 13, padding: "6px 12px" }}>
          Upgrade to Pro
        </Link>
      )}
      <Link href="/billing" style={{ fontSize: 13, marginLeft: tradesLeft === 0 || entriesLeft === 0 ? undefined : "auto" }}>Billing</Link>
    </div>
  );
}
