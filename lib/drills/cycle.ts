/**
 * Breakout Drill — non-repeating Blind Practice cycle queue.
 *
 * Blind Practice runs in CYCLES over the scenario pool (see
 * docs/drill-pool-2026-10-14.md for the full design note):
 *
 *  - A cycle's eligibility set is the blind catalog's opaque slugs,
 *    FROZEN at cycle creation under the then-current CATALOG_VERSION.
 *    Scenarios added to the catalog later join at the next cycle
 *    boundary — an active cycle never gains or loses scenarios, so a
 *    submitted attempt can never be invalidated mid-cycle.
 *  - The queue is a seeded shuffle (a true permutation of the
 *    eligibility set). Serving order: a started-but-unsubmitted drill
 *    is re-offered first (most recently started); otherwise the next
 *    unsubmitted queue entry. A scenario is therefore never served
 *    twice in a cycle once submitted.
 *  - SUBMITTED — the one consumption event — means a decision was
 *    SEALED in the DecisionLedger for that scenario in that cycle.
 *    Opening a drill, or starting it and leaving before sealing,
 *    consumes nothing. Submission is a single state transition keyed
 *    by (cycleId, slug) and is IDEMPOTENT: a slug already submitted
 *    can never be recorded twice, so double-clicks, retries, remounts,
 *    and replays of a submitted drill cannot duplicate or overwrite
 *    the sealed record.
 *  - Persistence is CLIENT-SIDE ONLY (localStorage, one versioned
 *    record): queue order, cycle id, started attempts, submitted
 *    attempts, and all archived cycles survive refresh, back/forward
 *    navigation, and browser reopen. No server, no accounts.
 *  - The persisted record contains ONLY opaque slugs — never internal
 *    scenario ids, never classifications of unsubmitted drills. A
 *    submitted attempt's record carries its revealed classification
 *    (that scenario has been answered and reviewed; it is results
 *    data, shown on the cycle-complete screen).
 *
 * Concurrency model (and its honest limits): every write path goes
 * through updatePool(), which re-reads the stored record immediately
 * before applying its transition and writes the result back in the
 * same synchronous turn — another tab's committed writes are never
 * clobbered by a stale in-memory copy, and within a tab transitions
 * are atomic. Two tabs submitting in the exact same synchronous
 * window could still race (localStorage has no compare-and-swap);
 * the loser re-reads on its next transition and its duplicate submit
 * is absorbed by the idempotency guard. No server-side guarantee is
 * claimed — there is no server.
 */
import { BLIND_CATALOG, CATALOG_VERSION } from "./catalog";
import type {
  BreakoutClassification,
  DecisionClassification,
  IntendedAction,
} from "./types";

/** localStorage key for the one versioned pool record. */
export const POOL_STORAGE_KEY = "ggl-drill-pool-v1";
/** Schema version of the persisted record itself. */
export const POOL_STATE_VERSION = 1;

/** Same mulberry32 algorithm as catalog.ts / candleGen.ts. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded Fisher–Yates shuffle (deterministic for a given seed). */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Everything the cycle-complete results screen needs about one sealed
 * submission. Written once, at seal time, from the locked decision +
 * scoring output; never mutated afterwards.
 */
export interface SubmittedAttempt {
  /** Opaque blind slug, e.g. "d-047". Matches its record key. */
  slug: string;
  /** The scenario's actual classification (results data — revealed). */
  actualClassification: BreakoutClassification;
  /** The user's locked classification read. */
  classification: DecisionClassification;
  /** The user's locked intended action. */
  action: IntendedAction;
  /** Effective confidence stamped on the locked decision (1–5). */
  confidence: number;
  readVerdict: "correct" | "partial" | "incorrect";
  actionVerdict: "appropriate" | "acceptable" | "inappropriate";
  /** Component scores 0–1, exactly as scoring.ts produced them. */
  readScore: number;
  actionScore: number;
  /** Combined 0–100. */
  overall: number;
  /** Canonical lock label from the sealed decision ("10:00 · candle 15"). */
  lockLabel: string;
  /** Scenario seed — the submission is reproducible from it. */
  scenarioSeed: number;
  /** Epoch ms when this submission was recorded. */
  submittedAt: number;
}

export interface DrillCycle {
  cycleId: string;
  /** Catalog version the eligibility set was frozen under. */
  catalogVersion: number;
  /** Eligibility set frozen at creation (opaque slugs, catalog order). */
  eligible: string[];
  /** Serving order — a permutation of `eligible`. */
  queue: string[];
  /** slug → epoch ms an attempt was started but not yet submitted. */
  started: Record<string, number>;
  /** slug → sealed submission record. The consumption ledger. */
  submitted: Record<string, SubmittedAttempt>;
  createdAt: number;
  /** Epoch ms the final submission landed; null while in progress. */
  completedAt: number | null;
}

export interface PoolState {
  version: number;
  active: DrillCycle;
  /** Finished (or superseded) cycles, oldest first, preserved verbatim. */
  archives: DrillCycle[];
}

/** The slugs a NEW cycle created right now would be eligible for. */
export function currentEligibleSlugs(): string[] {
  return BLIND_CATALOG.map((d) => d.slug);
}

export function createCycle(seed: number, now: number, ordinal: number): DrillCycle {
  const eligible = currentEligibleSlugs();
  return {
    cycleId: `cycle-${ordinal}-${(seed >>> 0).toString(36)}`,
    catalogVersion: CATALOG_VERSION,
    eligible,
    queue: shuffled(eligible, seed),
    started: {},
    submitted: {},
    createdAt: now,
    completedAt: null,
  };
}

export function createPoolState(seed: number, now: number): PoolState {
  return { version: POOL_STATE_VERSION, active: createCycle(seed, now, 1), archives: [] };
}

export function isCycleComplete(cycle: DrillCycle): boolean {
  return cycle.eligible.every((slug) => cycle.submitted[slug] !== undefined);
}

export function submittedCount(cycle: DrillCycle): number {
  return Object.keys(cycle.submitted).length;
}

/**
 * The slug Blind Practice serves next:
 *  1. a started-but-unsubmitted drill (most recently started first —
 *     an interrupted attempt is resumed before any fresh draw);
 *  2. otherwise the next unsubmitted entry in queue order;
 *  3. null when the cycle is complete.
 */
export function serveNextSlug(state: PoolState): string | null {
  const { active } = state;
  let best: string | null = null;
  for (const slug of active.queue) {
    const startedAt = active.started[slug];
    if (startedAt === undefined || active.submitted[slug]) continue;
    if (best === null || startedAt > active.started[best]) best = slug;
  }
  if (best !== null) return best;
  for (const slug of active.queue) {
    if (!active.submitted[slug]) return slug;
  }
  return null;
}

/**
 * Record that an attempt on `slug` was started. No-op (same state
 * reference) when the slug is not in this cycle, already submitted,
 * or already started — starting consumes nothing.
 */
export function markStarted(state: PoolState, slug: string, now: number): PoolState {
  const { active } = state;
  if (!active.eligible.includes(slug)) return state;
  if (active.submitted[slug] || active.started[slug] !== undefined) return state;
  return {
    ...state,
    active: { ...active, started: { ...active.started, [slug]: now } },
  };
}

/**
 * Record a sealed submission — THE consumption event. One transition
 * keyed by (cycleId, slug): if the slug is not eligible in the active
 * cycle, or is already submitted, the state is returned unchanged and
 * `applied` is false. The existing sealed record is never overwritten.
 */
export function submitAttempt(
  state: PoolState,
  attempt: SubmittedAttempt
): { state: PoolState; applied: boolean } {
  const { active } = state;
  const slug = attempt.slug;
  if (!active.eligible.includes(slug)) return { state, applied: false };
  if (active.submitted[slug]) return { state, applied: false };
  const submitted = { ...active.submitted, [slug]: attempt };
  const started = { ...active.started };
  delete started[slug];
  const next: DrillCycle = { ...active, submitted, started };
  if (isCycleComplete(next) && next.completedAt === null) {
    next.completedAt = attempt.submittedAt;
  }
  return { state: { ...state, active: next }, applied: true };
}

/**
 * Start a new cycle: the active cycle is archived VERBATIM (its sealed
 * records are never edited or deleted) and a fresh cycle is created
 * from the CURRENT catalog — scenarios added since the old cycle began
 * join here, at the boundary.
 */
export function startNewCycle(state: PoolState, seed: number, now: number): PoolState {
  const ordinal = state.archives.length + 2;
  return {
    version: POOL_STATE_VERSION,
    active: createCycle(seed, now, ordinal),
    archives: [...state.archives, state.active],
  };
}

export interface CycleResults {
  /** Submitted attempts in queue (serving) order. */
  rows: SubmittedAttempt[];
  submitted: number;
  total: number;
  complete: boolean;
  /** Mean overall score 0–100 over submitted attempts (null if none). */
  avgOverall: number | null;
  /** Mean classification score as a percentage (null if none). */
  readPct: number | null;
  /** Mean action score as a percentage (null if none). */
  actionPct: number | null;
}

export function cycleResults(cycle: DrillCycle): CycleResults {
  const rows = cycle.queue
    .map((slug) => cycle.submitted[slug])
    .filter((a): a is SubmittedAttempt => a !== undefined);
  const mean = (xs: number[]) =>
    xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
  const avgOverall = mean(rows.map((r) => r.overall));
  const read = mean(rows.map((r) => r.readScore));
  const action = mean(rows.map((r) => r.actionScore));
  return {
    rows,
    submitted: rows.length,
    total: cycle.eligible.length,
    complete: isCycleComplete(cycle),
    avgOverall: avgOverall === null ? null : Math.round(avgOverall),
    readPct: read === null ? null : Math.round(read * 100),
    actionPct: action === null ? null : Math.round(action * 100),
  };
}

/** Display label for a slug — derivable from the slug alone ("d-047" → "HOD Drill #047"). */
export function labelForSlug(slug: string): string {
  return `HOD Drill #${slug.startsWith("d-") ? slug.slice(2) : slug}`;
}

// ---------------------------------------------------------------------
// Persistence: load + validate + repair, save, and read-modify-write.
// ---------------------------------------------------------------------

/** Minimal storage surface (localStorage-compatible; testable). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage, or null when unavailable (SSR, privacy mode). */
export function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

const CLASSIFICATIONS: readonly string[] = ["clean", "weak", "failed", "continuation", "ambiguous"];
const DECISIONS: readonly string[] = ["clean", "weak", "failed", "ambiguous"];
const ACTIONS: readonly string[] = ["enter", "wait", "skip"];
const READ_VERDICTS: readonly string[] = ["correct", "partial", "incorrect"];
const ACTION_VERDICTS: readonly string[] = ["appropriate", "acceptable", "inappropriate"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isSlug = (v: unknown): v is string =>
  typeof v === "string" && /^d-\d{3}$/.test(v);

function sanitizeAttempt(key: string, raw: unknown): SubmittedAttempt | null {
  if (!isRecord(raw)) return null;
  if (raw.slug !== key) return null;
  if (!CLASSIFICATIONS.includes(raw.actualClassification as string)) return null;
  if (!DECISIONS.includes(raw.classification as string)) return null;
  if (!ACTIONS.includes(raw.action as string)) return null;
  if (!isFiniteNum(raw.confidence) || raw.confidence < 1 || raw.confidence > 5) return null;
  if (!READ_VERDICTS.includes(raw.readVerdict as string)) return null;
  if (!ACTION_VERDICTS.includes(raw.actionVerdict as string)) return null;
  if (!isFiniteNum(raw.readScore) || raw.readScore < 0 || raw.readScore > 1) return null;
  if (!isFiniteNum(raw.actionScore) || raw.actionScore < 0 || raw.actionScore > 1) return null;
  if (!isFiniteNum(raw.overall) || raw.overall < 0 || raw.overall > 100) return null;
  if (typeof raw.lockLabel !== "string") return null;
  if (!isFiniteNum(raw.scenarioSeed)) return null;
  if (!isFiniteNum(raw.submittedAt)) return null;
  return raw as unknown as SubmittedAttempt;
}

/**
 * Validate + repair one stored cycle. Returns null when the cycle is
 * unrecoverable (not an object, no id, empty eligibility). Repairs are
 * conservative: the queue is rebuilt into a true permutation of the
 * (frozen) eligibility set, started entries for submitted/unknown
 * slugs are dropped, and submitted records are kept whenever they are
 * individually valid — a sealed record is never discarded to fix a
 * bookkeeping field.
 */
function sanitizeCycle(raw: unknown): DrillCycle | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.cycleId !== "string" || raw.cycleId.length === 0) return null;
  if (!Array.isArray(raw.eligible)) return null;
  const eligible: string[] = [];
  for (const s of raw.eligible) {
    if (isSlug(s) && !eligible.includes(s)) eligible.push(s);
  }
  if (eligible.length === 0) return null;

  const submitted: Record<string, SubmittedAttempt> = {};
  if (isRecord(raw.submitted)) {
    for (const [key, value] of Object.entries(raw.submitted)) {
      if (!eligible.includes(key)) continue;
      const attempt = sanitizeAttempt(key, value);
      if (attempt) submitted[key] = attempt;
    }
  }

  const queue: string[] = [];
  if (Array.isArray(raw.queue)) {
    for (const s of raw.queue) {
      if (isSlug(s) && eligible.includes(s) && !queue.includes(s)) queue.push(s);
    }
  }
  for (const s of eligible) if (!queue.includes(s)) queue.push(s);

  const started: Record<string, number> = {};
  if (isRecord(raw.started)) {
    for (const [key, value] of Object.entries(raw.started)) {
      if (eligible.includes(key) && !submitted[key] && isFiniteNum(value)) {
        started[key] = value;
      }
    }
  }

  const cycle: DrillCycle = {
    cycleId: raw.cycleId,
    catalogVersion: isFiniteNum(raw.catalogVersion) ? raw.catalogVersion : CATALOG_VERSION,
    eligible,
    queue,
    started,
    submitted,
    createdAt: isFiniteNum(raw.createdAt) ? raw.createdAt : 0,
    completedAt: null,
  };
  if (isCycleComplete(cycle)) {
    const times = Object.values(submitted).map((a) => a.submittedAt);
    cycle.completedAt = isFiniteNum(raw.completedAt)
      ? raw.completedAt
      : times.length > 0
        ? Math.max(...times)
        : cycle.createdAt;
  }
  return cycle;
}

/**
 * Parse a stored record into a valid PoolState, repairing what is
 * safely repairable. Returns null when the record is absent, not JSON,
 * the wrong schema version, or its active cycle is unrecoverable —
 * callers fall back to a fresh pool (the safe default).
 */
export function parsePool(json: string | null): PoolState | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== POOL_STATE_VERSION) return null;
  const active = sanitizeCycle(raw.active);
  if (!active) return null;
  const archives: DrillCycle[] = [];
  if (Array.isArray(raw.archives)) {
    for (const entry of raw.archives) {
      const cycle = sanitizeCycle(entry);
      if (cycle) archives.push(cycle);
    }
  }
  return { version: POOL_STATE_VERSION, active, archives };
}

export function serializePool(state: PoolState): string {
  return JSON.stringify(state);
}

export function loadPool(storage: KeyValueStorage): PoolState | null {
  try {
    return parsePool(storage.getItem(POOL_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function savePool(storage: KeyValueStorage, state: PoolState): void {
  try {
    storage.setItem(POOL_STORAGE_KEY, serializePool(state));
  } catch {
    /* storage full/blocked — the in-memory session continues; the drill itself never breaks */
  }
}

/** Load the stored pool, or create + persist a fresh one. */
export function ensurePool(
  storage: KeyValueStorage,
  seed: number,
  now: number
): PoolState {
  const existing = loadPool(storage);
  if (existing) return existing;
  const fresh = createPoolState(seed, now);
  savePool(storage, fresh);
  return fresh;
}

/**
 * The one write path for all pool transitions: re-read the stored
 * record immediately before applying `fn`, then persist the result if
 * it changed. If the stored record is missing/corrupt, `fn` is applied
 * to a fresh pool. Returns the state after the transition.
 */
export function updatePool(
  storage: KeyValueStorage,
  seed: number,
  now: number,
  fn: (state: PoolState) => PoolState
): PoolState {
  const base = loadPool(storage) ?? createPoolState(seed, now);
  const next = fn(base);
  if (next !== base) savePool(storage, next);
  return next;
}
