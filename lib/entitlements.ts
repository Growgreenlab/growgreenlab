/**
 * entitlements.ts — subscription plan read model (client side).
 *
 * The SERVER truth lives in the database (subscriptions-v1.sql):
 * public.sub_is_pro() is the one entitlement function and
 * public.usage_status() is the one read model; quota enforcement is
 * in triggers/RPCs and cannot be bypassed from here. This module only
 * (a) mirrors the status map as a pure function so it can be unit
 * tested and reused for display, (b) loads usage_status() through
 * the user's own RLS session, and (c) parses the structured quota
 * error the database raises (errcode GGL01, message
 * "quota_limit_reached", JSON detail) into an upgrade prompt.
 *
 * DARK BY DEFAULT: until the subscriptions migration is applied, the
 * usage_status RPC does not exist, loadEntitlement() returns null,
 * and every billing surface (counters, gates, prompts) stays hidden —
 * the product behaves exactly as it did before this feature. The Pro
 * gates additionally require the rollout timestamp
 * (NEXT_PUBLIC_SUBSCRIPTIONS_ROLLOUT_AT) to be configured; without it
 * nothing is ever gated.
 */

export const FREE_TRADES_PER_DAY = 3;
export const FREE_ENTRIES_PER_MONTH = 7;
export const IMPORT_ALLOWANCE_TOTAL = 100;

/** Shape returned by public.usage_status() (subscriptions-v1.sql). */
export interface UsageStatus {
  configured: true;
  is_pro: boolean;
  plan: "free" | "pro";
  trades_used: number;
  trades_limit: number;
  trades_remaining: number | null; // null = unlimited (Pro)
  entries_used: number;
  entries_limit: number;
  entries_remaining: number | null;
  import_allowance_remaining: number;
  day_reset_at: string;
  month_reset_at: string;
  subscription: {
    status: string;
    interval: "month" | "year" | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  /* Added by access-grants-v1.sql (additive — absent entirely on a
   * pre-grants database, where loadEntitlement still succeeds and
   * every surface below treats the source as unknown). */
  access_source?: AccessSource;
  /** When grant-based access fully ends; null for paid, permanent
   *  grants, and Free. */
  access_expires_at?: string | null;
}

/** Where the caller's Pro comes from (public.access_source()).
 *  Display provenance only — enforcement never reads this. */
export type AccessSource = "paid" | "owner" | "admin" | "promo" | "trial" | "free";

/**
 * Human label for the entitlement source, e.g. "Pro — Monthly",
 * "Pro — Owner access", "Pro — Promo until Nov 18, 2026".
 * Display only. Falls back to plain "Pro" / "Free" whenever the
 * source is unknown (pre-grants database) — is_pro stays the truth.
 */
export function entitlementSourceLabel(ent: UsageStatus | null): string | null {
  if (!ent) return null;
  if (!ent.is_pro) return "Free";
  const until = (base: string, iso: string | null | undefined): string => {
    if (!iso) return base;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return base;
    return `${base} until ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  };
  switch (ent.access_source) {
    case "owner": return "Pro — Owner access";
    case "admin": return until("Pro — Complimentary access", ent.access_expires_at);
    case "promo": return until("Pro — Promo", ent.access_expires_at);
    case "trial": return until("Pro — Trial", ent.access_expires_at);
    case "paid":
      return ent.subscription?.interval === "year"
        ? "Pro — Yearly"
        : ent.subscription?.interval === "month"
          ? "Pro — Monthly"
          : "Pro — Subscription";
    default: return "Pro";
  }
}

/** Minimal structural client (the Supabase browser client fits —
 *  its rpc() returns a thenable builder, hence PromiseLike). */
interface RpcClient {
  rpc(fn: string): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Load the caller's entitlement + usage. Returns null when billing
 * is not configured on this database yet (RPC missing or malformed)
 * — the dark state every surface must treat as "feature off".
 */
export async function loadEntitlement(client: RpcClient): Promise<UsageStatus | null> {
  try {
    const { data, error } = await client.rpc("usage_status");
    if (error || !data || typeof data !== "object") return null;
    const d = data as Partial<UsageStatus>;
    if (d.configured !== true || typeof d.is_pro !== "boolean") return null;
    return d as UsageStatus;
  } catch {
    return null;
  }
}

/**
 * The entitlement status map, mirrored 1:1 from sub_is_pro() in
 * subscriptions-v1.sql (the SQL harness pins the SQL side; the unit
 * suite pins this side — they must never drift):
 *   active   -> pro
 *   past_due -> pro until current_period_end + 7 days (D6 grace)
 *   canceled -> pro until current_period_end (paid-through date)
 *   anything else / no row -> not pro
 */
export function isProStatus(
  sub: { status: string; current_period_end: string | null } | null | undefined,
  now: Date,
): boolean {
  if (!sub) return false;
  if (sub.status === "active") return true;
  if (!sub.current_period_end) return false;
  const end = new Date(sub.current_period_end).getTime();
  if (Number.isNaN(end)) return false;
  if (sub.status === "past_due") return now.getTime() < end + 7 * 24 * 3600 * 1000;
  if (sub.status === "canceled") return now.getTime() < end;
  return false;
}

/* ---------- Grandfathering (D8) ---------- */

/**
 * The rollout instant that freezes grandfathering: accounts created
 * BEFORE it keep AI Edge Export access without Pro; accounts created
 * after it need Pro. Configured via NEXT_PUBLIC_SUBSCRIPTIONS_ROLLOUT_AT
 * (ISO timestamp) and set at migration-apply time (release checklist).
 * Unset/empty/invalid => gating is DARK: nobody is gated.
 */
export function subscriptionsRolloutAt(): Date | null {
  const raw = process.env.NEXT_PUBLIC_SUBSCRIPTIONS_ROLLOUT_AT ?? "";
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isGrandfathered(userCreatedAt: string | null | undefined, rolloutAt: Date | null): boolean {
  if (!rolloutAt || !userCreatedAt) return false;
  const created = new Date(userCreatedAt).getTime();
  return !Number.isNaN(created) && created < rolloutAt.getTime();
}

/** AI Edge Export gate: locked only when gating is live (rollout set),
 *  the user is not Pro, and the account is not grandfathered. */
export function exportLocked(args: {
  entitlement: UsageStatus | null;
  userCreatedAt: string | null | undefined;
  rolloutAt: Date | null;
}): boolean {
  if (!args.rolloutAt) return false; // dark
  if (!args.entitlement) return false; // billing not live on this DB yet
  if (args.entitlement.is_pro) return false;
  return !isGrandfathered(args.userCreatedAt, args.rolloutAt);
}

/** Advanced-analytics gate (Strategy Performance): same dark pattern;
 *  grandfathering was decided for the export only (D8), so once
 *  gating is live this applies to every Free account. */
export function advancedAnalyticsLocked(args: {
  entitlement: UsageStatus | null;
  rolloutAt: Date | null;
}): boolean {
  if (!args.rolloutAt) return false;
  if (!args.entitlement) return false;
  return !args.entitlement.is_pro;
}

/* ---------- Structured quota errors ---------- */

export interface QuotaLimit {
  kind: "daily_trade" | "monthly_entry";
  limit: number;
  used: number;
  logicalKey: string | null;
}

interface PgLikeError {
  code?: string;
  message?: string;
  details?: string;
  detail?: string;
}

/**
 * Parse the database's structured quota rejection (RAISE EXCEPTION
 * 'quota_limit_reached', errcode GGL01, JSON DETAIL). Supabase
 * surfaces the detail string on error.details. Returns null for any
 * other error, so callers can fall through to their normal handling.
 */
export function parseQuotaError(err: unknown): QuotaLimit | null {
  if (!err || typeof err !== "object") return null;
  const e = err as PgLikeError;
  const msg = typeof e.message === "string" ? e.message : "";
  if (e.code !== "GGL01" && !msg.includes("quota_limit_reached")) return null;
  let kind: QuotaLimit["kind"] = msg.includes("monthly") ? "monthly_entry" : "daily_trade";
  let limit = kind === "daily_trade" ? FREE_TRADES_PER_DAY : FREE_ENTRIES_PER_MONTH;
  let used = limit;
  let logicalKey: string | null = null;
  const detailRaw = typeof e.details === "string" ? e.details : typeof e.detail === "string" ? e.detail : "";
  if (detailRaw) {
    try {
      const d = JSON.parse(detailRaw) as { kind?: string; limit?: number; used?: number; logical_key?: string };
      if (d.kind === "daily_trade" || d.kind === "monthly_entry") kind = d.kind;
      if (typeof d.limit === "number") limit = d.limit;
      if (typeof d.used === "number") used = d.used;
      if (typeof d.logical_key === "string") logicalKey = d.logical_key;
    } catch { /* detail is best-effort; the defaults above stand */ }
  }
  return { kind, limit, used, logicalKey };
}

/** The user-facing sentence for a quota rejection + the counters line. */
export function quotaMessage(q: QuotaLimit): string {
  if (q.kind === "daily_trade") {
    return `Daily trade limit reached — ${q.used} of ${q.limit} free trades used today. Limits reset at 12:00 AM ET. Upgrade to Pro for unlimited trades.`;
  }
  return `Monthly journal limit reached — ${q.used} of ${q.limit} free journal entries used this month. Limits reset on the 1st at 12:00 AM ET. Upgrade to Pro for unlimited entries.`;
}

/* ---------- ET bucket math (display + tests; mirrors sub_et_day/month) ---------- */

const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
});

/** The America/New_York calendar day (YYYY-MM-DD) containing `d`. */
export function etDay(d: Date): string {
  const parts = ET_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The America/New_York calendar month (YYYY-MM) containing `d`. */
export function etMonth(d: Date): string {
  return etDay(d).slice(0, 7);
}
