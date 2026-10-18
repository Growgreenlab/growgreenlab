"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";
import { groupFillsIntoTrades, calcMetrics, calcRealTrade, validateRealFills, perExitPnl, parseKeyLevels, validateKeyLevels, computePlanUpdate, KEY_LEVEL_TYPES, KEY_LEVEL_INTERACTIONS, type KeyLevel, type PlanChange, parseBrokerCsv, parseWithMapping, autoMapColumns, MAPPABLE_FIELDS, groupImportedFills, fmtPnl, fmtPct, type GroupedTrade, type RawFill, type RealFill, type RealTradeCalc, type BrokerParseResult, type ImportedTrade } from "../../lib/journal";
import { breakdown, riskMetrics, edgeInsights, dailyPnl, isDailyReplayTrade, type AnalyticsTrade, type BreakdownDimension, type Insight } from "../../lib/journalAnalytics";
import { listScreenshots, removeScreenshots, uploadScreenshots, validateScreenshotFile } from "../../lib/journalAttachments";
import EdgeExportPanel from "../../components/EdgeExportPanel";
import type { ExportSnapshotInput, ExportDrAttemptInput, ExportDrEventInput } from "../../lib/edgeExport";
import { deriveDrEvidence, splitCyclesByGeneration, type DrAttemptEvidence, type DrTradeEvidence } from "../../lib/drTradeEvidence";
import { describeDrEvent, type DrEvent } from "../../lib/dailyReplayEvents";
import {
  mapStrategyRow, mapStrategyVersionRow, mapAttemptRow, resolveVersionContext,
  type Strategy, type StrategyVersion, type DrAttemptLink,
} from "../../lib/strategies";
import {
  fetchDraftsForUser, finalizeDraft, supersedeDraft, writeDraftMapping,
  reconcileDrafts, computeDrExclusions, draftListCounts, upsertDraft,
  buildPreCompletionTrade, groupedTradeFromCycle, draftKeyFor, type DrDraftRow,
} from "../../lib/drDrafts";
import { formatSigned } from "../../lib/engine";
import { representativeSourceLabel, resolveRepresentative } from "../../lib/drRepresentative";
import DrDraftReview from "../../components/DrDraftReview";
import DrFinalizeConfirm from "../../components/DrFinalizeConfirm";

type Tab = "overview" | "trades" | "review" | "calendar" | "analytics";
type Period = "today" | "week" | "month" | "30d" | "90d" | "ytd" | "all";
type SourceFilter = "all" | "simulator" | "real" | "daily_replay";

interface TradeMeta {
  trade_key: string;
  setup_tag: string | null;
  hod_class: string | null;
  exec_grade: string | null;
  entry_reasoning: string | null;
  exit_reasoning: string | null;
  followed_plan: boolean | null;
  confidence: number | null;
  emotional_tags: string[];
  mistakes: string[];
  notes: string | null;
  lessons: string | null;
  would_take_again: boolean | null;
  key_levels: KeyLevel[] | null;
  original_stop_loss: number | null;
  original_target: number | null;
  plan_history: PlanChange[] | null;
}

interface RealTrade {
  id: string;
  ticker: string;
  company_name: string | null;
  broker: string | null;
  trade_date: string;
  direction: "long" | "short";
  strategy: string | null;
  status: "open" | "closed";
  stop_loss: number | null;
  target: number | null;
  float_shares: number | null;
  relative_volume: number | null;
  market_conditions: string | null;
  level2_tas_notes: string | null;
  fills: RealFill[];
  calc: RealTradeCalc;
}

/** Unified trade row for display */
interface UnifiedTrade {
  key: string;
  source: "simulator" | "real";
  ticker: string;
  tradeDate: string;
  direction: "long" | "short";
  entryPrice: number | null;
  exitPrice: number | null;
  qty: number;
  realizedPnl: number;
  isOpen: boolean;
  rMultiple: number | null;
  /* Daily Replay linkage (simulator-class trades only) */
  sessionSource: string | null;
  attemptId: string | null;
  strategyId: string | null;
  strategyVersionId: string | null;
  strategyName: string | null;
  strategyLabel: string | null;
}

/** Review-tab context for a Daily Replay trade. */
export interface DrReviewInfo {
  attemptId: string;
  attempt: DrAttemptLink | null;
  strategyLabel: string | null;
  setupType: string | null;
  strategyArchived: boolean;
  evidence: DrTradeEvidence | null;
  events: ExportDrEventInput[];
  /** Seqs of the events belonging to THIS trade's position cycle. */
  tradeEventSeqs: number[];
  resumed: boolean;
  startingBalance: number | null;
}

/** Everything the journal derives about Daily Replay attempts:
 *  the attempt rows, the strategies/versions they reference, the
 *  recorded timeline events (raw rows + recorder-shaped events), and
 *  the per-trade plan evidence derived from them. All optional in
 *  practice: when the strategy migration has not been applied, the
 *  strategies lists are empty and `strategiesAvailable` is false. */
interface DrJournalData {
  attempts: DrAttemptLink[];
  strategies: Strategy[];
  strategyVersions: StrategyVersion[];
  strategiesAvailable: boolean;
  evidenceByKey: Map<string, DrTradeEvidence>;
  evidenceByAttempt: Map<string, DrAttemptEvidence>;
  eventsByAttempt: Map<string, ExportDrEventInput[]>;
  attemptsExport: ExportDrAttemptInput[];
  /** Pre-completion journal rows for FINALIZED drafts on attempts
   *  with no session yet (2026-10-18 workflow fix): built from the
   *  attempts' events + draft anchors, keyed by draft key. An attempt
   *  appears here ONLY while it has no session row — at completion
   *  the canonical session row replaces these, never coexists. */
  preTrades: GroupedTrade[];
  /** Dataset identity per attempt (ticker / trade date) for display
   *  lookups — covers candidates and every draft-owning attempt, so
   *  Needs Review rows and the draft drawer can name their symbol
   *  even when the attempt has no session and no finalized draft. */
  tickerByAttempt: Map<string, { ticker: string; tradeDate: string }>;
  /** Finalized drafts whose pre-completion row was WITHHELD because
   *  the cycle could not be reconciled with the draft's anchors —
   *  surfaced to the export panel as a named hint, never silent. */
  withheldFinalized: { attemptId: string; strategyVersionId: string | null }[];
}

const SETUPS = ["HOD breakout", "EMA pullback", "VWAP pullback", "Clean breakout", "Weak breakout", "Failed breakout", "Anticipation", "Other"];
const HOD_CLASSES = ["clean", "weak", "failed", "anticipation"];
const GRADES = ["A", "B", "C", "D"];
const EMOTIONS = ["FOMO", "Revenge trading", "Hesitation", "Overconfidence", "Impatience", "Fear of losing", "Calm and disciplined"];
const MISTAKES = ["Entered too early", "Chased price", "Moved stop loss", "Exited too early", "Held loser too long", "Broke trading rules", "Overtraded"];

function periodStartStr(p: Period): string | null {
  const now = new Date();
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  switch (p) {
    case "today": return fmt(now);
    case "week": { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); return fmt(d); }
    case "month": return fmt(new Date(now.getFullYear(), now.getMonth(), 1));
    case "30d": { const d = new Date(now); d.setDate(d.getDate() - 30); return fmt(d); }
    case "90d": { const d = new Date(now); d.setDate(d.getDate() - 90); return fmt(d); }
    case "ytd": return fmt(new Date(now.getFullYear(), 0, 1));
    case "all": return null;
  }
}

export default function JournalPage() {
  const [tab, setTab] = useState<Tab>("overview");

  // Deep links: /journal?tab=analytics (e.g. the "Edge Analyzer" nav link)
  // opens the journal on that tab. Without the param, behavior is unchanged.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "overview" || t === "trades" || t === "review" || t === "calendar" || t === "analytics") {
      setTab(t);
    }
  }, []);
  const [period, setPeriod] = useState<Period>("all");
  const [trades, setTrades] = useState<GroupedTrade[]>([]);
  const [metas, setMetas] = useState<Record<string, TradeMeta>>({});
  const [realTrades, setRealTrades] = useState<RealTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedCalDay, setSelectedCalDay] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [strategyFilter, setStrategyFilter] = useState<string>("");
  const [drData, setDrData] = useState<DrJournalData>({
    attempts: [], strategies: [], strategyVersions: [], strategiesAvailable: false,
    evidenceByKey: new Map(), evidenceByAttempt: new Map(), eventsByAttempt: new Map(), attemptsExport: [],
    preTrades: [], withheldFinalized: [], tickerByAttempt: new Map(),
  });
  // Daily Replay per-cycle trade drafts (Phase D): the durable draft
  // rows for ALL of the user's attempts (linked and unlinked), plus the
  // per-attempt session_reset counts derived from the loaded events.
  // Empty pre-migration / when no drafts exist — every behaviour below
  // is then byte-identical to the pre-drafts journal.
  const [drDrafts, setDrDrafts] = useState<DrDraftRow[]>([]);
  const [drResetCounts, setDrResetCounts] = useState<Map<string, number>>(new Map());
  // Trade detail drawer (hosts the same ReviewTab content as the
  // Trade Review tab) + header Import menu + filter-bar Advanced
  // panel + Needs Review panel visibility.
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const [drawerFocusShots, setDrawerFocusShots] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [needsReviewOpen, setNeedsReviewOpen] = useState(false);
  const needsReviewRef = useRef<HTMLDivElement | null>(null);
  const needsReviewInitRef = useRef(false);
  const [reviewDraft, setReviewDraft] = useState<DrDraftRow | null>(null);
  // Draft awaiting finalize confirmation (the shared dialog).
  const [finalizeTarget, setFinalizeTarget] = useState<DrDraftRow | null>(null);
  const [draftEventsByAttempt, setDraftEventsByAttempt] = useState<Map<string, DrEvent[]>>(new Map());
  const reconcileRanRef = useRef(false);

  // Copy a draft-key annotation row forward to the finalized trade key
  // (plan §2.4): only when a draft-key row exists and no canonical row
  // exists yet — the session-key row is canonical once written.
  const copyDraftMetaForward = async (
    client: ReturnType<typeof createClient>,
    draftKey: string,
    finalizedTradeKey: string,
    sessionId: string | null,
  ) => {
    try {
      const { data: src } = await client.from("journal_trade_meta").select("*").eq("trade_key", draftKey).maybeSingle();
      if (!src) return;
      const { data: dst } = await client.from("journal_trade_meta").select("trade_key").eq("trade_key", finalizedTradeKey).maybeSingle();
      if (dst) return;
      const copy: Record<string, unknown> = { ...(src as Record<string, unknown>) };
      delete copy.id;
      delete copy.created_at;
      await client.from("journal_trade_meta").upsert(
        { ...copy, trade_key: finalizedTradeKey, session_id: sessionId },
        { onConflict: "user_id,trade_key" },
      );
    } catch { /* copy-forward is best-effort */ }
  };

  // The draft row for a finalized journal trade, by its durable
  // finalized_trade_key link first, else by (attempt, final reset
  // generation, cycle sequence) coordinates.
  const draftForTrade = (key: string, attemptId?: string | null): DrDraftRow | undefined => {
    const byFinal = drDrafts.find((d) => d.finalizedTradeKey === key);
    if (byFinal) return byFinal;
    // Pre-completion rows key off the draft key itself.
    const byDraftKey = drDrafts.find((d) => d.draftKey === key);
    if (byDraftKey) return byDraftKey;
    if (!attemptId) return undefined;
    const seq = Number.parseInt(key.slice(key.lastIndexOf(":") + 1), 10);
    if (!Number.isFinite(seq)) return undefined;
    const finalGen = drResetCounts.get(attemptId) ?? 0;
    return drDrafts.find(
      (d) => d.attemptId === attemptId && d.resetGeneration === finalGen && d.cycleIndex === seq,
    );
  };

  // Meta resolution with the draft-key fallback (plan §2.4): the
  // canonical session-key row wins; the draft-key row (annotations
  // taken during draft review) is the fallback. Inert when the trade
  // has no draft.
  const metaForTrade = (key: string, attemptId?: string | null): TradeMeta | undefined => {
    if (metas[key]) return metas[key];
    const draft = draftForTrade(key, attemptId);
    return draft ? metas[draft.draftKey] : undefined;
  };
  // Filters
  const [fTicker, setFTicker] = useState("");
  const [fSetup, setFSetup] = useState("");
  const [fWinLoss, setFWinLoss] = useState("");
  const [showRealForm, setShowRealForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // Real-trade edit/delete + page-level notice (e.g. attachment failures
  // reported after an otherwise successful save)
  const [editingReal, setEditingReal] = useState<{ trade: RealTrade; meta: TradeMeta | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UnifiedTrade | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    if (!isSupabaseConfigured()) { setError("Supabase is not configured."); setLoading(false); return; }
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError("Please sign in to view your trade journal."); setLoading(false); return; }

      // Fetch sessions with their fills
      const { data: sessions, error: sErr } = await supabase
        .from("replay_sessions")
        .select("id,ticker,trade_date,source")
        .order("created_at", { ascending: false })
        .limit(200);
      if (sErr) throw new Error(sErr.message);

      const allTrades: GroupedTrade[] = [];
      for (const s of sessions ?? []) {
        const { data: fills } = await supabase
          .from("session_trades")
          .select("*")
          .eq("session_id", s.id)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true });
        if (fills && fills.length > 0) {
          const grouped = groupFillsIntoTrades(fills as RawFill[], s);
          allTrades.push(...grouped);
        }
      }
      setTrades(allTrades);

      // ---- Daily Replay enrichment (attempts, strategies, evidence) ----
      // Everything here is best-effort and additive: each fetch is
      // independent, and any failure (e.g. the strategies migration not
      // applied yet) degrades to "not recorded" displays — the journal
      // itself never breaks.
      try {
        const sessionById = new Map((sessions ?? []).map((s: any) => [s.id, s]));
        let attempts: DrAttemptLink[] = [];
        const attemptDatasetId = new Map<string, string>();
        try {
          const { data: attRows, error: attErr } = await supabase
            .from("daily_replay_attempts")
            .select("id,session_id,dataset_id,strategy_version_id,status,start_index,created_at,finished_at")
            .order("created_at", { ascending: false })
            .limit(500);
          if (!attErr && attRows) {
            attempts = attRows.map((r: any) => mapAttemptRow(r));
            for (const r of attRows as any[]) if (r.dataset_id) attemptDatasetId.set(r.id, r.dataset_id);
          }
        } catch { /* attempts table unavailable — pre-DR database */ }
        // All of the user's Daily Replay trade drafts (any attempt,
        // linked or not). Tolerated failure (e.g. the drafts migration
        // not applied yet) degrades to no drafts.
        let fetchedDrafts: DrDraftRow[] = [];
        try {
          fetchedDrafts = await fetchDraftsForUser(supabase);
        } catch { fetchedDrafts = []; }
        setDrDrafts(fetchedDrafts);
        let strategies: Strategy[] = [];
        let strategyVersions: StrategyVersion[] = [];
        let strategiesAvailable = false;
        try {
          const [sRes, vRes] = await Promise.all([
            supabase.from("strategies").select("*").limit(200),
            supabase.from("strategy_versions").select("*").limit(1000),
          ]);
          if (!sRes.error && !vRes.error) {
            strategiesAvailable = true;
            strategies = (sRes.data ?? []).map((r: any) => mapStrategyRow(r));
            strategyVersions = (vRes.data ?? []).map((r: any) => mapStrategyVersionRow(r));
          }
        } catch { /* strategies migration not applied yet */ }

        const linked = attempts.filter((a) => a.sessionId && sessionById.has(a.sessionId));
        // Pre-completion candidates (2026-10-18 workflow fix):
        // attempts with at least one FINALIZED draft but no session
        // row yet. Their finalized trades are journal-visible NOW —
        // rows are built from the attempts' events + the drafts'
        // anchors further below. An attempt leaves this set the
        // moment a session exists; the canonical session row then
        // owns the trade and the two never coexist.
        const finalizedAttemptIds = new Set(
          fetchedDrafts.filter((d) => d.status === "finalized").map((d) => d.attemptId),
        );
        const candidates = attempts.filter(
          (a) => finalizedAttemptIds.has(a.id) && !(a.sessionId && sessionById.has(a.sessionId)),
        );
        // Dataset identity (ticker / trade date) for candidates —
        // their trades have no session row to read it from. The same
        // lookup also covers every attempt that owns a draft, so the
        // Needs Review rows can name their symbol even before any
        // draft on the attempt is finalized (display-only; the export
        // attempt list is unchanged).
        const datasetById = new Map<string, { ticker: string; tradeDate: string }>();
        const draftAttemptIds = new Set(fetchedDrafts.map((d) => d.attemptId));
        const identityAttempts = [...candidates, ...attempts.filter((a) => draftAttemptIds.has(a.id))];
        if (identityAttempts.length > 0) {
          try {
            const dsIds = [...new Set(identityAttempts.map((a) => attemptDatasetId.get(a.id)).filter(Boolean))] as string[];
            if (dsIds.length > 0) {
              const { data: dsRows, error: dsErr } = await supabase
                .from("daily_replay_datasets")
                .select("id,ticker,trade_date")
                .in("id", dsIds);
              if (!dsErr && dsRows) {
                for (const r of dsRows as any[]) datasetById.set(r.id, { ticker: r.ticker, tradeDate: r.trade_date });
              }
            }
          } catch { /* dataset lookup unavailable — candidates degrade to withheld */ }
        }
        const eventsByAttempt = new Map<string, ExportDrEventInput[]>();
        const eventAttempts = [...linked, ...candidates];
        if (eventAttempts.length > 0) {
          try {
            const ids = eventAttempts.map((a) => a.id);
            const { data: evRows, error: evErr } = await supabase
              .from("daily_replay_events")
              .select("id,attempt_id,seq,type,wall_ts,market_idx,market_ts,payload")
              .in("attempt_id", ids)
              .order("seq", { ascending: true })
              .limit(20000);
            if (!evErr && evRows) {
              for (const r of evRows as any[]) {
                const event: DrEvent = {
                  seq: Number(r.seq),
                  type: r.type,
                  wallTs: r.wall_ts ? new Date(r.wall_ts).getTime() : 0,
                  marketIdx: r.market_idx != null ? Number(r.market_idx) : null,
                  marketTs: r.market_ts != null ? Number(r.market_ts) : null,
                  payload: (r.payload ?? {}) as Record<string, unknown>,
                };
                const arr = eventsByAttempt.get(r.attempt_id) ?? [];
                arr.push({ id: r.id, attemptId: r.attempt_id, event });
                eventsByAttempt.set(r.attempt_id, arr);
              }
            }
          } catch { /* events unavailable — evidence stays unrecorded */ }
        }

        const evidenceByKey = new Map<string, DrTradeEvidence>();
        const evidenceByAttempt = new Map<string, DrAttemptEvidence>();
        for (const a of linked) {
          const sessionTrades = allTrades.filter((t) => t.sessionId === a.sessionId);
          const derived = deriveDrEvidence({
            attemptId: a.id,
            trades: sessionTrades,
            events: (eventsByAttempt.get(a.id) ?? []).map((e) => e.event),
          });
          evidenceByAttempt.set(a.id, derived);
          for (const [k, v] of derived.byTradeKey) evidenceByKey.set(k, v);
        }

        // Pre-completion rows + evidence for candidate attempts
        // (2026-10-18). Evidence derivation runs over ALL
        // final-generation closed cycles — pairing inside
        // deriveDrEvidence is ordinal across the attempt's pairable
        // cycles — keyed by each cycle's draft key. A row joins the
        // journal only for cycles whose draft is FINALIZED and
        // reconciles with its anchors (buildPreCompletionTrade);
        // anything else is withheld and named, never fabricated.
        const preTrades: GroupedTrade[] = [];
        const withheldFinalized: { attemptId: string; strategyVersionId: string | null }[] = [];
        for (const a of candidates) {
          const dsId = attemptDatasetId.get(a.id);
          const ds = dsId ? datasetById.get(dsId) : undefined;
          const events = (eventsByAttempt.get(a.id) ?? []).map((e) => e.event);
          const { cycles, lastGeneration } = splitCyclesByGeneration(events);
          const finalCycles = cycles.filter((c) => c.generation === lastGeneration && c.closed);
          if (ds) {
            const cycleTrades: GroupedTrade[] = [];
            for (const c of finalCycles) {
              const d = fetchedDrafts.find(
                (x) => x.attemptId === a.id && x.resetGeneration === c.generation && x.cycleIndex === c.cycleIndex,
              );
              const t = groupedTradeFromCycle(c, {
                tradeKey: d?.draftKey ?? draftKeyFor(a.id, c.generation, c.cycleIndex),
                ticker: ds.ticker, tradeDate: ds.tradeDate,
              });
              if (t) cycleTrades.push(t);
            }
            if (cycleTrades.length > 0) {
              const derived = deriveDrEvidence({ attemptId: a.id, trades: cycleTrades, events });
              evidenceByAttempt.set(a.id, derived);
              for (const [k, v] of derived.byTradeKey) evidenceByKey.set(k, v);
            }
          }
          for (const d of fetchedDrafts) {
            if (d.attemptId !== a.id || d.status !== "finalized") continue;
            // A finalized draft from before a replay reset can never
            // map to a journal trade (its fills were wiped) — it is
            // neither row-eligible nor "withheld"; it stays a
            // Finalized-history entry only.
            if (d.resetGeneration !== lastGeneration) continue;
            const cycle = finalCycles.find((c) => c.cycleIndex === d.cycleIndex);
            const row = ds && cycle
              ? buildPreCompletionTrade(d, cycle, { ticker: ds.ticker, tradeDate: ds.tradeDate })
              : null;
            if (row) preTrades.push(row);
            else withheldFinalized.push({ attemptId: a.id, strategyVersionId: a.strategyVersionId });
          }
        }

        const attemptsExport: ExportDrAttemptInput[] = [
          ...linked.map((a) => {
            const s: any = a.sessionId ? sessionById.get(a.sessionId) : null;
            return {
              id: a.id, sessionId: a.sessionId, strategyVersionId: a.strategyVersionId,
              status: a.status, startIndex: a.startIndex, createdAt: a.createdAt, finishedAt: a.finishedAt,
              ticker: s?.ticker ?? null, tradeDate: s?.trade_date ?? null,
            };
          }),
          ...candidates.map((a) => {
            const dsId = attemptDatasetId.get(a.id);
            const ds = dsId ? datasetById.get(dsId) : undefined;
            return {
              id: a.id, sessionId: a.sessionId, strategyVersionId: a.strategyVersionId,
              status: a.status, startIndex: a.startIndex, createdAt: a.createdAt, finishedAt: a.finishedAt,
              ticker: ds?.ticker ?? null, tradeDate: ds?.tradeDate ?? null,
            };
          }),
        ];
        const tickerByAttempt = new Map<string, { ticker: string; tradeDate: string }>();
        for (const a of attempts) {
          const dsId = attemptDatasetId.get(a.id);
          const ds = dsId ? datasetById.get(dsId) : undefined;
          if (ds) tickerByAttempt.set(a.id, ds);
        }
        setDrData({ attempts, strategies, strategyVersions, strategiesAvailable, evidenceByKey, evidenceByAttempt, eventsByAttempt, attemptsExport, preTrades, withheldFinalized, tickerByAttempt });

        // Reset counts per event-loaded attempt (session_reset events
        // in the loaded stream) — the final generation coordinate the
        // draft exclusion + meta fallback match on.
        const resetCounts = new Map<string, number>();
        for (const a of eventAttempts) {
          const evs = eventsByAttempt.get(a.id) ?? [];
          resetCounts.set(a.id, evs.filter((e) => e.event.type === "session_reset").length);
        }
        setDrResetCounts(resetCounts);

        // Lazy reconcile (plan §3.3 self-healing): for each linked
        // attempt that has drafts, recompute the draft <-> trade
        // mapping from events + grouped trades and persist any missing
        // links, supersede pre-reset drafts, and copy annotations
        // forward for finalized drafts. Purely a repair pass — it runs
        // at most once per page load and every failure is swallowed.
        if (!reconcileRanRef.current && fetchedDrafts.length > 0) {
          reconcileRanRef.current = true;
          try {
            for (const a of linked) {
              if (!a.sessionId) continue;
              const attemptDrafts = fetchedDrafts.filter((d) => d.attemptId === a.id);
              if (attemptDrafts.length === 0) continue;
              const sessionTrades = allTrades.filter((t) => t.sessionId === a.sessionId);
              const plan = reconcileDrafts({
                attemptId: a.id,
                sessionId: a.sessionId,
                events: (eventsByAttempt.get(a.id) ?? []).map((e) => e.event),
                trades: sessionTrades,
                drafts: attemptDrafts,
                allowCreate: true, // only because drafts exist for the attempt
              });
              // Decision-5 recovery: create any verified-but-missing
              // draft rows for this attempt (it provably belongs to
              // the drafts era — it already has drafts) BEFORE applying
              // mappings, so create-target mappings resolve by key.
              for (const c of plan.creates) {
                await upsertDraft(supabase, user.id, c);
              }
              for (const m of plan.mappings) {
                await writeDraftMapping(supabase, m.draftId ? m.draftId : m.draftKey, m.finalizedSessionId, m.finalizedTradeKey);
              }
              for (const id of plan.supersedeDraftIds) {
                await supersedeDraft(supabase, id);
              }
              // Meta copy-forward for finalized drafts that have a
              // mapping (pre-existing or from this plan).
              const mappedKeyByDraft = new Map<string, string>();
              for (const d of attemptDrafts) if (d.finalizedTradeKey) mappedKeyByDraft.set(d.id, d.finalizedTradeKey);
              for (const m of plan.mappings) {
                if (m.draftId) mappedKeyByDraft.set(m.draftId, m.finalizedTradeKey);
                const byKey = attemptDrafts.find((d) => d.draftKey === m.draftKey);
                if (byKey) mappedKeyByDraft.set(byKey.id, m.finalizedTradeKey);
              }
              for (const d of attemptDrafts) {
                if (d.status !== "finalized") continue;
                const finalizedKey = mappedKeyByDraft.get(d.id);
                if (!finalizedKey) continue;
                await copyDraftMetaForward(supabase, d.draftKey, finalizedKey, a.sessionId);
              }
            }
            // Refetch once so state reflects any mappings just written.
            try {
              const refreshed = await fetchDraftsForUser(supabase);
              if (refreshed.length > 0) setDrDrafts(refreshed);
            } catch { /* keep the originally fetched drafts */ }
          } catch { /* reconcile is best-effort self-healing */ }
        }
      } catch { /* DR enrichment is optional — journal continues without it */ }

      // Fetch annotations (shared by simulator + real trades via trade_key)
      const { data: metaRows } = await supabase.from("journal_trade_meta").select("*");
      const metaMap: Record<string, TradeMeta> = {};
      for (const m of metaRows ?? []) metaMap[m.trade_key] = m;
      setMetas(metaMap);

      // Fetch real-market trades with their fills
      const { data: realRows, error: rErr } = await supabase
        .from("journal_real_trades")
        .select("*")
        .order("trade_date", { ascending: false })
        .limit(500);
      if (rErr) throw new Error(rErr.message);

      const real: RealTrade[] = [];
      for (const rt of realRows ?? []) {
        const { data: fills } = await supabase
          .from("journal_real_fills")
          .select("*")
          .eq("trade_id", rt.id)
          .order("fill_time", { ascending: true })
          .order("id", { ascending: true });
        const rf: RealFill[] = (fills ?? []).map((f: any) => ({
          id: f.id, side: f.side, qty: Number(f.qty), price: Number(f.price),
          fees: Number(f.fees ?? 0), fill_time: f.fill_time,
        }));
        real.push({
          ...rt,
          direction: rt.direction as "long" | "short",
          status: rt.status as "open" | "closed",
          stop_loss: rt.stop_loss != null ? Number(rt.stop_loss) : null,
          target: rt.target != null ? Number(rt.target) : null,
          fills: rf,
          calc: calcRealTrade(rf, rt.direction,
            metaMap[`real:${rt.id}`]?.original_stop_loss ?? (rt.stop_loss != null ? Number(rt.stop_loss) : null),
            metaMap[`real:${rt.id}`]?.original_target ?? (rt.target != null ? Number(rt.target) : null)),
        });
      }
      setRealTrades(real);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load journal.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Daily Replay draft exclusion — THE choke point (plan §3.2/§7.1):
  // a finished attempt's cycle whose draft is still unfinalized is
  // excluded HERE, at unified construction, so it is absent from the
  // journal lists, calendar, analytics AND the export (all consume
  // `unified`). Empty when there are no drafts.
  const drExcluded: Set<string> = useMemo(() => {
    if (drDrafts.length === 0) return new Set<string>();
    const attemptBySession = new Map(
      drData.attempts.filter((a) => a.sessionId).map((a) => [a.sessionId!, a]),
    );
    return computeDrExclusions({
      trades: trades.map((t) => ({
        tradeKey: t.tradeKey,
        attemptId: attemptBySession.get(t.sessionId)?.id ?? null,
      })),
      drafts: drDrafts,
      resetCounts: drResetCounts,
    });
  }, [trades, drData.attempts, drDrafts, drResetCounts]);
  const excludedCount = drExcluded.size;

  // Build unified trade list with source tags
  const unified: UnifiedTrade[] = useMemo(() => {
    const attemptBySession = new Map(
      drData.attempts.filter((a) => a.sessionId).map((a) => [a.sessionId!, a]),
    );
    const sim: UnifiedTrade[] = trades.filter((t) => !drExcluded.has(t.tradeKey)).map((t) => {
      const attempt = attemptBySession.get(t.sessionId) ?? null;
      const evidence = attempt ? drData.evidenceByKey.get(t.tradeKey) : undefined;
      const ctx = attempt?.strategyVersionId
        ? resolveVersionContext(attempt.strategyVersionId, drData.strategies, drData.strategyVersions)
        : null;
      return {
        key: t.tradeKey,
        source: "simulator" as const,
        ticker: t.ticker,
        tradeDate: t.tradeDate,
        direction: t.direction,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        qty: t.qty,
        realizedPnl: t.realizedPnl,
        isOpen: false,
        // Daily Replay trades take R from the recorded evidence
        // (risk snapshot); Trade Lab trades keep the grouped value
        // (null — no recorded stop, by design).
        rMultiple: evidence ? evidence.rMultiple : t.rMultiple,
        sessionSource: t.source,
        attemptId: attempt?.id ?? null,
        strategyId: ctx?.strategy.id ?? null,
        strategyVersionId: attempt?.strategyVersionId ?? null,
        strategyName: ctx?.strategy.name ?? null,
        strategyLabel: ctx?.label ?? null,
      };
    });
    // Pre-completion Daily Replay trades (2026-10-18 workflow fix):
    // FINALIZED drafts on attempts with no session yet, keyed by
    // draft key. load() builds these ONLY for sessionless attempts,
    // so a canonical session row and a pre-completion row for the
    // same trade can never coexist — at completion the session row
    // replaces this one.
    const attemptById = new Map(drData.attempts.map((a) => [a.id, a]));
    const pre: UnifiedTrade[] = drData.preTrades.map((t) => {
      const draft = drDrafts.find((d) => d.draftKey === t.tradeKey) ?? null;
      const attempt = draft ? attemptById.get(draft.attemptId) ?? null : null;
      const evidence = drData.evidenceByKey.get(t.tradeKey);
      const ctx = attempt?.strategyVersionId
        ? resolveVersionContext(attempt.strategyVersionId, drData.strategies, drData.strategyVersions)
        : null;
      return {
        key: t.tradeKey,
        source: "simulator" as const,
        ticker: t.ticker,
        tradeDate: t.tradeDate,
        direction: t.direction,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        qty: t.qty,
        realizedPnl: t.realizedPnl,
        isOpen: false,
        rMultiple: evidence ? evidence.rMultiple : t.rMultiple,
        sessionSource: "daily_replay",
        attemptId: attempt?.id ?? null,
        strategyId: ctx?.strategy.id ?? null,
        strategyVersionId: attempt?.strategyVersionId ?? null,
        strategyName: ctx?.strategy.name ?? null,
        strategyLabel: ctx?.label ?? null,
      };
    });
    const rl: UnifiedTrade[] = realTrades.map((t) => ({
      key: `real:${t.id}`,
      source: "real" as const,
      ticker: t.ticker,
      tradeDate: t.trade_date,
      direction: t.direction,
      entryPrice: t.calc.avgEntry,
      exitPrice: null,
      qty: t.calc.entryQty,
      realizedPnl: t.calc.netRealized,
      isOpen: !t.calc.isClosed,
      rMultiple: t.calc.rMultiple,
      sessionSource: null,
      attemptId: null,
      strategyId: null,
      strategyVersionId: null,
      strategyName: null,
      strategyLabel: null,
    }));
    return [...sim, ...pre, ...rl].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
  }, [trades, realTrades, drData, drExcluded, drDrafts]);

  // Filter by source + period + search (date-string comparison avoids TZ bugs).
  // ONE filtered set: overview, trades, review, calendar, analytics and
  // the export panel all read from this memo, so they can never disagree.
  const filtered = useMemo(() => {
    const startStr = periodStartStr(period);
    return unified.filter((t) => {
      if (sourceFilter === "daily_replay") {
        if (!isDailyReplayTrade(t)) return false;
      } else if (sourceFilter === "simulator") {
        // The four source buckets are mutually exclusive (redesign):
        // "Simulator" excludes Daily Replay trades, which have their
        // own bucket — same separation the per-source metrics apply.
        if (t.source !== "simulator" || isDailyReplayTrade(t)) return false;
      } else if (sourceFilter !== "all" && t.source !== sourceFilter) return false;
      if (strategyFilter) {
        if (strategyFilter === "none") {
          if (t.strategyVersionId != null) return false;
        } else if (strategyFilter.startsWith("version:")) {
          if (t.strategyVersionId !== strategyFilter.slice("version:".length)) return false;
        } else {
          const version = drData.strategyVersions.find((v) => v.id === t.strategyVersionId);
          if (!version || version.strategyId !== strategyFilter) return false;
        }
      }
      if (startStr && t.tradeDate < startStr) return false;
      if (fTicker && !t.ticker.toLowerCase().includes(fTicker.toLowerCase())) return false;
      if (fSetup && metaForTrade(t.key, t.attemptId)?.setup_tag !== fSetup) return false;
      if (fWinLoss === "win" && t.realizedPnl <= 0) return false;
      if (fWinLoss === "loss" && t.realizedPnl >= 0) return false;
      return true;
    });
  }, [unified, sourceFilter, strategyFilter, period, fTicker, fSetup, fWinLoss, metas, drData.strategyVersions, drDrafts, drResetCounts]);

  // Closed trades only for metrics
  const closedFiltered = useMemo(() => filtered.filter((t) => !t.isOpen), [filtered]);
  const metrics = useMemo(() => calcMetrics(closedFiltered), [closedFiltered]);

  // Per-source metrics
  const simMetrics = useMemo(() => calcMetrics(closedFiltered.filter((t) => t.source === "simulator" && !isDailyReplayTrade(t))), [closedFiltered]);
  const realMetrics = useMemo(() => calcMetrics(closedFiltered.filter((t) => t.source === "real")), [closedFiltered]);
  const drMetrics = useMemo(() => calcMetrics(closedFiltered.filter((t) => isDailyReplayTrade(t))), [closedFiltered]);

  // Enriched view for Analytics: the SAME filtered closed set, joined with
  // Trade DNA annotations and the underlying records (timestamps, stop, risk).
  const analyticsTrades: AnalyticsTrade[] = useMemo(() => {
    const simByKey = new Map([...trades, ...drData.preTrades].map((t) => [t.tradeKey, t]));
    const realById = new Map(realTrades.map((t) => [`real:${t.id}`, t]));
    return closedFiltered.map((t) => {
      const meta = metaForTrade(t.key, t.attemptId);
      let entryTime: string | null = null;
      let exitTime: string | null = null;
      let stopLoss: number | null = null;
      let initialRisk: number | null = null;
      if (t.source === "simulator") {
        const g = simByKey.get(t.key);
        entryTime = g?.entryTime ?? null;
        exitTime = g?.exitTime ?? null;
        // Daily Replay trades: plan + risk come from the recorded
        // evidence (risk snapshot), never from reconstruction.
        const evidence = drData.evidenceByKey.get(t.key);
        if (evidence) {
          stopLoss = evidence.stopLoss;
          initialRisk = evidence.initialRisk;
        }
      } else {
        const rt = realById.get(t.key);
        if (rt) {
          const isEntry = (f: RealFill) => (rt.direction === "long" ? f.side === "buy" : f.side === "sell");
          const entries = rt.fills.filter(isEntry);
          const exits = rt.fills.filter((f) => !isEntry(f));
          entryTime = entries.length > 0 ? entries[0].fill_time : null;
          exitTime = exits.length > 0 ? exits[exits.length - 1].fill_time : null;
          stopLoss = rt.stop_loss;
          initialRisk = rt.calc.initialRisk;
        }
      }
      return {
        key: t.key, source: t.source, ticker: t.ticker, tradeDate: t.tradeDate,
        direction: t.direction, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
        qty: t.qty, realizedPnl: t.realizedPnl, rMultiple: t.rMultiple, isOpen: t.isOpen,
        setupTag: meta?.setup_tag ?? null,
        hodClass: meta?.hod_class ?? null,
        followedPlan: meta?.followed_plan ?? null,
        emotionalTags: meta?.emotional_tags ?? [],
        mistakes: meta?.mistakes ?? [],
        entryTime, exitTime, stopLoss, initialRisk,
        keyLevelType: parseKeyLevels(meta?.key_levels)[0]?.type ?? null,
        keyLevelInteraction: parseKeyLevels(meta?.key_levels)[0]?.interaction ?? null,
        sessionSource: t.sessionSource,
        attemptId: t.attemptId,
        strategyId: t.strategyId,
        strategyVersionId: t.strategyVersionId,
        strategyName: t.strategyName,
        strategyVersionLabel: t.strategyLabel,
      };
    });
  }, [closedFiltered, trades, realTrades, metas, drData, drDrafts, drResetCounts]);
  const analyticsRisk = useMemo(() => riskMetrics(analyticsTrades), [analyticsTrades]);

  // Cumulative P&L for chart (simple SVG)
  const cumPnl = useMemo(() => {
    const sorted = [...closedFiltered].sort((a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime());
    let cum = 0;
    return sorted.map((t) => { cum += t.realizedPnl; return cum; });
  }, [closedFiltered]);

  const selected = selectedKey
    ? (selectedKey.startsWith("real:")
        ? realTrades.find((t) => `real:${t.id}` === selectedKey) ?? null
        : trades.find((t) => t.tradeKey === selectedKey)
          ?? drData.preTrades.find((t) => t.tradeKey === selectedKey)
          ?? null)
    : null;
  const selectedMeta = selectedKey
    ? (metaForTrade(selectedKey, unified.find((t) => t.key === selectedKey)?.attemptId ?? null) ?? null)
    : null;
  const isRealSelected = selectedKey?.startsWith("real:") ?? false;

  // Daily Replay review context for the selected trade (null unless
  // the trade came from a Daily Replay attempt).
  const selectedDrInfo: DrReviewInfo | null = useMemo(() => {
    if (!selectedKey || isRealSelected) return null;
    const u = unified.find((t) => t.key === selectedKey);
    if (!u || !isDailyReplayTrade(u) || !u.attemptId) return null;
    const attempt = drData.attempts.find((a) => a.id === u.attemptId) ?? null;
    const attemptEvidence = drData.evidenceByAttempt.get(u.attemptId) ?? null;
    const evidence = drData.evidenceByKey.get(selectedKey) ?? null;
    const ctx = u.strategyVersionId
      ? resolveVersionContext(u.strategyVersionId, drData.strategies, drData.strategyVersions)
      : null;
    const events = drData.eventsByAttempt.get(u.attemptId) ?? [];
    const created = events.find((e) => e.event.type === "attempt_created");
    const startingBalance = typeof created?.event.payload.startingBalance === "number"
      ? (created.event.payload.startingBalance as number) : null;
    const tradeEventSeqs = attemptEvidence
      ? [...attemptEvidence.eventTradeKey.entries()].filter(([, k]) => k === selectedKey).map(([seq]) => seq)
      : [];
    return {
      attemptId: u.attemptId,
      attempt,
      strategyLabel: u.strategyLabel,
      setupType: ctx?.version.setupType ?? null,
      strategyArchived: ctx?.strategy.archivedAt != null,
      evidence,
      events,
      tradeEventSeqs,
      resumed: attemptEvidence?.resumed ?? false,
      startingBalance,
    };
  }, [selectedKey, isRealSelected, unified, drData]);

  // Period-agnostic counts for the CURRENT source filter — the Overview
  // empty states key off these (not the both-sources total), so a user
  // with simulator trades still gets the real-market empty state + the
  // Add Real Trade action when they have no real trades.
  const matchesSourceFilter = (t: UnifiedTrade) =>
    sourceFilter === "all" ? true
    : sourceFilter === "daily_replay" ? isDailyReplayTrade(t)
    : sourceFilter === "simulator" ? (t.source === "simulator" && !isDailyReplayTrade(t))
    : t.source === sourceFilter;
  const sourceTotalCount = useMemo(
    () => unified.filter(matchesSourceFilter).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unified, sourceFilter],
  );
  const sourceClosedCount = useMemo(
    () => unified.filter((t) => matchesSourceFilter(t) && !t.isOpen).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unified, sourceFilter],
  );

  const startEditReal = (key: string) => {
    const rt = realTrades.find((t) => `real:${t.id}` === key);
    if (!rt) return;
    setEditingReal({ trade: rt, meta: metas[key] ?? null });
    setShowRealForm(true);
    setTab("trades");
  };
  const cancelEdit = () => { setEditingReal(null); setShowRealForm(false); };
  const startDeleteReal = (key: string) => {
    const t = unified.find((u) => u.key === key);
    if (!t || t.source !== "real") return;
    setDeleteError(null);
    setDeleteTarget(t);
  };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true); setDeleteError(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const key = deleteTarget.key;
      const tradeId = key.replace(/^real:/, "");
      // Screenshots first (best-effort), then meta, fills, and the trade
      // itself — every delete is scoped to this user.
      const shots = await listScreenshots(supabase, user.id, key);
      await removeScreenshots(supabase, shots.map((s) => s.path));
      const { error: mErr } = await supabase.from("journal_trade_meta").delete().eq("trade_key", key).eq("user_id", user.id);
      if (mErr) throw new Error(mErr.message);
      const { error: fErr } = await supabase.from("journal_real_fills").delete().eq("trade_id", tradeId).eq("user_id", user.id);
      if (fErr) throw new Error(fErr.message);
      const { error: tErr } = await supabase.from("journal_real_trades").delete().eq("id", tradeId).eq("user_id", user.id);
      if (tErr) throw new Error(tErr.message);
      setDeleteTarget(null);
      if (selectedKey === key) setSelectedKey(null);
      if (editingReal && `real:${editingReal.trade.id}` === key) setEditingReal(null);
      setTab("trades");
      load();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  };
  const handleRealTradeSaved = (noticeText?: string) => {
    setEditingReal(null);
    if (noticeText) setNotice(noticeText);
    load();
  };

  // Trade detail drawer: row clicks across the page open the existing
  // Trade Review content in a right-side drawer. The drawer drives
  // the same selectedKey/selected derivations as the Review tab,
  // which keeps working full-page exactly as before.
  const openDrawer = (k: string, focusShots = false) => {
    setSelectedKey(k);
    setDrawerFocusShots(focusShots);
    setDrawerKey(k);
  };
  const closeDrawer = () => { setDrawerKey(null); setDrawerFocusShots(false); };

  // Finalize → reveal guard (shared by DrDraftReview and
  // DrFinalizeConfirm): land on the Trades tab with ALL filters reset
  // so a just-finalized trade can never be hidden by stale state.
  const revealFinalizedTrade = () => {
    setSourceFilter("daily_replay");
    setPeriod("all");
    setFTicker("");
    setFSetup("");
    setStrategyFilter("");
    setFWinLoss("");
    setTab("trades");
  };

  const clearAllFilters = () => {
    setSourceFilter("all");
    setPeriod("all");
    setFTicker("");
    setFSetup("");
    setStrategyFilter("");
    setFWinLoss("");
  };

  const strategyFilterLabel = (v: string): string => {
    if (v === "none") return "No strategy recorded";
    if (v.startsWith("version:")) {
      const ver = drData.strategyVersions.find((x) => x.id === v.slice("version:".length));
      const s = ver ? drData.strategies.find((x) => x.id === ver.strategyId) : undefined;
      return ver ? `${s?.name ?? "Strategy"} · v${ver.version} only` : "Strategy version";
    }
    return drData.strategies.find((s) => s.id === v)?.name ?? "Strategy";
  };

  const toggleNeedsReview = () => {
    setNeedsReviewOpen((v) => !v);
    needsReviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Drawer: Escape closes; a screenshots-focused open scrolls the
  // gallery into view once the content has mounted.
  useEffect(() => {
    if (!drawerKey) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeDrawer(); };
    window.addEventListener("keydown", onKey);
    let timer: number | undefined;
    if (drawerFocusShots) {
      timer = window.setTimeout(() => {
        document.getElementById("trade-screenshots")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer) window.clearTimeout(timer);
    };
  }, [drawerKey, drawerFocusShots]);

  // Header Import menu: closes on outside click / Escape.
  useEffect(() => {
    if (!importMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".jr-menu-wrap")) setImportMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setImportMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [importMenuOpen]);

  // Draft Review drawer: events come from the journal's loaded stream
  // for linked attempts; for UNLINKED attempts they are fetched on
  // demand (same row -> DrEvent mapping as load()) and cached here.
  const openDraftReview = async (draft: DrDraftRow) => {
    setReviewDraft(draft);
    if (drData.eventsByAttempt.has(draft.attemptId)) return;
    if (draftEventsByAttempt.has(draft.attemptId)) return;
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("daily_replay_events")
        .select("id,attempt_id,seq,type,wall_ts,market_idx,market_ts,payload")
        .eq("attempt_id", draft.attemptId)
        .order("seq", { ascending: true });
      if (error || !data) return;
      const evts: DrEvent[] = (data as any[]).map((r) => ({
        seq: Number(r.seq),
        type: r.type,
        wallTs: r.wall_ts ? new Date(r.wall_ts).getTime() : 0,
        marketIdx: r.market_idx != null ? Number(r.market_idx) : null,
        marketTs: r.market_ts != null ? Number(r.market_ts) : null,
        payload: (r.payload ?? {}) as Record<string, unknown>,
      }));
      setDraftEventsByAttempt((prev) => {
        const next = new Map(prev);
        next.set(draft.attemptId, evts);
        return next;
      });
    } catch { /* drawer renders with no events rather than failing */ }
  };
  const activeDraft: DrDraftRow | null = reviewDraft
    ? (drDrafts.find((d) => d.id === reviewDraft.id) ?? reviewDraft)
    : null;
  const activeDraftAttempt = activeDraft ? drData.attempts.find((a) => a.id === activeDraft.attemptId) ?? null : null;
  const activeDraftExport = activeDraft ? drData.attemptsExport.find((a) => a.id === activeDraft.attemptId) ?? null : null;
  const activeDraftEvents: DrEvent[] = activeDraft
    ? (drData.eventsByAttempt.get(activeDraft.attemptId)?.map((e) => e.event)
      ?? draftEventsByAttempt.get(activeDraft.attemptId)
      ?? [])
    : [];

  // Finalize confirm callback for the shared dialog: flips the
  // draft's flag, copies any draft-key annotations forward when a
  // canonical key is already known, then VERIFIES the flag landed
  // (a silent no-op must surface as an error in the dialog, not as a
  // false success state) and resyncs the page.
  const confirmFinalizeFromJournal = async (draft: DrDraftRow) => {
    const supabase = createClient();
    await finalizeDraft(supabase, draft.id);
    if (draft.finalizedTradeKey) {
      const sessionId = draft.finalizedSessionId
        ?? drData.attempts.find((a) => a.id === draft.attemptId)?.sessionId
        ?? null;
      await copyDraftMetaForward(supabase, draft.draftKey, draft.finalizedTradeKey, sessionId);
    }
    const fresh = await fetchDraftsForUser(supabase).catch(() => null);
    const row = fresh?.find((d) => d.id === draft.id);
    if (row && row.status !== "finalized") {
      throw new Error("Finalize did not land — please try again.");
    }
    load();
  };

  // Display status for a draft row: the stored status, with the
  // derived superseded case (a still-"draft" row from a generation
  // before a reset in a FINISHED attempt) shown honestly as such.
  const draftDisplayStatus = (d: DrDraftRow): { label: string; superseded: boolean } => {
    if (d.status === "finalized") return { label: "Finalized", superseded: false };
    if (d.status === "superseded") return { label: "Superseded (pre-reset)", superseded: true };
    const attempt = drData.attempts.find((a) => a.id === d.attemptId);
    const resets = drResetCounts.get(d.attemptId) ?? 0;
    if (attempt?.status === "finished" && d.resetGeneration < resets) {
      return { label: "Superseded (pre-reset)", superseded: true };
    }
    return { label: "Draft", superseded: false };
  };

  // Drafts card header + source chip read THIS aggregation, so their
  // total always equals the number of rows the card lists (finalized
  // drafts included); the still-open remainder is labeled "to review".
  const drCounts = draftListCounts(drDrafts, (d) => draftDisplayStatus(d).superseded);

  // Needs Review panel default: open when drafts await review. Set
  // once, when the first non-empty draft list loads; the header
  // Drafts button toggles it from there.
  useEffect(() => {
    if (needsReviewInitRef.current) return;
    if (drDrafts.length === 0) return;
    needsReviewInitRef.current = true;
    setNeedsReviewOpen(drCounts.toReview > 0);
  }, [drDrafts.length, drCounts.toReview]);

  // One row renderer for the drafts card's two lists: the actionable
  // list (unfinalized drafts awaiting review) and the collapsed
  // "Finalized" history subsection.
  const renderDraftRow = (d: DrDraftRow, actionable: boolean) => {
    const disp = draftDisplayStatus(d);
    const attempt = drData.attempts.find((a) => a.id === d.attemptId) ?? null;
    const exp = drData.attemptsExport.find((a) => a.id === d.attemptId) ?? null;
    const rowDate = exp?.tradeDate ?? drData.tickerByAttempt.get(d.attemptId)?.tradeDate ?? (attempt?.createdAt ? attempt.createdAt.slice(0, 10) : "");
    const statusLabel = disp.superseded ? disp.label : d.status === "finalized" ? "Finalized" : "Draft — awaiting review";
    const entryCapture = d.autoCapture?.entry as { status?: unknown } | undefined;
    const entryCaptureFailed = entryCapture?.status === "failed";
    return (
      <div key={d.id} className="jr-needs-row" style={{ opacity: disp.superseded ? 0.65 : 1 }}>
        <span style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="hint">{rowDate}</span>
          <b>{exp?.ticker ?? drData.tickerByAttempt.get(d.attemptId)?.ticker ?? "Daily Replay"}</b>
          <SourceBadge source="daily_replay" />
          <span className="jr-dir-badge long">Long</span>
          <span className="num">entry ${d.firstFillPrice.toFixed(2)}</span>
          <span className="num">qty {d.firstFillQty}</span>
          <span className="hint">
            {`cycle ${d.cycleIndex} (gen ${d.resetGeneration})`}
            {` · candle #${d.firstFillCandleIndex + 1} → #${d.closeFillCandleIndex + 1}`}
          </span>
          <span style={{
            fontSize: 10, padding: "2px 8px", borderRadius: 10, fontWeight: 600,
            background: disp.superseded ? "rgba(255,255,255,0.08)" : d.status === "finalized" ? "rgba(16,185,129,0.15)" : "rgba(251,191,36,0.12)",
            border: disp.superseded ? "1px solid rgba(255,255,255,0.2)" : d.status === "finalized" ? "1px solid rgba(16,185,129,0.4)" : "1px solid rgba(251,191,36,0.45)",
            color: disp.superseded ? "var(--muted)" : d.status === "finalized" ? "#34d399" : "#fbbf24",
            textDecoration: disp.superseded ? "line-through" : "none",
          }}>{statusLabel}</span>
          {entryCaptureFailed && (
            <span style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 10, fontWeight: 600,
              background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.45)", color: "#fbbf24",
            }}>Entry screenshot failed</span>
          )}
        </span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="num" style={{ fontWeight: 700, color: d.realizedPnl > 0 ? "var(--emerald-bright)" : d.realizedPnl < 0 ? "#f6465d" : "var(--muted)" }}>{formatSigned(d.realizedPnl)}</span>
          <button className="btn" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => openDraftReview(d)}>Review Draft</button>
          {actionable && d.status === "draft" && !disp.superseded && (
            <button className="btn" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => setFinalizeTarget(d)}>Finalize Trade</button>
          )}
        </span>
      </div>
    );
  };
  const draftsSorted = [...drDrafts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const actionableDrafts = draftsSorted.filter((d) => d.status !== "finalized");
  const finalizedDrafts = draftsSorted.filter((d) => d.status === "finalized");

  if (loading) return <div className="wrap" style={{ padding: 40 }}><p className="hint">Loading journal…</p></div>;
  if (error) return <div className="wrap" style={{ padding: 40 }}><div className="err">{error}</div><p style={{ marginTop: 12 }}><Link href="/replay">← Back to simulator</Link></p></div>;

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <div className="jr-head">
        <div>
          <h2 style={{ margin: "0 0 4px" }}>Trade Journal</h2>
          <p className="hint" style={{ margin: 0 }}>Review trades. Find your edge.</p>
        </div>
        <div className="jr-actions">
          <button className="btn primary" onClick={() => { setEditingReal(null); setTab("trades"); setShowRealForm(true); }}>Add Trade</button>
          <div className="jr-menu-wrap">
            <button className="btn" onClick={() => setImportMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={importMenuOpen}>Import Trades ▾</button>
            {importMenuOpen && (
              <div className="jr-menu" role="menu">
                <button className="jr-menu-item" role="menuitem" onClick={() => { setImportMenuOpen(false); setTab("trades"); setShowImport(true); }}>Import from Broker (CSV)</button>
              </div>
            )}
          </div>
          <button className="btn" onClick={toggleNeedsReview}>
            Drafts · {drCounts.toReview}
            <span className="hint" style={{ fontSize: 11 }}> of {drCounts.total} total</span>
          </button>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 12 }}>
        {(["overview", "trades", "review", "calendar", "analytics"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "overview" ? "Overview" : t === "trades" ? "All Trades" : t === "review" ? "Trade Review" : t === "calendar" ? "Calendar" : "Analytics"}
          </button>
        ))}
      </div>

      {/* Headline metric cards — the same filtered set every view reads */}
      <div className="jr-metrics">
        <div className="card jr-metric">
          <div className="jr-metric-label">Total Trades</div>
          <div className="num jr-metric-value">{metrics.totalTrades}</div>
        </div>
        <div className="card jr-metric">
          <div className="jr-metric-label">Win Rate</div>
          <div className="num jr-metric-value">{metrics.winRate == null ? "—" : fmtPct(metrics.winRate)}</div>
        </div>
        <div className="card jr-metric">
          <div className="jr-metric-label">Net P&L</div>
          <div className="num jr-metric-value" style={{ color: metrics.netPnl > 0 ? "var(--emerald-bright)" : metrics.netPnl < 0 ? "#f6465d" : "var(--text)" }}>{fmtPnl(metrics.netPnl)}</div>
        </div>
        <div className="card jr-metric">
          <div className="jr-metric-label">Average R</div>
          <div className="num jr-metric-value">{analyticsRisk.avgR == null ? "—" : `${analyticsRisk.avgR.toFixed(2)}R`}</div>
        </div>
      </div>

      {/* Unified filter bar — every control writes the existing
          filter state consumed by the single `filtered` memo. */}
      <div className="card jr-filterbar">
        <div className="jr-filterbar-row">
          <div className="jr-seg" role="group" aria-label="Source filter">
            {([["all", "All"], ["simulator", "Simulator"], ["daily_replay", "Daily Replay"], ["real", "Real Market"]] as [SourceFilter, string][]).map(([s, label]) => (
              <button key={s} className={`jr-seg-btn ${sourceFilter === s ? "active" : ""}`} onClick={() => setSourceFilter(s)}>{label}</button>
            ))}
          </div>
          <div className="jr-filter-field">
            <label htmlFor="jr-period">Date Range</label>
            <select id="jr-period" className="input" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="30d">Last 30 Days</option>
              <option value="90d">Last 90 Days</option>
              <option value="ytd">Year to Date</option>
              <option value="all">All Time</option>
            </select>
          </div>
          <div className="jr-filter-field">
            <label htmlFor="jr-ticker">Search Ticker</label>
            <input id="jr-ticker" className="input" placeholder="Search ticker…" value={fTicker} onChange={(e) => setFTicker(e.target.value)} />
          </div>
          <div className="jr-filter-field">
            <label htmlFor="jr-setup">Setup</label>
            <select id="jr-setup" className="input" value={fSetup} onChange={(e) => setFSetup(e.target.value)}>
              <option value="">All setups</option>
              {SETUPS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <button className="btn" onClick={() => setAdvancedOpen((v) => !v)} aria-expanded={advancedOpen}>Advanced Filters {advancedOpen ? "▴" : "▾"}</button>
          <button className="btn" onClick={clearAllFilters}>Clear Filters</button>
        </div>
        {advancedOpen && (
          <div className="jr-advanced">
            {(drData.strategies.length > 0 || unified.some((t) => isDailyReplayTrade(t))) && (
              <div className="jr-filter-field">
                <label htmlFor="jr-strategy">Strategy</label>
                <select id="jr-strategy" className="input" value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)}>
                  <option value="">All strategies</option>
                  {drData.strategies.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.archivedAt ? " (archived)" : ""}</option>
                  ))}
                  {drData.strategyVersions.map((v) => {
                    const s = drData.strategies.find((x) => x.id === v.strategyId);
                    return <option key={v.id} value={`version:${v.id}`}>{s?.name ?? "Strategy"} · v{v.version} only</option>;
                  })}
                </select>
              </div>
            )}
            <div className="jr-filter-field">
              <label htmlFor="jr-winloss">Win/Loss</label>
              <select id="jr-winloss" className="input" value={fWinLoss} onChange={(e) => setFWinLoss(e.target.value)}>
                <option value="">All</option>
                <option value="win">Winners</option>
                <option value="loss">Losers</option>
              </select>
            </div>
          </div>
        )}
        {(sourceFilter !== "all" || period !== "all" || fTicker !== "" || fSetup !== "" || strategyFilter !== "" || fWinLoss !== "") && (
          <div className="jr-chips">
            {sourceFilter !== "all" && (
              <span className="jr-chip">Source: {sourceFilter === "simulator" ? "Simulator" : sourceFilter === "daily_replay" ? "Daily Replay" : "Real Market"}
                <button className="jr-chip-x" onClick={() => setSourceFilter("all")} aria-label="Clear source filter">×</button>
              </span>
            )}
            {period !== "all" && (
              <span className="jr-chip">Date: {({ today: "Today", week: "This Week", month: "This Month", "30d": "Last 30 Days", "90d": "Last 90 Days", ytd: "Year to Date", all: "All Time" } as Record<Period, string>)[period]}
                <button className="jr-chip-x" onClick={() => setPeriod("all")} aria-label="Clear date filter">×</button>
              </span>
            )}
            {fTicker !== "" && (
              <span className="jr-chip">Ticker: {fTicker}
                <button className="jr-chip-x" onClick={() => setFTicker("")} aria-label="Clear ticker filter">×</button>
              </span>
            )}
            {fSetup !== "" && (
              <span className="jr-chip">Setup: {fSetup}
                <button className="jr-chip-x" onClick={() => setFSetup("")} aria-label="Clear setup filter">×</button>
              </span>
            )}
            {strategyFilter !== "" && (
              <span className="jr-chip">Strategy: {strategyFilterLabel(strategyFilter)}
                <button className="jr-chip-x" onClick={() => setStrategyFilter("")} aria-label="Clear strategy filter">×</button>
              </span>
            )}
            {fWinLoss !== "" && (
              <span className="jr-chip">{fWinLoss === "win" ? "Winners" : "Losers"}
                <button className="jr-chip-x" onClick={() => setFWinLoss("")} aria-label="Clear win/loss filter">×</button>
              </span>
            )}
          </div>
        )}
      </div>
      {filtered.some((t) => isDailyReplayTrade(t)) && (
        <p className="hint" style={{ margin: "0 0 16px", fontSize: 12 }}>
          Daily Replay trades are historical backtests — simulated results on recorded market days, not live trading performance.
        </p>
      )}
      {!filtered.some((t) => isDailyReplayTrade(t)) && <div style={{ marginBottom: 12 }} />}

      {notice && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "10px 14px", marginBottom: 16, borderRadius: 8, background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.4)", fontSize: 13 }}>
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
        </div>
      )}

      {tab === "overview" && <OverviewTab metrics={metrics} simMetrics={simMetrics} realMetrics={realMetrics} drMetrics={drMetrics} cumPnl={cumPnl} trades={filtered} sourceTotalCount={sourceTotalCount} sourceClosedCount={sourceClosedCount} sourceFilter={sourceFilter} maxDrawdown={analyticsRisk.maxDrawdownUSD} onSelect={(k) => openDrawer(k)} onAddRealTrade={() => { setEditingReal(null); setTab("trades"); setShowRealForm(true); }} onImportBroker={() => { setTab("trades"); setShowImport(true); }} />}
      {tab === "trades" && <TradesTab trades={filtered} metas={metas} onSelect={(k) => openDrawer(k)} onSelectShots={(k) => openDrawer(k, true)} onRealTradeSaved={handleRealTradeSaved} showRealForm={showRealForm} setShowRealForm={setShowRealForm} showImport={showImport} setShowImport={setShowImport} editingReal={editingReal} onEditReal={startEditReal} onDeleteReal={startDeleteReal} onCancelEdit={cancelEdit} />}
      {tab === "review" && <ReviewTab tradeKey={selectedKey} simTrade={!isRealSelected ? (selected as GroupedTrade | null) : null} realTrade={isRealSelected ? (selected as RealTrade | null) : null} meta={selectedMeta} onSaved={load} onEditReal={startEditReal} onDeleteReal={startDeleteReal} drInfo={selectedDrInfo} drDraftKey={selectedKey ? (draftForTrade(selectedKey, unified.find((t) => t.key === selectedKey)?.attemptId ?? null)?.draftKey ?? null) : null} drAutoCapture={selectedKey ? (draftForTrade(selectedKey, unified.find((t) => t.key === selectedKey)?.attemptId ?? null)?.autoCapture ?? null) : null} />}
      {tab === "calendar" && <CalendarTab trades={closedFiltered} metas={metas} selectedDay={selectedCalDay} onSelectDay={setSelectedCalDay} onSelectTrade={(k) => openDrawer(k)} />}
      {tab === "analytics" && <AnalyticsTab trades={analyticsTrades} onSelect={(k) => openDrawer(k)} exportInput={{
        unified, metas, realTrades, simTrades: [...trades, ...drData.preTrades],
        drAttempts: drData.attemptsExport,
        drEvidence: drData.evidenceByKey,
        drEvents: [...drData.eventsByAttempt.values()].flat(),
        drEventTradeKeys: new Map([...drData.evidenceByAttempt.entries()].map(([id, d]) => [id, d.eventTradeKey])),
        strategies: drData.strategies,
        strategyVersions: drData.strategyVersions,
        // Post-completion trades key by their finalized trade key;
        // pre-completion trades (finalized drafts on active attempts)
        // key by the draft key itself — the same prefix their
        // screenshots already live under, so representative
        // resolution and the union listing work unchanged.
        drDraftKeys: new Map<string, { draftKey: string; autoCapture: Record<string, unknown> }>([
          ...drDrafts.filter((d) => d.finalizedTradeKey).map((d) => [d.finalizedTradeKey!, { draftKey: d.draftKey, autoCapture: d.autoCapture }] as const),
          ...drData.preTrades.flatMap((t) => {
            const d = drDrafts.find((x) => x.draftKey === t.tradeKey);
            return d ? [[t.tradeKey, { draftKey: d.draftKey, autoCapture: d.autoCapture }] as const] : [];
          }),
        ]),
        // Finalized drafts whose pre-completion row was withheld
        // (anchor reconciliation failed) — the export panel names the
        // count instead of a silent absence. All other finalized
        // drafts are INCLUDED via `unified`, session or not.
        drWithheldFinalizedDrafts: drData.withheldFinalized,
      }} />}

      {/* Needs Review — Daily Replay drafts, additive below the tab
          content (never replaces it). Finalized drafts live only in
          the collapsed history subsection. */}
      {(drDrafts.length > 0 || needsReviewOpen) && (
        <div className="card jr-needs" ref={needsReviewRef} style={{ padding: 16, marginTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Needs review · {drCounts.toReview} draft{drCounts.toReview === 1 ? "" : "s"}</h3>
            <span className="hint" style={{ fontSize: 12 }}>
              {drCounts.total} draft{drCounts.total === 1 ? "" : "s"}
              {drCounts.toReview > 0 ? ` · ${drCounts.toReview} to review` : ""}
              {excludedCount > 0 ? ` · ${excludedCount} trade${excludedCount === 1 ? "" : "s"} excluded from the journal until finalized` : ""}
            </span>
          </div>
          <p className="hint" style={{ margin: "0 0 12px", fontSize: 12 }}>
            Closed Daily Replay position cycles, captured as drafts while you replay. Review a draft, then finalize it — a finalized trade appears in Trade Journal → Daily Replay / Backtest, analytics and AI Edge exports right away; the replay session does not need to be completed first.
          </p>
          {!needsReviewOpen ? (
            <button className="btn" onClick={() => setNeedsReviewOpen(true)}>Show drafts</button>
          ) : (
            <>
              {drDrafts.length === 0 && <p className="hint" style={{ margin: 0 }}>No Daily Replay drafts yet.</p>}
              {drDrafts.length > 0 && actionableDrafts.length === 0 && (
                <p className="hint" style={{ margin: "0 0 4px" }}>No drafts awaiting review — every draft is finalized.</p>
              )}
              {actionableDrafts.map((d) => renderDraftRow(d, true))}
              {finalizedDrafts.length > 0 && (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "6px 0" }}>
                    Finalized ({finalizedDrafts.length}) <span className="hint" style={{ fontWeight: 400 }}>— already in the journal</span>
                  </summary>
                  {finalizedDrafts.map((d) => renderDraftRow(d, false))}
                </details>
              )}
            </>
          )}
        </div>
      )}

      {/* Trade detail drawer — the existing ReviewTab content,
          unchanged, in a right-side panel. */}
      {drawerKey && (
        <div className="jr-drawer-backdrop" onClick={closeDrawer}>
          <div className="jr-drawer" role="dialog" aria-label="Trade detail" onClick={(e) => e.stopPropagation()}>
            <div className="jr-drawer-head">
              <span style={{ fontSize: 13, fontWeight: 600 }}>Trade Detail</span>
              <button className="btn" style={{ padding: "2px 10px", fontSize: 15, lineHeight: 1.2 }} onClick={closeDrawer} aria-label="Close trade detail">×</button>
            </div>
            <ReviewTab tradeKey={selectedKey} simTrade={!isRealSelected ? (selected as GroupedTrade | null) : null} realTrade={isRealSelected ? (selected as RealTrade | null) : null} meta={selectedMeta} onSaved={load} onEditReal={(k) => { closeDrawer(); startEditReal(k); }} onDeleteReal={(k) => { closeDrawer(); startDeleteReal(k); }} drInfo={selectedDrInfo} drDraftKey={selectedKey ? (draftForTrade(selectedKey, unified.find((t) => t.key === selectedKey)?.attemptId ?? null)?.draftKey ?? null) : null} drAutoCapture={selectedKey ? (draftForTrade(selectedKey, unified.find((t) => t.key === selectedKey)?.attemptId ?? null)?.autoCapture ?? null) : null} />
          </div>
        </div>
      )}

      {activeDraft && (
        <DrDraftReview
          draft={activeDraft}
          ticker={activeDraftExport?.ticker ?? (activeDraft ? drData.tickerByAttempt.get(activeDraft.attemptId)?.ticker ?? null : null)}
          tradeDate={activeDraftExport?.tradeDate ?? (activeDraft ? drData.tickerByAttempt.get(activeDraft.attemptId)?.tradeDate ?? null : null)}
          attemptStatus={activeDraftAttempt?.status ?? null}
          events={activeDraftEvents}
          onClose={() => setReviewDraft(null)}
          onChanged={() => load()}
          onViewInJournal={() => { setReviewDraft(null); revealFinalizedTrade(); }}
        />
      )}

      {finalizeTarget && (
        <DrFinalizeConfirm
          summary={{
            ticker: drData.attemptsExport.find((a) => a.id === finalizeTarget.attemptId)?.ticker ?? drData.tickerByAttempt.get(finalizeTarget.attemptId)?.ticker ?? null,
            tradeDate: drData.attemptsExport.find((a) => a.id === finalizeTarget.attemptId)?.tradeDate ?? drData.tickerByAttempt.get(finalizeTarget.attemptId)?.tradeDate ?? null,
            cycleIndex: finalizeTarget.cycleIndex,
            realizedPnl: finalizeTarget.realizedPnl,
          }}
          onConfirm={() => confirmFinalizeFromJournal(finalizeTarget)}
          onClose={() => setFinalizeTarget(null)}
          onViewInJournal={() => { revealFinalizedTrade(); }}
        />
      )}

      {deleteTarget && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 16 }}
          onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(null); } }}
        >
          <div className="card" style={{ padding: 20, maxWidth: 440, width: "100%" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 8px" }}>Delete {deleteTarget.ticker} ({deleteTarget.tradeDate})?</h3>
            <p style={{ margin: "0 0 6px", fontSize: 13 }}>
              {deleteTarget.direction} · Net P&L{" "}
              <b className="num" style={{ color: deleteTarget.realizedPnl > 0 ? "var(--emerald-bright)" : deleteTarget.realizedPnl < 0 ? "#f6465d" : "var(--muted)" }}>
                {fmtPnl(deleteTarget.realizedPnl)}
              </b>
              {deleteTarget.isOpen && <span style={{ color: "#fbbf24" }}> · still open</span>}
            </p>
            <p className="hint" style={{ margin: "0 0 16px" }}>
              This permanently deletes the trade, its fills, its review notes, and its screenshots. This cannot be undone.
            </p>
            {deleteError && <div className="err" style={{ marginBottom: 12 }}>{deleteError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => { setDeleteTarget(null); setDeleteError(null); }} disabled={deleting}>Cancel</button>
              <button className="btn" onClick={confirmDelete} disabled={deleting}
                style={{ background: "rgba(246,70,93,0.15)", borderColor: "rgba(246,70,93,0.5)", color: "#f6465d" }}>
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Overview ---------------- */
function SourceBadge({ source }: { source: "simulator" | "real" | "daily_replay" }) {
  const style = source === "real"
    ? { background: "rgba(96,165,250,0.15)", border: "1px solid rgba(96,165,250,0.4)", color: "#93c5fd" }
    : source === "daily_replay"
      ? { background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.45)", color: "#c4b5fd" }
      : { background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", color: "#34d399" };
  return (
    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, fontWeight: 600, ...style }}>
      {source === "real" ? "Real Market" : source === "daily_replay" ? "Daily Replay" : "Simulator"}
    </span>
  );
}

/** The badge a unified trade earns: DR trades are marked explicitly,
 *  never silently shown as plain "Simulator". */
function badgeSourceOf(t: UnifiedTrade): "simulator" | "real" | "daily_replay" {
  return t.source === "real" ? "real" : isDailyReplayTrade(t) ? "daily_replay" : "simulator";
}

function OverviewTab({ metrics, simMetrics, realMetrics, drMetrics, cumPnl, trades, sourceTotalCount, sourceClosedCount, sourceFilter, maxDrawdown, onSelect, onAddRealTrade, onImportBroker }: {
  metrics: ReturnType<typeof calcMetrics>;
  simMetrics: ReturnType<typeof calcMetrics>;
  realMetrics: ReturnType<typeof calcMetrics>;
  drMetrics: ReturnType<typeof calcMetrics>;
  cumPnl: number[];
  trades: UnifiedTrade[];
  /** All trades (open + closed) matching the source filter, any period */
  sourceTotalCount: number;
  /** Closed trades matching the source filter, any period */
  sourceClosedCount: number;
  sourceFilter: SourceFilter;
  maxDrawdown: number;
  onSelect: (k: string) => void;
  onAddRealTrade: () => void;
  onImportBroker: () => void;
}) {
  const m = metrics;
  const stat = (label: string, value: string, pnl?: number | null) => (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div className="num" style={{ fontSize: 20, fontWeight: 700, color: pnl == null ? "var(--text)" : pnl > 0 ? "var(--emerald-bright)" : pnl < 0 ? "#f6465d" : "var(--text)" }}>{value}</div>
    </div>
  );

  // Simple SVG cumulative chart
  const w = 600, h = 120, pad = 8;
  const min = Math.min(0, ...cumPnl), max = Math.max(0, ...cumPnl);
  const range = max - min || 1;
  const pts = cumPnl.map((v, i) => {
    const x = pad + (i / Math.max(1, cumPnl.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <div>
      {m.totalTrades === 0 ? (
        sourceTotalCount === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No trades yet</div>
            {sourceFilter === "real" ? (
              <>
                <p className="hint">Add your real market trades manually or import them from your broker.</p>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
                  <button className="btn primary" onClick={onAddRealTrade}>
                    + Add Real Trade
                  </button>
                  <button className="btn" onClick={onImportBroker}>
                    ⭳ Import from Broker
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="hint">Trade in the simulator, then your closed positions will appear here automatically.</p>
                <Link href="/replay" className="btn primary" style={{ marginTop: 8, display: "inline-block", textDecoration: "none" }}>Open Simulator</Link>
              </>
            )}
          </div>
        ) : (
          <div className="card" style={{ padding: 32, textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
              {sourceClosedCount > 0 ? "No closed trades in this period" : "No closed trades yet"}
            </div>
            <p className="hint">
              {sourceClosedCount > 0
                ? "Try a wider date range or a different source filter."
                : "Your trades for this source are still open — closed trades and their statistics will appear here."}
            </p>
            {sourceFilter === "real" && (
              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
                <button className="btn primary" onClick={onAddRealTrade}>
                  + Add Real Trade
                </button>
                <button className="btn" onClick={onImportBroker}>
                  ⭳ Import from Broker
                </button>
              </div>
            )}
          </div>
        )
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
            {stat("Profit Factor", m.profitFactor == null ? "—" : m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2))}
            {stat("Avg Win", fmtPnl(m.avgWin), m.avgWin)}
            {stat("Avg Loss", fmtPnl(m.avgLoss), m.avgLoss)}
            {stat("Expectancy", fmtPnl(m.expectancy), m.expectancy)}
            {stat("Largest Win", fmtPnl(m.largestWin), m.largestWin)}
            {stat("Max Drawdown", maxDrawdown > 0 ? fmtPnl(-maxDrawdown) : fmtPnl(0), maxDrawdown > 0 ? -maxDrawdown : 0)}
          </div>

          {cumPnl.length > 1 && (
            <div className="card" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Cumulative P&L</div>
              <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 120 }}>
                <polyline points={pts} fill="none" stroke="var(--emerald-bright)" strokeWidth={2} />
                <line x1={pad} x2={w - pad} y1={h - pad - ((0 - min) / range) * (h - pad * 2)} y2={h - pad - ((0 - min) / range) * (h - pad * 2)} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
              </svg>
            </div>
          )}

          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Recent Trades</div>
            {trades.slice(0, 10).map((t) => (
              <div key={t.key} onClick={() => onSelect(t.key)}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.06)", cursor: "pointer" }}>
                <span><b>{t.ticker}</b> <span className="hint">{t.tradeDate} · {t.direction}</span> <SourceBadge source={badgeSourceOf(t)} />{t.isOpen && <span style={{ fontSize: 10, color: "#fbbf24", marginLeft: 6 }}>OPEN</span>}</span>
                <span className="num" style={{ color: t.realizedPnl > 0 ? "var(--emerald-bright)" : t.realizedPnl < 0 ? "#f6465d" : "var(--muted)", fontWeight: 600 }}>{fmtPnl(t.realizedPnl)}</span>
              </div>
            ))}
          </div>

          {/* Per-source breakdown */}
          {sourceFilter === "all" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10, marginTop: 16 }}>
              <div className="card" style={{ padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <SourceBadge source="simulator" />
                  <span className="hint">{simMetrics.totalTrades} trades</span>
                </div>
                <div className="num" style={{ fontSize: 22, fontWeight: 700, color: simMetrics.netPnl > 0 ? "var(--emerald-bright)" : simMetrics.netPnl < 0 ? "#f6465d" : "var(--text)" }}>
                  {fmtPnl(simMetrics.netPnl)}
                </div>
                <div className="hint" style={{ marginTop: 4 }}>Win rate {fmtPct(simMetrics.winRate)} · PF {simMetrics.profitFactor == null ? "—" : simMetrics.profitFactor === Infinity ? "∞" : simMetrics.profitFactor.toFixed(2)}</div>
              </div>
              <div className="card" style={{ padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <SourceBadge source="real" />
                  <span className="hint">{realMetrics.totalTrades} trades</span>
                </div>
                <div className="num" style={{ fontSize: 22, fontWeight: 700, color: realMetrics.netPnl > 0 ? "var(--emerald-bright)" : realMetrics.netPnl < 0 ? "#f6465d" : "var(--text)" }}>
                  {fmtPnl(realMetrics.netPnl)}
                </div>
                <div className="hint" style={{ marginTop: 4 }}>Win rate {fmtPct(realMetrics.winRate)} · PF {realMetrics.profitFactor == null ? "—" : realMetrics.profitFactor === Infinity ? "∞" : realMetrics.profitFactor.toFixed(2)}</div>
              </div>
              {drMetrics.totalTrades > 0 && (
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <SourceBadge source="daily_replay" />
                    <span className="hint">{drMetrics.totalTrades} trades · backtest</span>
                  </div>
                  <div className="num" style={{ fontSize: 22, fontWeight: 700, color: drMetrics.netPnl > 0 ? "var(--emerald-bright)" : drMetrics.netPnl < 0 ? "#f6465d" : "var(--text)" }}>
                    {fmtPnl(drMetrics.netPnl)}
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>Win rate {fmtPct(drMetrics.winRate)} · PF {drMetrics.profitFactor == null ? "—" : drMetrics.profitFactor === Infinity ? "∞" : drMetrics.profitFactor.toFixed(2)}</div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- All Trades ---------------- */
type TradeSortKey = "date" | "symbol" | "entry" | "qty" | "pnl";

function TradesTab({ trades, metas, onSelect, onSelectShots, onRealTradeSaved, showRealForm, setShowRealForm, showImport, setShowImport, editingReal, onEditReal, onDeleteReal, onCancelEdit }: {
  trades: UnifiedTrade[]; metas: Record<string, TradeMeta>;
  onSelect: (k: string) => void;
  /** Open the trade's detail with the screenshots gallery scrolled
   *  into view (the kebab "Screenshots" action, real trades). */
  onSelectShots: (k: string) => void;
  onRealTradeSaved: (notice?: string) => void;
  showRealForm: boolean; setShowRealForm: (v: boolean | ((p: boolean) => boolean)) => void;
  showImport: boolean; setShowImport: (v: boolean | ((p: boolean) => boolean)) => void;
  editingReal: { trade: RealTrade; meta: TradeMeta | null } | null;
  onEditReal: (k: string) => void;
  onDeleteReal: (k: string) => void;
  onCancelEdit: () => void;
}) {
  // Client-side sorting + pagination over the page-level filtered
  // set. Default sort (date desc) matches the incoming order exactly.
  const [sortKey, setSortKey] = useState<TradeSortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const PAGE_SIZE = 25;

  useEffect(() => { setPage(1); }, [trades]);

  // Kebab menu: closes on outside click / Escape.
  useEffect(() => {
    if (!menuKey) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".jr-kebab-cell")) setMenuKey(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuKey(null); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuKey]);

  const sorted = useMemo(() => {
    const arr = [...trades];
    const mul = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case "date": return mul * a.tradeDate.localeCompare(b.tradeDate);
        case "symbol": return mul * a.ticker.localeCompare(b.ticker);
        case "entry": return mul * ((a.entryPrice ?? 0) - (b.entryPrice ?? 0));
        case "qty": return mul * (a.qty - b.qty);
        case "pnl": return mul * (a.realizedPnl - b.realizedPnl);
      }
    });
    return arr;
  }, [trades, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageTrades = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const rangeStart = sorted.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(sorted.length, safePage * PAGE_SIZE);

  const toggleSort = (k: TradeSortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "date" ? "desc" : "asc"); }
  };
  const thStyle = { padding: "10px 12px", color: "var(--muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase" as const };
  const sortHeader = (label: string, k: TradeSortKey) => (
    <th key={k} style={thStyle}>
      <button onClick={() => toggleSort(k)} aria-label={`Sort by ${label}`}
        style={{ background: "none", border: "none", color: "inherit", font: "inherit", cursor: "pointer", padding: 0, textTransform: "uppercase" }}>
        {label}{sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <div>
      {showRealForm && (
        <RealTradeForm
          key={editingReal ? `edit-${editingReal.trade.id}` : "add"}
          editing={editingReal}
          onCancel={onCancelEdit}
          onSaved={(notice) => { setShowRealForm(false); onRealTradeSaved(notice); }}
        />
      )}
      {showImport && (
        <div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <button className="btn" style={{ padding: "3px 12px", fontSize: 12 }} onClick={() => setShowImport(false)}>Close import</button>
          </div>
          <BrokerImportForm onSaved={() => { setShowImport(false); onRealTradeSaved(); }} />
        </div>
      )}
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table className="jr-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", textAlign: "left" }}>
              {sortHeader("Date", "date")}
              {sortHeader("Symbol", "symbol")}
              <th style={thStyle}>Source</th>
              <th style={thStyle}>Direction</th>
              {sortHeader("Entry", "entry")}
              {sortHeader("Qty", "qty")}
              {sortHeader("P&L", "pnl")}
              <th style={thStyle}>Setup</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageTrades.map((t) => {
              const meta = metas[t.key];
              return (
                <tr key={t.key} onClick={() => onSelect(t.key)}
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", cursor: "pointer" }}>
                  <td style={{ padding: "10px 12px" }}>{t.tradeDate}</td>
                  <td style={{ padding: "10px 12px", fontWeight: 600 }}>{t.ticker}</td>
                  <td style={{ padding: "10px 12px" }}><SourceBadge source={badgeSourceOf(t)} />{t.strategyLabel && <div className="hint" style={{ fontSize: 11, marginTop: 3 }}>{t.strategyLabel}</div>}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <span className={`jr-dir-badge ${t.direction === "long" ? "long" : "short"}`}>{t.direction === "long" ? "Long" : "Short"}</span>
                    {t.isOpen && <span style={{ fontSize: 10, color: "#fbbf24", marginLeft: 6, fontWeight: 700 }}>OPEN</span>}
                  </td>
                  <td className="num" style={{ padding: "10px 12px" }}>{t.entryPrice != null ? `$${t.entryPrice.toFixed(2)}` : "—"}</td>
                  <td className="num" style={{ padding: "10px 12px" }}>{t.qty}</td>
                  <td className="num" style={{ padding: "10px 12px", fontWeight: 700, color: t.realizedPnl > 0 ? "var(--emerald-bright)" : t.realizedPnl < 0 ? "#f6465d" : "var(--muted)" }}>{fmtPnl(t.realizedPnl)}</td>
                  <td style={{ padding: "10px 12px" }}>{meta?.setup_tag ?? "—"}</td>
                  <td className="jr-kebab-cell" style={{ padding: "10px 12px", whiteSpace: "nowrap", position: "relative" }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn" style={{ padding: "3px 10px", fontSize: 12, marginRight: 6 }}
                      onClick={(e) => { e.stopPropagation(); onSelect(t.key); }}>View</button>
                    <button className="btn" style={{ padding: "3px 8px", fontSize: 12 }}
                      aria-label={`More actions for ${t.ticker}`} aria-haspopup="menu" aria-expanded={menuKey === t.key}
                      onClick={(e) => { e.stopPropagation(); setMenuKey(menuKey === t.key ? null : t.key); }}>⋯</button>
                    {menuKey === t.key && (
                      <div className="jr-menu jr-kebab-menu" role="menu">
                        <button className="jr-menu-item" role="menuitem" onClick={() => { setMenuKey(null); onSelect(t.key); }}>View details</button>
                        {t.source === "real" && (
                          <>
                            <button className="jr-menu-item" role="menuitem" onClick={() => { setMenuKey(null); onEditReal(t.key); }}>Edit trade</button>
                            <button className="jr-menu-item" role="menuitem" onClick={() => { setMenuKey(null); onSelectShots(t.key); }}>Screenshots</button>
                            <button className="jr-menu-item danger" role="menuitem" onClick={() => { setMenuKey(null); onDeleteReal(t.key); }}>Delete trade</button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {trades.length === 0 && <p className="hint" style={{ padding: 20, textAlign: "center" }}>No trades match your filters.</p>}
        {sorted.length > 0 && (
          <div className="jr-table-footer">
            <span className="hint">Showing {rangeStart}–{rangeEnd} of {sorted.length}</span>
            <span style={{ display: "flex", gap: 8 }}>
              <button className="btn" style={{ padding: "3px 12px", fontSize: 12 }} disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>Prev</button>
              <button className="btn" style={{ padding: "3px 12px", fontSize: 12 }} disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>Next</button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Trade Review ---------------- */
/** Saved screenshots for the trade being reviewed (real trades only).
 *  Loads fresh signed URLs on mount / trade switch; renders nothing
 *  when the trade has no screenshots. */
function ReviewScreenshots({ tradeKey, extraTradeKey, drDraftKey, drAutoCapture }: {
  tradeKey: string;
  extraTradeKey?: string | null;
  /** Daily Replay only: the trade's draft key + auto_capture, used to
   *  resolve and badge the representative screenshot. */
  drDraftKey?: string | null;
  drAutoCapture?: Record<string, unknown> | null;
}) {
  const [shots, setShots] = useState<{ path: string; url: string }[]>([]);
  const [ownerId, setOwnerId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { if (alive) { setShots([]); setOwnerId(null); } return; }
      if (alive) setOwnerId(user.id);
      const list = await listScreenshots(supabase, user.id, tradeKey);
      let merged = list;
      if (extraTradeKey && extraTradeKey !== tradeKey) {
        const extra = await listScreenshots(supabase, user.id, extraTradeKey);
        const byPath = new Map<string, { path: string; url: string }>();
        for (const s of [...list, ...extra]) byPath.set(s.path, s);
        merged = [...byPath.values()];
      }
      if (alive) setShots(merged);
    })();
    return () => { alive = false; };
  }, [tradeKey, extraTradeKey]);

  // Representative resolution (Daily Replay trades only): the same
  // shared resolver the export uses. The representative sorts first
  // and is badged; ALL images stay visible — nothing is hidden here.
  const representative = useMemo(() => {
    if (!drDraftKey || !ownerId) return null;
    return resolveRepresentative({
      autoCapture: drAutoCapture,
      listedPaths: shots.map((s) => s.path),
      draftKey: drDraftKey,
      finalizedTradeKey: tradeKey,
      userId: ownerId,
    });
  }, [drDraftKey, drAutoCapture, ownerId, shots, tradeKey]);
  const ordered = useMemo(() => {
    if (!representative) return shots;
    const rep = shots.find((s) => s.path === representative.path);
    return rep ? [rep, ...shots.filter((s) => s.path !== representative.path)] : shots;
  }, [shots, representative]);

  if (shots.length === 0) return null;
  return (
    <div className="card" id="trade-screenshots" style={{ padding: 16 }}>
      <h4 style={{ margin: "0 0 12px" }}>Screenshots</h4>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {ordered.map((s) => {
          const isRep = representative?.path === s.path;
          return (
            <div key={s.path} style={{ maxWidth: 280 }}>
              <a href={s.url} target="_blank" rel="noreferrer" title="Open full size">
                <img src={s.url} alt="Trade screenshot" style={{ maxHeight: 200, maxWidth: 280, borderRadius: 8, border: isRep ? "2px solid var(--emerald-bright)" : "1px solid rgba(255,255,255,0.1)", objectFit: "cover", display: "block" }} />
              </a>
              {isRep && representative && (
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--emerald-bright)", marginTop: 4 }}>
                  Representative — {representativeSourceLabel(representative)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Daily Replay attempt card in Trade Review: the bound strategy,
 *  the original plan + adjustments from the recorded evidence, and
 *  this trade's slice of the attempt's Decision Timeline. Everything
 *  shown comes from the attempt's recorded events — nothing here is
 *  reconstructed, and missing evidence says so plainly. */
function DrAttemptCard({ info, tradeKeyVal }: { info: DrReviewInfo; tradeKeyVal: string }) {
  const [showAll, setShowAll] = useState(false);
  const ev = info.evidence;
  const ownSeqs = new Set(info.tradeEventSeqs);
  const ownEvents = info.events.filter((e) => ownSeqs.has(e.event.seq));
  const shown = showAll ? info.events : ownEvents;
  const lifecycle = info.attempt?.status === "finished"
    ? (info.resumed ? "Completed after resume" : "Completed")
    : "Session still in progress — trade finalized from its draft";
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h4 style={{ margin: 0 }}>Daily Replay Attempt</h4>
        <span className="hint" style={{ fontSize: 11 }}>Historical backtest — not live performance</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, fontSize: 13 }}>
        <div><span className="hint">Strategy</span><div>{info.strategyLabel ?? "No strategy recorded"}{info.strategyArchived ? <span className="hint"> (archived)</span> : null}</div></div>
        <div><span className="hint">Setup type</span><div>{info.setupType ?? "—"}</div></div>
        <div><span className="hint">Attempt</span><div>{lifecycle}</div></div>
        {info.startingBalance != null && (
          <div><span className="hint">Starting balance</span><div className="num">${info.startingBalance.toLocaleString()}</div></div>
        )}
        {info.attempt?.startIndex != null && (
          <div><span className="hint">Locked candle</span><div className="num">#{info.attempt.startIndex}</div></div>
        )}
      </div>

      <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Original Plan (recorded at entry)</div>
        {ev?.hasSnapshot ? (
          <>
            <div style={{ fontSize: 13 }}>
              <span className="hint">Original plan:</span> stop {ev.originalStopLoss != null ? `$${ev.originalStopLoss}` : "—"} · target {ev.originalTarget != null ? `$${ev.originalTarget}` : "—"}
              {ev.initialRisk != null && <> · initial risk <span className="num">${ev.initialRisk.toFixed(2)}</span></>}
              {ev.rMultiple != null && <> · R <span className="num">{ev.rMultiple.toFixed(2)}</span></>}
            </div>
            {(ev.planHistory.length > 0) && (
              <div className="hint" style={{ marginTop: 4 }}>
                {ev.planHistory.map((c, i) => (
                  <div key={i}>{new Date(c.at).toLocaleString()} — {c.field === "stop_loss" ? "Stop" : "Target"} changed {c.from != null ? `$${c.from}` : "—"} → {c.to != null ? `$${c.to}` : "—"}</div>
                ))}
              </div>
            )}
            <p className="hint" style={{ marginTop: 6, fontSize: 11.5 }}>{ev.riskBasis}</p>
          </>
        ) : (
          <p className="hint" style={{ margin: 0, fontSize: 12.5 }}>{ev?.riskBasis ?? "Plan evidence is unavailable for this trade."}</p>
        )}
      </div>

      <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Decision Timeline</div>
          {info.events.length > ownEvents.length && (
            <button className="btn" style={{ padding: "2px 10px", fontSize: 11.5 }} onClick={() => setShowAll((s) => !s)}>
              {showAll ? "This trade only" : `Full attempt (${info.events.length} events)`}
            </button>
          )}
        </div>
        {shown.length === 0 && <p className="hint" style={{ margin: 0 }}>No timeline events were recorded for this trade. The attempt history may not have been fully saved.</p>}
        <div style={{ display: "grid", gap: 3, maxHeight: 340, overflowY: "auto" }}>
          {shown.map(({ id, event }) => (
            <div key={id} style={{ fontSize: 12.5, display: "flex", gap: 10, padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
              <span className="num" style={{ color: "var(--muted)", minWidth: 44 }}>{event.marketIdx != null ? `#${event.marketIdx}` : "—"}</span>
              <span>{describeDrEvent(event)}</span>
            </div>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 6, fontSize: 11.5 }}>Timeline times are the historical market times of the replayed day. Trade key: {tradeKeyVal}</p>
      </div>
    </div>
  );
}

function ReviewTab({ tradeKey, simTrade, realTrade, meta, onSaved, onEditReal, onDeleteReal, drInfo, drDraftKey, drAutoCapture }: {
  tradeKey: string | null;
  simTrade: GroupedTrade | null;
  realTrade: RealTrade | null;
  meta: TradeMeta | null | undefined;
  onSaved: () => void;
  onEditReal?: (k: string) => void;
  onDeleteReal?: (k: string) => void;
  drInfo?: DrReviewInfo | null;
  /** Draft key of the selected Daily Replay trade (when it has a
   *  draft) — its screenshot prefix is unioned into Trade Review. */
  drDraftKey?: string | null;
  /** The draft's recorded auto_capture — the Trade Review gallery
   *  resolves and badges the representative from it (same resolver
   *  as the export, so UI and package can never disagree). */
  drAutoCapture?: Record<string, unknown> | null;
}) {
  const [form, setForm] = useState<Partial<TradeMeta>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (meta) setForm(meta);
    else setForm({});
    setMsg(null);
  }, [tradeKey]);

  if (!simTrade && !realTrade) {
    return (
      <div className="card" style={{ padding: 32, textAlign: "center" }}>
        <p className="hint">Select a trade from All Trades or Overview to review it.</p>
      </div>
    );
  }

  // Unified display values
  const isReal = !!realTrade;
  const displayTicker = isReal ? realTrade!.ticker : simTrade!.ticker;
  const displayDate = isReal ? realTrade!.trade_date : simTrade!.tradeDate;
  const displayDir = isReal ? realTrade!.direction : simTrade!.direction;
  const displayPnl = isReal ? realTrade!.calc.netRealized : simTrade!.realizedPnl;
  const displayEntry = isReal ? realTrade!.calc.avgEntry : simTrade!.entryPrice;
  const displayQty = isReal ? realTrade!.calc.entryQty : simTrade!.qty;
  const displayR = isReal ? realTrade!.calc.rMultiple : simTrade!.rMultiple;
  const tradeKeyVal = tradeKey!;

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const payload = {
        user_id: user.id,
        // Pre-completion Daily Replay trades have no session yet
        // (sessionId "") — the meta row records null, like draft
        // reviews do, until the canonical row takes over.
        session_id: isReal ? null : (simTrade!.sessionId || null),
        trade_key: tradeKeyVal,
        setup_tag: form.setup_tag ?? null,
        hod_class: form.hod_class ?? null,
        exec_grade: form.exec_grade ?? null,
        entry_reasoning: form.entry_reasoning ?? null,
        exit_reasoning: form.exit_reasoning ?? null,
        followed_plan: form.followed_plan ?? null,
        confidence: form.confidence ?? null,
        emotional_tags: form.emotional_tags ?? [],
        mistakes: form.mistakes ?? [],
        notes: form.notes ?? null,
        lessons: form.lessons ?? null,
        would_take_again: form.would_take_again ?? null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase.from("journal_trade_meta").upsert(payload, { onConflict: "user_id,trade_key" });
      if (error) throw new Error(error.message);
      setMsg("Saved.");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const toggleArr = (field: "emotional_tags" | "mistakes", val: string) => {
    const arr = [...(form[field] ?? [])];
    const i = arr.indexOf(val);
    if (i >= 0) arr.splice(i, 1); else arr.push(val);
    setForm({ ...form, [field]: arr });
  };

  const chip = (field: "emotional_tags" | "mistakes", val: string) => {
    const active = (form[field] ?? []).includes(val);
    return (
      <button key={val} onClick={() => toggleArr(field, val)}
        style={{
          padding: "4px 10px", borderRadius: 20, fontSize: 12, cursor: "pointer",
          background: active ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.05)",
          border: active ? "1px solid rgba(16,185,129,0.5)" : "1px solid rgba(255,255,255,0.1)",
          color: active ? "#34d399" : "var(--muted)",
        }}>{val}</button>
    );
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{displayTicker} <span className="hint">· {displayDate} · {displayDir}</span> <SourceBadge source={isReal ? "real" : drInfo ? "daily_replay" : "simulator"} />{drInfo?.strategyLabel && <span className="hint" style={{ fontSize: 12, marginLeft: 6 }}>{drInfo.strategyLabel}</span>}</h3>
          <span className="num" style={{ fontSize: 22, fontWeight: 700, color: displayPnl > 0 ? "var(--emerald-bright)" : displayPnl < 0 ? "#f6465d" : "var(--muted)" }}>
            {fmtPnl(displayPnl)}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, fontSize: 13 }}>
          <div><span className="hint">Avg Entry</span><div className="num">{displayEntry != null ? `$${displayEntry.toFixed(2)}` : "—"}</div></div>
          <div><span className="hint">Qty</span><div className="num">{displayQty}</div></div>
          <div><span className="hint">R-multiple</span><div className="num">{displayR != null ? displayR.toFixed(2) : "—"}</div></div>
          {isReal && (
            <>
              <div><span className="hint">Broker</span><div>{realTrade!.broker ?? "—"}</div></div>
              <div><span className="hint">Fees</span><div className="num">{fmtPnl(-realTrade!.calc.totalFees)}</div></div>
              <div><span className="hint">Gross P&L</span><div className="num">{fmtPnl(realTrade!.calc.grossRealized)}</div></div>
            </>
          )}
          {!isReal && <div><span className="hint">Fills</span><div className="num">{simTrade!.fills.length}</div></div>}
        </div>
        {isReal && realTrade!.fills.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Fills</div>
            {realTrade!.fills.map((f) => (
              <div key={f.id} style={{ display: "flex", gap: 12, fontSize: 13, padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <span style={{ color: f.side === "buy" ? "var(--emerald-bright)" : "#f6465d", fontWeight: 600, textTransform: "uppercase", width: 36 }}>{f.side}</span>
                <span className="num">{f.qty} @ ${Number(f.price).toFixed(2)}</span>
                {f.fees > 0 && <span className="hint">fees ${Number(f.fees).toFixed(2)}</span>}
                {f.fill_time && <span className="hint">{new Date(f.fill_time).toLocaleTimeString()}</span>}
              </div>
            ))}
          </div>
        )}
        {!isReal && simTrade!.sessionId && (
          <p style={{ marginTop: 12 }}><Link href={`/replay?session=${simTrade!.sessionId}`} style={{ fontSize: 13 }}>↩ Open replay session</Link></p>
        )}
        {(parseKeyLevels(form.key_levels).length > 0 || form.original_stop_loss != null || form.original_target != null) && (
          <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Key Levels &amp; Plan</div>
            {parseKeyLevels(form.key_levels).map((l, i) => (
              <div key={i} style={{ fontSize: 13, padding: "3px 0" }}>
                <b className="num">${l.price}</b> · {l.type}{l.interaction ? ` · ${l.interaction}` : ""}
                {l.notes ? <span className="hint"> — {l.notes}</span> : null}
              </div>
            ))}
            {(form.original_stop_loss != null || form.original_target != null) && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                <span className="hint">Original plan:</span> stop {form.original_stop_loss != null ? `$${form.original_stop_loss}` : "—"} · target {form.original_target != null ? `$${form.original_target}` : "—"}
                {(form.plan_history?.length ?? 0) > 0 && (
                  <div className="hint" style={{ marginTop: 4 }}>
                    {form.plan_history!.map((c, i) => (
                      <div key={i}>{new Date(c.at).toLocaleDateString()} — {c.field === "stop_loss" ? "Stop" : "Target"} changed {c.from != null ? `$${c.from}` : "—"} → {c.to != null ? `$${c.to}` : "—"}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {isReal && (
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="btn" onClick={() => onEditReal?.(tradeKeyVal)}>Edit trade</button>
            <button className="btn" onClick={() => onDeleteReal?.(tradeKeyVal)}
              style={{ color: "#f6465d", borderColor: "rgba(246,70,93,0.4)" }}>Delete trade</button>
          </div>
        )}
      </div>

      {(isReal || drInfo) && <ReviewScreenshots tradeKey={tradeKeyVal} extraTradeKey={drDraftKey && drDraftKey !== tradeKeyVal ? drDraftKey : null} drDraftKey={drInfo ? drDraftKey : null} drAutoCapture={drInfo ? drAutoCapture : null} />}

      {drInfo && <DrAttemptCard info={drInfo} tradeKeyVal={tradeKeyVal} />}

      <div className="card" style={{ padding: 16 }}>
        <h4 style={{ margin: "0 0 12px" }}>Trade DNA</h4>
        <div style={{ display: "grid", gap: 12 }}>
          <div className="field">
            <label>Setup</label>
            <select className="input" value={form.setup_tag ?? ""} onChange={(e) => setForm({ ...form, setup_tag: e.target.value || null })}>
              <option value="">— Select —</option>
              {SETUPS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label>HOD Classification</label>
              <select className="input" value={form.hod_class ?? ""} onChange={(e) => setForm({ ...form, hod_class: e.target.value || null })}>
                <option value="">—</option>
                {HOD_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Execution Grade</label>
              <select className="input" value={form.exec_grade ?? ""} onChange={(e) => setForm({ ...form, exec_grade: e.target.value || null })}>
                <option value="">—</option>
                {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Why did I enter?</label>
            <textarea className="input" rows={2} value={form.entry_reasoning ?? ""} onChange={(e) => setForm({ ...form, entry_reasoning: e.target.value })} />
          </div>
          <div className="field">
            <label>Why did I exit?</label>
            <textarea className="input" rows={2} value={form.exit_reasoning ?? ""} onChange={(e) => setForm({ ...form, exit_reasoning: e.target.value })} />
          </div>
          <div className="field">
            <label>What did I learn?</label>
            <textarea className="input" rows={2} value={form.lessons ?? ""} onChange={(e) => setForm({ ...form, lessons: e.target.value })} />
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h4 style={{ margin: "0 0 12px" }}>Psychology</h4>
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Emotional state</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{EMOTIONS.map((e) => chip("emotional_tags", e))}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Mistakes</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{MISTAKES.map((e) => chip("mistakes", e))}</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label>Confidence (1–10)</label>
              <input className="input num" type="number" min={1} max={10} value={form.confidence ?? ""} onChange={(e) => setForm({ ...form, confidence: e.target.value ? Number(e.target.value) : null })} />
            </div>
            <div className="field">
              <label>Followed plan?</label>
              <select className="input" value={form.followed_plan == null ? "" : form.followed_plan ? "yes" : "no"} onChange={(e) => setForm({ ...form, followed_plan: e.target.value === "" ? null : e.target.value === "yes" })}>
                <option value="">—</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>Notes</label>
            <textarea className="input" rows={3} value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
      </div>

      <div>
        <button className="btn primary big" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Review"}</button>
        {msg && <span style={{ marginLeft: 12, fontSize: 13, color: msg === "Saved." ? "var(--emerald-bright)" : "#f6465d" }}>{msg}</span>}
      </div>
    </div>
  );
}

/* ---------------- Broker CSV Import ---------------- */
function BrokerImportForm({ onSaved }: { onSaved: () => void }) {
  const [parseResult, setParseResult] = useState<BrokerParseResult | null>(null);
  const [previewTrades, setPreviewTrades] = useState<ImportedTrade[]>([]);
  const [duplicates, setDuplicates] = useState<number>(0);
  const [existingHashes, setExistingHashes] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [rawText, setRawText] = useState("");
  const [showMapping, setShowMapping] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [brokerName, setBrokerName] = useState("My Broker");
  const fileRef = useRef<HTMLInputElement>(null);

  const requiredMapped = ["symbol", "side", "qty", "price"].every((k) => mapping[k]);

  const checkDuplicates = async (fills: { hash: string }[]) => {
    if (fills.length === 0) { setDuplicates(0); setExistingHashes(new Set()); return; }
    const supabase = createClient();
    const hashes = fills.map((x) => x.hash);
    const existing = new Set<string>();
    for (let i = 0; i < hashes.length; i += 100) {
      const chunk = hashes.slice(i, i + 100);
      const { data } = await supabase.from("journal_real_fills").select("import_hash").in("import_hash", chunk);
      for (const row of data ?? []) existing.add(row.import_hash);
    }
    setExistingHashes(existing);
    setDuplicates(existing.size);
  };

  const handleFile = async (f: File) => {
    setMsg(null); setShowMapping(false);
    setExistingHashes(new Set()); setDuplicates(0);
    try {
      const text = await f.text();
      setRawText(text);
      const result = parseBrokerCsv(text);
      setFileName(f.name);

      // If Webull auto-detect worked with fills, use it directly
      if (result.broker === "Webull" && result.fills.length > 0) {
        setParseResult(result);
        setPreviewTrades(groupImportedFills(result.fills));
        checkDuplicates(result.fills);
      } else {
        // Unknown format → show column mapping
        const autoMap = autoMapColumns(result.headers);
        setMapping(autoMap);
        setParseResult(result);
        setShowMapping(true);
        // Preview with auto-map if all required fields found
        if (["symbol", "side", "qty", "price"].every((k) => autoMap[k])) {
          applyMapping(text, autoMap, result.headers);
        }
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not parse CSV.");
    }
  };

  const applyMapping = (text: string, map: Record<string, string>, headers: string[]) => {
    const result = parseWithMapping(text, map, null, brokerName || "My Broker");
    // Keep original headers for the mapping UI
    setParseResult({ ...result, headers });
    setPreviewTrades(groupImportedFills(result.fills));
    checkDuplicates(result.fills);
  };

  const onMappingChange = (field: string, header: string) => {
    const newMap = { ...mapping, [field]: header };
    setMapping(newMap);
    if (["symbol", "side", "qty", "price"].every((k) => newMap[k])) {
      applyMapping(rawText, newMap, parseResult?.headers ?? []);
    }
  };

  const doImport = async () => {
    if (!parseResult || previewTrades.length === 0) return;
    setImporting(true); setMsg(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");

      let imported = 0, skipped = 0;
      for (const t of previewTrades) {
        // Filter out already-imported fills using the pre-fetched hash set.
        // Only skip the trade when ALL fills are duplicates; otherwise
        // import the new fills so partial re-imports don't lose data.
        const newFills = t.fills.filter((f) => f.hash && !existingHashes.has(f.hash));
        if (newFills.length === 0) { skipped++; continue; }

        const { data: trade, error: tErr } = await supabase.from("journal_real_trades").insert({
          user_id: user.id,
          ticker: t.ticker,
          broker: parseResult.broker,
          trade_date: t.tradeDate,
          direction: t.direction,
          strategy: "Imported",
        }).select("id").single();
        if (tErr) throw new Error(tErr.message);

        const fillRows = newFills.map((f) => ({
          trade_id: trade.id,
          user_id: user.id,
          side: f.side,
          qty: f.qty,
          price: f.price,
          fees: f.fees,
          fill_time: f.fillTime,
          import_hash: f.hash,
        }));
        const { error: fErr } = await supabase.from("journal_real_fills").insert(fillRows);
        if (fErr) {
          // If unique violation on import_hash, count as skipped
          if (fErr.message.includes("duplicate") || fErr.code === "23505") {
            await supabase.from("journal_real_trades").delete().eq("id", trade.id);
            skipped++;
            continue;
          }
          throw new Error(fErr.message);
        }
        imported++;
      }
      setMsg(`Imported ${imported} trades. ${skipped} skipped as duplicates.`);
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <h4 style={{ margin: "0 0 4px" }}>Import from Broker</h4>
      <p className="hint" style={{ margin: "0 0 12px" }}>
        Export your order history from your broker and upload the CSV.
        Webull is auto-detected — other brokers get a column mapping step.
        Only filled orders are imported. Duplicates are automatically skipped.
      </p>
      <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      <button className="btn" onClick={() => fileRef.current?.click()}>Choose CSV file</button>
      {fileName && <span className="hint" style={{ marginLeft: 12 }}>{fileName}</span>}

      {showMapping && parseResult && (
        <div className="card" style={{ padding: 12, marginTop: 16, marginBottom: 16, background: "rgba(96,165,250,0.04)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Map your broker's columns</div>
          <p className="hint" style={{ margin: "0 0 12px" }}>Match each field to the correct column in your CSV.</p>
          <div className="field" style={{ marginBottom: 12, maxWidth: 280 }}>
            <label>Broker name</label>
            <input className="input" value={brokerName} onChange={(e) => { setBrokerName(e.target.value); if (requiredMapped) applyMapping(rawText, mapping, parseResult.headers); }} placeholder="e.g. Interactive Brokers" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
            {MAPPABLE_FIELDS.map((field) => (
              <div className="field" key={field.key} style={{ marginBottom: 0 }}>
                <label>{field.label}</label>
                <select className="input" value={mapping[field.key] ?? ""} onChange={(e) => onMappingChange(field.key, e.target.value)}>
                  <option value="">— Select column —</option>
                  {parseResult.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {!requiredMapped && (
            <p className="hint" style={{ marginTop: 10, color: "#fbbf24" }}>Map at least Symbol, Side, Quantity, and Price to continue.</p>
          )}
        </div>
      )}

      {parseResult && (previewTrades.length > 0 || !showMapping) && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, marginBottom: 12 }}>
            <span>Detected: <b>{parseResult.broker}</b></span>
            <span>Fills: <b className="num">{parseResult.fills.length}</b></span>
            <span>Trades: <b className="num">{previewTrades.length}</b></span>
            {duplicates > 0 && <span style={{ color: "#fbbf24" }}>{duplicates} duplicate fills will be skipped</span>}
            {parseResult.rejected.length > 0 && <span style={{ color: "#f6465d" }}>{parseResult.rejected.length} rows rejected</span>}
          </div>

          {previewTrades.length > 0 && (
            <div style={{ maxHeight: 240, overflowY: "auto", marginBottom: 12, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                    <th style={{ padding: "8px 10px", color: "var(--muted)" }}>Ticker</th>
                    <th style={{ padding: "8px 10px", color: "var(--muted)" }}>Date</th>
                    <th style={{ padding: "8px 10px", color: "var(--muted)" }}>Dir</th>
                    <th style={{ padding: "8px 10px", color: "var(--muted)" }}>Fills</th>
                  </tr>
                </thead>
                <tbody>
                  {previewTrades.slice(0, 50).map((t, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      <td style={{ padding: "6px 10px", fontWeight: 600 }}>{t.ticker}</td>
                      <td style={{ padding: "6px 10px" }}>{t.tradeDate}</td>
                      <td style={{ padding: "6px 10px" }}>{t.direction}</td>
                      <td style={{ padding: "6px 10px" }} className="num">{t.fills.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {previewTrades.length > 50 && <p className="hint" style={{ padding: 8 }}>…and {previewTrades.length - 50} more</p>}
            </div>
          )}

          {parseResult.rejected.length > 0 && (
            <details style={{ marginBottom: 12, fontSize: 12 }}>
              <summary style={{ cursor: "pointer", color: "var(--muted)" }}>Rejected rows ({parseResult.rejected.length})</summary>
              {parseResult.rejected.slice(0, 20).map((r, i) => (
                <div key={i} className="hint">Row {r.row}: {r.reason}</div>
              ))}
            </details>
          )}

          <button className="btn primary big" onClick={doImport} disabled={importing || previewTrades.length === 0}>
            {importing ? "Importing…" : `Import ${previewTrades.length} trades`}
          </button>
        </div>
      )}
      {msg && <p style={{ marginTop: 12, fontSize: 13 }}>{msg}</p>}
    </div>
  );
}

/* ---------------- Real Trade Form ---------------- */
/** ISO timestamp → local "HH:MM" for the fill time inputs (edit prefill). */
function fillTimeToInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * FillTimePicker — hour / minute / AM-PM selects that produce the same
 * "HH:MM" 24-hour string the form has always stored (storage format and
 * timezone conventions unchanged). Replaces the native time input,
 * whose segmented keyboard entry was confusing. Empty = no time.
 */
function FillTimePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  const h24 = m ? Number(m[1]) : null;
  const min = m ? Number(m[2]) : null;
  const period = h24 != null && h24 >= 12 ? "PM" : "AM";
  const h12 = h24 == null ? "" : String(h24 % 12 === 0 ? 12 : h24 % 12);
  const emit = (h12v: string, minv: number | null, per: string) => {
    if (!h12v) { onChange(""); return; }
    let h = Number(h12v) % 12;
    if (per === "PM") h += 12;
    onChange(`${String(h).padStart(2, "0")}:${String(minv ?? 0).padStart(2, "0")}`);
  };
  const selStyle = { width: "auto", flex: "0 0 auto", padding: "8px 6px" };
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <select className="input" style={selStyle} aria-label="Hour" value={h12}
        onChange={(e) => emit(e.target.value, min, period)}>
        <option value="">––</option>
        {Array.from({ length: 12 }, (_, i) => String(i + 1)).map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <span style={{ color: "var(--muted)" }}>:</span>
      <select className="input" style={selStyle} aria-label="Minute" value={min == null ? "" : String(min).padStart(2, "0")}
        onChange={(e) => emit(h12 || "9", e.target.value === "" ? null : Number(e.target.value), period)}>
        <option value="">––</option>
        {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((mm) => <option key={mm} value={mm}>{mm}</option>)}
      </select>
      <div style={{ display: "flex", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, overflow: "hidden" }}>
        {(["AM", "PM"] as const).map((pp) => (
          <button key={pp} type="button" onClick={() => emit(h12 || "9", min, pp)}
            style={{ padding: "7px 8px", fontSize: 12, cursor: "pointer", border: "none",
              background: h24 != null && period === pp ? "rgba(16,185,129,0.25)" : "transparent",
              color: h24 != null && period === pp ? "#34d399" : "var(--muted)" }}>{pp}</button>
        ))}
      </div>
      {value && (
        <button type="button" title="Clear time" onClick={() => onChange("")}
          style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: 2 }}>×</button>
      )}
    </div>
  );
}

function RealTradeForm({ onSaved, editing, onCancel }: {
  /** Called after a successful save; `notice` carries non-fatal issues
   *  (e.g. screenshot upload failures) for the page to surface. */
  onSaved: (notice?: string) => void;
  editing?: { trade: RealTrade; meta: TradeMeta | null } | null;
  onCancel?: () => void;
}) {
  const et = editing?.trade ?? null;
  const em = editing?.meta ?? null;
  const [ticker, setTicker] = useState(et?.ticker ?? "");
  const [company, setCompany] = useState(et?.company_name ?? "");
  const [broker, setBroker] = useState(et?.broker ?? "Webull");
  const [date, setDate] = useState(et?.trade_date ?? new Date().toISOString().slice(0, 10));
  const [direction, setDirection] = useState<"long" | "short">(et?.direction ?? "long");
  const [strategy, setStrategy] = useState(et?.strategy ?? "");
  // Fills: edit mode prefills from the saved fills; add mode starts with
  // one blank entry fill
  const [fills, setFills] = useState<{ side: "buy" | "sell"; qty: string; price: string; fees: string; time: string }[]>(() =>
    et && et.fills.length > 0
      ? et.fills.map((f) => ({
          side: f.side,
          qty: String(f.qty),
          price: String(f.price),
          fees: String(f.fees ?? 0),
          time: fillTimeToInput(f.fill_time),
        }))
      : [{ side: "buy", qty: "", price: "", fees: "", time: "" }],
  );
  const [stopLoss, setStopLoss] = useState(et?.stop_loss != null ? String(et.stop_loss) : "");
  const [target, setTarget] = useState(et?.target != null ? String(et.target) : "");
  const [floatShares, setFloatShares] = useState(et?.float_shares != null ? String(et.float_shares) : "");
  const [rvol, setRvol] = useState(et?.relative_volume != null ? String(et.relative_volume) : "");
  const [marketCond, setMarketCond] = useState(et?.market_conditions ?? "");
  const [l2tas, setL2Tas] = useState(et?.level2_tas_notes ?? "");
  const [setup, setSetup] = useState(em?.setup_tag ?? "");
  const [hodClass, setHodClass] = useState(em?.hod_class ?? "");
  const [grade, setGrade] = useState(em?.exec_grade ?? "");
  const [entryReason, setEntryReason] = useState(em?.entry_reasoning ?? "");
  const [notes, setNotes] = useState(em?.notes ?? "");
  const [lessons, setLessons] = useState(em?.lessons ?? "");
  const [emotions, setEmotions] = useState<string[]>(em?.emotional_tags ?? []);
  const [mistakes, setMistakes] = useState<string[]>(em?.mistakes ?? []);
  // Key levels & trade context (Trade DNA) — stored on meta as jsonb
  const [levels, setLevels] = useState<{ price: string; type: string; interaction: string; notes: string }[]>(() =>
    parseKeyLevels(em?.key_levels).map((l) => ({
      price: String(l.price), type: l.type, interaction: l.interaction ?? "", notes: l.notes ?? "",
    })),
  );
  const updateLevel = (i: number, k: string, v: string) =>
    setLevels(levels.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const levelsError = validateKeyLevels(levels);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Screenshots: newly staged files (object-URL previews), screenshots
  // already saved for the trade being edited, and saved ones the user
  // marked for removal (deletion is applied on save)
  const [staged, setStaged] = useState<{ file: File; url: string }[]>([]);
  const [stageError, setStageError] = useState<string | null>(null);
  const [existingShots, setExistingShots] = useState<{ path: string; url: string }[]>([]);
  const [removedPaths, setRemovedPaths] = useState<string[]>([]);
  const shotInputRef = useRef<HTMLInputElement>(null);

  // Edit mode: load the trade's saved screenshots for display/removal
  useEffect(() => {
    if (!et) return;
    let alive = true;
    (async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !alive) return;
      const list = await listScreenshots(supabase, user.id, `real:${et.id}`);
      if (alive) setExistingShots(list);
    })();
    return () => { alive = false; };
    // Mount-only: the page remounts this form per edit target (key prop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stageFiles = (list: FileList | null) => {
    if (!list) return;
    const errs: string[] = [];
    const next: { file: File; url: string }[] = [];
    for (const file of Array.from(list)) {
      const invalid = validateScreenshotFile(file);
      if (invalid) { errs.push(invalid); continue; }
      next.push({ file, url: URL.createObjectURL(file) });
    }
    if (next.length > 0) setStaged((s) => [...s, ...next]);
    setStageError(errs.length > 0 ? errs.join(" ") : null);
  };
  const unstage = (idx: number) =>
    setStaged((s) => {
      const copy = [...s];
      const [rm] = copy.splice(idx, 1);
      if (rm) URL.revokeObjectURL(rm.url);
      return copy;
    });
  const removeExisting = (path: string) => {
    setExistingShots((s) => s.filter((x) => x.path !== path));
    setRemovedPaths((r) => [...r, path]);
  };

  const addFill = (side: "buy" | "sell") =>
    setFills([...fills, { side, qty: "", price: "", fees: "", time: "" }]);
  const updateFill = (i: number, k: string, v: string) =>
    setFills(fills.map((f, j) => (j === i ? { ...f, [k]: v } : f)));
  const removeFill = (i: number) => setFills(fills.filter((_, j) => j !== i));

  const toggle = (arr: string[], set: (v: string[]) => void, val: string) =>
    set(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);

  // Live preview of calculations
  const previewFills: RealFill[] = fills
    .map((f, row) => ({ f, row }))
    .filter(({ f }) => f.qty && f.price)
    .map(({ f, row }) => ({ id: `row${row}`, side: f.side, qty: Number(f.qty), price: Number(f.price), fees: Number(f.fees || 0), fill_time: f.time || null }));
  // Realized P&L per exit fill (FIFO, reconciles with the totals below)
  const exitPnlByRow = new Map(perExitPnl(previewFills, direction).map((x) => [x.fillId, x]));
  // Row captions: initial vs partial entries, exits vs partial exits
  const isEntrySide = (s: "buy" | "sell") => (direction === "long" ? s === "buy" : s === "sell");
  let entrySeen = 0, exitSeen = 0;
  const rowCaptions = fills.map((f) =>
    isEntrySide(f.side)
      ? (++entrySeen === 1 ? "Initial entry" : "Partial entry")
      : (++exitSeen === 1 ? "Exit" : "Partial exit"));
  const preview = previewFills.length > 0
    ? calcRealTrade(previewFills, direction, stopLoss ? Number(stopLoss) : null, target ? Number(target) : null)
    : null;
  // Same validation at save time and live: an invalid fill set (e.g.
  // exits beyond the position size) blocks saving instead of silently
  // writing bad accounting.
  const fillsError = previewFills.length > 0 ? validateRealFills(direction, previewFills) : null;

  const save = async () => {
    if (!ticker.trim()) { setMsg("Ticker is required."); return; }
    if (previewFills.length === 0) { setMsg("Add at least one fill with quantity and price."); return; }
    if (fillsError) { setMsg(fillsError); return; }
    if (levelsError) { setMsg(levelsError); return; }
    setSaving(true); setMsg(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");

      const tradeFields = {
        ticker: ticker.trim().toUpperCase(),
        company_name: company.trim() || null,
        broker: broker.trim() || null,
        trade_date: date,
        direction,
        strategy: strategy.trim() || null,
        stop_loss: stopLoss ? Number(stopLoss) : null,
        target: target ? Number(target) : null,
        float_shares: floatShares ? Number(floatShares) : null,
        relative_volume: rvol ? Number(rvol) : null,
        market_conditions: marketCond.trim() || null,
        level2_tas_notes: l2tas.trim() || null,
      };

      let tradeId: string;
      if (et) {
        // Edit: update the existing record in place — never a duplicate
        const { error: uErr } = await supabase.from("journal_real_trades")
          .update(tradeFields)
          .eq("id", et.id)
          .eq("user_id", user.id);
        if (uErr) throw new Error(uErr.message);
        tradeId = et.id;
        const { error: dErr } = await supabase.from("journal_real_fills")
          .delete()
          .eq("trade_id", tradeId)
          .eq("user_id", user.id);
        if (dErr) throw new Error(dErr.message);
      } else {
        const { data: trade, error: tErr } = await supabase.from("journal_real_trades").insert({
          user_id: user.id,
          ...tradeFields,
        }).select("id").single();
        if (tErr) throw new Error(tErr.message);
        tradeId = trade.id;
      }

      const fillRows = previewFills.map((f) => ({
        trade_id: tradeId,
        user_id: user.id,
        side: f.side,
        qty: f.qty,
        price: f.price,
        fees: f.fees,
        fill_time: f.fill_time ? new Date(`${date}T${f.fill_time}`).toISOString() : null,
        note: null,
      }));
      const { error: fErr } = await supabase.from("journal_real_fills").insert(fillRows);
      if (fErr) throw new Error(fErr.message);

      // Plan preservation + key levels (Trade DNA): originals are
      // set-once, stop/target changes append to plan_history, and R
      // downstream is computed from the ORIGINAL plan (see loader).
      const planState = computePlanUpdate(
        em ? { original_stop_loss: em.original_stop_loss ?? null, original_target: em.original_target ?? null, plan_history: em.plan_history ?? [] } : null,
        et?.stop_loss ?? null, et?.target ?? null,
        stopLoss ? Number(stopLoss) : null, target ? Number(target) : null,
        new Date().toISOString(),
      );
      const keyLevels = parseKeyLevels(
        levels
          .filter((l) => l.price.trim() || l.type.trim())
          .map((l) => ({ price: Number(l.price), type: l.type, interaction: l.interaction || null, notes: l.notes.trim() || null })),
      );

      // Save Trade DNA annotations via shared meta table
      const tradeKey = `real:${tradeId}`;
      const { error: mErr } = await supabase.from("journal_trade_meta").upsert({
        user_id: user.id,
        session_id: null,
        trade_key: tradeKey,
        setup_tag: setup || null,
        hod_class: hodClass || null,
        exec_grade: grade || null,
        entry_reasoning: entryReason.trim() || null,
        emotional_tags: emotions,
        mistakes,
        notes: notes.trim() || null,
        lessons: lessons.trim() || null,
        key_levels: keyLevels,
        original_stop_loss: planState.original_stop_loss,
        original_target: planState.original_target,
        plan_history: planState.plan_history,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,trade_key" });
      if (mErr) throw new Error(mErr.message);

      // Screenshots last: a storage failure must not fail the trade
      // save — failures are reported back as a page notice instead.
      const attachErrors: string[] = [];
      if (staged.length > 0) {
        const res = await uploadScreenshots(supabase, user.id, tradeKey, staged.map((s) => s.file));
        attachErrors.push(...res.errors);
      }
      if (removedPaths.length > 0) {
        await removeScreenshots(supabase, removedPaths);
      }
      const attachNote = attachErrors.length > 0
        ? `Trade saved, but ${attachErrors.length} screenshot${attachErrors.length === 1 ? "" : "s"} failed to upload — ${attachErrors.join("; ")} — re-add via Edit.`
        : undefined;

      setMsg("Saved.");
      onSaved(attachNote);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const chip = (arr: string[], set: (v: string[]) => void, val: string, options: string[]) =>
    options.map((o) => {
      const active = arr.includes(o);
      return (
        <button key={o} type="button" onClick={() => toggle(arr, set, o)}
          style={{
            padding: "4px 10px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: active ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.05)",
            border: active ? "1px solid rgba(16,185,129,0.5)" : "1px solid rgba(255,255,255,0.1)",
            color: active ? "#34d399" : "var(--muted)",
          }}>{o}</button>
      );
    });

  const field = { marginBottom: 0 };

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <h4 style={{ margin: "0 0 4px" }}>{et ? "Edit Real Trade" : "Add Real Trade"}</h4>
      <p className="hint" style={{ margin: "0 0 16px" }}>
        {et
          ? "Editing updates this trade in place — P&L, R and analytics recalculate from the saved fills."
          : "From your broker — never touches the simulator."}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div className="field" style={field}><label>Ticker *</label><input className="input mono" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AAPL" /></div>
        <div className="field" style={field}><label>Company</label><input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="—" /></div>
        <div className="field" style={field}><label>Broker</label><input className="input" value={broker} onChange={(e) => setBroker(e.target.value)} /></div>
        <div className="field" style={field}><label>Date *</label><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="field" style={field}><label>Direction</label><select className="input" value={direction} onChange={(e) => setDirection(e.target.value as "long" | "short")}><option value="long">Long</option><option value="short">Short</option></select></div>
        <div className="field" style={field}><label>Strategy</label><input className="input" value={strategy} onChange={(e) => setStrategy(e.target.value)} placeholder="HOD breakout…" /></div>
      </div>

      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Fills <span className="hint">(multiple entries & partial exits)</span></div>
      {fills.map((f, i) => (
        <div key={i} className="fill-row" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10, alignItems: "end" }}>
          <div style={{ flex: "1 0 100%", fontSize: 11, color: "var(--muted)", display: "flex", gap: 10, alignItems: "baseline" }}>
            <span style={{ fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>{rowCaptions[i]}</span>
            {exitPnlByRow.get(`row${i}`) && (
              <span>realized on this exit{" "}
                <b className="num" style={{ color: (exitPnlByRow.get(`row${i}`)?.grossPnl ?? 0) >= 0 ? "var(--emerald-bright)" : "#f6465d" }}>
                  {fmtPnl(exitPnlByRow.get(`row${i}`)?.grossPnl ?? 0)}
                </b>{" "}(before fees)
              </span>
            )}
          </div>
          <div className="field" style={{ ...field, flex: "0 0 76px" }}><label>Side</label>
            <select className="input" value={f.side} onChange={(e) => updateFill(i, "side", e.target.value)}>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select></div>
          <div className="field" style={{ ...field, flex: "1 1 84px" }}><label>Qty *</label><input className="input num" type="number" step="any" value={f.qty} onChange={(e) => updateFill(i, "qty", e.target.value)} /></div>
          <div className="field" style={{ ...field, flex: "1 1 84px" }}><label>Price *</label><input className="input num" type="number" step="any" value={f.price} onChange={(e) => updateFill(i, "price", e.target.value)} /></div>
          <div className="field" style={{ ...field, flex: "1 1 84px" }}><label>Fees $</label><input className="input num" type="number" step="any" value={f.fees} onChange={(e) => updateFill(i, "fees", e.target.value)} placeholder="0" /></div>
          <div className="field" style={{ ...field, flex: "0 1 auto" }}><label>Time</label>
            <FillTimePicker value={f.time} onChange={(v) => updateFill(i, "time", v)} /></div>
          <button className="btn" onClick={() => removeFill(i)} disabled={fills.length === 1} style={{ height: 38 }}>×</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" onClick={() => addFill(direction === "long" ? "buy" : "sell")}>+ Add Partial Entry</button>
        <button className="btn" onClick={() => addFill(direction === "long" ? "sell" : "buy")}>+ Add Partial Exit</button>
        <span className="hint">Each adds another fill to this same trade — partial entries and exits stay grouped as one trade.</span>
      </div>

      {preview && (
        <div className="card" style={{ padding: 12, marginBottom: 16, background: "rgba(16,185,129,0.04)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Live Preview</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            <span>Avg entry <b className="num">{preview.avgEntry != null ? `$${preview.avgEntry.toFixed(2)}` : "—"}</b></span>
            <span>Avg exit <b className="num">{preview.avgExit != null ? `$${preview.avgExit.toFixed(2)}` : "—"}</b></span>
            <span>Gross <b className="num" style={{ color: preview.grossRealized >= 0 ? "var(--emerald-bright)" : "#f6465d" }}>{fmtPnl(preview.grossRealized)}</b></span>
            <span>Fees <b className="num">{fmtPnl(-preview.totalFees)}</b></span>
            <span>Net <b className="num" style={{ color: preview.netRealized >= 0 ? "var(--emerald-bright)" : "#f6465d" }}>{fmtPnl(preview.netRealized)}</b></span>
            {preview.openQty > 0 && <span style={{ color: "#fbbf24" }}>Open: {preview.openQty} shares</span>}
            {preview.rMultiple != null && <span>R <b className="num">{preview.rMultiple.toFixed(2)}</b></span>}
          </div>
          {fillsError && <div style={{ color: "#f6465d", fontSize: 12, marginTop: 8 }}>{fillsError}</div>}
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
          Screenshots <span className="hint">(optional — stored permanently with this trade)</span>
        </div>
        <input ref={shotInputRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={(e) => { stageFiles(e.target.files); e.target.value = ""; }} />
        <button className="btn" type="button" onClick={() => shotInputRef.current?.click()}>📎 Attach Screenshot</button>
        <span className="hint" style={{ marginLeft: 10 }}>PNG, JPEG, WebP or GIF, up to 5 MB each</span>
        {stageError && <p style={{ color: "#f6465d", fontSize: 12, margin: "8px 0 0" }}>{stageError}</p>}
        {(existingShots.length > 0 || staged.length > 0) && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            {existingShots.map((s) => (
              <div key={s.path} style={{ position: "relative" }}>
                <img src={s.url} alt="Saved screenshot" style={{ height: 72, width: 108, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", display: "block" }} />
                <button type="button" title="Remove screenshot" onClick={() => removeExisting(s.path)}
                  style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.25)", background: "#1a2229", color: "#fff", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
              </div>
            ))}
            {staged.map((s, i) => (
              <div key={s.url} style={{ position: "relative" }}>
                <img src={s.url} alt="New screenshot" style={{ height: 72, width: 108, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(16,185,129,0.45)", display: "block" }} />
                <button type="button" title="Remove screenshot" onClick={() => unstage(i)}
                  style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.25)", background: "#1a2229", color: "#fff", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
        {removedPaths.length > 0 && (
          <p className="hint" style={{ margin: "8px 0 0" }}>
            {removedPaths.length} saved screenshot{removedPaths.length === 1 ? "" : "s"} will be removed when you save.
          </p>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div className="field" style={field}><label>Stop Loss</label><input className="input num" type="number" step="any" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} /></div>
        <div className="field" style={field}><label>Target</label><input className="input num" type="number" step="any" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
        <div className="field" style={field}><label>Float</label><input className="input num" type="number" step="any" value={floatShares} onChange={(e) => setFloatShares(e.target.value)} placeholder="—" /></div>
        <div className="field" style={field}><label>Rel Volume</label><input className="input num" type="number" step="any" value={rvol} onChange={(e) => setRvol(e.target.value)} placeholder="—" /></div>
        <div className="field" style={field}><label>Setup</label><select className="input" value={setup} onChange={(e) => setSetup(e.target.value)}><option value="">—</option>{SETUPS.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div className="field" style={field}><label>HOD Class</label><select className="input" value={hodClass} onChange={(e) => setHodClass(e.target.value)}><option value="">—</option>{HOD_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
        <div className="field" style={field}><label>Exec Grade</label><select className="input" value={grade} onChange={(e) => setGrade(e.target.value)}><option value="">—</option>{GRADES.map((g) => <option key={g} value={g}>{g}</option>)}</select></div>
      </div>

      {et && (em?.original_stop_loss != null || em?.original_target != null) && (
        <p className="hint" style={{ margin: "0 0 12px" }}>
          Original plan (preserved): stop {em?.original_stop_loss != null ? `$${em.original_stop_loss}` : "—"} · target {em?.original_target != null ? `$${em.original_target}` : "—"}
          {(em?.plan_history?.length ?? 0) > 0 && <> · {em?.plan_history?.length} plan change{(em?.plan_history?.length ?? 0) === 1 ? "" : "s"} recorded — R is calculated from the original plan</>}
        </p>
      )}
      {et && em?.original_stop_loss == null && em?.original_target == null && (et.stop_loss != null || et.target != null) && (
        <p className="hint" style={{ margin: "0 0 12px" }}>
          Plan history was not recorded for this trade (it pre-dates plan tracking). Saving now records the current stop/target as the original plan — nothing is back-filled or invented.
        </p>
      )}

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
          Key Levels &amp; Trade Context <span className="hint">(optional — the technical level this trade was built around; feeds Trade DNA review)</span>
        </div>
        {levels.map((l, i) => (
          <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "end" }}>
            <div className="field" style={{ ...field, flex: "1 1 110px" }}><label>Level price</label>
              <input className="input num" type="number" step="any" value={l.price} onChange={(e) => updateLevel(i, "price", e.target.value)} placeholder="4.20" /></div>
            <div className="field" style={{ ...field, flex: "1 1 170px" }}><label>Level type</label>
              <select className="input" value={l.type} onChange={(e) => updateLevel(i, "type", e.target.value)}>
                <option value="">Select level type…</option>
                {KEY_LEVEL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></div>
            <div className="field" style={{ ...field, flex: "1 1 170px" }}><label>Trade interaction</label>
              <select className="input" value={l.interaction} onChange={(e) => updateLevel(i, "interaction", e.target.value)}>
                <option value="">Select interaction…</option>
                {KEY_LEVEL_INTERACTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></div>
            <div className="field" style={{ ...field, flex: "2 1 220px" }}><label>Context notes</label>
              <input className="input" value={l.notes} onChange={(e) => updateLevel(i, "notes", e.target.value)} placeholder="What you expected at this level, confirmation you saw…" /></div>
            <button className="btn" type="button" title="Remove this level" onClick={() => setLevels(levels.filter((_, j) => j !== i))} style={{ height: 38 }}>×</button>
          </div>
        ))}
        <button className="btn" type="button" disabled={levels.length >= 5}
          onClick={() => setLevels([...levels, { price: "", type: "", interaction: "", notes: "" }])}>
          + Add Key Level
        </button>
        {levelsError && <p style={{ color: "#f6465d", fontSize: 12, margin: "8px 0 0" }}>{levelsError}</p>}
      </div>

      <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        <div className="field" style={field}><label>Entry reasoning</label><textarea className="input" rows={2} value={entryReason} onChange={(e) => setEntryReason(e.target.value)} /></div>
        <div className="field" style={field}><label>Market conditions</label><textarea className="input" rows={2} value={marketCond} onChange={(e) => setMarketCond(e.target.value)} placeholder="Spy trend, sector strength…" /></div>
        <div className="field" style={field}><label>Level 2 / Time & Sales notes</label><textarea className="input" rows={2} value={l2tas} onChange={(e) => setL2Tas(e.target.value)} placeholder="Bid stacking, large prints…" /></div>
        <div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Emotional state</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{chip(emotions, setEmotions, "", EMOTIONS)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Mistakes</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{chip(mistakes, setMistakes, "", MISTAKES)}</div>
        </div>
        <div className="field" style={field}><label>Notes</label><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div className="field" style={field}><label>Lessons learned</label><textarea className="input" rows={2} value={lessons} onChange={(e) => setLessons(e.target.value)} /></div>
      </div>

      <div>
        <button className="btn primary big" onClick={save} disabled={saving || !!fillsError}>
          {saving ? "Saving…" : et ? "Save Changes" : "Save Real Trade"}
        </button>
        {onCancel && (
          <button className="btn big" onClick={onCancel} disabled={saving} style={{ marginLeft: 8 }}>Cancel</button>
        )}
        {msg && <span style={{ marginLeft: 12, fontSize: 13 }}>{msg}</span>}
      </div>
    </div>
  );
}

/* ---------------- Calendar ---------------- */
function CalendarTab({ trades, metas, selectedDay, onSelectDay, onSelectTrade }: {
  trades: UnifiedTrade[];
  metas: Record<string, TradeMeta>;
  selectedDay: string | null;
  onSelectDay: (d: string) => void;
  onSelectTrade: (k: string) => void;
}) {
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const dayTrades = useMemo(
    () => (selectedDay ? trades.filter((t) => t.tradeDate === selectedDay) : []),
    [trades, selectedDay]
  );

  const byDay = useMemo(() => {
    const map: Record<string, { pnl: number; wins: number; losses: number }> = {};
    for (const t of trades) {
      const d = t.tradeDate;
      if (!map[d]) map[d] = { pnl: 0, wins: 0, losses: 0 };
      map[d].pnl += t.realizedPnl;
      if (t.realizedPnl > 0) map[d].wins++;
      else if (t.realizedPnl < 0) map[d].losses++;
    }
    return map;
  }, [trades]);

  const first = new Date(month.y, month.m, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(startPad).fill(null)];
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthName = first.toLocaleString("en-US", { month: "long", year: "numeric" });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button className="btn" onClick={() => setMonth(month.m === 0 ? { y: month.y - 1, m: 11 } : { y: month.y, m: month.m - 1 })}>←</button>
        <b>{monthName}</b>
        <button className="btn" onClick={() => setMonth(month.m === 11 ? { y: month.y + 1, m: 0 } : { y: month.y, m: month.m + 1 })}>→</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
          <div key={d} style={{ textAlign: "center", fontSize: 11, color: "var(--muted)", padding: 4 }}>{d}</div>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={i} />;
          const key = `${month.y}-${String(month.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const info = byDay[key];
          const isSelected = selectedDay === key;
          return (
            <div key={i} className="card"
              style={{
                padding: 8, minHeight: 64, cursor: info ? "pointer" : "default",
                background: info ? (info.pnl > 0 ? "rgba(16,185,129,0.08)" : info.pnl < 0 ? "rgba(246,70,93,0.08)" : undefined) : undefined,
                border: isSelected
                  ? "1px solid var(--emerald-bright)"
                  : info ? (info.pnl > 0 ? "1px solid rgba(16,185,129,0.25)" : info.pnl < 0 ? "1px solid rgba(246,70,93,0.25)" : undefined) : undefined,
              }}
              onClick={() => info && onSelectDay(key)}>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{d}</div>
              {info && <div className="num" style={{ fontSize: 13, fontWeight: 700, color: info.pnl > 0 ? "var(--emerald-bright)" : info.pnl < 0 ? "#f6465d" : "var(--muted)" }}>{fmtPnl(info.pnl)}</div>}
            </div>
          );
        })}
      </div>

      {selectedDay && (
        <div className="card" style={{ padding: 16, marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            {selectedDay} — {dayTrades.length} closed trade{dayTrades.length === 1 ? "" : "s"}
            {dayTrades.length > 0 && (
              <span className="num" style={{ marginLeft: 10, color: dayTrades.reduce((s, t) => s + t.realizedPnl, 0) > 0 ? "var(--emerald-bright)" : dayTrades.reduce((s, t) => s + t.realizedPnl, 0) < 0 ? "#f6465d" : "var(--muted)" }}>
                {fmtPnl(dayTrades.reduce((s, t) => s + t.realizedPnl, 0))}
              </span>
            )}
          </div>
          <p className="hint" style={{ margin: "0 0 8px" }}>Click a trade to open it in Trade Review.</p>
          {dayTrades.map((t) => (
            <div key={t.key} onClick={() => onSelectTrade(t.key)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.06)", cursor: "pointer" }}>
              <span>
                <b>{t.ticker}</b>{" "}
                <span className="hint">{t.direction} · {metas[t.key]?.setup_tag ?? "No setup tagged"}</span>{" "}
                <SourceBadge source={badgeSourceOf(t)} />
              </span>
              <span style={{ display: "flex", gap: 14, alignItems: "center" }}>
                <span className="hint num">{t.rMultiple != null ? `${t.rMultiple.toFixed(2)}R` : "—"}</span>
                <span className="num" style={{ fontWeight: 600, color: t.realizedPnl > 0 ? "var(--emerald-bright)" : t.realizedPnl < 0 ? "#f6465d" : "var(--muted)" }}>{fmtPnl(t.realizedPnl)}</span>
              </span>
            </div>
          ))}
          {dayTrades.length === 0 && <p className="hint" style={{ margin: 0 }}>No closed trades on this day in the current filter selection.</p>}
        </div>
      )}
    </div>
  );
}

/* ---------------- Analytics (Batch A) ---------------- */

const DIMENSION_OPTIONS: { key: BreakdownDimension; label: string }[] = [
  { key: "setup", label: "Setup" },
  { key: "symbol", label: "Symbol" },
  { key: "mistake", label: "Mistake" },
  { key: "emotion", label: "Emotion" },
  { key: "plan", label: "Plan Adherence" },
  { key: "session", label: "Session" },
  { key: "timeOfDay", label: "Time of Day" },
  { key: "hold", label: "Hold Time" },
  { key: "source", label: "Source" },
  { key: "side", label: "Side" },
  { key: "hodClass", label: "HOD Class" },
  { key: "keyLevel", label: "Key Level" },
  { key: "interaction", label: "Trade Interaction" },
  { key: "strategy", label: "Strategy" },
  { key: "strategyVersion", label: "Strategy Version" },
];

function fmtR(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(2)}R`;
}
function fmtHold(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  return `${(min / 60).toFixed(1)}h`;
}
function fmtPf(v: number | null): string {
  if (v == null) return "—";
  if (!isFinite(v)) return "∞";
  return v.toFixed(2);
}
function pnlColor(v: number): string {
  return v > 0 ? "var(--emerald-bright)" : v < 0 ? "#f6465d" : "var(--muted)";
}

function SmallSampleBadge() {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20,
      background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.45)", color: "#fbbf24",
    }}>Small sample — interpret with care</span>
  );
}

function InsightCard({ title, insight }: { title: string; insight: Insight }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--muted)", marginBottom: 6 }}>{title}</div>
      {insight.stat ? (
        <>
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>{insight.stat.label}</div>
          <div style={{ fontSize: 13, display: "grid", gap: 2 }}>
            <div>Net P&L <span className="num" style={{ fontWeight: 700, color: pnlColor(insight.stat.netPnl) }}>{fmtPnl(insight.stat.netPnl)}</span></div>
            <div className="hint">Expectancy <span className="num" style={{ color: "var(--foreground)" }}>{fmtPnl(insight.stat.expectancy ?? 0)}</span> · Avg R <span className="num" style={{ color: "var(--foreground)" }}>{fmtR(insight.stat.avgR)}</span> · Win rate <span className="num" style={{ color: "var(--foreground)" }}>{insight.stat.winRate == null ? "—" : fmtPct(insight.stat.winRate)}</span></div>
            <div className="hint">Based on {insight.sampleSize} trade{insight.sampleSize === 1 ? "" : "s"}</div>
          </div>
          {insight.smallSample && <div style={{ marginTop: 8 }}><SmallSampleBadge /></div>}
        </>
      ) : (
        <p className="hint" style={{ margin: 0 }}>{insight.reason ?? "No data."}</p>
      )}
    </div>
  );
}

function AnalyticsTab({ trades, onSelect, exportInput }: { trades: AnalyticsTrade[]; onSelect: (k: string) => void; exportInput?: ExportSnapshotInput }) {
  const [dim, setDim] = useState<BreakdownDimension>("setup");
  const [expanded, setExpanded] = useState<string | null>(null);
  // Breakdown-table scroll affordance: show a right-edge fade while more
  // columns remain off-screen to the right.
  const bdRef = useRef<HTMLDivElement | null>(null);
  const [bdMore, setBdMore] = useState(false);
  const updateBdMore = () => { const el = bdRef.current; setBdMore(!!el && el.scrollWidth - el.scrollLeft - el.clientWidth > 4); };

  const risk = useMemo(() => riskMetrics(trades), [trades]);
  const insights = useMemo(() => edgeInsights(trades), [trades]);
  const rows = useMemo(() => breakdown(trades, dim), [trades, dim]);
  const days = useMemo(() => dailyPnl(trades), [trades]);

  useEffect(() => { updateBdMore(); window.addEventListener("resize", updateBdMore); return () => window.removeEventListener("resize", updateBdMore); }, [rows, dim, trades]);

  if (trades.length === 0) {
    return (
      <div style={{ display: "grid", gap: 20 }}>
        {exportInput && <EdgeExportPanel input={exportInput} />}
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <p className="hint" style={{ margin: 0 }}>No data — analytics need closed trades in the current filter selection. Adjust the source/period filters above, or log and close some trades first.</p>
        </div>
      </div>
    );
  }

  const tile = (label: string, value: string, sub?: string, color?: string) => (
    <div key={label} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 14px" }}>
      <div className="hint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div className="num" style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: color ?? "var(--foreground)" }}>{value}</div>
      {sub && <div className="hint" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  // R-distribution chart geometry
  const rMax = Math.max(1, ...risk.rDistribution.map((b) => b.count));
  // Daily P&L chart geometry
  const dMax = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  const DW = 620, DH = 130, zeroY = DH / 2;
  const barW = days.length > 0 ? Math.max(2, Math.floor(DW / days.length) - 2) : 0;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {exportInput && <EdgeExportPanel input={exportInput} />}
      {/* ---- Risk & Consistency ---- */}
      <section style={{ minWidth: 0 }}>
        <h3 style={{ margin: "0 0 10px" }}>Risk &amp; Consistency</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
          {tile("Max Drawdown", risk.maxDrawdownUSD > 0 ? fmtPnl(-risk.maxDrawdownUSD) : fmtPnl(0), risk.maxDrawdownPct != null ? `${risk.maxDrawdownPct.toFixed(1)}% of peak cumulative P&L` : "of peak cumulative P&L", risk.maxDrawdownUSD > 0 ? "#f6465d" : undefined)}
          {tile("Average R", fmtR(risk.avgR), `over ${risk.tradesWithR} trades with a recorded stop`)}
          {tile("Win / Loss Ratio", risk.winLossRatio == null ? "—" : risk.winLossRatio.toFixed(2), "avg win ÷ avg loss")}
          {tile("Avg Risk / Trade", risk.avgRiskPerTrade == null ? "—" : fmtPnl(risk.avgRiskPerTrade), risk.avgRiskPerTrade == null ? "no stops recorded" : `over ${risk.tradesWithRisk} trades with known risk`)}
          {tile("Win Streak", `${risk.currentWinStreak} current`, `longest ${risk.maxWinStreak}`)}
          {tile("Loss Streak", `${risk.currentLossStreak} current`, `longest ${risk.maxLossStreak}`)}
          {tile("Losing Days", risk.losingDayFrequency == null ? "—" : fmtPct(risk.losingDayFrequency), `${risk.losingDays} of ${risk.tradingDays} trading days`)}
        </div>
        <p className="hint" style={{ margin: "8px 0 0" }}>Breakeven trades neither extend nor break a streak. Drawdown % is measured against the peak cumulative realized P&L (the journal has no account-equity baseline).</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", gap: 12, marginTop: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>R Distribution</div>
            {risk.tradesWithR === 0 ? (
              <p className="hint" style={{ margin: 0 }}>No data — R requires a recorded stop loss. Real trades with a stop get an R automatically; simulator trades need a stop recorded.</p>
            ) : (
              <svg viewBox={`0 0 320 140`} style={{ width: "100%" }}>
                {risk.rDistribution.map((b, i) => {
                  const bh = (b.count / rMax) * 84;
                  const x = 12 + i * 62;
                  return (
                    <g key={b.label}>
                      <rect x={x} y={104 - bh} width={44} height={bh} rx={3} fill={i < 2 ? "#f6465d" : i === 2 ? "rgba(255,255,255,0.35)" : "var(--emerald)"} opacity={0.9} />
                      <text x={x + 22} y={98 - bh} textAnchor="middle" fontSize={12} fill="var(--foreground)">{b.count}</text>
                      <text x={x + 22} y={122} textAnchor="middle" fontSize={10} fill="var(--muted)">{b.label}</text>
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Daily P&amp;L</div>
            <svg viewBox={`0 0 ${DW} ${DH}`} style={{ width: "100%" }}>
              <line x1={0} y1={zeroY} x2={DW} y2={zeroY} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 3" />
              {days.map((d, i) => {
                const h = (Math.abs(d.pnl) / dMax) * (DH / 2 - 8);
                const x = i * (DW / Math.max(1, days.length)) + 1;
                return <rect key={d.date} x={x} y={d.pnl >= 0 ? zeroY - h : zeroY} width={barW} height={Math.max(1, h)} fill={d.pnl >= 0 ? "var(--emerald)" : "#f6465d"} opacity={0.9} />;
              })}
            </svg>
            <div className="hint" style={{ fontSize: 11 }}>{days.length} trading day{days.length === 1 ? "" : "s"} · best {fmtPnl(Math.max(...days.map((d) => d.pnl)))} · worst {fmtPnl(Math.min(...days.map((d) => d.pnl)))}</div>
          </div>
        </div>
      </section>

      {/* ---- Performance Breakdowns ---- */}
      <section style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Performance Breakdowns</h3>
          <select className="input" style={{ width: "auto" }} value={dim} onChange={(e) => { setDim(e.target.value as BreakdownDimension); setExpanded(null); }}>
            {DIMENSION_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <span className="hint" style={{ marginLeft: "auto", fontSize: 11.5 }}>Scroll the table sideways for Avg R, Expectancy, Profit Factor →</span>
        </div>
        <div style={{ position: "relative" }}>
        <div ref={bdRef} onScroll={updateBdMore} className="card tablescroll" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", textAlign: "left" }}>
                {[DIMENSION_OPTIONS.find((o) => o.key === dim)?.label ?? "Bucket", "Trades", "Win %", "Net P&L", "Avg Win", "Avg Loss", "Avg R", "Expectancy", "Profit Factor", "Avg Hold"].map((h, i) => (
                  <th key={h} style={{ padding: "10px 12px", color: "var(--muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap", ...(i === 0 ? { position: "sticky" as const, left: 0, background: "var(--bg2)", zIndex: 2, boxShadow: "1px 0 0 rgba(255,255,255,0.08)" } : {}) }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.key}>
                  <tr onClick={() => setExpanded(expanded === r.key ? null : r.key)}
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", cursor: "pointer", background: expanded === r.key ? "rgba(255,255,255,0.03)" : undefined }}>
                    <td style={{ padding: "10px 12px", fontWeight: 600, position: "sticky", left: 0, background: "var(--bg2)", zIndex: 1, boxShadow: "1px 0 0 rgba(255,255,255,0.08)" }}>{expanded === r.key ? "▾ " : "▸ "}{r.label}</td>
                    <td className="num" style={{ padding: "10px 12px" }}>{r.count}</td>
                    <td className="num" style={{ padding: "10px 12px" }}>{r.winRate == null ? "—" : fmtPct(r.winRate)}</td>
                    <td className="num" style={{ padding: "10px 12px", fontWeight: 700, color: pnlColor(r.netPnl) }}>{fmtPnl(r.netPnl)}</td>
                    <td className="num" style={{ padding: "10px 12px" }}>{r.avgWin == null ? "—" : fmtPnl(r.avgWin)}</td>
                    <td className="num" style={{ padding: "10px 12px" }}>{r.avgLoss == null ? "—" : fmtPnl(r.avgLoss)}</td>
                    <td className="num" style={{ padding: "10px 12px" }}>{fmtR(r.avgR)}</td>
                    <td className="num" style={{ padding: "10px 12px" }}>{r.expectancy == null ? "—" : fmtPnl(r.expectancy)}</td>
                    <td className="num" style={{ padding: "10px 12px" }}>{fmtPf(r.profitFactor)}</td>
                    <td className="num" style={{ padding: "10px 12px" }}>{fmtHold(r.avgHoldMinutes)}</td>
                  </tr>
                  {expanded === r.key && (
                    <tr key={`${r.key}-detail`}>
                      <td colSpan={10} style={{ padding: "4px 12px 12px 28px", background: "rgba(255,255,255,0.02)" }}>
                        {r.trades.map((t) => (
                          <div key={t.key} onClick={() => onSelect(t.key)}
                            style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer", fontSize: 12.5 }}>
                            <span>{t.tradeDate} · <b>{t.ticker}</b> <span className="hint">{t.direction}</span></span>
                            <span style={{ display: "flex", gap: 14 }}>
                              <span className="hint num">{fmtR(t.rMultiple)}</span>
                              <span className="num" style={{ fontWeight: 600, color: pnlColor(t.realizedPnl) }}>{fmtPnl(t.realizedPnl)}</span>
                            </span>
                          </div>
                        ))}
                        <div className="hint" style={{ fontSize: 11, marginTop: 4 }}>Click a trade to open it in Trade Review.</div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 20, textAlign: "center" }} className="hint">No data for this breakdown — nothing has been tagged yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {bdMore && (
          <div aria-hidden style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 46, pointerEvents: "none", background: "linear-gradient(to right, rgba(9,14,17,0), rgba(9,14,17,0.88))", display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 6, color: "var(--muted)", fontSize: 20 }}>›</div>
        )}
        </div>
        {(dim === "mistake" || dim === "emotion") && (
          <p className="hint" style={{ margin: "8px 0 0" }}>A trade counts under each of its tags, so rows can add up to more than the total number of trades. Trades with no tags recorded appear in no row.</p>
        )}
        <p className="hint" style={{ margin: "8px 0 0" }}>Win % here excludes breakeven trades from the denominator. Net P&L for single-value breakdowns sums exactly to the Overview total for the same filters.</p>
      </section>

      {/* ---- Edge Finder ---- */}
      <section style={{ minWidth: 0 }}>
        <h3 style={{ margin: "0 0 4px" }}>Edge Finder</h3>
        <p className="hint" style={{ margin: "0 0 12px" }}>Patterns in your own logged trades — descriptions of what happened, not predictions. Small samples are flagged; never treat a handful of trades as an edge.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
          <InsightCard title="Best setup (by expectancy)" insight={insights.bestSetup} />
          <InsightCard title="Best HOD classification" insight={insights.bestHodClass} />
          <InsightCard title="Costliest mistake" insight={insights.costliestMistake} />
          <InsightCard title="Worst emotion (by net P&L)" insight={insights.worstEmotion} />
          <InsightCard title="Best time window (by expectancy)" insight={insights.bestTimeWindow} />
        </div>

        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Plan adherence</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            {([["Followed plan", insights.planAdherence.followed], ["Did not follow", insights.planAdherence.notFollowed]] as const).map(([label, s]) => (
              <div key={label} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 14px" }}>
                <div className="hint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
                {s ? (
                  <>
                    <div className="num" style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: pnlColor(s.netPnl) }}>{fmtPnl(s.netPnl)}</div>
                    <div className="hint">{s.count} trade{s.count === 1 ? "" : "s"} · expectancy {fmtPnl(s.expectancy ?? 0)} · avg R {fmtR(s.avgR)}</div>
                    {s.count < 10 && <div style={{ marginTop: 6 }}><SmallSampleBadge /></div>}
                  </>
                ) : (
                  <p className="hint" style={{ margin: "6px 0 0" }}>No trades recorded with this plan status.</p>
                )}
              </div>
            ))}
          </div>
          {insights.planAdherence.notRecordedCount > 0 && (
            <p className="hint" style={{ margin: "10px 0 0" }}>{insights.planAdherence.notRecordedCount} trade{insights.planAdherence.notRecordedCount === 1 ? "" : "s"} have no plan status recorded — they are counted separately, never assumed to have followed or broken the plan.</p>
          )}
        </div>

        <div className="card" style={{ padding: 16, marginTop: 12, overflowX: "auto" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Improvement trend — recent window vs the equal window before it</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                {["Window", "Recent Net P&L", "Prior Net P&L", "Δ Net P&L", "Δ Expectancy"].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", color: "var(--muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {insights.trends.map((w) => (
                <tr key={w.days} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <td style={{ padding: "8px 10px", fontWeight: 600 }}>Last {w.days} days</td>
                  {w.current && w.prior ? (
                    <>
                      <td className="num" style={{ padding: "8px 10px" }}>{fmtPnl(w.current.netPnl)} <span className="hint">({w.current.count})</span></td>
                      <td className="num" style={{ padding: "8px 10px" }}>{fmtPnl(w.prior.netPnl)} <span className="hint">({w.prior.count})</span></td>
                      <td className="num" style={{ padding: "8px 10px", fontWeight: 700, color: pnlColor(w.netPnlDelta ?? 0) }}>{w.netPnlDelta == null ? "—" : fmtPnl(w.netPnlDelta)}</td>
                      <td className="num" style={{ padding: "8px 10px", color: pnlColor(w.expectancyDelta ?? 0) }}>{w.expectancyDelta == null ? "—" : fmtPnl(w.expectancyDelta)}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="hint" style={{ padding: "8px 10px" }}>{w.current ? `${fmtPnl(w.current.netPnl)} recent (${w.current.count} trades) — ` : ""}{w.reason ?? "Not enough history."}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint" style={{ margin: "8px 0 0" }}>Windows are anchored to your most recent trade date in the current selection. Trade counts are shown in parentheses. Deltas are calculated from unrounded totals, so a displayed change can differ by a cent from subtracting the rounded totals.</p>
        </div>
      </section>
    </div>
  );
}
