/**
 * stripeWebhook.ts — pure webhook state reduction for subscriptions.
 *
 * The route handler (app/api/stripe/webhook) does the I/O: raw-body
 * signature verification, the stripe_events_processed idempotency
 * insert, fetching the subscription snapshot from Stripe, and the
 * service-role upsert. EVERY decision lives here as a pure function
 * so it is unit-testable without a network:
 *
 *  - which event types are handled (everything else: record + ignore);
 *  - the out-of-order guard (an event older than the last applied
 *    one for that subscription NEVER rewrites the row — Stripe does
 *    not guarantee delivery order, and a stale event must not
 *    resurrect an expired entitlement);
 *  - duplicate application is a no-op (re-applying the same snapshot
 *    yields the same row);
 *  - Stripe state wins (reconciliation: replaying events from the
 *    Stripe Dashboard converges this table to Stripe's truth).
 *
 * Statuses are stored verbatim from Stripe; entitlement is computed
 * from them by sub_is_pro() in the database (lib/entitlements.ts
 * mirrors the same map for display/tests).
 */

export interface SubscriptionRow {
  user_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  status: string;
  price_id: string | null;
  interval: "month" | "year" | null;
  current_period_end: string | null; // ISO
  cancel_at_period_end: boolean;
  stripe_event_created: string | null; // ISO
}

/** A Stripe event, normalized by the route from the verified payload
 *  (+ a fetched subscription snapshot where the event itself does not
 *  carry the full object). */
export interface NormalizedEvent {
  id: string;
  type: string;
  created: number; // unix seconds (Stripe event.created)
  userId: string | null; // from checkout metadata / client_reference_id / existing map
  subscription: {
    id: string;
    customer: string;
    status: string;
    priceId: string | null;
    interval: "month" | "year" | null;
    currentPeriodEnd: number | null; // unix seconds
    cancelAtPeriodEnd: boolean;
  } | null;
}

export const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export type ReduceResult =
  | { action: "upsert"; row: SubscriptionRow }
  | { action: "ignore"; reason: string };

const iso = (unixSec: number | null): string | null =>
  unixSec == null ? null : new Date(unixSec * 1000).toISOString();

/**
 * Reduce one normalized event against the current stored row for
 * that subscription (null when none). Pure: no I/O, no clock.
 */
export function reduceSubscriptionEvent(
  current: SubscriptionRow | null,
  evt: NormalizedEvent,
): ReduceResult {
  if (!HANDLED_EVENT_TYPES.has(evt.type)) {
    return { action: "ignore", reason: `unhandled type ${evt.type}` };
  }
  if (!evt.subscription) {
    return { action: "ignore", reason: "event carries no subscription snapshot" };
  }
  const userId = evt.userId ?? current?.user_id ?? null;
  if (!userId) {
    // e.g. a subscription created outside our checkout, with no
    // customer->user mapping known yet. Recorded by the route in
    // stripe_events_processed; a later checkout.session.completed for
    // the same subscription binds it. Never guess an owner.
    return { action: "ignore", reason: "no user binding for subscription" };
  }
  if (current && current.stripe_event_created) {
    const appliedAt = new Date(current.stripe_event_created).getTime();
    if (evt.created * 1000 < appliedAt) {
      return { action: "ignore", reason: "stale event (out-of-order delivery)" };
    }
  }
  const s = evt.subscription;
  return {
    action: "upsert",
    row: {
      user_id: userId,
      stripe_subscription_id: s.id,
      stripe_customer_id: s.customer,
      status: s.status,
      price_id: s.priceId,
      interval: s.interval,
      current_period_end: iso(s.currentPeriodEnd),
      cancel_at_period_end: s.cancelAtPeriodEnd,
      stripe_event_created: iso(evt.created),
    },
  };
}

/** Resolve the billing interval from a price ID against the two
 *  server-configured approved prices. Unknown price -> null (the row
 *  still records it; entitlement does not depend on interval). */
export function intervalForPrice(
  priceId: string | null,
  monthlyPriceId: string | undefined,
  yearlyPriceId: string | undefined,
): "month" | "year" | null {
  if (!priceId) return null;
  if (monthlyPriceId && priceId === monthlyPriceId) return "month";
  if (yearlyPriceId && priceId === yearlyPriceId) return "year";
  return null;
}
