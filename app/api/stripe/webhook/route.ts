/**
 * POST /api/stripe/webhook — Stripe webhook receiver.
 *
 * Raw-body signature verification first (STRIPE_WEBHOOK_SECRET);
 * anything unverified is rejected 400 and never processed. Then the
 * idempotent reducer (lib/billingServer.handleStripeEvent over
 * lib/stripeWebhook): duplicate deliveries are no-ops, out-of-order
 * events cannot resurrect stale state, and Stripe's state always
 * wins on replay (the reconciliation path).
 *
 * This route has NO Supabase user session — the service-role client
 * is the only writer, and the billing tables have no client write
 * policies at all. Dark until configured: 503 when env is absent.
 */
import { NextResponse } from "next/server";
import {
  billingConfig,
  getServiceRoleClient,
  getStripe,
  handleStripeEvent,
  isWebhookConfigured,
  supabaseBillingDb,
  type StripeEventLike,
} from "../../../../lib/billingServer";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const cfg = billingConfig();
  if (!isWebhookConfigured(cfg)) {
    return NextResponse.json({ error: "billing_not_configured" }, { status: 503 });
  }
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing_signature" }, { status: 400 });
  }
  const payload = await req.text(); // raw body — never req.json() here
  const stripe = getStripe(cfg);
  let event: StripeEventLike;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, cfg.webhookSecret!) as StripeEventLike;
  } catch {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }
  try {
    const outcome = await handleStripeEvent({
      db: supabaseBillingDb(getServiceRoleClient(cfg)),
      stripe,
      cfg,
      event,
    });
    return NextResponse.json({ received: true, ...outcome });
  } catch {
    // 500 -> Stripe retries with backoff; the idempotency ledger was
    // unmarked by handleStripeEvent so the retry really reprocesses.
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}
