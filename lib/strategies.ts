/**
 * strategies.ts — Daily Replay trading strategies (prepared migration:
 * supabase/migrations/daily-replay-strategies-v1.sql).
 *
 * A strategy is identity only (name, notes, archive flag). Everything
 * that defines HOW it trades — setup type, entry/stop/target/exit
 * rules, market filters — lives on an immutable VERSION. Versions are
 * never edited or deleted (the database enforces this: SELECT +
 * INSERT policies only); changing the rules means allocating the next
 * version via the dr_allocate_strategy_version RPC, which numbers it
 * atomically server-side.
 *
 * A Daily Replay attempt is BORN with the version it was locked under
 * (attempts.strategy_version_id, set inside dr_create_attempt), so any
 * finished attempt's strategy is a fact about the attempt, never a
 * later annotation. Attempts locked without a strategy keep NULL —
 * "no strategy recorded" — and nothing is ever backfilled.
 *
 * This module is pure shaping/mapping: row <-> domain conversion,
 * labels, grouping for the review surfaces, and the small predicates
 * the UI needs. All persistence goes through Supabase under owner RLS
 * (journal page) or the security-definer RPCs (replay page).
 */

export type StrategySetupType =
  | "hod_breakout"
  | "ema_pullback"
  | "vwap_pullback"
  | "custom";

export const STRATEGY_SETUP_TYPES: { value: StrategySetupType; label: string }[] = [
  { value: "hod_breakout", label: "HOD breakout" },
  { value: "ema_pullback", label: "EMA pullback" },
  { value: "vwap_pullback", label: "VWAP pullback" },
  { value: "custom", label: "Custom" },
];

export function isStrategySetupType(v: unknown): v is StrategySetupType {
  return v === "hod_breakout" || v === "ema_pullback" || v === "vwap_pullback" || v === "custom";
}

export function setupTypeLabel(t: StrategySetupType | string | null | undefined): string {
  if (!t) return "Not recorded";
  return STRATEGY_SETUP_TYPES.find((s) => s.value === t)?.label ?? t;
}

export interface Strategy {
  id: string;
  userId: string;
  name: string;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Classification vocabulary family for the journal's per-trade
   *  "Strategy traded" annotation (migration
   *  journal-strategy-annotation-v1.sql — PREPARED, may not be
   *  applied yet). Read defensively: the column is simply absent
   *  from rows fetched before the migration, so this stays null and
   *  the family falls back to read-time derivation from the latest
   *  version's setup_type (lib/strategyClassification.ts). */
  classificationFamily: string | null;
}

export interface StrategyVersion {
  id: string;
  strategyId: string;
  userId: string;
  version: number;
  setupType: StrategySetupType;
  entryRules: string | null;
  stopRules: string | null;
  targetRules: string | null;
  exitRules: string | null;
  marketFilters: Record<string, unknown>;
  notes: string | null;
  createdAt: string | null;
}

/** A daily_replay_attempts row, as the journal/replay surfaces need it. */
export interface DrAttemptLink {
  id: string;
  sessionId: string | null;
  strategyVersionId: string | null;
  status: "active" | "finished" | "abandoned" | string;
  startIndex: number | null;
  createdAt: string | null;
  finishedAt: string | null;
}

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function mapStrategyRow(r: Row): Strategy {
  return {
    id: String(r.id ?? ""),
    userId: String(r.user_id ?? ""),
    name: typeof r.name === "string" ? r.name : "",
    notes: str(r.notes),
    archivedAt: str(r.archived_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    classificationFamily: str(r.classification_family),
  };
}

export function mapStrategyVersionRow(r: Row): StrategyVersion {
  const mf = r.market_filters;
  return {
    id: String(r.id ?? ""),
    strategyId: String(r.strategy_id ?? ""),
    userId: String(r.user_id ?? ""),
    version: num(r.version) ?? 0,
    setupType: isStrategySetupType(r.setup_type) ? r.setup_type : "custom",
    entryRules: str(r.entry_rules),
    stopRules: str(r.stop_rules),
    targetRules: str(r.target_rules),
    exitRules: str(r.exit_rules),
    marketFilters: mf != null && typeof mf === "object" && !Array.isArray(mf) ? (mf as Record<string, unknown>) : {},
    notes: str(r.notes),
    createdAt: str(r.created_at),
  };
}

export function mapAttemptRow(r: Row): DrAttemptLink {
  return {
    id: String(r.id ?? ""),
    sessionId: str(r.session_id),
    strategyVersionId: str(r.strategy_version_id),
    status: typeof r.status === "string" ? r.status : "active",
    startIndex: num(r.start_index),
    createdAt: str(r.created_at),
    finishedAt: str(r.finished_at),
  };
}

export function isStrategyArchived(s: Strategy): boolean {
  return s.archivedAt != null;
}

/** "HOD Breakout · v2" — the one label format used everywhere. */
export function strategyVersionLabel(
  strategyName: string | null | undefined,
  version: number | null | undefined,
): string {
  if (!strategyName) return "No strategy recorded";
  return version != null ? `${strategyName} · v${version}` : strategyName;
}

/**
 * The version number the NEXT allocation will receive, given the
 * versions that exist. Display/prediction only — the authoritative
 * allocation happens server-side under the strategy row lock, and the
 * unique (strategy_id, version) constraint is the backstop.
 */
export function nextVersionNumber(versions: Pick<StrategyVersion, "version">[]): number {
  return versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
}

export interface StrategyWithVersions {
  strategy: Strategy;
  versions: StrategyVersion[]; // ascending by version number
}

/** Group flat version rows under their strategies, both sorted for display. */
export function groupStrategies(
  strategies: Strategy[],
  versions: StrategyVersion[],
): StrategyWithVersions[] {
  const byStrategy = new Map<string, StrategyVersion[]>();
  for (const v of versions) {
    const arr = byStrategy.get(v.strategyId) ?? [];
    arr.push(v);
    byStrategy.set(v.strategyId, arr);
  }
  return strategies
    .map((s) => ({
      strategy: s,
      versions: (byStrategy.get(s.id) ?? []).slice().sort((a, b) => a.version - b.version),
    }))
    .sort((a, b) => (a.strategy.name || "").localeCompare(b.strategy.name || ""));
}

/** Attempts recorded against one version, newest first. */
export function attemptsForVersion(
  attempts: DrAttemptLink[],
  versionId: string,
): DrAttemptLink[] {
  return attempts
    .filter((a) => a.strategyVersionId === versionId)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * Resolve the display context for a version id against loaded
 * strategies/versions. Returns null when the version is unknown to the
 * caller (e.g. the strategies tables are not available yet) — callers
 * render "strategy details unavailable", never a guess.
 */
export function resolveVersionContext(
  versionId: string | null | undefined,
  strategies: Strategy[],
  versions: StrategyVersion[],
): { strategy: Strategy; version: StrategyVersion; label: string } | null {
  if (!versionId) return null;
  const version = versions.find((v) => v.id === versionId);
  if (!version) return null;
  const strategy = strategies.find((s) => s.id === version.strategyId);
  if (!strategy) return null;
  return { strategy, version, label: strategyVersionLabel(strategy.name, version.version) };
}
