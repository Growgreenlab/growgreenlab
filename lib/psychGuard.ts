/**
 * psychGuard.ts — Psychology Guard V1 (position-based).
 *
 * Tracks loss against the INITIAL POSITION VALUE (not account balance).
 * When a position's combined realized + unrealized P&L drops past
 * configured thresholds, it warns or locks new entries for a cooldown.
 *
 * Position Loss % = -(realizedPnl + unrealizedPnl) / initialPositionValue * 100
 */

export interface GuardThreshold {
  lossPct: number; // e.g. 5, 10, 20, 30
  lockMinutes: number; // 0 = warning only
}

export const DEFAULT_THRESHOLDS: GuardThreshold[] = [
  { lossPct: 5, lockMinutes: 0 },
  { lossPct: 10, lockMinutes: 30 },
  { lossPct: 20, lockMinutes: 60 },
  { lossPct: 30, lockMinutes: 180 },
];

export interface PositionBaseline {
  shares: number;
  avgEntry: number;
  value: number; // shares * avgEntry, fixed denominator
}

export interface LockoutState {
  expiry: number; // epoch ms
  threshold: number; // lossPct that triggered it
  startedAt: number;
}

const LOCKOUT_KEY = "psychGuard.lockout.v1";
const CONFIG_KEY = "psychGuard.config.v1";

export function calculatePositionLoss(
  baseline: PositionBaseline | null,
  positionRealized: number,
  unrealizedPnl: number
): { pnl: number; lossPct: number } | null {
  if (!baseline || baseline.value <= 0) return null;
  const pnl = positionRealized + unrealizedPnl;
  const lossPct = (-pnl / baseline.value) * 100;
  return { pnl, lossPct };
}

/** Highest threshold at or below the current loss %. */
export function activeThreshold(
  lossPct: number,
  thresholds: GuardThreshold[]
): GuardThreshold | null {
  let hit: GuardThreshold | null = null;
  for (const t of thresholds) {
    if (lossPct >= t.lossPct && (!hit || t.lossPct > hit.lossPct)) hit = t;
  }
  return hit;
}

// --- Persistence (localStorage, no paid services) ---

export function saveLockout(l: LockoutState): void {
  try {
    localStorage.setItem(LOCKOUT_KEY, JSON.stringify(l));
  } catch { /* storage unavailable */ }
}

export function loadLockout(): LockoutState | null {
  try {
    const raw = localStorage.getItem(LOCKOUT_KEY);
    if (!raw) return null;
    const l = JSON.parse(raw) as LockoutState;
    if (!l.expiry || l.expiry <= Date.now()) {
      clearLockout();
      return null;
    }
    return l;
  } catch {
    return null;
  }
}

export function clearLockout(): void {
  try {
    localStorage.removeItem(LOCKOUT_KEY);
  } catch { /* ignore */ }
}

export function saveThresholds(t: GuardThreshold[]): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(t));
  } catch { /* ignore */ }
}

export function loadThresholds(): GuardThreshold[] {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_THRESHOLDS;
    const t = JSON.parse(raw) as GuardThreshold[];
    if (!Array.isArray(t) || t.length === 0) return DEFAULT_THRESHOLDS;
    return t.filter((x) => typeof x.lossPct === "number" && typeof x.lockMinutes === "number");
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

// --- Supabase sync (signed-in users): lockout follows across browsers/devices ---

type AnyClient = any;

/** Save lockout to Supabase for cross-browser persistence. Fire-and-forget. */
export async function saveLockoutRemote(
  supabase: AnyClient,
  userId: string,
  l: LockoutState
): Promise<void> {
  try {
    await supabase.from("profiles").update({
      guard_lockout_expiry: new Date(l.expiry).toISOString(),
      guard_lockout_threshold: l.threshold,
      guard_lockout_started_at: new Date(l.startedAt).toISOString(),
    }).eq("id", userId);
  } catch { /* offline or RLS — localStorage remains the fallback */ }
}

/** Load lockout from Supabase. Returns null if none or expired. */
export async function loadLockoutRemote(
  supabase: AnyClient,
  userId: string
): Promise<LockoutState | null> {
  try {
    const { data } = await supabase.from("profiles")
      .select("guard_lockout_expiry, guard_lockout_threshold, guard_lockout_started_at")
      .eq("id", userId).single();
    if (!data?.guard_lockout_expiry) return null;
    const expiry = new Date(data.guard_lockout_expiry as string).getTime();
    if (expiry <= Date.now()) return null;
    return {
      expiry,
      threshold: Number(data.guard_lockout_threshold ?? 0),
      startedAt: new Date(data.guard_lockout_started_at as string).getTime() || Date.now(),
    };
  } catch {
    return null;
  }
}

/** Clear remote lockout (on expiry). */
export async function clearLockoutRemote(
  supabase: AnyClient,
  userId: string
): Promise<void> {
  try {
    await supabase.from("profiles").update({
      guard_lockout_expiry: null,
      guard_lockout_threshold: null,
      guard_lockout_started_at: null,
    }).eq("id", userId);
  } catch { /* ignore */ }
}

/** Merge local and remote lockouts — the later expiry wins. */
export function mergeLockouts(
  local: LockoutState | null,
  remote: LockoutState | null
): LockoutState | null {
  if (!local) return remote;
  if (!remote) return local;
  return remote.expiry > local.expiry ? remote : local;
}

// --- Guest device fingerprint (public mode): same device, different browser ---

/** Build a stable-ish device fingerprint from browser attributes. */
export function deviceFingerprint(): string {
  try {
    const parts = [
      navigator.userAgent,
      navigator.language,
      String(screen.width),
      String(screen.height),
      String(screen.colorDepth),
      Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      String(new Date().getTimezoneOffset()),
      // Canvas fingerprint
      (() => {
        try {
          const c = document.createElement("canvas");
          const ctx = c.getContext("2d");
          if (!ctx) return "";
          ctx.textBaseline = "top";
          ctx.font = "14px Arial";
          ctx.fillText("gg-lab", 2, 2);
          return c.toDataURL().slice(-64);
        } catch { return ""; }
      })(),
    ];
    const s = parts.join("|");
    // Simple FNV-1a hash
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return "gfp_" + h.toString(36);
  } catch {
    return "gfp_unknown";
  }
}

/** Save guest lockout keyed by device fingerprint. */
export async function saveGuestLockoutRemote(
  supabase: AnyClient,
  fingerprint: string,
  l: LockoutState
): Promise<void> {
  try {
    await supabase.from("guest_guard_lockouts").upsert({
      fingerprint,
      expiry: new Date(l.expiry).toISOString(),
      threshold: l.threshold,
      started_at: new Date(l.startedAt).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "fingerprint" });
  } catch { /* offline — localStorage fallback */ }
}

/** Load guest lockout by fingerprint. */
export async function loadGuestLockoutRemote(
  supabase: AnyClient,
  fingerprint: string
): Promise<LockoutState | null> {
  try {
    const { data } = await supabase.from("guest_guard_lockouts")
      .select("expiry, threshold, started_at")
      .eq("fingerprint", fingerprint).single();
    if (!data?.expiry) return null;
    const expiry = new Date(data.expiry as string).getTime();
    if (expiry <= Date.now()) return null;
    return {
      expiry,
      threshold: Number(data.threshold ?? 0),
      startedAt: new Date(data.started_at as string).getTime() || Date.now(),
    };
  } catch {
    return null;
  }
}
