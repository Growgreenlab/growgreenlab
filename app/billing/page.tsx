"use client";

/**
 * /billing — current plan, subscription status, interval, renewal /
 * expiration date, and Manage Subscription (Stripe Customer Portal).
 * All state comes from the same rows the entitlement function reads,
 * so this page can never disagree with enforcement. Checkout result
 * states arrive as ?checkout=success|canceled — a success landing
 * does NOT grant anything by itself; it polls usage_status until the
 * webhook lands (usually seconds), and says so honestly meanwhile.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";
import { entitlementSourceLabel, loadEntitlement, type UsageStatus } from "../../lib/entitlements";
import { redeemPromoCode } from "../../lib/accessAdmin";
import { openBillingPortal } from "../../lib/billing";
import UsageIndicators from "../../components/UsageIndicators";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function BillingInner() {
  const params = useSearchParams();
  const checkout = params.get("checkout");
  const [entitlement, setEntitlement] = useState<UsageStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [promoCode, setPromoCode] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoMsg, setPromoMsg] = useState<string | null>(null);
  const pollRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured()) { setLoaded(true); return; }
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    setSignedIn(!!user);
    setUserId(user?.id ?? null);
    if (user) setEntitlement(await loadEntitlement(supabase));
    setLoaded(true);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // After a successful checkout, entitlement arrives via webhook —
  // poll a few times so the page can confirm Pro without a manual
  // refresh, and never claim Pro before the server state says so.
  useEffect(() => {
    if (checkout !== "success" || !loaded || entitlement?.is_pro) return;
    if (pollRef.current >= 6) return;
    const t = setTimeout(() => { pollRef.current += 1; refresh(); }, 2500);
    return () => clearTimeout(t);
  }, [checkout, loaded, entitlement, refresh]);

  // Promo redemption: the server binds the grant to this account
  // and answers every failure identically — so the failure copy
  // here is deliberately generic too (no "wrong code" vs "expired"
  // distinction may leak into the UI).
  const redeem = async () => {
    const code = promoCode.trim();
    if (!code || promoBusy) return;
    setPromoBusy(true);
    setPromoMsg(null);
    const r = await redeemPromoCode(createClient(), code);
    setPromoBusy(false);
    if (r.ok) {
      setPromoCode("");
      setPromoMsg(
        r.expiresAt
          ? `Promo applied — Pro is active until ${fmtDate(r.expiresAt)}.`
          : "Promo applied — Pro is active on your account.",
      );
      refresh();
    } else {
      setPromoMsg("That code couldn't be applied. Check the code and try again.");
    }
  };

  // The account ID shown below is always the signed-in user's OWN
  // id, taken from their own session — it exists so the owner can
  // grant complimentary access by ID from /admin/access. Display
  // only; nothing here accepts an ID from anywhere else.
  const copyId = async () => {
    if (!userId) return;
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (permissions / insecure context):
      // fall back to selecting a scratch field and execCommand.
      try {
        const ta = document.createElement("textarea");
        ta.value = userId;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
      } catch { /* user can still long-press / select the field manually */ }
    }
    setTimeout(() => setCopied(false), 2000);
  };

  const manage = async () => {
    setBusy(true);
    setNotice(null);
    const r = await openBillingPortal();
    if (!r.ok) {
      setBusy(false);
      if (r.reason === "not_configured") setNotice("Billing isn't configured on this deployment yet.");
      else if (r.reason === "no_customer") setNotice("No subscription found for your account yet — subscribe from the pricing page first.");
      else setNotice("The billing portal couldn't be opened. Please try again in a moment.");
    }
  };

  if (!loaded) return <div className="wrap" style={{ padding: 40 }}><p className="hint">Loading billing…</p></div>;
  if (!signedIn) {
    return (
      <div className="wrap" style={{ paddingTop: 28, maxWidth: 760 }}>
        <h2 style={{ margin: "0 0 8px" }}>Billing</h2>
        <p className="hint">Please <Link href="/login">sign in</Link> to see your plan and subscription.</p>
      </div>
    );
  }

  const sub = entitlement?.subscription ?? null;
  const isPro = !!entitlement?.is_pro;
  const pastDueInGrace = !!sub && sub.status === "past_due" && isPro;
  const expired = !!sub && !isPro && (sub.status === "canceled" || sub.status === "past_due" || sub.status === "unpaid");

  return (
    <div className="wrap" style={{ paddingTop: 28, paddingBottom: 48, maxWidth: 760 }}>
      <h2 style={{ margin: "0 0 6px" }}>Billing</h2>
      <p className="hint" style={{ margin: "0 0 20px" }}>Your plan, subscription status, and payment management.</p>

      {checkout === "success" && (
        <div className="card" style={{ padding: "12px 16px", marginBottom: 14 }}>
          {isPro
            ? "Payment confirmed — your Pro subscription is active. Welcome to Pro."
            : "Payment received — your subscription is being confirmed (this usually takes a few seconds). This page refreshes automatically; Pro activates as soon as Stripe confirms."}
        </div>
      )}
      {checkout === "canceled" && (
        <div className="card" style={{ padding: "12px 16px", marginBottom: 14 }}>
          Checkout was canceled — no charge was made. You can subscribe anytime from the <Link href="/pricing">pricing page</Link>.
        </div>
      )}
      {pastDueInGrace && (
        <div className="card" style={{ padding: "12px 16px", marginBottom: 14, borderColor: "#f5c542" }}>
          <strong>Payment issue:</strong> your last renewal payment failed. Pro stays active during the
          grace period until <strong>{fmtDate(sub.current_period_end ? new Date(new Date(sub.current_period_end).getTime() + 7 * 86400000).toISOString() : null)}</strong> —
          update your payment method in the billing portal to keep Pro without interruption.
        </div>
      )}
      {expired && (
        <div className="card" style={{ padding: "12px 16px", marginBottom: 14 }}>
          Your Pro subscription has ended, so your account is on the Free plan. Your complete trade
          history, journal, and screenshots remain fully available — resubscribe anytime to restore Pro.
        </div>
      )}
      {notice && <div className="card" style={{ padding: "12px 16px", marginBottom: 14 }}>{notice}</div>}

      <div style={{ display: "grid", gap: 16 }}>
        <UsageIndicators entitlement={entitlement} />
        {userId && (
          <div className="card" style={{ padding: 18, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <span className="hint">Your account ID</span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                value={userId}
                readOnly
                aria-label="Your account ID"
                onFocus={(e) => e.target.select()}
                style={{ flex: "1 1 260px", padding: "8px 10px" }}
              />
              <button className="btn" onClick={copyId}>{copied ? "Copied ✓" : "Copy"}</button>
            </div>
            <p className="hint" style={{ margin: 0, fontSize: 12 }}>
              Share this ID if you've been offered complimentary access.
            </p>
          </div>
        )}
        <div className="card" style={{ padding: 18, display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span className="hint">Current plan</span>
            <strong>{isPro ? "Grow Green Lab Pro" : "Free"}</strong>
          </div>
          {isPro && entitlement?.access_source && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <span className="hint">Access source</span>
              <span className="num">{entitlementSourceLabel(entitlement)}</span>
            </div>
          )}
          {sub ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <span className="hint">Subscription status</span>
                <span className="num">{sub.status}{sub.cancel_at_period_end ? " (cancels at period end)" : ""}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <span className="hint">Billing interval</span>
                <span className="num">{sub.interval === "year" ? "Yearly — CA$99.99/yr" : sub.interval === "month" ? "Monthly — CA$9.99/mo" : "—"}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <span className="hint">{sub.cancel_at_period_end || !isPro ? "Access until" : "Renews on"}</span>
                <span className="num">{fmtDate(sub.current_period_end)}</span>
              </div>
            </>
          ) : (
            <p className="hint" style={{ margin: 0 }}>
              {entitlement
                ? isPro
                  ? "Your Pro comes from complimentary access, so there is no Stripe subscription on this account — nothing is billed, and there is nothing to manage in the billing portal."
                  : "No subscription on this account. Upgrade from the pricing page whenever you're ready."
                : "Billing isn't configured on this deployment yet — plans and usage counters will appear here once subscriptions launch."}
            </p>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
            {sub
              ? <button className="btn primary" disabled={busy} onClick={manage}>{busy ? "Opening portal…" : "Manage Subscription"}</button>
              : isPro
                ? null
                : <Link href="/pricing" className="btn primary" style={{ display: "inline-block" }}>See Pro plans</Link>}
            <Link href="/pricing" className="btn" style={{ display: "inline-block" }}>Compare plans</Link>
          </div>
          <p className="hint" style={{ margin: 0, fontSize: 12 }}>
            The billing portal (Stripe) handles payment methods, invoices, plan switches, and
            cancellation. Canceling keeps Pro until the end of the paid period, and your trade
            history always stays available.
          </p>
        </div>
        {entitlement && (
          <div className="card" style={{ padding: 18, display: "grid", gap: 10 }}>
            <strong>Have a promo code?</strong>
            <p className="hint" style={{ margin: 0 }}>
              Redeem it here — Pro activates on this account right away. A promo
              never changes a paid subscription or its renewal dates; the two
              simply stack.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") redeem(); }}
                placeholder="Enter promo code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                style={{ flex: "1 1 220px", padding: "8px 10px" }}
              />
              <button className="btn primary" disabled={promoBusy || !promoCode.trim()} onClick={redeem}>
                {promoBusy ? "Redeeming…" : "Redeem"}
              </button>
            </div>
            {promoMsg && <p className="hint" style={{ margin: 0 }}>{promoMsg}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="wrap" style={{ padding: 40 }}><p className="hint">Loading billing…</p></div>}>
      <BillingInner />
    </Suspense>
  );
}
