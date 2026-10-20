/**
 * accessAdmin.test.ts — access-grants RPC wrapper tests.
 * Run: npx -y tsx lib/accessAdmin.test.ts
 *
 * Drives lib/accessAdmin.ts with structural fake RPC clients (the
 * billingServer.test.ts pattern). Pins: the exact RPC names and
 * argument names the SQL functions declare, the total (never-throw)
 * result mapping, and — critically — that EVERY redeem failure
 * collapses to the identical { ok:false, expiresAt:null } shape,
 * preserving the server's failure indistinguishability end to end.
 */
import {
  adminCreatePromo,
  adminDeactivatePromo,
  adminGrantAccess,
  adminListGrants,
  adminListPromos,
  adminRevokeGrant,
  checkIsAppAdmin,
  redeemPromoCode,
} from "./accessAdmin";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b);
}

interface Call { fn: string; args?: Record<string, unknown> }
function fakeClient(responder: (fn: string) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  return {
    calls,
    async rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      return responder(fn);
    },
  };
}
const okData = (data: unknown) => () => ({ data, error: null });
const errData = (message: string) => () => ({ data: null, error: { message } });

async function main() {
/* ---------- redeem ---------- */
{
  const c = fakeClient(okData({ ok: true, source: "promo", grant_id: "g1", expires_at: "2026-11-18T00:00:00Z" }));
  const r = await redeemPromoCode(c, "LAUNCH-TEST-01");
  eq("redeem: success ok", r.ok, true);
  eq("redeem: success expiry surfaced", r.expiresAt, "2026-11-18T00:00:00Z");
  eq("redeem: rpc name", c.calls[0].fn, "redeem_promo_code");
  eq("redeem: code passed as p_code", c.calls[0].args?.p_code, "LAUNCH-TEST-01");
}
{
  // Every server failure mode returns the same payload; the wrapper
  // must surface them all identically — no reason may leak through.
  const shapes: unknown[] = [];
  for (const payload of [
    { ok: false, error: "promo_invalid" },           // generic server failure
    { ok: false, error: "anything-else" },            // even a stray reason is dropped
    null,                                            // malformed
    "nope",                                          // malformed
  ]) {
    const c = fakeClient(okData(payload));
    shapes.push(await redeemPromoCode(c, "WHATEVER-123"));
  }
  const transport = fakeClient(errData("network down"));
  shapes.push(await redeemPromoCode(transport, "WHATEVER-123"));
  const boom = { async rpc() { throw new Error("boom"); } };
  shapes.push(await redeemPromoCode(boom, "WHATEVER-123"));
  for (const s of shapes) {
    eq("redeem: failure shape is always {ok:false, expiresAt:null}",
      JSON.stringify(s), JSON.stringify({ ok: false, expiresAt: null }));
  }
}

/* ---------- is_app_admin ---------- */
{
  eq("is_admin: true passes through", await checkIsAppAdmin(fakeClient(okData(true))), true);
  eq("is_admin: false", await checkIsAppAdmin(fakeClient(okData(false))), false);
  eq("is_admin: error -> false", await checkIsAppAdmin(fakeClient(errData("denied"))), false);
  eq("is_admin: truthy non-boolean -> false", await checkIsAppAdmin(fakeClient(okData("yes"))), false);
}

/* ---------- admin grant ---------- */
{
  const c = fakeClient(okData("grant-uuid-1"));
  const r = await adminGrantAccess(c, {
    targetUserId: "user-9", source: "trial", durationDays: 14, note: "coaching",
  });
  eq("grant: ok", r.ok, true);
  eq("grant: id returned", r.grantId, "grant-uuid-1");
  eq("grant: rpc name", c.calls[0].fn, "admin_grant_access");
  eq("grant: target arg", c.calls[0].args?.p_target_user, "user-9");
  eq("grant: source arg", c.calls[0].args?.p_source, "trial");
  eq("grant: duration arg", c.calls[0].args?.p_duration_days, 14);
  eq("grant: note arg", c.calls[0].args?.p_note, "coaching");
}
{
  const c = fakeClient(errData("forbidden: admin access required"));
  const r = await adminGrantAccess(c, {
    targetUserId: "user-9", source: "admin", durationDays: null, note: null,
  });
  eq("grant: refusal not ok", r.ok, false);
  eq("grant: refusal carries server message", r.error, "forbidden: admin access required");
  eq("grant: refusal has no id", r.grantId, null);
}

/* ---------- admin revoke ---------- */
{
  const c = fakeClient(okData({ ok: true, grant_id: "g7" }));
  const r = await adminRevokeGrant(c, "g7");
  eq("revoke: ok", r.ok, true);
  eq("revoke: rpc name + arg", `${c.calls[0].fn}:${c.calls[0].args?.p_grant_id}`, "admin_revoke_grant:g7");
}
{
  const c = fakeClient(okData({ ok: false, error: "owner_grant_protected" }));
  const r = await adminRevokeGrant(c, "g-owner");
  eq("revoke: owner refusal not ok", r.ok, false);
  eq("revoke: owner error code surfaced", r.error, "owner_grant_protected");
}
{
  const c = fakeClient(errData("forbidden: admin access required"));
  const r = await adminRevokeGrant(c, "g7");
  eq("revoke: rpc error not ok", r.ok, false);
  check("revoke: rpc error message surfaced", (r.error ?? "").includes("forbidden"));
}

/* ---------- admin list ---------- */
{
  const rows = [{
    id: "g1", user_id: "user-9", source: "promo", starts_at: "2026-10-19T00:00:00Z",
    expires_at: null, revoked_at: null, created_by: null, promo_code_id: "pc1",
    note: null, created_at: "2026-10-19T00:00:00Z",
  }];
  const c = fakeClient(okData(rows));
  const r = await adminListGrants(c, "user-9");
  eq("list: ok", r.ok, true);
  eq("list: rows passed through", r.grants.length, 1);
  eq("list: filter arg", c.calls[0].args?.p_target_user, "user-9");
  const c2 = fakeClient(okData(rows));
  await adminListGrants(c2);
  eq("list: no filter -> null arg", c2.calls[0].args?.p_target_user, null);
  const denied = fakeClient(errData("forbidden: admin access required"));
  const r3 = await adminListGrants(denied);
  eq("list: refusal not ok, empty", `${r3.ok}:${r3.grants.length}`, "false:0");
}

/* ---------- admin create promo ---------- */
{
  const c = fakeClient(okData("promo-uuid-1"));
  const r = await adminCreatePromo(c, {
    code: "INSTA-PROMO-2026", label: "Instagram promo", durationDays: 30,
    maxRedemptions: 50, perUserLimit: 1, expiresAt: "2026-12-31T23:59:59Z",
  });
  eq("promo create: ok", r.ok, true);
  eq("promo create: id returned", r.promoId, "promo-uuid-1");
  eq("promo create: rpc name", c.calls[0].fn, "admin_create_promo");
  eq("promo create: code arg", c.calls[0].args?.p_code, "INSTA-PROMO-2026");
  eq("promo create: label arg", c.calls[0].args?.p_label, "Instagram promo");
  eq("promo create: duration arg", c.calls[0].args?.p_duration_days, 30);
  eq("promo create: cap arg", c.calls[0].args?.p_max_redemptions, 50);
  eq("promo create: per-user arg", c.calls[0].args?.p_per_user_limit, 1);
  eq("promo create: expiry arg", c.calls[0].args?.p_expires_at, "2026-12-31T23:59:59Z");
}
{
  const c = fakeClient(okData("promo-uuid-2"));
  await adminCreatePromo(c, {
    code: "LAUNCH-KEY-0001", label: null, durationDays: 7,
    maxRedemptions: null, perUserLimit: 1, expiresAt: null,
  });
  eq("promo create: unlimited cap passes null", c.calls[0].args?.p_max_redemptions, null);
  eq("promo create: no key expiry passes null", c.calls[0].args?.p_expires_at, null);
}
{
  const c = fakeClient(errData("admin_create_promo: code must be 10-64 chars of A-Z, 0-9, dash, underscore"));
  const r = await adminCreatePromo(c, {
    code: "bad code!", label: null, durationDays: 30,
    maxRedemptions: null, perUserLimit: 1, expiresAt: null,
  });
  eq("promo create: refusal not ok", r.ok, false);
  check("promo create: refusal carries server message", (r.error ?? "").includes("code must be 10-64 chars"));
  const boom = { async rpc() { throw new Error("boom"); } };
  const r2 = await adminCreatePromo(boom, {
    code: "LAUNCH-KEY-0001", label: null, durationDays: 30,
    maxRedemptions: null, perUserLimit: 1, expiresAt: null,
  });
  eq("promo create: transport throw collapses to not-ok", r2.ok, false);
}

/* ---------- admin list promos ---------- */
{
  const rows = [{
    id: "pc1", code_hash: "ab12cd34", label: "Instagram promo", duration_days: 30,
    expires_at: null, max_redemptions: 50, redeemed_count: 3, per_user_limit: 1,
    active: true, created_by: "admin-1", created_at: "2026-10-19T00:00:00Z",
  }];
  const c = fakeClient(okData(rows));
  const r = await adminListPromos(c);
  eq("promo list: ok", r.ok, true);
  eq("promo list: rpc name", c.calls[0].fn, "admin_list_promos");
  eq("promo list: rows passed through", r.promos.length, 1);
  eq("promo list: count surfaced", r.promos[0].redeemed_count, 3);
  const denied = fakeClient(errData("forbidden: admin access required"));
  const r2 = await adminListPromos(denied);
  eq("promo list: refusal not ok, empty", `${r2.ok}:${r2.promos.length}`, "false:0");
}

/* ---------- admin deactivate promo ---------- */
{
  const c = fakeClient(okData(true));
  const r = await adminDeactivatePromo(c, "pc1");
  eq("promo deactivate: ok", r.ok, true);
  eq("promo deactivate: rpc name + arg", `${c.calls[0].fn}:${c.calls[0].args?.p_code_id}`, "admin_deactivate_promo:pc1");
}
{
  const c = fakeClient(okData(false));
  const r = await adminDeactivatePromo(c, "pc-missing");
  eq("promo deactivate: no live key -> not ok", r.ok, false);
  const denied = fakeClient(errData("forbidden: admin access required"));
  const r2 = await adminDeactivatePromo(denied, "pc1");
  eq("promo deactivate: rpc error not ok", r2.ok, false);
  check("promo deactivate: rpc error message surfaced", (r2.error ?? "").includes("forbidden"));
}

console.log(`=== ACCESS ADMIN RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
