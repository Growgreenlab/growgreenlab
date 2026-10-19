/**
 * billing.ts — browser-side helpers for the billing API routes.
 * Thin fetch wrappers: they never see a price ID or a key; the
 * server resolves plan -> price and customer -> portal itself.
 * A 503 from either route means billing is not configured on this
 * deployment yet (the dark state) and callers show the honest
 * "not available yet" notice instead of an error.
 */

export type BillingCallResult =
  | { ok: true; url: string }
  | { ok: false; reason: "not_configured" | "unauthorized" | "no_customer" | "error"; message?: string };

async function post(path: string, body?: unknown): Promise<BillingCallResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (res.ok && data.url) return { ok: true, url: data.url };
    if (res.status === 503) return { ok: false, reason: "not_configured" };
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (res.status === 404) return { ok: false, reason: "no_customer" };
    return { ok: false, reason: "error", message: data.error };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : "network error" };
  }
}

/** Start hosted Checkout for a plan and navigate to it. */
export async function startCheckout(plan: "monthly" | "yearly"): Promise<BillingCallResult> {
  const r = await post("/api/billing/checkout", { plan });
  if (r.ok) window.location.href = r.url;
  return r;
}

/** Open the Stripe Customer Portal (manage / cancel / payment method). */
export async function openBillingPortal(): Promise<BillingCallResult> {
  const r = await post("/api/billing/portal");
  if (r.ok) window.location.href = r.url;
  return r;
}
