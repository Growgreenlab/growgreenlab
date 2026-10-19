/**
 * billingServer.ts — SERVER-ONLY Stripe billing core.
 *
 * Imported only by the app/api route handlers. Holds the env config
 * contract, the checkout/portal/webhook flows as functions over
 * small structural interfaces (so unit tests can drive them with
 * fakes — no network, no real keys), and the Supabase service-role
 * implementation of BillingDb.
 *
 * Secrets come from Vercel env vars ONLY (names in
 * docs/subscriptions-release-checklist.md). When they are absent the
 * routes answer a clean 503 "billing not configured" and the app
 * behaves exactly as it did before this feature — dark until
 * configured, like every other staged feature in this product.
 * No key is ever committed, logged, or sent to the client; the
 * client may only name a PLAN ("monthly" | "yearly") — the price ID
 * always comes from server env, never from the request.
 */
import Stripe from "stripe";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  intervalForPrice,
  reduceSubscriptionEvent,
  type NormalizedEvent,
  type SubscriptionRow,
} from "./stripeWebhook";

export interface BillingConfig {
  secretKey?: string;
  webhookSecret?: string;
  priceMonthly?: string;
  priceYearly?: string;
  serviceRoleKey?: string;
  supabaseUrl?: string;
}

export function billingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  return {
    secretKey: env.STRIPE_SECRET_KEY || undefined,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
    priceMonthly: env.STRIPE_PRICE_PRO_MONTHLY || undefined,
    priceYearly: env.STRIPE_PRICE_PRO_YEARLY || undefined,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL || undefined,
  };
}

export const isCheckoutConfigured = (c: BillingConfig) =>
  !!c.secretKey && !!c.priceMonthly && !!c.priceYearly && !!c.serviceRoleKey && !!c.supabaseUrl;
export const isPortalConfigured = (c: BillingConfig) =>
  !!c.secretKey && !!c.serviceRoleKey && !!c.supabaseUrl;
export const isWebhookConfigured = (c: BillingConfig) =>
  !!c.secretKey && !!c.webhookSecret && !!c.serviceRoleKey && !!c.supabaseUrl;

export type PlanChoice = "monthly" | "yearly";

/** The ONLY place a plan name becomes a price ID. Client-supplied
 *  price IDs are never accepted anywhere in this system. */
export function priceIdForPlan(cfg: BillingConfig, plan: unknown): string {
  if (plan === "monthly" && cfg.priceMonthly) return cfg.priceMonthly;
  if (plan === "yearly" && cfg.priceYearly) return cfg.priceYearly;
  throw new Error("invalid_plan");
}

/* ---------- Structural interfaces (real SDK satisfies these) ---------- */

export interface StripeLike {
  customers: {
    create(params: Record<string, unknown>): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ id: string; url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ url: string }>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<StripeSubscriptionLike>;
  };
  webhooks: {
    constructEvent(payload: string, header: string, secret: string): StripeEventLike;
  };
}

export interface StripeSubscriptionLike {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number | null;
  metadata?: Record<string, string>;
  items?: {
    data: {
      price?: { id: string; recurring?: { interval?: string } | null } | null;
      current_period_end?: number | null;
    }[];
  };
}

export interface StripeEventLike {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export interface BillingDb {
  getCustomerId(userId: string): Promise<string | null>;
  saveCustomerId(userId: string, customerId: string): Promise<void>;
  getUserIdForCustomer(customerId: string): Promise<string | null>;
  getSubscriptionRow(stripeSubscriptionId: string): Promise<SubscriptionRow | null>;
  /** Returns false when the event was already recorded (duplicate). */
  markEventProcessed(eventId: string, type: string, createdIso: string | null): Promise<boolean>;
  unmarkEventProcessed(eventId: string): Promise<void>;
  upsertSubscription(row: SubscriptionRow): Promise<void>;
}

/* ---------- Checkout ---------- */

export async function createCheckoutSession(args: {
  db: BillingDb;
  stripe: StripeLike;
  cfg: BillingConfig;
  userId: string;
  email: string | null;
  plan: unknown;
  origin: string;
}): Promise<{ url: string }> {
  const price = priceIdForPlan(args.cfg, args.plan);
  let customerId = await args.db.getCustomerId(args.userId);
  if (!customerId) {
    const customer = await args.stripe.customers.create({
      email: args.email ?? undefined,
      metadata: { supabase_user_id: args.userId },
    });
    customerId = customer.id;
    await args.db.saveCustomerId(args.userId, customerId);
  }
  const session = await args.stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: args.userId,
    metadata: { supabase_user_id: args.userId },
    subscription_data: { metadata: { supabase_user_id: args.userId } },
    success_url: `${args.origin}/billing?checkout=success`,
    cancel_url: `${args.origin}/billing?checkout=canceled`,
  });
  if (!session.url) throw new Error("checkout_session_no_url");
  return { url: session.url };
}

/* ---------- Customer portal ---------- */

export async function createPortalSession(args: {
  db: BillingDb;
  stripe: StripeLike;
  userId: string;
  origin: string;
}): Promise<{ url: string }> {
  const customerId = await args.db.getCustomerId(args.userId);
  if (!customerId) throw new Error("no_billing_customer");
  const session = await args.stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${args.origin}/billing`,
  });
  return { url: session.url };
}

/* ---------- Webhook ---------- */

function snapshotFromSubscription(
  sub: StripeSubscriptionLike,
  cfg: BillingConfig,
): NormalizedEvent["subscription"] {
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;
  return {
    id: sub.id,
    customer: sub.customer,
    status: sub.status,
    priceId,
    interval:
      intervalForPrice(priceId, cfg.priceMonthly, cfg.priceYearly) ??
      (item?.price?.recurring?.interval === "year" ? "year" : item?.price?.recurring?.interval === "month" ? "month" : null),
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  };
}

export async function normalizeStripeEvent(args: {
  db: BillingDb;
  stripe: StripeLike;
  cfg: BillingConfig;
  event: StripeEventLike;
}): Promise<NormalizedEvent> {
  const { db, stripe, cfg, event } = args;
  const obj = event.data.object;
  const base: NormalizedEvent = {
    id: event.id,
    type: event.type,
    created: event.created,
    userId: null,
    subscription: null,
  };

  if (event.type === "checkout.session.completed") {
    const subId = typeof obj.subscription === "string" ? obj.subscription : null;
    const meta = (obj.metadata ?? {}) as Record<string, string>;
    base.userId =
      (typeof obj.client_reference_id === "string" ? obj.client_reference_id : null) ??
      meta.supabase_user_id ??
      null;
    if (subId) {
      const sub = await stripe.subscriptions.retrieve(subId);
      base.subscription = snapshotFromSubscription(sub, cfg);
      if (!base.userId && sub.metadata?.supabase_user_id) base.userId = sub.metadata.supabase_user_id;
    }
    return base;
  }

  if (event.type.startsWith("customer.subscription.")) {
    const sub = obj as unknown as StripeSubscriptionLike;
    base.subscription = snapshotFromSubscription(sub, cfg);
    base.userId =
      sub.metadata?.supabase_user_id ??
      (await db.getUserIdForCustomer(sub.customer));
    return base;
  }

  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const subId =
      (typeof obj.subscription === "string" ? obj.subscription : null) ??
      ((obj.parent as { subscription_details?: { subscription?: string } } | undefined)
        ?.subscription_details?.subscription ?? null);
    if (subId) {
      const sub = await stripe.subscriptions.retrieve(subId);
      base.subscription = snapshotFromSubscription(sub, cfg);
      base.userId =
        sub.metadata?.supabase_user_id ??
        (await db.getUserIdForCustomer(sub.customer));
    }
    return base;
  }

  return base;
}

export type WebhookOutcome =
  | { status: "processed" }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

export async function handleStripeEvent(args: {
  db: BillingDb;
  stripe: StripeLike;
  cfg: BillingConfig;
  event: StripeEventLike;
}): Promise<WebhookOutcome> {
  const { db, stripe, cfg, event } = args;
  const createdIso = new Date(event.created * 1000).toISOString();
  const fresh = await db.markEventProcessed(event.id, event.type, createdIso);
  if (!fresh) return { status: "duplicate" };
  try {
    const normalized = await normalizeStripeEvent({ db, stripe, cfg, event });
    const current = normalized.subscription
      ? await db.getSubscriptionRow(normalized.subscription.id)
      : null;
    const result = reduceSubscriptionEvent(current, normalized);
    if (result.action === "ignore") return { status: "ignored", reason: result.reason };
    await db.upsertSubscription(result.row);
    return { status: "processed" };
  } catch (e) {
    // Processing failed after the idempotency mark: unmark so the
    // Stripe retry (it retries non-200s) can actually reprocess.
    await db.unmarkEventProcessed(event.id).catch(() => {});
    throw e;
  }
}

/* ---------- Real implementations (server runtime only) ---------- */

export function getStripe(cfg: BillingConfig): StripeLike {
  if (!cfg.secretKey) throw new Error("billing_not_configured");
  return new Stripe(cfg.secretKey) as unknown as StripeLike;
}

export function getServiceRoleClient(cfg: BillingConfig): SupabaseClient {
  if (!cfg.supabaseUrl || !cfg.serviceRoleKey) throw new Error("billing_not_configured");
  return createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function supabaseBillingDb(client: SupabaseClient): BillingDb {
  return {
    async getCustomerId(userId) {
      const { data } = await client
        .from("billing_customers")
        .select("stripe_customer_id")
        .eq("user_id", userId)
        .maybeSingle();
      return data?.stripe_customer_id ?? null;
    },
    async saveCustomerId(userId, customerId) {
      const { error } = await client
        .from("billing_customers")
        .upsert({ user_id: userId, stripe_customer_id: customerId }, { onConflict: "user_id" });
      if (error) throw new Error(error.message);
    },
    async getUserIdForCustomer(customerId) {
      const { data } = await client
        .from("billing_customers")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      return data?.user_id ?? null;
    },
    async getSubscriptionRow(stripeSubscriptionId) {
      const { data } = await client
        .from("subscriptions")
        .select("user_id, stripe_subscription_id, stripe_customer_id, status, price_id, interval, current_period_end, cancel_at_period_end, stripe_event_created")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();
      return (data as SubscriptionRow | null) ?? null;
    },
    async markEventProcessed(eventId, type, createdIso) {
      const { error } = await client
        .from("stripe_events_processed")
        .insert({ event_id: eventId, type, created: createdIso });
      if (!error) return true;
      if (error.code === "23505") return false; // duplicate delivery
      throw new Error(error.message);
    },
    async unmarkEventProcessed(eventId) {
      await client.from("stripe_events_processed").delete().eq("event_id", eventId);
    },
    async upsertSubscription(row) {
      const { error } = await client
        .from("subscriptions")
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "stripe_subscription_id" });
      if (error) throw new Error(error.message);
    },
  };
}
