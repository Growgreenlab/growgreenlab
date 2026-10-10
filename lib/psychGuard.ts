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
