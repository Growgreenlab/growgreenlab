/**
 * subscribeResume.ts — carry a Pro subscribe intent through sign-in.
 *
 * The bug this fixes: the pricing page's signed-out Pro CTA linked to
 * a bare /login, so the plan the user clicked was discarded and the
 * auth flow fell back to its default destination (/replay) with no
 * checkout resume afterwards.
 *
 * The intent rides inside the login flow's existing `next` parameter
 * (the same mechanism the Community pages use in production):
 *
 *   /login?next=/pricing?subscribe=yearly
 *
 * `next` survives every auth method unchanged — password sign-in uses
 * it directly, and magic-link / sign-up confirmation bake it into the
 * emailRedirectTo that the auth callback re-reads. Nothing is stored
 * (no localStorage, no TTL): abandoning the login page abandons the
 * intent, and the pricing page consumes the intent exactly once and
 * strips it from the URL as it fires.
 *
 * The value carried is a plan NAME ("monthly" | "yearly") — never a
 * Stripe price ID. The checkout route still resolves plan -> price
 * from server configuration only.
 */

export type SubscribePlan = "monthly" | "yearly";

/** The /login URL a signed-out Pro CTA links to for `plan`. */
export function buildSubscribeNext(plan: SubscribePlan): string {
  return "/login?next=" + encodeURIComponent(`/pricing?subscribe=${plan}`);
}

/**
 * Validate a raw `subscribe` query value. Accepts ONLY the exact plan
 * names; rejects price IDs ("price_…"), wrong case, empty strings,
 * arrays (repeated params), and anything else — all become null,
 * meaning "no resume intent".
 */
export function parseSubscribeParam(value: unknown): SubscribePlan | null {
  if (typeof value !== "string") return null;
  if (value === "monthly" || value === "yearly") return value;
  return null;
}

/**
 * Is `p` a safe internal destination for post-auth navigation?
 * Must be a same-origin absolute path: starts with "/" but NOT "//"
 * (protocol-relative — `new URL("//evil.com", origin)` would leave
 * the site) and contains no backslash (browsers treat "\" as "/" in
 * URLs, so "/\evil.com" and "\/evil.com" are the same hole in
 * disguise). No legitimate internal destination in this app contains
 * a backslash.
 */
export function isSafeNext(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p[0] !== "/") return false;
  if (p[1] === "/" || p[1] === "\\") return false;
  if (p.includes("\\")) return false;
  return true;
}

/**
 * A consume-once subscribe intent: take() returns the parsed plan
 * the first time it is called and null forever after, so a resume
 * effect that re-runs (state changes, re-renders, StrictMode double
 * effects) can never fire checkout twice for one landing.
 */
export interface SubscribeIntent {
  take(): SubscribePlan | null;
}

export function createSubscribeIntent(rawParam: unknown): SubscribeIntent {
  let plan = parseSubscribeParam(rawParam);
  return {
    take() {
      const p = plan;
      plan = null;
      return p;
    },
  };
}
