/**
 * Trading Academy — progress store (Stage 2 foundation).
 *
 * Two layers, one shape:
 *  - GUEST: a versioned localStorage record (`ggl-academy-v1`), the
 *    same convention as the drills pool (`ggl-drill-pool-v1`) and the
 *    guest trade guard (`ggl_guest_trades`). Per-device only — the UI
 *    says so plainly. Loading is parse-tolerant: a corrupt or
 *    wrong-version record degrades to an empty state, never a crash.
 *  - AUTHENTICATED: best-effort sync against `academy_progress` /
 *    `academy_journal` (see supabase/migrations/academy-v1.sql). The
 *    migration is applied by hand at go-live; until the tables exist
 *    every sync call fails SOFT — the learner keeps full guest-mode
 *    behavior, no error reaches the UI, and nothing claims to be
 *    "synced" that was not (sync returns synced: false).
 *
 * MERGE RULE (guest → account, and any two states): the better state
 * wins per lesson — status rank mastered > completed > in-progress >
 * not-started; bestScore takes the max; attempts take the MAX (never
 * summed — summing would double-count the same attempts after a
 * re-sync); lastPosition comes from the higher-ranked side (ties:
 * the side with the later updatedAt). Reflections merge per
 * (lesson, prompt): the server value wins, guest fills gaps.
 * Misconception counters take the max per concept. A merge can never
 * downgrade a lesson.
 *
 * Status semantics: a lesson is "completed" when its activities are
 * done (completeLesson, or an assessment attempt submitted), and
 * "mastered" only when an attempt scores at or above the lesson's
 * threshold (default 80). There is deliberately no mark-mastered
 * path: completion and mastery are separate records.
 */
import type { JournalPrompt } from "./types";

/* ------------------------------------------------------------------ */
/* State shape                                                         */
/* ------------------------------------------------------------------ */

export const ACADEMY_STORAGE_KEY = "ggl-academy-v1";
export const ACADEMY_STATE_VERSION = 1;

export type ProgressStatus = "not-started" | "in-progress" | "completed" | "mastered";

export interface LessonProgress {
  lessonId: string;
  status: ProgressStatus;
  /** Best assessment score 0–100, or null before any attempt. */
  bestScore: number | null;
  attempts: number;
  /** Resume anchor: a lesson section id, or null. */
  lastPosition: string | null;
  updatedAt: number;
}

export interface AcademyState {
  version: number;
  lessons: Record<string, LessonProgress>;
  /** lessonId -> promptKey -> response text. Private to the learner. */
  reflections: Record<string, Record<string, string>>;
  /** concept -> times a first classification/answer missed it. */
  misconceptions: Record<string, number>;
}

export function emptyAcademyState(): AcademyState {
  return { version: ACADEMY_STATE_VERSION, lessons: {}, reflections: {}, misconceptions: {} };
}

const STATUS_RANK: Record<ProgressStatus, number> = {
  "not-started": 0,
  "in-progress": 1,
  completed: 2,
  mastered: 3,
};

export function statusRank(s: ProgressStatus): number {
  return STATUS_RANK[s] ?? 0;
}

export const DEFAULT_LESSON_PROGRESS = (lessonId: string): LessonProgress => ({
  lessonId,
  status: "not-started",
  bestScore: null,
  attempts: 0,
  lastPosition: null,
  updatedAt: 0,
});

/* ------------------------------------------------------------------ */
/* Pure state transitions                                              */
/* ------------------------------------------------------------------ */

function withLesson(state: AcademyState, p: LessonProgress): AcademyState {
  return { ...state, lessons: { ...state.lessons, [p.lessonId]: p } };
}

/** Mark a lesson started (or update its resume position). Never downgrades. */
export function touchLesson(
  state: AcademyState,
  lessonId: string,
  lastPosition: string | null,
  now: number
): AcademyState {
  const cur = state.lessons[lessonId] ?? DEFAULT_LESSON_PROGRESS(lessonId);
  const next: LessonProgress = {
    ...cur,
    status: statusRank(cur.status) >= statusRank("in-progress") ? cur.status : "in-progress",
    lastPosition: lastPosition ?? cur.lastPosition,
    updatedAt: now,
  };
  return withLesson(state, next);
}

/**
 * Record an assessment attempt. `activitiesDone` means the learner
 * has completed the lesson's activities (submitting the assessment is
 * itself the final activity). Status: mastered at/above threshold;
 * otherwise completed when activities are done; never a downgrade.
 */
export function recordAttempt(
  state: AcademyState,
  lessonId: string,
  scorePct: number,
  threshold: number,
  activitiesDone: boolean,
  now: number
): AcademyState {
  const cur = state.lessons[lessonId] ?? DEFAULT_LESSON_PROGRESS(lessonId);
  let status = cur.status;
  if (scorePct >= threshold) status = "mastered";
  else if (activitiesDone && statusRank(status) < statusRank("completed")) status = "completed";
  else if (statusRank(status) < statusRank("in-progress")) status = "in-progress";
  const next: LessonProgress = {
    ...cur,
    status,
    attempts: cur.attempts + 1,
    bestScore: cur.bestScore === null ? scorePct : Math.max(cur.bestScore, scorePct),
    updatedAt: now,
  };
  return withLesson(state, next);
}

/**
 * Mark a lesson's learning activities complete. This is deliberately
 * separate from assessment recording: completion can never become
 * mastery here, and an existing mastered record is left untouched.
 */
export function completeLesson(state: AcademyState, lessonId: string, now: number): AcademyState {
  const cur = state.lessons[lessonId] ?? DEFAULT_LESSON_PROGRESS(lessonId);
  if (statusRank(cur.status) >= statusRank("completed")) return state;
  return withLesson(state, { ...cur, status: "completed", updatedAt: now });
}

/** Pre-redesign flagship id and the stable ids it maps onto. */
export const LEGACY_LESSON_ID = "candlestick-mastery";
export const CANDLE_BASICS_LESSON_IDS = [
  "candle-basics-1",
  "candle-basics-2",
  "candle-basics-3",
  "candle-basics-4",
  "candle-basics-5",
  "candle-basics-6",
  "candle-basics-7",
] as const;

/**
 * Translate progress recorded against the pre-redesign single-lesson
 * id onto the seven-lesson path. A completed/mastered legacy record
 * is strong evidence the learner covered Lessons 1–6 and sat the same
 * assessment now living in Lesson 7, so Lesson 7 inherits its score
 * record and Lessons 1–6 are completed. An in-progress legacy record
 * only resumes the path at Lesson 1 — its assessment numbers are not
 * transferred to a lesson that has no assessment. Pure; a state with
 * no legacy record is returned unchanged.
 */
export function translateLegacyProgress(state: AcademyState): AcademyState {
  const legacy = state.lessons[LEGACY_LESSON_ID];
  const legacyReflections = state.reflections[LEGACY_LESSON_ID];
  if (!legacy && !legacyReflections) return state;

  const lessons: Record<string, LessonProgress> = { ...state.lessons };
  delete lessons[LEGACY_LESSON_ID];
  const reflections: Record<string, Record<string, string>> = { ...state.reflections };
  delete reflections[LEGACY_LESSON_ID];

  if (legacyReflections) {
    // Existing Lesson 7 reflections win a same-prompt conflict.
    reflections["candle-basics-7"] = {
      ...legacyReflections,
      ...(reflections["candle-basics-7"] ?? {}),
    };
  }

  if (legacy && (legacy.status === "completed" || legacy.status === "mastered")) {
    const target = lessons["candle-basics-7"];
    const legacyAsTarget: LessonProgress = { ...legacy, lessonId: "candle-basics-7" };
    lessons["candle-basics-7"] = target ? mergeLesson(target, legacyAsTarget) : legacyAsTarget;
    for (const id of CANDLE_BASICS_LESSON_IDS.slice(0, 6)) {
      const cur = lessons[id];
      if (!cur) {
        lessons[id] = { ...DEFAULT_LESSON_PROGRESS(id), status: "completed", updatedAt: legacy.updatedAt };
      } else if (statusRank(cur.status) < statusRank("completed")) {
        lessons[id] = { ...cur, status: "completed", updatedAt: Math.max(cur.updatedAt, legacy.updatedAt) };
      }
    }
  } else if (legacy && legacy.status === "in-progress") {
    const cur = lessons["candle-basics-1"];
    if (!cur) {
      lessons["candle-basics-1"] = {
        ...DEFAULT_LESSON_PROGRESS("candle-basics-1"),
        status: "in-progress",
        lastPosition: legacy.lastPosition,
        updatedAt: legacy.updatedAt,
      };
    } else if (cur.status === "not-started") {
      lessons["candle-basics-1"] = {
        ...cur,
        status: "in-progress",
        lastPosition: cur.lastPosition ?? legacy.lastPosition,
        updatedAt: Math.max(cur.updatedAt, legacy.updatedAt),
      };
    }
  }

  return { ...state, lessons, reflections };
}

/** Count a missed concept (Evidence Board / explanation first answers). */
export function recordMisconception(state: AcademyState, concept: string): AcademyState {
  return {
    ...state,
    misconceptions: { ...state.misconceptions, [concept]: (state.misconceptions[concept] ?? 0) + 1 },
  };
}

/** Save (or overwrite) one decision-journal reflection. */
export function setReflection(
  state: AcademyState,
  lessonId: string,
  promptKey: string,
  text: string
): AcademyState {
  return {
    ...state,
    reflections: {
      ...state.reflections,
      [lessonId]: { ...(state.reflections[lessonId] ?? {}), [promptKey]: text },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

function mergeLesson(a: LessonProgress, b: LessonProgress): LessonProgress {
  // Higher status rank supplies the position; ties go to the fresher side.
  const winner =
    statusRank(a.status) > statusRank(b.status)
      ? a
      : statusRank(b.status) > statusRank(a.status)
        ? b
        : a.updatedAt >= b.updatedAt
          ? a
          : b;
  return {
    lessonId: a.lessonId,
    status: statusRank(a.status) >= statusRank(b.status) ? a.status : b.status,
    bestScore:
      a.bestScore === null ? b.bestScore : b.bestScore === null ? a.bestScore : Math.max(a.bestScore, b.bestScore),
    attempts: Math.max(a.attempts, b.attempts),
    lastPosition: winner.lastPosition,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

/** Merge two states; the better state wins per lesson. Pure. */
export function mergeAcademyStates(a: AcademyState, b: AcademyState): AcademyState {
  const lessons: Record<string, LessonProgress> = { ...a.lessons };
  for (const [id, pb] of Object.entries(b.lessons)) {
    lessons[id] = lessons[id] ? mergeLesson(lessons[id], pb) : pb;
  }
  const reflections: Record<string, Record<string, string>> = {};
  const lessonIds = new Set([...Object.keys(a.reflections), ...Object.keys(b.reflections)]);
  for (const id of lessonIds) {
    // `a` is the base (callers pass the server state as `b` to let it
    // win per-key conflicts — see mergeForSync).
    reflections[id] = { ...(a.reflections[id] ?? {}), ...(b.reflections[id] ?? {}) };
  }
  const misconceptions: Record<string, number> = { ...a.misconceptions };
  for (const [concept, n] of Object.entries(b.misconceptions)) {
    misconceptions[concept] = Math.max(misconceptions[concept] ?? 0, n);
  }
  // Legacy single-lesson records translate onto the seven-lesson path
  // after every merge, whichever side they arrived from.
  return translateLegacyProgress({ version: ACADEMY_STATE_VERSION, lessons, reflections, misconceptions });
}

/** Merge for sync: server state is `b`, so server reflections win ties. */
export function mergeForSync(guest: AcademyState, server: AcademyState): AcademyState {
  return mergeAcademyStates(guest, server);
}

/* ------------------------------------------------------------------ */
/* Guest persistence (localStorage)                                    */
/* ------------------------------------------------------------------ */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStatus = (v: unknown): v is ProgressStatus =>
  v === "not-started" || v === "in-progress" || v === "completed" || v === "mastered";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Parse-tolerant load: any malformed input degrades to empty state. */
export function parseAcademyState(raw: string | null): AcademyState {
  if (!raw) return emptyAcademyState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== ACADEMY_STATE_VERSION) return emptyAcademyState();
    const state = emptyAcademyState();
    if (isRecord(parsed.lessons)) {
      for (const [id, v] of Object.entries(parsed.lessons)) {
        if (!isRecord(v) || !isStatus(v.status)) continue;
        state.lessons[id] = {
          lessonId: id,
          status: v.status,
          bestScore: isNum(v.bestScore) ? v.bestScore : null,
          attempts: isNum(v.attempts) ? Math.max(0, Math.floor(v.attempts)) : 0,
          lastPosition: typeof v.lastPosition === "string" ? v.lastPosition : null,
          updatedAt: isNum(v.updatedAt) ? v.updatedAt : 0,
        };
      }
    }
    if (isRecord(parsed.reflections)) {
      for (const [id, v] of Object.entries(parsed.reflections)) {
        if (!isRecord(v)) continue;
        const entry: Record<string, string> = {};
        for (const [k, text] of Object.entries(v)) if (typeof text === "string") entry[k] = text;
        if (Object.keys(entry).length > 0) state.reflections[id] = entry;
      }
    }
    if (isRecord(parsed.misconceptions)) {
      for (const [concept, n] of Object.entries(parsed.misconceptions)) {
        if (isNum(n) && n > 0) state.misconceptions[concept] = Math.floor(n);
      }
    }
    return translateLegacyProgress(state);
  } catch {
    return emptyAcademyState();
  }
}

export function loadGuestState(storage: KeyValueStorage | null): AcademyState {
  if (!storage) return emptyAcademyState();
  try {
    return parseAcademyState(storage.getItem(ACADEMY_STORAGE_KEY));
  } catch {
    return emptyAcademyState();
  }
}

export function saveGuestState(storage: KeyValueStorage | null, state: AcademyState): void {
  if (!storage) return;
  try {
    storage.setItem(ACADEMY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full/blocked — progress simply stays in memory */
  }
}

/* ------------------------------------------------------------------ */
/* Authenticated sync (best-effort; fails soft to guest mode)          */
/* ------------------------------------------------------------------ */

/** Server status vocabulary (audit §4): 'started' instead of 'in-progress'. */
export function toServerStatus(s: ProgressStatus): "started" | "completed" | "mastered" {
  return s === "mastered" ? "mastered" : s === "completed" ? "completed" : "started";
}
export function fromServerStatus(s: string): ProgressStatus {
  return s === "mastered" ? "mastered" : s === "completed" ? "completed" : "in-progress";
}

/** Minimal structural view of the Supabase client used here. */
export interface ProgressSyncClient {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface ServerProgressRow {
  lesson_id: string;
  status: string;
  best_score: number | null;
  attempts: number;
  last_position: unknown;
  updated_at: string;
}
interface ServerJournalRow {
  lesson_id: string;
  prompt_key: string;
  response: string;
  created_at: string;
}

function serverRowsToState(
  progressRows: ServerProgressRow[],
  journalRows: ServerJournalRow[]
): AcademyState {
  const state = emptyAcademyState();
  for (const row of progressRows) {
    state.lessons[row.lesson_id] = {
      lessonId: row.lesson_id,
      status: fromServerStatus(row.status),
      bestScore: typeof row.best_score === "number" ? row.best_score : null,
      attempts: typeof row.attempts === "number" ? row.attempts : 0,
      lastPosition:
        isRecord(row.last_position) && typeof row.last_position.section === "string"
          ? (row.last_position.section as string)
          : null,
      updatedAt: Date.parse(row.updated_at) || 0,
    };
  }
  // Journal rows are append-only; the latest row per (lesson, prompt) wins.
  const sorted = [...journalRows].sort((x, y) => (x.created_at < y.created_at ? -1 : 1));
  for (const row of sorted) {
    state.reflections[row.lesson_id] = {
      ...(state.reflections[row.lesson_id] ?? {}),
      [row.prompt_key]: row.response,
    };
  }
  return state;
}

export interface SyncResult {
  /** True only when the server round-trip actually succeeded. */
  synced: boolean;
  state: AcademyState;
}

/**
 * Merge local (guest) state with the signed-in user's server rows and
 * push the merged result back. ANY failure — tables not yet created,
 * network, RLS — returns { synced: false, state: local } untouched:
 * the caller keeps pure guest behavior and must not claim a sync.
 * The guest record is only replaced by the merged state (by the
 * caller) after a successful sync, so a failed sync can never lose
 * or downgrade local progress.
 */
export async function syncAcademyProgress(
  client: ProgressSyncClient,
  userId: string,
  local: AcademyState
): Promise<SyncResult> {
  try {
    const progRes = await client
      .from("academy_progress")
      .select("lesson_id, status, best_score, attempts, last_position, updated_at")
      .eq("user_id", userId);
    if (progRes.error || !Array.isArray(progRes.data)) return { synced: false, state: local };
    const jourRes = await client
      .from("academy_journal")
      .select("lesson_id, prompt_key, response, created_at")
      .eq("user_id", userId);
    if (jourRes.error || !Array.isArray(jourRes.data)) return { synced: false, state: local };

    const serverState = serverRowsToState(
      progRes.data as ServerProgressRow[],
      jourRes.data as ServerJournalRow[]
    );
    const merged = mergeForSync(local, serverState);

    const rows = Object.values(merged.lessons)
      .filter((p) => p.status !== "not-started" || p.attempts > 0)
      .map((p) => ({
        user_id: userId,
        lesson_id: p.lessonId,
        status: toServerStatus(p.status),
        best_score: p.bestScore,
        attempts: p.attempts,
        last_position: p.lastPosition ? { section: p.lastPosition } : null,
        updated_at: new Date(p.updatedAt || Date.now()).toISOString(),
      }));
    if (rows.length > 0) {
      const up = await client
        .from("academy_progress")
        .upsert(rows, { onConflict: "user_id,lesson_id" });
      if (up.error) return { synced: false, state: local };
    }

    // Push reflections the server doesn't already hold verbatim.
    const serverKeys = new Set(
      (jourRes.data as ServerJournalRow[]).map((r) => `${r.lesson_id}${r.prompt_key}${r.response}`)
    );
    const inserts: { user_id: string; lesson_id: string; prompt_key: string; response: string }[] = [];
    for (const [lessonId, prompts] of Object.entries(merged.reflections)) {
      for (const [promptKey, response] of Object.entries(prompts)) {
        if (response.trim() === "") continue;
        if (!serverKeys.has(`${lessonId}${promptKey}${response}`)) {
          inserts.push({ user_id: userId, lesson_id: lessonId, prompt_key: promptKey, response });
        }
      }
    }
    if (inserts.length > 0) {
      const ins = await client.from("academy_journal").insert(inserts);
      if (ins.error) return { synced: false, state: local };
    }

    return { synced: true, state: merged };
  } catch {
    return { synced: false, state: local };
  }
}

/** The four decision-journal prompts from the spec (§8). */
export const JOURNAL_PROMPTS: JournalPrompt[] = [
  { key: "evidence-used", label: "What evidence did you actually use?" },
  { key: "evidence-ignored", label: "What evidence did you ignore or underweight?" },
  { key: "uncertain", label: "What remains uncertain?" },
  { key: "change-mind", label: "What would change your mind next time?" },
];
