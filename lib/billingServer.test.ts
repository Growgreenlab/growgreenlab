/**
 * billingServer.test.ts — checkout / portal / webhook flow cores.
 * Run: npx -y tsx lib/billingServer.test.ts
 *
 * Drives lib/billingServer.ts with structural fakes (fake Stripe +
 * in-memory BillingDb). Pins: the price ALWAYS comes from server env
 * (a client can only name a plan); checkout creates the Stripe
 * customer once and reuses the mapping; the portal only ever opens
 * for the caller's own customer; webhook handling is idempotent
 * (duplicate = no-op), order-safe (stale = ignored), and unmarks on
 * processing failure so a Stripe retry can reprocess.
 */
import {
  createCheckoutSession,
  createPortalSession,
  handleStripeEvent,
  priceIdForPlan,
  type BillingConfig,
  type BillingDb,
  type StripeEventLike,
  type StripeLike,
  type StripeSubscriptionLike,
} from "./billingServer";
import type { SubscriptionRow } from "./stripeWebhook";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b);
}
async function expectThrow(name: string, fn: () => Promise<unknown>, match: string) {
  try { await fn(); check(name, false); }
  catch (e) { check(name, e instanceof Error && e.message.includes(match)); }
}

const CFG: BillingConfig = {
  secretKey: "sk_test_x", webhookSecret: "whsec_x",
  priceMonthly: "price_ENV_monthly", priceYearly: "price_ENV_yearly",
  serviceRoleKey: "svc_x", supabaseUrl: "https://example.supabase.co",
};

function fakeDb(): BillingDb & { customers: Map<string, string>; subs: Map<string, SubscriptionRow>; events: Set<string> } {
  const customers = new Map<string, string>();
  const subs = new Map<string, SubscriptionRow>();
  const events = new Set<string>();
  return {
    customers, subs, events,
    async getCustomerId(u) { return customers.get(u) ?? null; },
    async saveCustomerId(u, c) { customers.set(u, c); },
    async getUserIdForCustomer(c) { for (const [u, cu] of customers) if (cu === c) return u; return null; },
    async getSubscriptionRow(id) { return subs.get(id) ?? null; },
    async markEventProcessed(id) { if (events.has(id)) return false; events.add(id); return true; },
    async unmarkEventProcessed(id) { events.delete(id); },
    async upsertSubscription(row) { subs.set(row.stripe_subscription_id, row); },
  };
}

function fakeStripe(sub: StripeSubscriptionLike) {
  const calls: { checkoutParams?: Record<string, unknown>; customersCreated: number; portalCustomer?: string } = { customersCreated: 0 };
  const stripe: StripeLike = {
    customers: {
      async create() { calls.customersCreated++; return { id: "cus_fake_1" }; },
    },
    checkout: {
      sessions: {
        async create(params) { calls.checkoutParams = params; return { id: "cs_1", url: "https://checkout.stripe.test/cs_1" }; },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) { calls.portalCustomer = params.customer as string; return { url: "https://portal.stripe.test/s" }; },
      },
    },
    subscriptions: {
      async retrieve() { return sub; },
    },
    webhooks: {
      constructEvent() { throw new Error("not used in core tests"); },
    },
  };
  return { stripe, calls };
}

const SUB: StripeSubscriptionLike = {
  id: "sub_1", customer: "cus_fake_1", status: "active", cancel_at_period_end: false,
  current_period_end: 1760000000 + 30 * 86400, metadata: { supabase_user_id: "user-1" },
  items: { data: [{ price: { id: "price_ENV_monthly", recurring: { interval: "month" } }, current_period_end: 1760000000 + 30 * 86400 }] },
};

async function main() {
  /* ---------- price resolution: server env only ---------- */
  eq("monthly plan -> env monthly price", priceIdForPlan(CFG, "monthly"), "price_ENV_monthly");
  eq("yearly plan -> env yearly price", priceIdForPlan(CFG, "yearly"), "price_ENV_yearly");
  await expectThrow("a raw price id is not a plan", async () => priceIdForPlan(CFG, "price_hacked"), "invalid_plan");
  await expectThrow("unknown plan rejected", async () => priceIdForPlan(CFG, "lifetime"), "invalid_plan");

  /* ---------- checkout ---------- */
  {
    const db = fakeDb();
    const { stripe, calls } = fakeStripe(SUB);
    const r = await createCheckoutSession({ db, stripe, cfg: CFG, userId: "user-1", email: "a@b.c", plan: "yearly", origin: "https://www.growgreenlab.com" });
    eq("checkout returns the session url", r.url, "https://checkout.stripe.test/cs_1");
    eq("customer created once", calls.customersCreated, 1);
    eq("customer mapping saved", db.customers.get("user-1"), "cus_fake_1");
    const li = (calls.checkoutParams?.line_items as { price: string }[])[0];
    eq("session charges the ENV yearly price", li.price, "price_ENV_yearly");
    eq("session binds the user as client_reference_id", calls.checkoutParams?.client_reference_id, "user-1");
    eq("success url lands on billing states", calls.checkoutParams?.success_url, "https://www.growgreenlab.com/billing?checkout=success");
    // Second checkout reuses the customer.
    await createCheckoutSession({ db, stripe, cfg: CFG, userId: "user-1", email: "a@b.c", plan: "monthly", origin: "https://www.growgreenlab.com" });
    eq("second checkout reuses the customer", calls.customersCreated, 1);
    await expectThrow("checkout rejects a forged plan", () =>
      createCheckoutSession({ db, stripe, cfg: CFG, userId: "user-1", email: "a@b.c", plan: "price_ENV_monthly", origin: "https://x" }), "invalid_plan");
  }

  /* ---------- portal ---------- */
  {
    const db = fakeDb();
    const { stripe, calls } = fakeStripe(SUB);
    await expectThrow("portal without a customer -> no_billing_customer", () =>
      createPortalSession({ db, stripe, userId: "user-9", origin: "https://x" }), "no_billing_customer");
    db.customers.set("user-9", "cus_9");
    const r = await createPortalSession({ db, stripe, userId: "user-9", origin: "https://x" });
    eq("portal opens for the caller's own customer", calls.portalCustomer, "cus_9");
    eq("portal returns url", r.url, "https://portal.stripe.test/s");
  }

  /* ---------- webhook flow ---------- */
  {
    const db = fakeDb();
    db.customers.set("user-1", "cus_fake_1");
    const { stripe } = fakeStripe(SUB);
    const evt = (id: string, type: string, created: number, object: Record<string, unknown>): StripeEventLike =>
      ({ id, type, created, data: { object } });

    const created = evt("evt_c1", "checkout.session.completed", 1760000000, {
      id: "cs_1", subscription: "sub_1", customer: "cus_fake_1",
      client_reference_id: "user-1", metadata: { supabase_user_id: "user-1" },
    });
    const out1 = await handleStripeEvent({ db, stripe, cfg: CFG, event: created });
    eq("checkout.session.completed processed", out1.status, "processed");
    const row = db.subs.get("sub_1");
    check("row written from the fetched subscription", !!row && row.status === "active" && row.user_id === "user-1");
    eq("row interval resolved from env price", row?.interval, "month");

    const dup = await handleStripeEvent({ db, stripe, cfg: CFG, event: created });
    eq("duplicate delivery is a no-op", dup.status, "duplicate");

    const stale = evt("evt_old", "customer.subscription.updated", 1759990000, { ...SUB, status: "canceled" });
    const outStale = await handleStripeEvent({ db, stripe, cfg: CFG, event: stale });
    eq("out-of-order event ignored", outStale.status, "ignored");
    eq("stale event did not resurrect/change state", db.subs.get("sub_1")?.status, "active");

    const newerSub: StripeSubscriptionLike = { ...SUB, status: "past_due" };
    const { stripe: stripe2 } = fakeStripe(newerSub);
    const failed = evt("evt_f1", "invoice.payment_failed", 1760100000, { id: "in_1", subscription: "sub_1" });
    const outF = await handleStripeEvent({ db, stripe: stripe2, cfg: CFG, event: failed });
    eq("invoice.payment_failed processed", outF.status, "processed");
    eq("status follows Stripe (past_due)", db.subs.get("sub_1")?.status, "past_due");

    const other = evt("evt_x", "payment_intent.succeeded", 1760200000, { id: "pi_1" });
    const outX = await handleStripeEvent({ db, stripe, cfg: CFG, event: other });
    eq("unhandled type recorded + ignored", outX.status, "ignored");

    // Processing failure unmarks, so the retry can reprocess.
    const db2 = fakeDb();
    const badStripe = fakeStripe(SUB).stripe;
    badStripe.subscriptions.retrieve = async () => { throw new Error("stripe down"); };
    const evtBad = evt("evt_bad", "checkout.session.completed", 1760000000, { subscription: "sub_1", client_reference_id: "user-1" });
    await expectThrow("processing failure propagates (route -> 500)", () =>
      handleStripeEvent({ db: db2, stripe: badStripe, cfg: CFG, event: evtBad }), "stripe down");
    check("failed event was unmarked for retry", !db2.events.has("evt_bad"));
  }

  console.log(`=== BILLING SERVER RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
