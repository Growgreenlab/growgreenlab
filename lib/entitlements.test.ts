/**
 * entitlements.test.ts — subscription read-model tests.
 * Run: npx -y tsx lib/entitlements.test.ts
 *
 * Pins: the is_pro status map (mirrors sub_is_pro in
 * subscriptions-v1.sql, whose side is pinned by the SQL harness),
 * the America/New_York day/month bucket math, D8 grandfathering,
 * the dark-by-default gate composition, and the structured quota
 * error parsing (errcode GGL01 + JSON detail).
 */
import {
  advancedAnalyticsLocked,
  entitlementSourceLabel,
  etDay,
  etMonth,
  exportLocked,
  isGrandfathered,
  isProStatus,
  loadEntitlement,
  parseQuotaError,
  quotaMessage,
  type UsageStatus,
} from "./entitlements";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b);
}

const NOW = new Date("2026-10-18T16:00:00Z");
const inDays = (d: number) => new Date(NOW.getTime() + d * 86400000).toISOString();

/* ---------- is_pro status map ---------- */
eq("no subscription -> free", isProStatus(null, NOW), false);
eq("active -> pro", isProStatus({ status: "active", current_period_end: inDays(-30) }, NOW), true);
eq("past_due inside grace (ended 1d ago) -> pro", isProStatus({ status: "past_due", current_period_end: inDays(-1) }, NOW), true);
eq("past_due at grace edge (ended 6.9d ago) -> pro", isProStatus({ status: "past_due", current_period_end: inDays(-6.9) }, NOW), true);
eq("past_due past grace (ended 7.1d ago) -> free", isProStatus({ status: "past_due", current_period_end: inDays(-7.1) }, NOW), false);
eq("past_due exactly at period_end+7d -> free (strict <)", isProStatus({ status: "past_due", current_period_end: inDays(-7) }, NOW), false);
eq("canceled with time left -> pro", isProStatus({ status: "canceled", current_period_end: inDays(5) }, NOW), true);
eq("canceled past period end -> free", isProStatus({ status: "canceled", current_period_end: inDays(-0.1) }, NOW), false);
eq("incomplete -> free", isProStatus({ status: "incomplete", current_period_end: inDays(30) }, NOW), false);
eq("unpaid -> free", isProStatus({ status: "unpaid", current_period_end: inDays(30) }, NOW), false);
eq("past_due without period end -> free", isProStatus({ status: "past_due", current_period_end: null }, NOW), false);
eq("garbage status -> free", isProStatus({ status: "whatever", current_period_end: inDays(30) }, NOW), false);

/* ---------- ET buckets ---------- */
// 2026-10-19T03:59Z = Oct 18 23:59 EDT; 04:01Z = Oct 19 00:01 EDT.
eq("ET day just before midnight ET", etDay(new Date("2026-10-19T03:59:00Z")), "2026-10-18");
eq("ET day just after midnight ET", etDay(new Date("2026-10-19T04:01:00Z")), "2026-10-19");
// Month edge: Oct 31 23:00 EDT = Nov 1 03:00Z (October); Nov 1 01:00 EST = 06:00Z (November).
eq("ET month at Oct 31 23:00 ET", etMonth(new Date("2026-11-01T03:00:00Z")), "2026-10");
eq("ET month at Nov 1 01:00 ET", etMonth(new Date("2026-11-01T06:00:00Z")), "2026-11");
// DST fall-back day (Nov 1 2026): the repeated hour stays one ET day.
eq("ET day on DST fall-back", etDay(new Date("2026-11-01T06:30:00Z")), "2026-11-01");
eq("ET day late on DST fall-back", etDay(new Date("2026-11-02T04:59:00Z")), "2026-11-01");

/* ---------- grandfathering + gate composition ---------- */
const ROLLOUT = new Date("2026-11-01T00:00:00Z");
eq("created before rollout -> grandfathered", isGrandfathered("2026-10-01T00:00:00Z", ROLLOUT), true);
eq("created after rollout -> not grandfathered", isGrandfathered("2026-11-02T00:00:00Z", ROLLOUT), false);
eq("created exactly at rollout -> not grandfathered", isGrandfathered("2026-11-01T00:00:00Z", ROLLOUT), false);
eq("no rollout configured -> nobody grandfathered (dark handled by gates)", isGrandfathered("2020-01-01T00:00:00Z", null), false);

const freeStatus: UsageStatus = {
  configured: true, is_pro: false, plan: "free",
  trades_used: 3, trades_limit: 3, trades_remaining: 0,
  entries_used: 7, entries_limit: 7, entries_remaining: 0,
  import_allowance_remaining: 0,
  day_reset_at: "2026-10-19T04:00:00Z", month_reset_at: "2026-11-01T04:00:00Z",
  subscription: null,
};
const proStatus: UsageStatus = { ...freeStatus, is_pro: true, plan: "pro", trades_remaining: null, entries_remaining: null };

eq("export: dark without rollout", exportLocked({ entitlement: freeStatus, userCreatedAt: "2026-11-05T00:00:00Z", rolloutAt: null }), false);
eq("export: dark without entitlement (pre-migration)", exportLocked({ entitlement: null, userCreatedAt: "2026-11-05T00:00:00Z", rolloutAt: ROLLOUT }), false);
eq("export: pro never locked", exportLocked({ entitlement: proStatus, userCreatedAt: "2026-11-05T00:00:00Z", rolloutAt: ROLLOUT }), false);
eq("export: grandfathered account not locked", exportLocked({ entitlement: freeStatus, userCreatedAt: "2026-09-01T00:00:00Z", rolloutAt: ROLLOUT }), false);
eq("export: new free account locked", exportLocked({ entitlement: freeStatus, userCreatedAt: "2026-11-05T00:00:00Z", rolloutAt: ROLLOUT }), true);
eq("analytics: locked for free once live", advancedAnalyticsLocked({ entitlement: freeStatus, rolloutAt: ROLLOUT }), true);
eq("analytics: grandfathering does NOT apply (D8 was export-only)", advancedAnalyticsLocked({ entitlement: freeStatus, rolloutAt: ROLLOUT }), true);
eq("analytics: pro not locked", advancedAnalyticsLocked({ entitlement: proStatus, rolloutAt: ROLLOUT }), false);
eq("analytics: dark without rollout", advancedAnalyticsLocked({ entitlement: freeStatus, rolloutAt: null }), false);

/* ---------- quota error parsing ---------- */
const quotaErr = {
  code: "GGL01",
  message: "quota_limit_reached",
  details: JSON.stringify({ kind: "monthly_entry", limit: 7, used: 7, logical_key: "real:abc" }),
};
const parsed = parseQuotaError(quotaErr);
check("GGL01 parses", parsed !== null);
eq("parsed kind", parsed?.kind, "monthly_entry");
eq("parsed limit", parsed?.limit, 7);
eq("parsed used", parsed?.used, 7);
eq("parsed key", parsed?.logicalKey, "real:abc");
check("message names the limit + upgrade", quotaMessage(parsed!).includes("7 of 7") && quotaMessage(parsed!).includes("Pro"));
eq("non-quota error -> null", parseQuotaError({ code: "23505", message: "duplicate key" }), null);
eq("random error -> null", parseQuotaError(new Error("boom")), null);
const byMsg = parseQuotaError({ message: "quota_limit_reached" });
check("message-only quota error still parses with defaults", byMsg !== null && byMsg.limit === 3);

/* ---------- access source labels (access-grants-v1, additive) --- */
{
  const base: UsageStatus = {
    configured: true, is_pro: false, plan: "free",
    trades_used: 0, trades_limit: 3, trades_remaining: 3,
    entries_used: 0, entries_limit: 7, entries_remaining: 7,
    import_allowance_remaining: 100,
    day_reset_at: inDays(1), month_reset_at: inDays(12), subscription: null,
  };
  const pro = (patch: Partial<UsageStatus>): UsageStatus => ({
    ...base, is_pro: true, plan: "pro",
    trades_remaining: null, entries_remaining: null, ...patch,
  });
  eq("label: null entitlement -> null", entitlementSourceLabel(null), null);
  eq("label: free", entitlementSourceLabel(base), "Free");
  eq("label: pro without source fields (pre-grants DB) -> plain Pro",
    entitlementSourceLabel(pro({})), "Pro");
  eq("label: paid monthly",
    entitlementSourceLabel(pro({ access_source: "paid", subscription: { status: "active", interval: "month", current_period_end: inDays(30), cancel_at_period_end: false } })),
    "Pro — Monthly");
  eq("label: paid yearly",
    entitlementSourceLabel(pro({ access_source: "paid", subscription: { status: "active", interval: "year", current_period_end: inDays(300), cancel_at_period_end: false } })),
    "Pro — Yearly");
  eq("label: paid without subscription snapshot",
    entitlementSourceLabel(pro({ access_source: "paid" })), "Pro — Subscription");
  eq("label: owner", entitlementSourceLabel(pro({ access_source: "owner", access_expires_at: null })), "Pro — Owner access");
  eq("label: owner ignores expiry field",
    entitlementSourceLabel(pro({ access_source: "owner", access_expires_at: inDays(5) })), "Pro — Owner access");
  const promoLabel = entitlementSourceLabel(pro({ access_source: "promo", access_expires_at: "2026-11-18T12:00:00Z" })) ?? "";
  check("label: promo carries until-date", promoLabel.startsWith("Pro — Promo until ") && promoLabel.includes("Nov") && promoLabel.includes("2026"));
  eq("label: promo without expiry", entitlementSourceLabel(pro({ access_source: "promo", access_expires_at: null })), "Pro — Promo");
  const adminLabel = entitlementSourceLabel(pro({ access_source: "admin", access_expires_at: "2026-11-02T12:00:00Z" })) ?? "";
  check("label: admin grant is complimentary + dated", adminLabel.startsWith("Pro — Complimentary access until "));
  eq("label: permanent admin grant", entitlementSourceLabel(pro({ access_source: "admin", access_expires_at: null })), "Pro — Complimentary access");
  const trialLabel = entitlementSourceLabel(pro({ access_source: "trial", access_expires_at: "2026-10-29T12:00:00Z" })) ?? "";
  check("label: trial carries until-date", trialLabel.startsWith("Pro — Trial until "));
  eq("label: garbage expiry falls back to base label",
    entitlementSourceLabel(pro({ access_source: "promo", access_expires_at: "not-a-date" })), "Pro — Promo");
  // A source field must never OVERRIDE is_pro: a free payload that
  // somehow carries a grant source still labels Free.
  eq("label: source never overrides is_pro=false",
    entitlementSourceLabel({ ...base, access_source: "promo", access_expires_at: inDays(9) }), "Free");
}

/* ---------- loadEntitlement: new keys pass through, absence ok ---
 * (async tail: this suite predates top-level await support in the
 * tsx CJS runner, so the totals print from inside the IIFE.) */
void (async () => {
  const payload = {
    configured: true, is_pro: true, plan: "pro",
    trades_used: 0, trades_limit: 3, trades_remaining: null,
    entries_used: 0, entries_limit: 7, entries_remaining: null,
    import_allowance_remaining: 100,
    day_reset_at: inDays(1), month_reset_at: inDays(12), subscription: null,
    access_source: "promo", access_expires_at: "2026-11-18T00:00:00Z",
  };
  const client = { async rpc() { return { data: payload, error: null }; } };
  const ent = await loadEntitlement(client);
  eq("loadEntitlement: access_source passes through", ent?.access_source, "promo");
  eq("loadEntitlement: access_expires_at passes through", ent?.access_expires_at, "2026-11-18T00:00:00Z");
  const legacy = { ...payload } as Record<string, unknown>;
  delete legacy.access_source; delete legacy.access_expires_at;
  const legacyClient = { async rpc() { return { data: legacy, error: null }; } };
  const ent2 = await loadEntitlement(legacyClient);
  check("loadEntitlement: pre-grants payload still loads", ent2 !== null && ent2.is_pro === true);
  eq("loadEntitlement: missing source stays undefined", ent2?.access_source, undefined);

  console.log(`=== ENTITLEMENTS RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
