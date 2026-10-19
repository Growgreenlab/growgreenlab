/**
 * stripeWebhook.test.ts — webhook reducer + signature verification.
 * Run: npx -y tsx lib/stripeWebhook.test.ts
 *
 * The reducer is pure (lib/stripeWebhook.ts); the Supabase writes in
 * the route are exercised separately in lib/billingServer.test.ts.
 * Signature verification uses the real Stripe SDK's offline crypto
 * (constructEvent + generateTestHeaderString) with a locally
 * generated test secret — the same code path the route runs.
 */
import Stripe from "stripe";
import {
  HANDLED_EVENT_TYPES,
  intervalForPrice,
  reduceSubscriptionEvent,
  type NormalizedEvent,
  type SubscriptionRow,
} from "./stripeWebhook";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b);
}

const T0 = 1760000000; // fixed event clock
function evt(over: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    id: "evt_1",
    type: "customer.subscription.created",
    created: T0,
    userId: "user-1",
    subscription: {
      id: "sub_1", customer: "cus_1", status: "active",
      priceId: "price_monthly", interval: "month",
      currentPeriodEnd: T0 + 30 * 86400, cancelAtPeriodEnd: false,
    },
    ...over,
  };
}

/* ---------- reducer ---------- */
{
  const r = reduceSubscriptionEvent(null, evt({}));
  eq("create applies", r.action, "upsert");
  if (r.action === "upsert") {
    eq("row status", r.row.status, "active");
    eq("row user", r.row.user_id, "user-1");
    eq("row period end ISO", r.row.current_period_end, new Date((T0 + 30 * 86400) * 1000).toISOString());
    eq("row guard stamped", r.row.stripe_event_created, new Date(T0 * 1000).toISOString());
  }
  // Duplicate delivery of the same event: same row out (no-op effect).
  const cur = r.action === "upsert" ? r.row : null;
  const dup = reduceSubscriptionEvent(cur, evt({}));
  check("duplicate event re-applies identically", dup.action === "upsert" && JSON.stringify(dup.row) === JSON.stringify(cur));
  // Out-of-order: an OLDER event must not resurrect/change state.
  const stale = reduceSubscriptionEvent(cur, evt({
    id: "evt_old", created: T0 - 3600, type: "customer.subscription.updated",
    subscription: { id: "sub_1", customer: "cus_1", status: "canceled", priceId: "price_monthly", interval: "month", currentPeriodEnd: T0 + 86400, cancelAtPeriodEnd: false },
  }));
  eq("stale event ignored", stale.action, "ignore");
  // A NEWER event applies (renewal / cancel-at-period-end).
  const newer = reduceSubscriptionEvent(cur, evt({
    id: "evt_2", created: T0 + 3600, type: "customer.subscription.updated",
    subscription: { id: "sub_1", customer: "cus_1", status: "active", priceId: "price_monthly", interval: "month", currentPeriodEnd: T0 + 30 * 86400, cancelAtPeriodEnd: true },
  }));
  check("newer event applies + cancel flag kept", newer.action === "upsert" && newer.row.cancel_at_period_end === true);
  // subscription.deleted maps to canceled verbatim.
  const del = reduceSubscriptionEvent(cur, evt({
    id: "evt_3", created: T0 + 7200, type: "customer.subscription.deleted",
    subscription: { id: "sub_1", customer: "cus_1", status: "canceled", priceId: "price_monthly", interval: "month", currentPeriodEnd: T0 + 30 * 86400, cancelAtPeriodEnd: false },
  }));
  check("deleted -> canceled row", del.action === "upsert" && del.row.status === "canceled");
  // Unhandled types and unbindable events are recorded-but-ignored.
  eq("unhandled type ignored", reduceSubscriptionEvent(null, evt({ type: "payment_intent.succeeded" })).action, "ignore");
  eq("no user binding ignored", reduceSubscriptionEvent(null, evt({ userId: null })).action, "ignore");
  eq("no snapshot ignored", reduceSubscriptionEvent(null, evt({ subscription: null })).action, "ignore");
  // Binding can come from the existing row (invoice events).
  const inv = reduceSubscriptionEvent(cur, evt({ id: "evt_4", created: T0 + 8000, type: "invoice.paid", userId: null }));
  check("invoice event binds via existing row", inv.action === "upsert" && inv.row.user_id === "user-1");
  check("handled set has the 6 spec events", HANDLED_EVENT_TYPES.size === 6);
}

/* ---------- interval resolution ---------- */
eq("monthly price -> month", intervalForPrice("price_monthly", "price_monthly", "price_yearly"), "month");
eq("yearly price -> year", intervalForPrice("price_yearly", "price_monthly", "price_yearly"), "year");
eq("unknown price -> null", intervalForPrice("price_other", "price_monthly", "price_yearly"), null);
eq("null price -> null", intervalForPrice(null, "price_monthly", "price_yearly"), null);

/* ---------- signature verification (real SDK, offline) ---------- */
{
  const stripe = new Stripe("sk_test_dummy_local");
  const secret = "whsec_local_test_secret_for_unit_tests";
  const payload = JSON.stringify({
    id: "evt_sig", type: "customer.subscription.created", created: T0,
    data: { object: { id: "sub_1" } },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const okEvent = stripe.webhooks.constructEvent(payload, header, secret);
  eq("valid signature verifies", okEvent.id, "evt_sig");
  let threw = false;
  try { stripe.webhooks.constructEvent(payload, header, "whsec_wrong_secret"); } catch { threw = true; }
  check("wrong secret rejected", threw);
  threw = false;
  try { stripe.webhooks.constructEvent(payload.replace("evt_sig", "evt_evil"), header, secret); } catch { threw = true; }
  check("tampered payload rejected", threw);
}

console.log(`=== STRIPE WEBHOOK RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
