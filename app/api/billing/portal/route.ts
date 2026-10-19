/**
 * POST /api/billing/portal — Stripe Customer Portal session for the
 * signed-in caller's OWN billing customer only (the customer is
 * resolved from the caller's user id via the service-role mapping;
 * a customer id is never accepted from the request).
 * Dark until configured: 503 when the billing env vars are absent.
 */
import { NextResponse } from "next/server";
import { createServerSupabase } from "../../../../lib/supabaseServer";
import {
  billingConfig,
  createPortalSession,
  getServiceRoleClient,
  getStripe,
  isPortalConfigured,
  supabaseBillingDb,
} from "../../../../lib/billingServer";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const cfg = billingConfig();
  if (!isPortalConfigured(cfg)) {
    return NextResponse.json({ error: "billing_not_configured" }, { status: 503 });
  }
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const origin = new URL(req.url).origin;
    const { url } = await createPortalSession({
      db: supabaseBillingDb(getServiceRoleClient(cfg)),
      stripe: getStripe(cfg),
      userId: user.id,
      origin,
    });
    return NextResponse.json({ url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "portal_failed";
    return NextResponse.json(
      { error: msg },
      { status: msg === "no_billing_customer" ? 404 : 502 },
    );
  }
}
