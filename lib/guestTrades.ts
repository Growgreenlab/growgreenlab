/**
 * Guest trade limit: 5 new positions per day for non-signed-in users.
 * Uses the device fingerprint (same mechanism as guard lockout sync).
 * Server-side counting via Postgres for tamper resistance.
 * localStorage fallback keeps the limit working offline.
 */

export const GUEST_DAILY_LIMIT = 5;

import { deviceFingerprint } from "./psychGuard";

export function getGuestFingerprint(): string {
  return deviceFingerprint();
}

// --- localStorage fallback (offline) ---

const LS_KEY = "ggl_guest_trades";

interface LocalUsage {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function readLocal(): LocalUsage {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { date: todayUTC(), count: 0 };
    const u = JSON.parse(raw) as LocalUsage;
    // Reset if it's a new day
    if (u.date !== todayUTC()) return { date: todayUTC(), count: 0 };
    return u;
  } catch {
    return { date: todayUTC(), count: 0 };
  }
}

function writeLocal(u: LocalUsage): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(u));
  } catch { /* ignore */ }
}

type AnyClient = any;

/** Get remaining guest trades for today. Falls back to localStorage offline. */
export async function getGuestTradesRemaining(
  supabase: AnyClient,
  fingerprint: string
): Promise<number> {
  try {
    const { data, error } = await supabase.rpc("guest_trades_remaining", {
      fp: fingerprint,
    });
    if (error) throw error;
    const server = typeof data === "number" ? data : GUEST_DAILY_LIMIT;
    // Merge with local: take the lower remaining (stricter)
    const local = readLocal();
    const localRemaining = Math.max(0, GUEST_DAILY_LIMIT - local.count);
    return Math.min(server, localRemaining);
  } catch {
    // Offline: use localStorage
    const local = readLocal();
    return Math.max(0, GUEST_DAILY_LIMIT - local.count);
  }
}

/**
 * Atomically consume one guest trade. Returns true if consumed, false if at limit.
 * Only call after a successful NEW position open.
 * Always writes localStorage; also writes server when online.
 */
export async function consumeGuestTrade(
  supabase: AnyClient,
  fingerprint: string
): Promise<boolean> {
  // Always increment local first (works offline)
  const local = readLocal();
  const localAllowed = local.count < GUEST_DAILY_LIMIT;
  if (localAllowed) {
    writeLocal({ date: local.date, count: local.count + 1 });
  }

  try {
    const { data, error } = await supabase.rpc("try_consume_guest_trade", {
      fp: fingerprint,
      max_trades: GUEST_DAILY_LIMIT,
    });
    if (error) throw error;
    // Server is authoritative when reachable; reconcile local
    if (data === true) return true;
    // Server says at limit — ensure local reflects it
    writeLocal({ date: todayUTC(), count: GUEST_DAILY_LIMIT });
    return false;
  } catch {
    // Offline: rely on localStorage
    return localAllowed;
  }
}
