"use client";

/**
 * /pricing — Free vs Pro Monthly vs Pro Yearly.
 * Prices are the approved ones (D1: USD $9.99/mo, $89.99/yr; the
 * yearly plan saves $29.89 ≈ 25% vs 12 monthly payments). Checkout
 * buttons call the server route with a plan NAME only — if billing
 * is not configured on this deployment yet (503), the buttons show
 * the honest "not available yet" state instead of failing.
 * Signed-out CTAs carry the chosen plan through sign-in via the
 * login flow's `next` param (lib/subscribeResume.ts); landing back
 * here signed in with ?subscribe=<plan> resumes checkout once.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";
import { loadEntitlement, type UsageStatus } from "../../lib/entitlements";
import { startCheckout } from "../../lib/billing";
import { buildSubscribeNext, createSubscribeIntent, type SubscribeIntent } from "../../lib/subscribeResume";

const FREE_FEATURES = [
  "Trading Simulator / Replay Lab with sample data",
  "Daily Replay — full sealed replay workflow",
  "3 trades per day · 7 journal entries per month",
  "Trade Journal with full history — always readable",
  "Basic analytics, Psychology Guard, Breakout Drills, Community",
];

const PRO_FEATURES = [
  "Unlimited trades and journal entries",
  "AI Edge Analysis Export",
  "Advanced analytics — Strategy Performance and breakdowns",
  "Everything in Free, with no daily or monthly caps",
];

function PricingInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [entitlement, setEntitlement] = useState<UsageStatus | null>(null);
  const [entitlementLoaded, setEntitlementLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The subscribe intent carried through sign-in (?subscribe=monthly|
  // yearly), parsed once and consumed exactly once by the resume
  // effect below. Invalid values (incl. any price ID) yield no intent.
  const intentRef = useRef<SubscribeIntent | null>(null);
  if (intentRef.current === null) {
    intentRef.current = createSubscribeIntent(searchParams.get("subscribe"));
  }

  useEffect(() => {
    (async () => {
      if (!isSupabaseConfigured()) { setEntitlementLoaded(true); return; }
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      setSignedIn(!!user);
      if (user) setEntitlement(await loadEntitlement(supabase));
      setEntitlementLoaded(true);
    })();
  }, []);

  const subscribe = async (plan: "monthly" | "yearly") => {
    setBusy(plan);
    setNotice(null);
    const r = await startCheckout(plan);
    if (!r.ok) {
      setBusy(null);
      if (r.reason === "not_configured") setNotice("Pro checkout isn't available yet — billing is still being set up. Your Free plan works as always.");
      else if (r.reason === "unauthorized") setNotice("Please sign in first, then subscribe.");
      else setNotice("Checkout couldn't be started. Please try again in a moment.");
    }
  };

  // Resume after sign-in: the user clicked a Pro plan while signed
  // out, authenticated, and landed back here with ?subscribe=<plan>.
  // Fire the SAME subscribe() a button click uses — exactly once —
  // and strip the param as it fires so refresh/back can't re-fire it.
  // Unconfigured billing lands in subscribe()'s existing honest
  // notice; the user stays on /pricing. Already-Pro: no-op.
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  useEffect(() => {
    if (!signedIn || !entitlementLoaded) return;
    if (entitlement?.is_pro) return;
    const plan = intentRef.current?.take();
    if (!plan) return;
    router.replace("/pricing");
    void subscribeRef.current(plan);
  }, [signedIn, entitlementLoaded, entitlement, router]);

  const planCard = (
    title: string,
    price: string,
    per: string,
    features: string[],
    cta: React.ReactNode,
    accent = false,
    badge?: string,
  ) => (
    <div
      className="card"
      style={{
        padding: 22, display: "flex", flexDirection: "column", gap: 14, minWidth: 0,
        border: accent ? "1px solid var(--emerald-bright)" : undefined,
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          {badge && (
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#06281c", background: "var(--emerald-bright)", borderRadius: 999, padding: "3px 9px" }}>
              {badge}
            </span>
          )}
        </div>
        <div className="num" style={{ fontSize: 30, fontWeight: 800, marginTop: 8 }}>
          {price}
          <span className="hint" style={{ fontSize: 14, fontWeight: 400 }}> {per}</span>
        </div>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 7, fontSize: 14 }}>
        {features.map((f) => <li key={f}>{f}</li>)}
      </ul>
      <div style={{ marginTop: "auto" }}>{cta}</div>
    </div>
  );

  const proCta = (plan: "monthly" | "yearly", label: string) => {
    if (entitlement?.is_pro) {
      return <Link href="/billing" className="btn" style={{ display: "inline-block" }}>You&rsquo;re on Pro — manage billing</Link>;
    }
    if (!signedIn) {
      return <Link href={buildSubscribeNext(plan)} className="btn primary" style={{ display: "inline-block" }}>Sign in to subscribe</Link>;
    }
    return (
      <button className="btn primary" disabled={busy !== null} onClick={() => subscribe(plan)}>
        {busy === plan ? "Opening checkout…" : label}
      </button>
    );
  };

  return (
    <div className="wrap" style={{ paddingTop: 28, paddingBottom: 48, maxWidth: 1060 }}>
      <h2 style={{ margin: "0 0 6px" }}>Pricing</h2>
      <p className="hint" style={{ margin: "0 0 22px", maxWidth: 640 }}>
        Start free. Upgrade when the caps start costing you trades. Your trade history stays
        fully available on every plan — canceling never locks your journal.
      </p>
      {notice && <div className="card" style={{ padding: "12px 16px", marginBottom: 16 }}>{notice}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        {planCard("Free", "$0", "forever", FREE_FEATURES,
          signedIn
            ? <span className="hint">{entitlement?.is_pro ? "Your previous plan" : "Your current plan"}</span>
            : <Link href="/login" className="btn" style={{ display: "inline-block" }}>Create a free account</Link>)}
        {planCard("Grow Green Lab Pro — Monthly", "$9.99", "USD / month", PRO_FEATURES,
          proCta("monthly", "Subscribe — $9.99/mo"), false)}
        {planCard("Grow Green Lab Pro — Yearly", "$89.99", "USD / year", PRO_FEATURES,
          proCta("yearly", "Subscribe — $89.99/yr"), true, "Save $29.89/yr (~25%) vs monthly")}
      </div>
      <p className="hint" style={{ marginTop: 18, fontSize: 12.5 }}>
        Subscriptions auto-renew until canceled. Cancel anytime in the billing portal — Pro
        stays active until the end of the paid period. Prices in USD.
      </p>
    </div>
  );
}

export default function PricingPage() {
  return (
    <Suspense fallback={<div className="hint">Loading…</div>}>
      <PricingInner />
    </Suspense>
  );
}
