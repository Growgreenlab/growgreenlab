/**
 * POST /api/billing/checkout — create a Stripe Checkout Session for
 * the signed-in caller. Body: { plan: "monthly" | "yearly" } — the
 * plan NAME only; the price ID comes from server env
 * (lib/billingServer.priceIdForPlan), never from the request.
 * Entitlement is NEVER granted here: the success redirect is not
 * trusted — only the webhook changes subscription state.
 * Dark until configured: 503 when the billing env vars are absent.
 */
import { NextResponse } from "next/server";
import { createServerSupabase } from "../../../../lib/supabaseServer";
import {
  billingConfig,
  createCheckoutSession,
  getServiceRoleClient,
  getStripe,
  isCheckoutConfigured,
  supabaseBillingDb,
} from "../../../../lib/billingServer";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const cfg = billingConfig();
  if (!isCheckoutConfigured(cfg)) {
    return NextResponse.json({ error: "billing_not_configured" }, { status: 503 });
  }
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let plan: unknown;
  try {
    plan = (await req.json())?.plan;
  } catch {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }
  if (plan !== "monthly" && plan !== "yearly") {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }
  try {
    const origin = new URL(req.url).origin;
    const { url } = await createCheckoutSession({
      db: supabaseBillingDb(getServiceRoleClient(cfg)),
      stripe: getStripe(cfg),
      cfg,
      userId: user.id,
      email: user.email ?? null,
      plan,
      origin,
    });
    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "checkout_failed" },
      { status: 502 },
    );
  }
}
