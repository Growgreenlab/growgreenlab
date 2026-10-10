/**
 * Guest trade limit: 5 new positions per day for non-signed-in users.
 * Uses the device fingerprint (same mechanism as guard lockout sync).
 * Server-side counting via Postgres for tamper resistance.
 */

export const GUEST_DAILY_LIMIT = 5;

import { deviceFingerprint } from "./psychGuard";

export function getGuestFingerprint(): string {
  return deviceFingerprint();
}

type AnyClient = any;

/** Get remaining guest trades for today. Returns limit if unavailable. */
export async function getGuestTradesRemaining(
  supabase: AnyClient,
  fingerprint: string
): Promise<number> {
  try {
    const { data, error } = await supabase.rpc("guest_trades_remaining", {
      fp: fingerprint,
    });
    if (error) return GUEST_DAILY_LIMIT;
    return typeof data === "number" ? data : GUEST_DAILY_LIMIT;
  } catch {
    return GUEST_DAILY_LIMIT;
  }
}

/**
 * Atomically consume one guest trade. Returns true if consumed, false if at limit.
 * Only call after a successful NEW position open.
 */
export async function consumeGuestTrade(
  supabase: AnyClient,
  fingerprint: string
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("try_consume_guest_trade", {
      fp: fingerprint,
      max_trades: GUEST_DAILY_LIMIT,
    });
    if (error) return true; // fail open: don't block trading on DB errors
    return data === true;
  } catch {
    return true;
  }
}
