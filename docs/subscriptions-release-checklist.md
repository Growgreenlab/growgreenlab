# Subscriptions — Release Checklist (feature/subscriptions)

Status: **PREPARED, NOT LAUNCHED.** The implementation ships dark:
with no billing env vars set and no rollout timestamp configured,
the product behaves exactly as it did before subscriptions — no
counters, no gates, no checkout. Live billing stays DISABLED until
Karandeep explicitly approves this checklist end-to-end.

## ⛔ D11 TAX GATE — MANDATORY PRE-LAUNCH GATE

**Live billing must not be enabled until tax treatment and
registration requirements are reviewed (D11).** Stripe Tax is NOT
integrated; prices are tax-exclusive; no tax configuration exists in
the code or the migration. Before any live price, live key, or live
webhook is created, Karandeep reviews with his accountant:

- Whether Grow Green Lab must register for and collect GST/HST (and
  any other jurisdictions' sales taxes) on subscriptions, given his
  Canada-based sole-proprietor status, revenue thresholds, and where
  customers are located.
- Whether to enable Stripe Tax at that point (it can be enabled
  later without entitlement code changes), and what tax behavior /
  tax codes the live prices need.

Checking this box requires the review to have happened — it is not a
formality: **[ ] Tax treatment + registration reviewed (D11)**

## What was built (branch feature/subscriptions)

- Migration `supabase/migrations/subscriptions-v1.sql` (**PREPARED,
  not applied**) + mirror in `supabase/schema.sql`: billing_customers,
  subscriptions, stripe_events_processed, usage_ledger,
  import_allowance; `sub_is_pro()` entitlement; quota triggers
  (real trades, DR draft create/finalize); `import_real_trades` RPC
  (allowance-then-quota, atomic batch refusal); `save_replay_session`
  RPC (server-side regroup + quota, balance port); `usage_status()`.
- API routes: `/api/billing/checkout`, `/api/billing/portal`,
  `/api/stripe/webhook` (first API routes in this app; server-only
  env; 503 "billing not configured" when env is absent).
- UI: `/pricing`, `/billing`, usage indicators in the journal,
  structured quota messages with upgrade prompts, Pro gates for the
  AI Edge Export (D8 grandfathering) and Strategy Performance —
  both dark until the rollout timestamp is configured.
- Test-mode Stripe objects (created 2026-10-18, livemode=false):
  product `prod_VT3eG0P9zWufqV` "Grow Green Lab Pro";
  monthly `price_1US7XQCkdp8RhthV44kxldcP` (USD $9.99/mo);
  yearly `price_1US7XnCkdp8RhthVNK8eemGR` (USD $89.99/yr).
  **No live products or prices exist. None may be created before
  the D11 gate above is checked.**

## Environment variables (names only — never commit values)

Set in Vercel. **Preview scope = TEST-mode values** (for branch QA);
**Production scope only at launch**, with live values then.

| Variable | Value source |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys (`sk_test_…` for Preview; `sk_live_…` at launch) |
| `STRIPE_WEBHOOK_SECRET` | The signing secret of each webhook endpoint (`whsec_…`) — test and live endpoints have DIFFERENT secrets; Preview gets the test endpoint's, Production the live endpoint's |
| `STRIPE_PRICE_PRO_MONTHLY` | Test: `price_1US7XQCkdp8RhthV44kxldcP`. Live: the live monthly price ID created at launch |
| `STRIPE_PRICE_PRO_YEARLY` | Test: `price_1US7XnCkdp8RhthVNK8eemGR`. Live: the live yearly price ID created at launch |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Settings → API → service_role secret (Karandeep retrieves it; it has never been shared in this project) |
| `NEXT_PUBLIC_SUBSCRIPTIONS_ROLLOUT_AT` | The exact instant the subscriptions migration is applied to production (ISO timestamp). Freezes D8 grandfathering: accounts created before it keep AI Edge Export. Set when applying the migration — not before |

## Manual steps, in order (all Karandeep's)

### Phase 1 — test-mode lifecycle proof (before any merge)
1. [ ] Vercel **Preview** env vars set (test values from the table).
2. [ ] Stripe Dashboard (TEST mode): register webhook endpoint
       `https://growgreenlab-git-feature-subscriptions-growgreen1.vercel.app/api/stripe/webhook`
       with events: `checkout.session.completed`,
       `customer.subscription.created`, `customer.subscription.updated`,
       `customer.subscription.deleted`, `invoice.paid`,
       `invoice.payment_failed`. Copy its signing secret into the
       Preview `STRIPE_WEBHOOK_SECRET`.
3. [ ] Stripe Dashboard (TEST mode): activate the **Customer Portal**
       (Settings → Billing → Customer portal): allow payment-method
       updates, plan switching (monthly ↔ yearly; Stripe-default
       proration per D13), and cancellation **at period end**.
4. [ ] Apply the migration to production Supabase via the dashboard
       SQL Editor (the usual route, explicit tap) — NOTE: preview and
       production share this one database, so the migration goes
       live for enforcement at this step; the app stays dark until
       the branch merges and the rollout timestamp is set. Ordering
       vs. merge is Karandeep's call at review time.
5. [ ] Run the test-mode lifecycle matrix (below) on the preview.

### Phase 2 — launch (separate approval; requires the D11 gate)
6. [ ] D11 tax review done (gate above).
7. [ ] Create the LIVE product/prices in Stripe (USD $9.99/mo,
       $89.99/yr) — only now.
8. [ ] Register the LIVE webhook endpoint
       `https://www.growgreenlab.com/api/stripe/webhook` (same 6
       events); put its signing secret + live keys/prices into
       Vercel **Production** env.
9. [ ] Set `NEXT_PUBLIC_SUBSCRIPTIONS_ROLLOUT_AT` (Production) to the
       migration-apply timestamp from step 4; merge
       feature/subscriptions to main (Karandeep's approval).
10. [ ] D12: Karandeep subscribes on the live account with a real
        card — the first live lifecycle verification (checkout →
        webhook → `is_pro` true → portal cancel keeps access until
        period end).
11. [ ] Verify the homepage Access band copy (already updated on the
        branch) matches the now-live gates; announce.

## Test-mode lifecycle matrix (Phase 1, step 5)

Use Stripe test cards on the preview deployment, signed in as a
throwaway account where possible:

- [ ] Subscribe Monthly with `4242 4242 4242 4242` → checkout
      success state → within seconds the billing page shows Pro,
      unlimited (webhook landed; the page polls for it).
- [ ] Subscribe Yearly on a second account → interval shows Yearly.
- [ ] Customer Portal: switch Monthly → Yearly (proration per D13),
      update payment method, download an invoice.
- [ ] Cancel in the portal → status "cancels at period end", Pro
      stays active until `current_period_end`, then expires (verify
      by the subscription row + `usage_status`).
- [ ] Payment failure: subscribe with `4000 0000 0000 0341` (attaches,
      fails on renewal) or force a failed renewal from the Dashboard
      → subscription `past_due`; Pro continues during the grace
      window (period end + 7 days, D6) and the billing page shows
      the payment-issue notice.
- [ ] Quotas on a Free account: 3 trades/day and 7 entries/month
      enforced server-side (4th trade / 8th entry rejected with the
      structured limit message); CSV import consumes the one-time
      100-entry allowance first; Daily Replay draft + finalize each
      consume exactly once.
- [ ] Existing data sanity: journal history, AI Edge Export, and
      screenshots work exactly as before for grandfathered accounts.

## Reconciliation (if Stripe and Supabase ever disagree)

Stripe is the source of truth. (1) Re-deliver the events from the
Stripe Dashboard (Developers → Webhooks → resend) — processing is
idempotent and order-guarded, so replay converges the
`subscriptions` rows. (2) If a row is still wrong, compare it with
the Stripe subscription and correct the row via SQL with Stripe's
values. (3) Users fix payment/cancellation state themselves in the
Customer Portal; those changes flow back via webhook. No in-app
admin panel exists in v1 (none exists anywhere in this product).
