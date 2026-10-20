/**
 * accessAdmin.ts — typed wrappers over the access-grants RPCs
 * (supabase/migrations/access-grants-v1.sql).
 *
 * These wrappers are CONVENIENCE ONLY. Every authorization decision
 * lives in Postgres: redeem_promo_code binds to auth.uid() and
 * answers every failure with one generic payload; the admin RPCs
 * re-check is_app_admin() server-side and refuse non-admins. A
 * tampered client gains nothing — it can only ever call the same
 * functions with the same session.
 *
 * All wrappers are total: they never throw. RPC/transport failures
 * collapse to { ok: false } results so UI code stays linear.
 */
import type { AccessSource } from "./entitlements";

/** Minimal structural client (the Supabase browser client fits). */
interface RpcClient {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface RedeemResult {
  ok: boolean;
  /** ISO instant the promo grant ends (success only). */
  expiresAt: string | null;
}

/**
 * Redeem a promo code for the signed-in caller. The server returns
 * one generic failure for every failure mode (unknown, expired,
 * exhausted, throttled, …) — this wrapper deliberately preserves
 * that indistinguishability: failure carries no reason.
 */
export async function redeemPromoCode(
  client: RpcClient,
  code: string,
): Promise<RedeemResult> {
  try {
    const { data, error } = await client.rpc("redeem_promo_code", {
      p_code: code,
    });
    if (error || !data || typeof data !== "object") {
      return { ok: false, expiresAt: null };
    }
    const d = data as { ok?: unknown; expires_at?: unknown };
    if (d.ok !== true) return { ok: false, expiresAt: null };
    return {
      ok: true,
      expiresAt: typeof d.expires_at === "string" ? d.expires_at : null,
    };
  } catch {
    return { ok: false, expiresAt: null };
  }
}

/** True when the signed-in caller is an app admin (server-checked). */
export async function checkIsAppAdmin(client: RpcClient): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("is_app_admin");
    return !error && data === true;
  } catch {
    return false;
  }
}

export interface AccessGrantRow {
  id: string;
  user_id: string;
  source: AccessSource | "free";
  starts_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  promo_code_id: string | null;
  note: string | null;
  created_at: string;
}

export interface GrantResult {
  ok: boolean;
  grantId: string | null;
  /** Server error message on refusal (admins are trusted callers,
   *  so unlike redeem these may be specific). */
  error: string | null;
}

/** Admin-only: grant complimentary access to a target user.
 *  source is 'admin' or 'trial' (owner grants are SQL-seeded only;
 *  promo grants come only from redemption — the server enforces
 *  both). durationDays null = permanent. */
export async function adminGrantAccess(
  client: RpcClient,
  args: {
    targetUserId: string;
    source: "admin" | "trial";
    durationDays: number | null;
    note: string | null;
  },
): Promise<GrantResult> {
  try {
    const { data, error } = await client.rpc("admin_grant_access", {
      p_target_user: args.targetUserId,
      p_source: args.source,
      p_duration_days: args.durationDays,
      p_note: args.note,
    });
    if (error) {
      return { ok: false, grantId: null, error: errorMessage(error) };
    }
    return {
      ok: typeof data === "string" && data.length > 0,
      grantId: typeof data === "string" ? data : null,
      error: null,
    };
  } catch (e) {
    return { ok: false, grantId: null, error: errorMessage(e) };
  }
}

export interface RevokeResult {
  ok: boolean;
  /** e.g. 'owner_grant_protected' | 'grant_not_found' | 'already_revoked' */
  error: string | null;
}

/** Admin-only: revoke a grant (row + history are preserved). */
export async function adminRevokeGrant(
  client: RpcClient,
  grantId: string,
): Promise<RevokeResult> {
  try {
    const { data, error } = await client.rpc("admin_revoke_grant", {
      p_grant_id: grantId,
    });
    if (error) return { ok: false, error: errorMessage(error) };
    if (!data || typeof data !== "object") {
      return { ok: false, error: "unexpected_response" };
    }
    const d = data as { ok?: unknown; error?: unknown };
    if (d.ok === true) return { ok: true, error: null };
    return {
      ok: false,
      error: typeof d.error === "string" ? d.error : "revoke_failed",
    };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Admin-only: list grants (optionally for one target user),
 *  newest first. Non-admins get { ok: false } — the RPC refuses. */
export async function adminListGrants(
  client: RpcClient,
  targetUserId?: string | null,
): Promise<{ ok: boolean; grants: AccessGrantRow[] }> {
  try {
    const { data, error } = await client.rpc("admin_list_grants", {
      p_target_user: targetUserId ?? null,
    });
    if (error || !Array.isArray(data)) return { ok: false, grants: [] };
    return { ok: true, grants: data as AccessGrantRow[] };
  } catch {
    return { ok: false, grants: [] };
  }
}

export interface PromoCodeRow {
  id: string;
  /** sha-256 of the normalized code — the plaintext is NEVER stored
   *  and can never be displayed again after creation. */
  code_hash: string;
  label: string | null;
  duration_days: number;
  /** When the KEY stops being redeemable (null = no key expiry). */
  expires_at: string | null;
  /** Redemption cap (null = unlimited). */
  max_redemptions: number | null;
  redeemed_count: number;
  per_user_limit: number;
  active: boolean;
  created_by: string | null;
  created_at: string;
}

export interface CreatePromoResult {
  ok: boolean;
  promoId: string | null;
  /** Server error message on refusal (admins are trusted callers,
   *  so unlike redeem these may be specific). */
  error: string | null;
}

/** Admin-only: create a promo key. Only the sha-256 of the
 *  normalized code is stored server-side — the plaintext exists
 *  solely in this call, so the caller must capture it NOW.
 *  maxRedemptions null = unlimited; expiresAt null = the key never
 *  expires (already-redeemed grants still run their own duration). */
export async function adminCreatePromo(
  client: RpcClient,
  args: {
    code: string;
    label: string | null;
    durationDays: number;
    maxRedemptions: number | null;
    perUserLimit: number;
    expiresAt: string | null;
  },
): Promise<CreatePromoResult> {
  try {
    const { data, error } = await client.rpc("admin_create_promo", {
      p_code: args.code,
      p_label: args.label,
      p_duration_days: args.durationDays,
      p_max_redemptions: args.maxRedemptions,
      p_per_user_limit: args.perUserLimit,
      p_expires_at: args.expiresAt,
    });
    if (error) {
      return { ok: false, promoId: null, error: errorMessage(error) };
    }
    return {
      ok: typeof data === "string" && data.length > 0,
      promoId: typeof data === "string" ? data : null,
      error: null,
    };
  } catch (e) {
    return { ok: false, promoId: null, error: errorMessage(e) };
  }
}

/** Admin-only: list promo keys, newest first. Non-admins get
 *  { ok: false } — the RPC refuses. Rows carry only code hashes. */
export async function adminListPromos(
  client: RpcClient,
): Promise<{ ok: boolean; promos: PromoCodeRow[] }> {
  try {
    const { data, error } = await client.rpc("admin_list_promos");
    if (error || !Array.isArray(data)) return { ok: false, promos: [] };
    return { ok: true, promos: data as PromoCodeRow[] };
  } catch {
    return { ok: false, promos: [] };
  }
}

export interface DeactivatePromoResult {
  ok: boolean;
  error: string | null;
}

/** Admin-only: deactivate a promo key. Stops NEW redemptions only;
 *  grants already redeemed keep running to their own expiry. The
 *  RPC returns true when a live key was deactivated. */
export async function adminDeactivatePromo(
  client: RpcClient,
  codeId: string,
): Promise<DeactivatePromoResult> {
  try {
    const { data, error } = await client.rpc("admin_deactivate_promo", {
      p_code_id: codeId,
    });
    if (error) return { ok: false, error: errorMessage(error) };
    return { ok: data === true, error: data === true ? null : "not_deactivated" };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return "request_failed";
}
