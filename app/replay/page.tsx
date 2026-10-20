"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import CandleChart from "../../components/CandleChart";
import LwcChart from "../../components/LwcChart";
import DiagPanel from "../../components/DiagPanel";
import DataSourcePanel from "../../components/DataSourcePanel";
import ReplayControls from "../../components/ReplayControls";
import TradingPanel from "../../components/TradingPanel";
import RiskCalculator from "../../components/RiskCalculator";
import { ReplayEngine, formatMoney, formatSigned, countdownText, countdownTextFor, TICKS_PER_CANDLE, SECONDS_PER_CANDLE } from "../../lib/engine";
import type { Candle, Fill, SessionMeta } from "../../lib/types";
import { TIMEFRAMES, aggregateCandles, higherTimeframeProgress, timeframeMinutes, formatEtTime, type TimeframeId } from "../../lib/marketData";
import {
  SealedCandleFeed,
  buildDrEngine,
  DAILY_REPLAY_STARTING_BALANCE,
  DAILY_REPLAY_STATE_KEY,
  encodeDrResumeHint,
  decodeDrResumeHint,
  validateDataset,
  highlightBandFor,
  drDatasetKey,
  premarketWarningGate,
  premarketOverlayVisible,
  normalizeReloadedSource,
  type SealedTransport,
} from "../../lib/dailyReplay";
import {
  DrEventRecorder,
  describeDrEvent,
  formatDrClock,
  type DrEvent,
  type DrEventType,
  type DrBracketMethod,
  type DrBracketScope,
} from "../../lib/dailyReplayEvents";
import {
  DrEventFlusher,
  newDrFlushState,
  type DrFlushState,
} from "../../lib/drEventFlush";
import {
  FREE_TRADES_PER_DAY, loadEntitlement, parseQuotaError, quotaMessage,
  type UsageStatus,
} from "../../lib/entitlements";
import { canOpenPosition, quotaCombinedUsed } from "../../lib/quotaGate";
import {
  reconstructDrAttempt,
  shouldOfferDrResume,
} from "../../lib/dailyReplayResume";
import {
  STRATEGY_SETUP_TYPES, mapAttemptRow, mapStrategyRow, mapStrategyVersionRow,
  resolveVersionContext, setupTypeLabel, strategyVersionLabel,
  type DrAttemptLink, type Strategy, type StrategySetupType, type StrategyVersion,
} from "../../lib/strategies";
import {
  DrOrderTracker,
  newDrOrderId,
  type DrOrderRow,
  type DrOrderUpdateOp,
} from "../../lib/dailyReplayOrders";
import {
  draftKeyFor, buildDraftPayload, draftsForAttempt, latestClosedCycle,
  reconcileDrafts, upsertDraft, updateDraftAutoCapture,
  fetchDraftsForAttempts, finalizeDraft, supersedeDraft, writeDraftMapping,
  type DrDraftRow, type DrDraftPayload,
} from "../../lib/drDrafts";
import { splitCyclesByGeneration } from "../../lib/drTradeEvidence";
import { groupFillsIntoTrades, type RawFill } from "../../lib/journal";
import { uploadScreenshotBlob, MAX_BYTES } from "../../lib/journalAttachments";
import DrDraftReview from "../../components/DrDraftReview";
import DrFinalizeConfirm from "../../components/DrFinalizeConfirm";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";
import { diag } from "../../lib/diag";
import { DEFAULT_HOTKEYS, isTypingTarget } from "../../lib/hotkeys";
import { normalizePrice } from "../../lib/price";
import type { Drawing, DrawingTool } from "../../lib/drawings";
import {
  calculatePositionLoss,
  activeThreshold,
  loadThresholds,
  saveThresholds,
  loadLockout,
  saveLockout,
  clearLockout,
  formatCountdown,
  saveLockoutRemote,
  loadLockoutRemote,
  clearLockoutRemote,
  mergeLockouts,
  deviceFingerprint,
  saveGuestLockoutRemote,
  loadGuestLockoutRemote,
} from "../../lib/psychGuard";
import type { GuardThreshold, PositionBaseline, LockoutState } from "../../lib/psychGuard";
import PsychologyGuardPanel from "../../components/PsychologyGuardPanel";
import GuestLimitModal from "../../components/GuestLimitModal";
import UpgradeModal from "../../components/UpgradeModal";
import {
  GUEST_DAILY_LIMIT,
  getGuestFingerprint,
  getGuestTradesRemaining,
  consumeGuestTrade,
} from "../../lib/guestTrades";

const START_CASH = 100_000;
const BALANCE_KEY = "ggl-account-balance";

/* ---------------- Daily Replay (server-sealed) ---------------- */

interface DrInfo {
  attemptId: string;
  datasetId: string;
  ticker: string;
  tradeDate: string;
  startIndex: number;
  total: number;
  /** Strategy version bound at lock time (null = none recorded). */
  strategyVersionId: string | null;
  /** "Name · vN" for display; null when unbound or unresolved. */
  strategyLabel: string | null;
}

const DR_EMPTY_BRACKETS = {
  plannedSL: null,
  plannedTP: null,
  activeSL: null,
  activeTP: null,
};

/**
 * Supabase transport for SealedCandleFeed — thin mapping over the dr_*
 * RPCs from supabase/migrations/daily-replay-v1.sql. All sealing rules
 * (ownership, position clamping) are enforced inside those functions.
 */
function createDrTransport(
  supabase: ReturnType<typeof createClient>
): SealedTransport {
  return {
    async createAttempt(datasetId, startIndex, strategyVersionId) {
      // The strategy parameter exists only once the strategies
      // migration is applied. Where the extended signature is missing
      // (PostgREST PGRST202), retry with the original two arguments —
      // the attempt then simply records no strategy. Any other error
      // (e.g. a foreign strategy version) propagates untouched.
      let res = await supabase.rpc("dr_create_attempt", {
        p_dataset_id: datasetId,
        p_start_index: startIndex,
        ...(strategyVersionId ? { p_strategy_version_id: strategyVersionId } : {}),
      });
      if (res.error && strategyVersionId && (res.error as { code?: string }).code === "PGRST202") {
        res = await supabase.rpc("dr_create_attempt", {
          p_dataset_id: datasetId,
          p_start_index: startIndex,
        });
      }
      const { data, error } = res;
      if (error) throw error;
      const d = data as { attempt_id: string; position: number; candles: Candle[] };
      return { attemptId: d.attempt_id, position: d.position, candles: d.candles };
    },
    async advance(attemptId, steps) {
      const { data, error } = await supabase.rpc("dr_advance_attempt", {
        p_attempt_id: attemptId,
        p_steps: steps,
      });
      if (error) throw error;
      const d = data as { position: number; candles: Candle[]; finished: boolean };
      return { position: d.position, candles: d.candles, finished: d.finished };
    },
    async getRevealed(attemptId) {
      const { data, error } = await supabase.rpc("dr_get_revealed", {
        p_attempt_id: attemptId,
      });
      if (error) throw error;
      const d = data as { position: number; candles: Candle[] };
      return { position: d.position, candles: d.candles };
    },
  };
}

/** True when the Daily Replay migration has not been applied yet. */
function isDrStorageMissing(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string };
  if (
    err.code === "PGRST202" ||
    err.code === "PGRST205" ||
    err.code === "42P01" ||
    err.code === "42883"
  ) {
    return true;
  }
  const msg = (err.message ?? "").toLowerCase();
  return (
    msg.includes("could not find the function") ||
    msg.includes("daily_replay_datasets") ||
    msg.includes("daily_replay_attempts") ||
    msg.includes("daily_replay_events") ||
    msg.includes("daily_replay_orders") ||
    msg.includes("dr_create_attempt") ||
    msg.includes("dr_upload_candles") ||
    msg.includes("dr_advance_attempt") ||
    msg.includes("dr_place_order") ||
    msg.includes("dr_update_order")
  );
}

const DR_STORAGE_MISSING_MSG =
  "Daily Replay storage is not enabled on this deployment yet.";

/** True when the trade-drafts table is absent (its migration has not
 *  been applied on this deployment yet). Drafts then degrade to an
 *  honest "not enabled" notice — never an error at every cycle close. */
function isDraftsStorageMissing(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string };
  if (err.code === "42P01" || err.code === "PGRST205") return true;
  return (err.message ?? "").includes("daily_replay_trade_drafts");
}

/** True when an RPC error means THIS function does not exist on the
 *  deployment (its migration not applied) — as opposed to the
 *  function existing and rejecting the call, which must propagate. */
function isMissingDrFunction(e: unknown, fnName: string): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string };
  const msg = (err.message ?? "").toLowerCase();
  if (!msg.includes(fnName.toLowerCase())) return false;
  return (
    err.code === "PGRST202" ||
    msg.includes("could not find the function") ||
    msg.includes("does not exist")
  );
}

/* ---------------- Daily Replay strategies panel ----------------
 * Create strategies + immutable versions, archive strategies, and
 * review strategies -> versions -> their attempts. Versions are
 * created ONLY through dr_allocate_strategy_version (atomic numbering)
 * and are never edited or deleted — changing the rules means making
 * the next version. Copy never calls a saved strategy "validated":
 * a strategy is a recorded set of rules, nothing more. */
function DrStrategyPanel(props: {
  strategies: Strategy[];
  versions: StrategyVersion[];
  attempts: DrAttemptLink[];
  available: boolean | null;
  onChanged: () => void;
}) {
  const { strategies, versions, attempts, available, onChanged } = props;
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [setup, setSetup] = useState<StrategySetupType>("hod_breakout");
  const [entryRules, setEntryRules] = useState("");
  const [stopRules, setStopRules] = useState("");
  const [targetRules, setTargetRules] = useState("");
  const [exitRules, setExitRules] = useState("");
  const [versionFor, setVersionFor] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);

  if (available === null) return null;
  if (available === false) {
    return (
      <div className="card" style={{ padding: 14, marginTop: 12 }}>
        <b style={{ fontSize: 13.5 }}>Trading Strategies</b>
        <p className="hint" style={{ margin: "6px 0 0" }}>
          Strategy tracking is not enabled on this deployment yet (its database update has not been
          applied). Daily Replay works as before — attempts simply record no strategy until it is enabled.
        </p>
      </div>
    );
  }

  const createStrategy = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in to save strategies.");
      const { data: s, error } = await supabase
        .from("strategies")
        .insert({ user_id: user.id, name: name.trim() })
        .select("id")
        .single();
      if (error || !s) throw error ?? new Error("Could not create the strategy.");
      const { error: vErr } = await supabase.rpc("dr_allocate_strategy_version", {
        p_strategy_id: s.id,
        p_setup_type: setup,
        p_entry_rules: entryRules.trim() || null,
        p_stop_rules: stopRules.trim() || null,
        p_target_rules: targetRules.trim() || null,
        p_exit_rules: exitRules.trim() || null,
        p_market_filters: {},
        p_notes: null,
      });
      if (vErr) throw vErr;
      setName(""); setEntryRules(""); setStopRules(""); setTargetRules(""); setExitRules("");
      setShowCreate(false);
      setMsg("Strategy saved with version 1. It becomes available in the strategy picker when you lock a Daily Replay.");
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save the strategy.");
    } finally { setBusy(false); }
  };

  const createVersion = async (strategyId: string) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("dr_allocate_strategy_version", {
        p_strategy_id: strategyId,
        p_setup_type: setup,
        p_entry_rules: entryRules.trim() || null,
        p_stop_rules: stopRules.trim() || null,
        p_target_rules: targetRules.trim() || null,
        p_exit_rules: exitRules.trim() || null,
        p_market_filters: {},
        p_notes: null,
      });
      if (error) throw error;
      const v = data as { version?: number } | null;
      setMsg(`Version ${v?.version ?? ""} created. Existing attempts keep the version they were locked under — versions are never edited.`);
      setVersionFor("");
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not create the version.");
    } finally { setBusy(false); }
  };

  const archiveStrategy = async (s: Strategy) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("strategies")
        .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", s.id);
      if (error) throw error;
      setMsg(`"${s.name}" archived. It stays attached to its historical attempts and can no longer be picked for new ones.`);
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not archive the strategy.");
    } finally { setBusy(false); }
  };

  const rulesFields = (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
        <label style={{ fontSize: 12 }}>Setup type
          <select className="input" value={setup} onChange={(e) => setSetup(e.target.value as StrategySetupType)} style={{ width: "100%" }}>
            {STRATEGY_SETUP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>Entry rules
          <textarea className="input" rows={2} value={entryRules} onChange={(e) => setEntryRules(e.target.value)} style={{ width: "100%" }} placeholder="When do you enter?" />
        </label>
        <label style={{ fontSize: 12 }}>Stop rules
          <textarea className="input" rows={2} value={stopRules} onChange={(e) => setStopRules(e.target.value)} style={{ width: "100%" }} placeholder="Where is the stop?" />
        </label>
        <label style={{ fontSize: 12 }}>Target rules
          <textarea className="input" rows={2} value={targetRules} onChange={(e) => setTargetRules(e.target.value)} style={{ width: "100%" }} placeholder="Where do you take profit?" />
        </label>
        <label style={{ fontSize: 12 }}>Exit rules
          <textarea className="input" rows={2} value={exitRules} onChange={(e) => setExitRules(e.target.value)} style={{ width: "100%" }} placeholder="How do you exit otherwise?" />
        </label>
      </div>
    </>
  );

  return (
    <div className="card" style={{ padding: 14, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 13.5 }}>Trading Strategies</b>
        <span className="hint">Record a strategy, lock Daily Replay attempts under one of its versions, and review the results per version in your journal.</span>
        <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setShowCreate((s) => !s)}>
          {showCreate ? "Close" : "New strategy"}
        </button>
      </div>
      {msg && <div className="hint" style={{ marginTop: 8, color: "var(--foreground)" }}>{msg}</div>}
      {showCreate && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          <label style={{ fontSize: 12 }}>Strategy name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} placeholder="e.g. HOD Breakout" />
          </label>
          {rulesFields}
          <div>
            <button className="btn primary" onClick={createStrategy} disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save strategy (creates version 1)"}
            </button>
          </div>
        </div>
      )}
      {strategies.length === 0 && !showCreate && (
        <p className="hint" style={{ margin: "8px 0 0" }}>No strategies yet. Attempts locked without a strategy stay unclassified — nothing is assigned after the fact.</p>
      )}
      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        {strategies.map((s) => {
          const sVersions = versions.filter((v) => v.strategyId === s.id).sort((a, b) => a.version - b.version);
          const isOpen = expanded === s.id;
          return (
            <div key={s.id} style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button className="btn" style={{ padding: "2px 10px" }} onClick={() => setExpanded(isOpen ? null : s.id)}>
                  {isOpen ? "▾" : "▸"} {s.name}
                </button>
                <span className="hint">{sVersions.length} version{sVersions.length === 1 ? "" : "s"}</span>
                {s.archivedAt
                  ? <span className="hint">archived</span>
                  : <button className="btn" style={{ padding: "2px 10px", fontSize: 12 }} disabled={busy} onClick={() => archiveStrategy(s)}>Archive</button>}
                {!s.archivedAt && (
                  <button className="btn" style={{ padding: "2px 10px", fontSize: 12 }} disabled={busy}
                    onClick={() => setVersionFor(versionFor === s.id ? "" : s.id)}>
                    New version
                  </button>
                )}
              </div>
              {versionFor === s.id && (
                <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                  {rulesFields}
                  <div>
                    <button className="btn primary" onClick={() => createVersion(s.id)} disabled={busy}>
                      {busy ? "Saving…" : `Save as version ${sVersions.length > 0 ? Math.max(...sVersions.map((v) => v.version)) + 1 : 1}`}
                    </button>
                    <span className="hint" style={{ marginLeft: 8 }}>The previous version stays exactly as recorded.</span>
                  </div>
                </div>
              )}
              {isOpen && (
                <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                  {sVersions.map((v) => {
                    const vAttempts = attempts.filter((a) => a.strategyVersionId === v.id);
                    return (
                      <div key={v.id} style={{ fontSize: 12.5, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 8 }}>
                        <b>{strategyVersionLabel(s.name, v.version)}</b> · {setupTypeLabel(v.setupType)}
                        {v.entryRules && <div className="hint">Entry: {v.entryRules}</div>}
                        {v.stopRules && <div className="hint">Stop: {v.stopRules}</div>}
                        {v.targetRules && <div className="hint">Target: {v.targetRules}</div>}
                        {v.exitRules && <div className="hint">Exit: {v.exitRules}</div>}
                        <div className="hint" style={{ marginTop: 3 }}>
                          {vAttempts.length === 0 ? "No attempts recorded under this version yet." : vAttempts.map((a) => (
                            <span key={a.id} style={{ marginRight: 10 }}>
                              Attempt {a.id.slice(0, 8)} · {a.status}{a.sessionId ? <> · <a href="/journal">view trades in Journal</a></> : ""}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReplayPageInner() {
  const searchParams = useSearchParams();
  const engineRef = useRef<ReplayEngine | null>(null);
  // Persistent account balance — carries P&L across sessions.
  const [accountBalance, setAccountBalance] = useState<number>(START_CASH);
  const balanceRef = useRef(accountBalance);
  balanceRef.current = accountBalance;

  // Load balance: Supabase for signed-in users, localStorage for guests.
  useEffect(() => {
    (async () => {
      try {
        if (isSupabaseConfigured()) {
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            const { data } = await supabase
              .from("profiles")
              .select("account_balance")
              .eq("id", user.id)
              .single();
            if (data && data.account_balance != null) {
              const b = Number(data.account_balance);
              if (isFinite(b) && b > 0) {
                setAccountBalance(b);
                balanceRef.current = b;
                return;
              }
            }
          }
        }
      } catch { /* fall through to localStorage */ }
      try {
        const stored = localStorage.getItem(BALANCE_KEY);
        if (stored) {
          const b = Number(stored);
          if (isFinite(b) && b > 0) {
            setAccountBalance(b);
            balanceRef.current = b;
          }
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // Persist balance: Supabase for signed-in, localStorage for guests.
  const persistBalance = useCallback(async (b: number) => {
    setAccountBalance(b);
    balanceRef.current = b;
    try { localStorage.setItem(BALANCE_KEY, String(b)); } catch { /* ignore */ }
    try {
      if (isSupabaseConfigured()) {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await supabase.from("profiles").update({ account_balance: b }).eq("id", user.id);
        }
      }
    } catch { /* non-fatal */ }
  }, []);

  // Reset balance to $100k with confirmation.
  const resetBalance = useCallback(() => {
    if (!window.confirm("Reset account balance to $100,000? This cannot be undone.")) return;
    persistBalance(START_CASH);
  }, [persistBalance]);

  // Auto-save state (signed-in users only)
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const savedSessionIdRef = useRef<string | null>(null);
  const lastSavedPnlRef = useRef<number>(0);
  const autoSaveEnabledRef = useRef(autoSaveEnabled);
  autoSaveEnabledRef.current = autoSaveEnabled;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [version, setVersion] = useState(0);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [orderQty, setOrderQty] = useState("100");
  // Planned SL/TP (dashed, no engine effect) vs active brackets (engine).
  const [plannedSL, setPlannedSL] = useState<number | null>(null);
  const [plannedTP, setPlannedTP] = useState<number | null>(null);
  // Planned entry: captured when levels are first set, fixed thereafter.
  // Used for R:R calculations so they don't drift with live price.
  const [plannedEntry, setPlannedEntry] = useState<number | null>(null);
  // Chart drawings (persisted per ticker+date+source in localStorage).
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  // Load saved drawings when session meta changes
  useEffect(() => {
    if (!meta) { setDrawings([]); return; }
    try {
      const key = `ggl-drawings:${meta.ticker}:${meta.tradeDate}:${meta.source}`;
      const raw = localStorage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw) as Drawing[];
        if (Array.isArray(saved)) setDrawings(saved);
        else setDrawings([]);
      } else {
        setDrawings([]);
      }
    } catch { setDrawings([]); }
  }, [meta?.ticker, meta?.tradeDate, meta?.source]);
  // Save drawings on change (debounced)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!meta) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        const key = `ggl-drawings:${meta.ticker}:${meta.tradeDate}:${meta.source}`;
        localStorage.setItem(key, JSON.stringify(drawings));
      } catch { /* storage full or unavailable */ }
    }, 500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [drawings, meta?.ticker, meta?.tradeDate, meta?.source]);
  // Right sidebar tabs: order / risk / guard (no scrolling).
  const [rightTab, setRightTab] = useState<"order" | "risk" | "guard">("order");
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("select");

  const setPlannedLevels = (sl: number | null, tp: number | null) => {
    if ((sl != null || tp != null) && plannedEntry == null) {
      const eng = engineRef.current;
      if (eng && eng.displayPrice > 0) {
        setPlannedEntry(normalizePrice(eng.displayPrice));
      }
    }
    if (sl == null && tp == null) {
      setPlannedEntry(null);
    }
    setPlannedSL(sl);
    setPlannedTP(tp);
  };
  // Bumped to force the timer effect to re-run on restart even when
  // `playing` doesn't net-change (React batches setPlaying(false) +
  // setPlaying(true) into a no-op, which used to leave the replay frozen
  // with no timer running).
  const [playNonce, setPlayNonce] = useState(0);
  const [speed, setSpeed] = useState(1);
  // Chart timeframe: display-layer aggregation only. The engine always runs
  // on 1-minute candles; switching never touches replay state, positions,
  // orders, or the clock.
  const [timeframe, setTimeframe] = useState<TimeframeId>("1m");
  const [ended, setEnded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [premarketNoticeDismissed, setPremarketNoticeDismissed] = useState(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  /* ---------------- Daily Replay state ----------------
   * Phases: off → preview (full day visible, unsealed by design) →
   * active (engine built ONLY over the SealedCandleFeed's array) → done.
   * The DR balance lives solely inside the DR engine's cash — the Trade
   * Lab persistent balance (profiles.account_balance / BALANCE_KEY) is
   * never read or written by any Daily Replay path. */
  const [drPhase, setDrPhase] = useState<"off" | "preview" | "active" | "done">("off");
  const drPhaseRef = useRef(drPhase);
  drPhaseRef.current = drPhase;
  const [drPreview, setDrPreview] = useState<{
    candles: Candle[];
    meta: SessionMeta;
    warnings: string[];
    selected: number;
    /** From validateDataset stats at load time: whether this dataset
     *  has any pre-09:30 ET candles. Drives the load-time premarket
     *  warning gate in the preview (see premarketWarningGate). */
    premarketAvailable: boolean;
  } | null>(null);
  /** Dataset key for which the preview's premarket warning was
   *  dismissed. Keyed (not boolean) so a new dataset always
   *  re-evaluates; also reset on every new preview load. */
  const [drPremarketDismissedKey, setDrPremarketDismissedKey] =
    useState<string | null>(null);
  const [drConfirm, setDrConfirm] = useState(false);
  /** "Complete session now" confirmation (early completion): shown
   *  from the DR status banner while an attempt is active. */
  const [drCompleteConfirm, setDrCompleteConfirm] = useState(false);
  const [drBusy, setDrBusy] = useState(false);
  const [drBuffering, setDrBuffering] = useState(false);
  const [drError, setDrError] = useState<string | null>(null);
  const [drInfo, setDrInfo] = useState<DrInfo | null>(null);
  const drInfoRef = useRef<DrInfo | null>(null);
  drInfoRef.current = drInfo;
  const [drFinal, setDrFinal] = useState<{ realized: number; equity: number } | null>(null);
  const [drSaveMsg, setDrSaveMsg] = useState<string | null>(null);
  /* ---- Daily Replay strategies (prepared migration) ----
   * Loaded best-effort when the page mounts for a signed-in user.
   * `drStrategiesAvailable === false` means the strategies tables do
   * not exist on this deployment yet (migration not applied): the
   * strategy UI disables itself with an honest notice and every other
   * Daily Replay behavior is unchanged. */
  const [drStrategies, setDrStrategies] = useState<Strategy[]>([]);
  const [drStrategyVersions, setDrStrategyVersions] = useState<StrategyVersion[]>([]);
  const [drStrategiesAvailable, setDrStrategiesAvailable] = useState<boolean | null>(null);
  /** Attempts list for the strategies review surface. */
  const [drAttemptsList, setDrAttemptsList] = useState<DrAttemptLink[]>([]);

  const loadDrStrategies = useCallback(async () => {
    if (!isSupabaseConfigured()) { setDrStrategiesAvailable(false); return; }
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setDrStrategiesAvailable(false); return; }
      const [sRes, vRes, aRes] = await Promise.all([
        supabase.from("strategies").select("*").order("created_at", { ascending: true }).limit(200),
        supabase.from("strategy_versions").select("*").order("version", { ascending: true }).limit(1000),
        supabase.from("daily_replay_attempts").select("id,session_id,strategy_version_id,status,start_index,created_at,finished_at").order("created_at", { ascending: false }).limit(200),
      ]);
      if (sRes.error || vRes.error) throw sRes.error ?? vRes.error;
      setDrStrategies((sRes.data ?? []).map((r) => mapStrategyRow(r as Record<string, unknown>)));
      setDrStrategyVersions((vRes.data ?? []).map((r) => mapStrategyVersionRow(r as Record<string, unknown>)));
      if (!aRes.error && aRes.data) {
        setDrAttemptsList(aRes.data.map((r) => mapAttemptRow(r as Record<string, unknown>)));
      }
      setDrStrategiesAvailable(true);
    } catch {
      setDrStrategiesAvailable(false);
    }
  }, []);

  useEffect(() => { void loadDrStrategies(); }, [loadDrStrategies]);
  const drFeedRef = useRef<SealedCandleFeed | null>(null);
  /* Preview -> workspace framing handoff: the preview chart reports
   * its visible range (and the bar spacing derived from it) on every
   * change; at lock-confirm time the latest spacing is captured into
   * drInitialViewRef, keyed by attempt id, and passed to the
   * workspace chart as its initialView — so the active chart opens
   * with the candle size the user had in the preview instead of the
   * library default view. Resume never sets it: a resumed attempt
   * keeps the library-default initial view, as before. */
  const drPreviewViewRef = useRef<{ spacingPx: number; from: number; to: number } | null>(null);
  const drInitialViewRef = useRef<{ targetSpacingPx: number; viewKey: string } | null>(null);
  const drAdvancingRef = useRef(false);
  const drCompletedRef = useRef(false);
  const drOnErrorRef = useRef<(e: unknown) => void>(() => {});
  /* Decision Timeline (DR-scoped): the recorder is fed from the same
   * call sites where actions happen; fills are observed centrally. */
  const [drEvents, setDrEvents] = useState<DrEvent[]>([]);
  const drRecorderRef = useRef<DrEventRecorder | null>(null);
  /* Timeline persistence state, replaced per attempt so a flush still
   * queued for a previous attempt can never touch the new attempt's
   * offset (see lib/drEventFlush.ts). The flusher itself is shared:
   * it serializes every flush on one chain. */
  const drFlushStateRef = useRef<DrFlushState>(newDrFlushState());
  const drEventFlusherRef = useRef<DrEventFlusher>(new DrEventFlusher());
  const drSeenFillsRef = useRef(0);
  const drPlayStartedRef = useRef(false);
  /* Persistent working orders (daily_replay_orders, v2): the tracker
   * maps engine order ids to server rows for the on-screen attempt;
   * store ops for one order are serialized on a per-order promise
   * chain so a fill update can never overtake its placement insert.
   * drOrdersMissingRef latches when the v2 migration is not applied —
   * order persistence then stays off (device-only), never crashing,
   * exactly how the events layer degrades pre-migration. */
  const drOrderTrackerRef = useRef<DrOrderTracker | null>(null);
  const drOrdersMissingRef = useRef(false);
  const drOrderChainsRef = useRef(new Map<string, Promise<void>>());
  /* ---- Daily Replay trade drafts (per-cycle durable records) ----
   * A draft row is written the moment a position cycle closes
   * (observed in drSyncFills), keyed dr:{attempt}:g{gen}:c{cycle}.
   * drCaptureRef is the workspace chart's screenshot handle (assigned
   * by LwcChart's captureHandleRef prop); entry captures are staged
   * in drPendingEntryCaptureRef at the entry fill and uploaded only
   * after the draft row itself is confirmed saved. Save states are
   * per-draft and HONEST: "saved" renders only after the upsert
   * resolves, failures stay visible with a retry that re-runs the
   * writer from the stored payload. */
  const drCaptureRef = useRef<(() => HTMLCanvasElement | null) | null>(null);
  const [drDraftRows, setDrDraftRows] = useState<DrDraftRow[]>([]);
  const drDraftRowsRef = useRef<DrDraftRow[]>([]);
  drDraftRowsRef.current = drDraftRows;
  const [drDraftsAvailable, setDrDraftsAvailable] = useState<boolean | null>(null);
  const drDraftsMissingRef = useRef(false);
  const [drDraftSaveStates, setDrDraftSaveStates] = useState<
    Record<string, "saving" | "saved" | "failed">
  >({});
  const drFailedPayloadsRef = useRef(new Map<string, DrDraftPayload>());
  const [drDraftNotice, setDrDraftNotice] = useState<
    { text: string; tone: "ok" | "warn" } | null
  >(null);
  const drNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Subscription daily-quota buy gate (2026-10-19): the database
   * enforces the Free plan's 3-trades/day cap when a trade is
   * RECORDED (Daily Replay draft insert, simulator session save,
   * real-trade insert) — too late for the trader mid-session, who
   * kept executing buys and only lost the SAVE. This gate mirrors
   * the cap at the moment a NEW position opens (lib/quotaGate), so
   * the 4th buy never executes and the upgrade modal shows instead.
   * Signed-in users only; guests keep their separate guest limit,
   * and the DB triggers remain the authoritative backstop. */
  const entitlementRef = useRef<UsageStatus | null>(null);
  /** New positions opened since the last usage_status() refresh. */
  const quotaOpenedRef = useRef(0);
  const quotaUserIdRef = useRef<string | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  /** Re-sync the server's daily count (usage_status RPC). Opens not
   * yet recorded fold back to just the still-open position (0 or 1):
   * every other trade opened since the last sync is inside
   * trades_used by now, or was never going to be recorded. Call
   * ONLY at sync points — session/attempt start (incl. restore and
   * resume) and after each successful save / draft save. A null
   * entitlement (billing not live on this database) disables the
   * gate entirely, matching the dark-by-default read model. */
  const syncQuotaFromServer = async (): Promise<void> => {
    if (!isSupabaseConfigured() || !quotaUserIdRef.current) return;
    const ent = await loadEntitlement(createClient());
    entitlementRef.current = ent;
    quotaOpenedRef.current =
      engineRef.current && engineRef.current.positionQty > 0 ? 1 : 0;
  };

  /** Just-in-time entitlement refresh for the buy gate, bounded so
   *  a slow network can never wedge trading: if the sync points
   *  (session start / after saves) left the ref empty — first buy
   *  raced the load, the RPC hiccuped — re-read usage_status()
   *  right here, at the decision point, and evaluate on the fresh
   *  value. A timeout or a still-null result falls through to the
   *  cached evaluation (dark-by-default; the DB cap at save/draft
   *  time remains the backstop either way). */
  const refreshQuotaJit = async (ms = 1500): Promise<void> => {
    try {
      await Promise.race([
        syncQuotaFromServer(),
        new Promise((res) => setTimeout(res, ms)),
      ]);
    } catch { /* cached state stands */ }
  };

  /** True when a signed-in Free user has no daily slot for a new open. */
  const quotaBuyBlocked = (): boolean => {
    const ent = entitlementRef.current;
    if (!quotaUserIdRef.current || !ent) return false;
    return !canOpenPosition({
      signedIn: true,
      isPro: ent.is_pro,
      dailyUsed: ent.trades_used,
      sessionOpened: quotaOpenedRef.current,
      dailyLimit: ent.trades_limit,
    });
  };

  /** The error line shown (with the modal) when the gate blocks a buy. */
  const quotaBlockMessage = (): string => {
    const ent = entitlementRef.current;
    const limit = ent?.trades_limit ?? FREE_TRADES_PER_DAY;
    const used = ent
      ? Math.min(
          quotaCombinedUsed({
            signedIn: true, isPro: ent.is_pro,
            dailyUsed: ent.trades_used,
            sessionOpened: quotaOpenedRef.current,
            dailyLimit: ent.trades_limit,
          }),
          limit
        )
      : limit;
    return `Daily trade limit reached — ${used} of ${limit} free trades used today. Upgrade to Pro for unlimited trades.`;
  };
  const [drReviewDraftKey, setDrReviewDraftKey] = useState<string | null>(null);
  /** Draft awaiting finalize confirmation (the shared dialog). */
  const [drFinalizeTarget, setDrFinalizeTarget] = useState<DrDraftRow | null>(null);
  /** Collapsible workspace sections (2026-10-18 chart-first layout):
   *  both start COLLAPSED so the chart keeps the vertical space;
   *  the timeline additionally auto-opens when the session completes
   *  (the review moment). Toggling never touches replay state. */
  const [drTimelineOpen, setDrTimelineOpen] = useState(false);
  const [drDraftsOpen, setDrDraftsOpen] = useState(false);
  const drPhasePrevRef = useRef<string>("idle");
  // Timeline auto-opens ONCE when the session transitions to done
  // (the review moment); it stays collapsed through active trading.
  useEffect(() => {
    if (drPhasePrevRef.current !== "done" && drPhase === "done") setDrTimelineOpen(true);
    drPhasePrevRef.current = drPhase;
  }, [drPhase]);
  const drPendingEntryCaptureRef = useRef<{
    draftKey: string;
    candleIndex: number;
    blob: Blob | null;
    status: string;
  } | null>(null);
  const drDraftHandledRef = useRef(new Set<string>());
  /* Refresh-resume: an in-progress attempt found on load, verified
   * against the attempts table (the localStorage hint alone proves
   * nothing — the server row decides, and anything non-active clears
   * the hint). */
  const [drResume, setDrResume] = useState<{
    attemptId: string;
    ticker: string;
    tradeDate: string;
    startIndex: number;
    position: number;
    total: number;
    startingBalance: number;
  } | null>(null);
  const [drResuming, setDrResuming] = useState(false);
  /** Set when a resumed attempt's earlier trade history could not be
   *  restored (events unreadable or empty): the timeline panel says
   *  so plainly instead of inventing fills. */
  const [drHistoryNote, setDrHistoryNote] = useState<string | null>(null);

  // Trading-workspace mode: hide the site footer so the workspace owns the screen.
  useEffect(() => {
    document.body.classList.add("ws-active");
    return () => document.body.classList.remove("ws-active");
  }, []);

  // Play loop: deadline-based tick clock. 1x = live market speed — each
  // 1-minute candle forms over 60 real seconds, ticking continuously, then
  // finalizes exactly when its countdown reaches zero. Deadlines (not an
  // accumulator) keep long-term timing exact; if the tab was backgrounded
  // or the laptop slept, the clock re-anchors instead of firing a burst of
  // catch-up ticks that would saturate the main thread and look frozen.
  useEffect(() => {
    if (!playing) return;
    const eng = engineRef.current;
    if (!eng) return;
    // Guard against duplicate timers: only one interval may exist.
    if (timerRef.current) clearInterval(timerRef.current);
    const tickMs = 1000 / ((TICKS_PER_CANDLE / SECONDS_PER_CANDLE) * speed);
    let nextTick = performance.now();
    let done = false;
    const id = setInterval(() => {
      if (done) return;
      const now = performance.now();
      // Diagnostics: track timer health.
      diag.timerFires++;
      if (diag.lastTimerFire !== null) {
        diag.maxFireGapMs = Math.max(diag.maxFireGapMs, now - diag.lastTimerFire);
      }
      diag.lastTimerFire = now;
      // Fell behind by more than a second (hidden tab / sleep / pause in
      // devtools): resume from the live edge instead of bursting.
      if (now - nextTick > 1000) nextTick = now;
      // Daily Replay: the engine may only form candles the sealed feed
      // already holds. At the held end (engine.atEnd with more candles
      // still sealed server-side), release exactly the next candle —
      // strict release-on-consume via the feed's ensure() gate, never
      // a batch — instead of ticking, and pause ticking while that
      // request is in flight.
      if (drPhaseRef.current === "active") {
        const feed = drFeedRef.current;
        if (feed && eng.atEnd && !feed.finished) {
          if (!drAdvancingRef.current) {
            drAdvancingRef.current = true;
            setDrBuffering(true);
            feed
              .ensure(eng.index + 1)
              .then(() => bump())
              .catch((e) => drOnErrorRef.current(e))
              .finally(() => {
                drAdvancingRef.current = false;
                setDrBuffering(false);
              });
          }
          return;
        }
      }
      let ran = 0;
      let finished = false;
      const qtyBefore = eng.positionQty;
      while (nextTick <= now && ran < 60) {
        diag.tickCalls++;
        diag.lastTick = performance.now();
        const r = eng.tick();
        ran++;
        nextTick += tickMs;
        if (r.atEnd) { finished = true; break; }
      }
      // Guest limit: consume when a limit buy fill opens a new position.
      // (Market buys consume in gateBuy; this covers the limit-order path.)
      if (qtyBefore === 0 && eng.positionQty !== 0 && !guardUserIdRef.current) {
        consumeGuestTrade(
          isSupabaseConfigured() ? createClient() : null,
          getGuestFingerprint()
        ).then(async () => {
          const remaining = await getGuestTradesRemaining(
            isSupabaseConfigured() ? createClient() : null,
            getGuestFingerprint()
          );
          setGuestRemaining(remaining);
        });
      }
      if (ran > 0) bump();
      if (finished) {
        // Daily Replay: finalizing the last HELD candle is a
        // buffering state, not the end (see the ended-effect below).
        // The engine's atEnd fires in this same tick, before any
        // interval pass could observe it and release the next candle
        // — so stopping here would halt playback after every candle.
        // Keep the timer alive instead: the next pass takes the
        // Daily Replay branch above, releases exactly one candle via
        // ensure(), and ticking resumes. A finished feed (or any
        // standard session) still ends playback exactly as before.
        const feedNow = drFeedRef.current;
        const drBuffering =
          drPhaseRef.current === "active" && feedNow !== null && !feedNow.finished;
        if (!drBuffering) {
          done = true;
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          setPlaying(false);
          setEnded(true);
        }
      }
    }, 50);
    timerRef.current = id;
    return () => {
      clearInterval(id);
      if (timerRef.current === id) timerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, playNonce]);

  const handleLoad = useCallback((cs: Candle[], m: SessionMeta) => {
    stopTimer();
    setEnded(false);
    // Reset auto-save tracking for the new session
    savedSessionIdRef.current = null;
    lastSavedPnlRef.current = 0;
    setPremarketNoticeDismissed(false);
    engineRef.current = new ReplayEngine(cs, balanceRef.current, m.startIndex);
    setCandles(cs);
    setMeta(m);
    setSaveMsg(null);
    setDataOpen(false);
    bump();
    // Quota gate sync point: fresh session, fresh server count.
    void syncQuotaFromServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump, stopTimer]);

  /* ---------------- Daily Replay handlers ---------------- */

  const handleDrAdvanceError = useCallback(
    (e: unknown) => {
      stopTimer();
      setDrError(
        isDrStorageMissing(e)
          ? DR_STORAGE_MISSING_MSG
          : `Daily Replay paused: ${e instanceof Error ? e.message : "server request failed."}`
      );
    },
    [stopTimer]
  );
  drOnErrorRef.current = handleDrAdvanceError;

  // Step B: a validated Real Market Data load lands in the full-day
  // preview. Any running session is torn down exactly like a fresh load.
  const handleDrPreview = useCallback(
    (cs: Candle[], m: SessionMeta, warnings: string[]) => {
      stopTimer();
      setEnded(false);
      setSaveMsg(null);
      engineRef.current = null;
      savedSessionIdRef.current = null;
      lastSavedPnlRef.current = 0;
      setCandles(null);
      setMeta(null);
      setDrError(null);
      setDrFinal(null);
      setDrSaveMsg(null);
      // Premarket availability is determined NOW, at load time (the
      // panel already validated this exact dataset with the same
      // arguments — the recomputation is deterministic and cheap), so
      // the preview can warn before any candle is selected or locked.
      const v = validateDataset(cs, {
        ticker: m.ticker,
        tradeDate: m.tradeDate,
        timeframeMinutes: 1,
      });
      setDrPreview({
        candles: cs,
        meta: m,
        warnings,
        selected: Math.min(Math.max(m.startIndex, 0), cs.length - 1),
        premarketAvailable: v.stats.premarketAvailable,
      });
      setDrPremarketDismissedKey(null);
      setDrConfirm(false);
      setDrPhase("preview");
      bump();
    },
    [bump, stopTimer]
  );

  const exitDrPreview = useCallback(() => {
    setDrPreview(null);
    setDrConfirm(false);
    setDrError(null);
    setDrPhase("off");
    bump();
  }, [bump]);

  // Preview escape hatch: the pre-existing unsealed Trade Lab replay,
  // unchanged (the full array the user just inspected, their start time).
  const startStandardFromPreview = useCallback(() => {
    const pv = drPreview;
    if (!pv) return;
    setDrPreview(null);
    setDrPhase("off");
    handleLoad(pv.candles, pv.meta);
  }, [drPreview, handleLoad]);

  // Step C: lock the starting candle. Uploads the dataset server-side,
  // creates the sealed attempt, then DISCARDS the preview array — the
  // active engine is built only from the feed's server-released prefix.
  const confirmDrLock = useCallback(async () => {
    const pv = drPreview;
    if (!pv) return;
    setDrBusy(true);
    setDrError(null);
    try {
      if (!isSupabaseConfigured()) {
        setDrError(DR_STORAGE_MISSING_MSG);
        return;
      }
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setDrError(
          "Daily Replay keeps candles sealed on the server, stored per account — please sign in to lock a starting candle, or start a standard replay instead."
        );
        return;
      }
      const premarketUnavailable = pv.meta.premarketUnavailable;
      // 1) Register the dataset (owner RLS applies).
      const { data: ds, error: dsErr } = await supabase
        .from("daily_replay_datasets")
        .insert({
          user_id: user.id,
          ticker: pv.meta.ticker,
          trade_date: pv.meta.tradeDate,
          timeframe: 1,
          source: "twelvedata",
          candle_count: pv.candles.length,
        })
        .select("id")
        .single();
      if (dsErr || !ds) throw dsErr ?? new Error("Could not register the dataset.");
      // 2) Upload the candles through the definer RPC (the candles
      //    table itself accepts no direct writes at all).
      const { error: upErr } = await supabase.rpc("dr_upload_candles", {
        p_dataset_id: ds.id,
        p_candles: pv.candles,
      });
      if (upErr) throw upErr;
      // 3) Create the sealed attempt; the feed ingests ONLY the
      //    server-released prefix [0..start]. Attempts bind NO
      //    strategy version at lock time — the lock-screen strategy
      //    selector was removed (2026-10-18 workflow fix, user's
      //    direction), so strategy_version_id stays null and the
      //    attempt arrives unclassified. The strategy system itself
      //    (management UI, journal filters, export) is unchanged;
      //    attempts locked before this change keep their binding,
      //    which the resume path still reads back.
      const feed = new SealedCandleFeed(createDrTransport(supabase));
      feed.setTotal(pv.candles.length);
      await feed.create(ds.id, pv.selected, null);
      const info: DrInfo = {
        attemptId: feed.attemptId!,
        datasetId: ds.id,
        ticker: pv.meta.ticker,
        tradeDate: pv.meta.tradeDate,
        startIndex: pv.selected,
        total: pv.candles.length,
        strategyVersionId: null,
        strategyLabel: null,
      };
      // Decision Timeline starts here: attempt_created is event #1.
      const startCandle = feed.candles[pv.selected];
      const recorder = new DrEventRecorder();
      drRecorderRef.current = recorder;
      drFlushStateRef.current = newDrFlushState();
      drSeenFillsRef.current = 0;
      drPlayStartedRef.current = false;
      // Trade drafts start empty for a fresh attempt.
      setDrDraftRows([]);
      setDrDraftSaveStates({});
      setDrReviewDraftKey(null);
      setDrDraftNotice(null);
      drDraftHandledRef.current = new Set();
      drFailedPayloadsRef.current = new Map();
      drPendingEntryCaptureRef.current = null;
      // Fresh persistent-order tracking for this attempt.
      drOrderTrackerRef.current = new DrOrderTracker();
      drOrdersMissingRef.current = false;
      drOrderChainsRef.current = new Map();
      recorder.setListener(() => {
        setDrEvents(recorder.all);
        if (recorder.length - drFlushStateRef.current.offset >= 10) {
          void flushDrEvents();
        }
      });
      recorder.record(
        "attempt_created",
        {
          ticker: info.ticker,
          tradeDate: info.tradeDate,
          startIndex: info.startIndex,
          startEtTime: startCandle ? formatEtTime(startCandle.t) : "",
          startingBalance: DAILY_REPLAY_STARTING_BALANCE,
          strategyVersionId: info.strategyVersionId,
          strategyLabel: info.strategyLabel,
        },
        {
          marketIdx: info.startIndex,
          marketTs: startCandle ? startCandle.t : null,
        }
      );
      // 4) Drop every page-held reference to the full preview array.
      //    From here on, the only candles in memory are the feed's.
      drFeedRef.current = feed;
      // Framing handoff: capture the bar spacing the user had in the
      // preview at this moment (continuously reported via
      // onViewChange); the workspace chart's initialView preserves
      // it. A missing capture degrades to the readable-spacing floor
      // inside lib/chartFit's initialActiveWindow.
      drInitialViewRef.current = {
        targetSpacingPx: drPreviewViewRef.current?.spacingPx ?? 0,
        viewKey: info.attemptId,
      };
      setDrInfo(info);
      setDrPreview(null);
      setDrConfirm(false);
      drCompletedRef.current = false;
      // 5) Engine over the sealed array, with the independent DR
      //    balance. Boundary: the locked candle is the last COMPLETED
      //    candle — buildDrEngine releases exactly one more candle
      //    and starts the engine at startIndex + 1, so the NEXT
      //    candle is the first one that forms.
      const eng = await buildDrEngine(
        feed,
        info.startIndex,
        DAILY_REPLAY_STARTING_BALANCE
      );
      engineRef.current = eng;
      savedSessionIdRef.current = null;
      lastSavedPnlRef.current = 0;
      setCandles(feed.candles);
      setMeta({
        ticker: info.ticker,
        tradeDate: info.tradeDate,
        source: "twelvedata",
        startIndex: info.startIndex,
        premarketUnavailable,
      });
      setDrHistoryNote(null);
      setDrPhase("active");
      // Quota gate sync point: attempt start — fresh server count.
      void syncQuotaFromServer();
      try {
        localStorage.setItem(
          DAILY_REPLAY_STATE_KEY,
          encodeDrResumeHint({
            attemptId: info.attemptId,
            datasetId: info.datasetId,
            ticker: info.ticker,
            tradeDate: info.tradeDate,
            startIndex: info.startIndex,
          })
        );
      } catch { /* non-authoritative UI hint only */ }
      bump();
    } catch (e) {
      setDrError(
        isDrStorageMissing(e)
          ? DR_STORAGE_MISSING_MSG
          : e instanceof Error
            ? e.message
            : "Could not start Daily Replay."
      );
    } finally {
      setDrBusy(false);
    }
  }, [drPreview, bump]);

  // Step button for Daily Replay: release the next candle first when
  // the engine sits at the sealed end — exactly one candle, through
  // the same strict ensure() gate the play loop uses.
  const drStepNext = useCallback(async () => {
    const eng = engineRef.current;
    const feed = drFeedRef.current;
    if (!eng || !feed) return;
    if (eng.atEnd && !feed.finished) {
      setDrBuffering(true);
      try {
        await feed.ensure(eng.index + 1);
      } catch (e) {
        handleDrAdvanceError(e);
        return;
      } finally {
        setDrBuffering(false);
      }
    }
    if (!eng.atEnd) eng.step();
    setEnded(eng.atEnd && feed.finished);
    bump();
  }, [bump, handleDrAdvanceError]);

  // Leave Daily Replay. The server-side attempt stays 'active' (the
  // client holds no position it could forge anyway); the local sealed
  // array and engine are dropped.
  const exitDailyReplay = useCallback(() => {
    stopTimer();
    // Timeline: record the exit and flush what we can before teardown.
    const rec = drRecorderRef.current;
    if (rec && drPhaseRef.current !== "done") {
      rec.record("session_exited", {}, drCtx());
    }
    void flushDrEvents();
    drRecorderRef.current = null;
    // The attempt (and its working orders) stays 'active' server-side
    // for a later resume — only the local tracking is dropped.
    drOrderTrackerRef.current = null;
    drFeedRef.current = null;
    drInitialViewRef.current = null;
    drCompletedRef.current = false;
    setDrEvents([]);
    setDrHistoryNote(null);
    setDrInfo(null);
    setDrFinal(null);
    setDrSaveMsg(null);
    setDrCompleteConfirm(false);
    setDrError(null);
    setDrPhase("off");
    engineRef.current = null;
    setCandles(null);
    setMeta(null);
    setEnded(false);
    bump();
  }, [bump, stopTimer]);

  // Refresh-resume: rebuild an in-progress attempt from its server
  // artifacts — the sealed feed (dr_get_revealed: revealed prefix +
  // authoritative position) and the persisted Decision Timeline
  // (fills re-applied at their exact recorded prices, mirroring the
  // saved-session reload below). The starting candle cannot change:
  // resume re-enters the ACTIVE phase directly; there is no path
  // back to preview for this attempt.
  const resumeDailyReplay = useCallback(async () => {
    const offer = drResume;
    if (!offer || drResuming) return;
    // Resume keeps the library-default initial view (no preview was
    // involved) — make sure no earlier attempt's framing leaks in.
    drInitialViewRef.current = null;
    setDrResuming(true);
    setDrError(null);
    try {
      if (!isSupabaseConfigured()) {
        setDrError(DR_STORAGE_MISSING_MSG);
        return;
      }
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setDrError("Please sign in to resume your Daily Replay attempt.");
        return;
      }
      // Re-verify at click time: the attempt may have finished (or
      // been finished on another device) since the offer was shown.
      const { data: att, error: attErr } = await supabase
        .from("daily_replay_attempts")
        .select("id, dataset_id, start_index, position, status, starting_balance")
        .eq("id", offer.attemptId)
        .maybeSingle();
      if (attErr) throw attErr;
      if (!att || !shouldOfferDrResume(att.status)) {
        try { localStorage.removeItem(DAILY_REPLAY_STATE_KEY); } catch { /* ignore */ }
        setDrResume(null);
        setDrError("That Daily Replay attempt is no longer active.");
        return;
      }
      // Sealed feed: attach pulls ONLY the revealed prefix; the
      // position in the response is authoritative.
      const feed = new SealedCandleFeed(createDrTransport(supabase));
      feed.setTotal(offer.total);
      await feed.attach(offer.attemptId);
      // Boundary (same rule as a fresh lock): the locked candle is
      // completed history and the NEXT candle is the first live one.
      // If the server position never moved past the locked candle
      // (locked, then refreshed before playing), release exactly that
      // next candle now so reconstruction has a candle to form; if
      // the position already advanced during the original run, the
      // revealed prefix already contains it.
      const lockIndex = att.start_index as number;
      if (!feed.finished && feed.position <= lockIndex) {
        await feed.advance(1);
      }
      // Decision Timeline: the attempt's persisted events, in order.
      // If they cannot be read (or none were ever persisted), resume
      // the candles + position with a fresh trading state and say so
      // in the timeline — fills are never fabricated.
      let events: DrEvent[] = [];
      let historyOk = true;
      const { data: rows, error: evErr } = await supabase
        .from("daily_replay_events")
        .select("seq, type, wall_ts, market_idx, market_ts, payload")
        .eq("attempt_id", offer.attemptId)
        .order("seq", { ascending: true });
      if (evErr) {
        historyOk = false;
      } else {
        events = (rows ?? []).map((r) => ({
          seq: r.seq as number,
          type: r.type as DrEventType,
          wallTs: Date.parse(r.wall_ts as string),
          marketIdx: (r.market_idx as number | null) ?? null,
          marketTs: r.market_ts != null ? Number(r.market_ts) : null,
          payload: (r.payload ?? {}) as Record<string, unknown>,
        }));
        if (events.length === 0) historyOk = false;
      }
      // Persistent orders: the attempt's daily_replay_orders rows are
      // the AUTHORITATIVE working-order state (v2). Read them under
      // the owner SELECT policy, in creation order; reconstruction
      // re-places exactly the 'working' ones at remaining qty. If the
      // v2 storage is missing, resume proceeds without orders (the
      // pre-v2 behavior) and placement persistence stays latched off.
      let orderRows: DrOrderRow[] = [];
      drOrdersMissingRef.current = false;
      const { data: oRows, error: oErr } = await supabase
        .from("daily_replay_orders")
        .select(
          "id, attempt_id, side, order_type, qty, filled_qty, limit_price, status, engine_order_id, created_at"
        )
        .eq("attempt_id", offer.attemptId)
        .order("created_at", { ascending: true });
      if (oErr) {
        if (isDrStorageMissing(oErr)) {
          drOrdersMissingRef.current = true;
        } else {
          historyOk = false;
        }
      } else {
        orderRows = (oRows ?? []).map((r) => ({
          id: r.id as string,
          attemptId: r.attempt_id as string,
          side: r.side as "buy" | "sell",
          orderType: (r.order_type as string) ?? "limit",
          qty: Number(r.qty),
          filledQty: Number(r.filled_qty),
          limitPrice: Number(r.limit_price),
          status: r.status as DrOrderRow["status"],
          engineOrderId:
            r.engine_order_id != null ? Number(r.engine_order_id) : null,
          createdAt: (r.created_at as string) ?? undefined,
        }));
      }
      const startingBalance =
        Number(att.starting_balance) || DAILY_REPLAY_STARTING_BALANCE;
      const recon = reconstructDrAttempt({
        candles: feed.candles,
        startingBalance,
        startIndex: att.start_index,
        events,
        orders: orderRows,
      });
      const { engine: eng, recorder } = recon;
      // Wire the attempt exactly like a fresh lock does.
      drFeedRef.current = feed;
      drRecorderRef.current = recorder;
      // Everything loaded is already persisted: start past the stream.
      drFlushStateRef.current = newDrFlushState(events.length);
      drSeenFillsRef.current = eng.fills.length; // restored fills are already recorded
      drPlayStartedRef.current = true; // the next Play is a resume, not a start
      drCompletedRef.current = false;
      // Register the restored working orders with the tracker under
      // their persistent ids, so fills/cancels from here on keep
      // updating the SAME server rows (no duplicates, ever). Restored
      // orders emit no new limit_placed events — the originals are
      // already in the loaded stream.
      const tracker = new DrOrderTracker();
      for (const ro of recon.restoredOrders) {
        tracker.track(ro.engineOrderId, {
          id: ro.orderId,
          attemptId: offer.attemptId,
          side: ro.side,
          orderType: "limit",
          qty: ro.qty,
          filledQty: ro.filledQty,
          limitPrice: ro.limitPrice,
          status: "working",
          engineOrderId: ro.engineOrderId,
        });
      }
      drOrderTrackerRef.current = tracker;
      drOrderChainsRef.current = new Map();
      recorder.setListener(() => {
        setDrEvents(recorder.all);
        if (recorder.length - drFlushStateRef.current.offset >= 10) {
          void flushDrEvents();
        }
      });
      setDrEvents(recorder.all);
      // Trade drafts: backfill/reconcile from the restored stream —
      // cycles already closed server-side keep (or gain) their draft
      // rows before any new trading happens.
      void drSyncDraftsFromStream(offer.attemptId, events);
      if (recon.restoredPlannedBrackets) {
        setPlannedSL(recon.restoredPlannedBrackets.sl);
        setPlannedTP(recon.restoredPlannedBrackets.tp);
      }
      // Strategy binding (best-effort): the column exists only once
      // the strategies migration is applied; a failed probe simply
      // leaves the resumed attempt's strategy unshown.
      let resumedVersionId: string | null = null;
      try {
        const { data: sv } = await supabase
          .from("daily_replay_attempts")
          .select("strategy_version_id")
          .eq("id", offer.attemptId)
          .maybeSingle();
        resumedVersionId = (sv?.strategy_version_id as string | null) ?? null;
      } catch { /* column not present yet */ }
      const resumedCtx = resumedVersionId
        ? resolveVersionContext(resumedVersionId, drStrategies, drStrategyVersions)
        : null;
      const info: DrInfo = {
        attemptId: offer.attemptId,
        datasetId: att.dataset_id as string,
        ticker: offer.ticker,
        tradeDate: offer.tradeDate,
        startIndex: att.start_index as number,
        total: offer.total,
        strategyVersionId: resumedVersionId,
        strategyLabel: resumedCtx?.label ?? null,
      };
      stopTimer();
      setEnded(false);
      engineRef.current = eng;
      savedSessionIdRef.current = null;
      lastSavedPnlRef.current = 0;
      setCandles(feed.candles);
      setMeta({
        ticker: info.ticker,
        tradeDate: info.tradeDate,
        source: "twelvedata",
        startIndex: info.startIndex,
      });
      setDrInfo(info);
      setDrHistoryNote(
        historyOk
          ? null
          : "Earlier trade history for this attempt could not be restored, so the trade state starts fresh — your locked starting candle and every candle revealed so far are intact."
      );
      setDrResume(null);
      setDrPhase("active");
      // Quota gate sync point: attempt resumed — fresh server count
      // (a restored open position folds in as the one pending open).
      void syncQuotaFromServer();
      // The reload gap is part of the history: mark it in the
      // timeline (seq continues from the restored maximum).
      recorder.record(
        "session_resumed",
        { via: "page-reload", restoredOrders: recon.restoredOrders.length },
        drCtx()
      );
      bump();
    } catch (e) {
      setDrError(
        isDrStorageMissing(e)
          ? DR_STORAGE_MISSING_MSG
          : e instanceof Error
            ? e.message
            : "Could not resume Daily Replay."
      );
    } finally {
      setDrResuming(false);
    }
  }, [drResume, drResuming, bump, stopTimer, drStrategies, drStrategyVersions]);

  // Load a saved session (?session=<id>)
  useEffect(() => {
    const id = searchParams.get("session");
    if (!id || !isSupabaseConfigured()) return;
    setLoadingSession(true);
    (async () => {
      try {
        const supabase = createClient();
        const { data: s, error } = await supabase
          .from("replay_sessions")
          .select("*")
          .eq("id", id)
          .single();
        if (error || !s) throw new Error("Could not load that saved session.");
        const cs = s.candles as Candle[];
        const { data: trades } = await supabase
          .from("session_trades")
          .select("*")
          .eq("session_id", id)
          .order("created_at", { ascending: true });
        stopTimer();
        setEnded(false);
        // When loading a saved session, subtract its realized P&L from the
        // current balance before replaying fills — so the final balance
        // matches the persistent account balance (no double-counting).
        const fills = (trades ?? []).slice().sort((a, b) => a.candle_index - b.candle_index);
        let sessionPnl = 0;
        for (const t of fills) {
          if (t.realized_pnl != null && isFinite(Number(t.realized_pnl))) {
            sessionPnl += Number(t.realized_pnl);
          }
        }
        const eng = new ReplayEngine(cs, balanceRef.current - sessionPnl, s.start_index ?? 0);
        // fast-forward through the recorded fills to rebuild state,
        // replaying each at its exact recorded price for P/L fidelity
        for (const t of fills) {
          while (eng.index < t.candle_index) eng.step();
          if (t.side === "buy") eng.buyAt(Number(t.qty), Number(t.price), t.candle_index, new Date(t.candle_time).getTime());
          else eng.sellAt(Number(t.qty), Number(t.price), t.candle_index, new Date(t.candle_time).getTime());
        }
        engineRef.current = eng;
        setCandles(cs);
        setMeta({ ticker: s.ticker, tradeDate: s.trade_date, source: normalizeReloadedSource(s.source as string), startIndex: s.start_index ?? 0 });
        bump();
        // Quota gate sync point: restored session — the server
        // count already holds its saved trades; a still-open
        // restored position folds in as the one pending open.
        void syncQuotaFromServer();
      } catch (e) {
        setSaveMsg(e instanceof Error ? e.message : "Failed to load session.");
      } finally {
        setLoadingSession(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Daily Replay resume detection (mount, best-effort): if the
  // resume hint names an attempt the server still reports 'active'
  // for this signed-in user, offer to resume it. Finished/abandoned/
  // missing attempts clear the hint silently; an unverifiable hint
  // (signed out, storage not enabled) is left alone and stays silent.
  useEffect(() => {
    if (searchParams.get("session")) return; // a saved-session load wins
    let cancelled = false;
    (async () => {
      try {
        if (!isSupabaseConfigured()) return;
        const raw = localStorage.getItem(DAILY_REPLAY_STATE_KEY);
        const hint = decodeDrResumeHint(raw);
        if (!hint) {
          if (raw) {
            try { localStorage.removeItem(DAILY_REPLAY_STATE_KEY); } catch { /* ignore */ }
          }
          return;
        }
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return; // leave the hint for a signed-in visit
        const { data: att, error } = await supabase
          .from("daily_replay_attempts")
          .select("id, dataset_id, start_index, position, status, starting_balance")
          .eq("id", hint.attemptId)
          .maybeSingle();
        if (cancelled || error) return; // cannot verify — keep the hint, stay silent
        if (!att || !shouldOfferDrResume(att.status)) {
          try { localStorage.removeItem(DAILY_REPLAY_STATE_KEY); } catch { /* ignore */ }
          return;
        }
        const { data: ds } = await supabase
          .from("daily_replay_datasets")
          .select("ticker, trade_date, candle_count")
          .eq("id", att.dataset_id)
          .maybeSingle();
        if (cancelled) return;
        if (!ds) {
          // Attempt without its dataset can never resume.
          try { localStorage.removeItem(DAILY_REPLAY_STATE_KEY); } catch { /* ignore */ }
          return;
        }
        setDrResume({
          attemptId: att.id as string,
          ticker: ds.ticker as string,
          tradeDate: ds.trade_date as string,
          startIndex: att.start_index as number,
          position: att.position as number,
          total: ds.candle_count as number,
          startingBalance:
            Number(att.starting_balance) || DAILY_REPLAY_STARTING_BALANCE,
        });
      } catch {
        /* resume is best-effort; the normal flow is unaffected */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snap = useMemo(() => {
    const eng = engineRef.current;
    if (!eng) return null;
    return {
      price: eng.displayPrice,
      cash: eng.cash,
      qty: eng.positionQty,
      avg: eng.positionAvg,
      unreal: eng.unrealizedPnl(),
      realized: eng.realizedPnl,
      equity: eng.equity(),
      fills: eng.fills,
      pendingOrders: eng.pendingOrders,
      stopLoss: eng.stopLoss,
      takeProfit: eng.takeProfit,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, candles]);

  // Aggregated chart candles for the selected timeframe.
  // displayCandles contains only revealed data (finalized + forming 1-min),
  // so aggregation can never leak future candles.
  const chartCandles = useMemo(() => {
    const eng = engineRef.current;
    if (!eng) return null;
    return aggregateCandles(eng.displayCandles, timeframeMinutes(timeframe));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, timeframe, candles]);

  // Timeframe-aware countdown: higher timeframes count down the full period.
  const tfCountdown = useMemo(() => {
    const eng = engineRef.current;
    if (!eng || !playing) return null;
    const mins = timeframeMinutes(timeframe);
    if (mins <= 1) return countdownText(eng.formationProgress, speed);
    const forming1m = eng.candles[eng.index + 1];
    if (!forming1m) return null;
    const prog = higherTimeframeProgress(eng.formationProgress, forming1m.t, mins);
    return countdownTextFor(prog, speed, mins * 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, timeframe, playing, speed, candles]);

  // Auto-save: trigger when realized P&L changes (trade closed) for signed-in users.
  // Debounced by 2 seconds to avoid saving mid-fill-sequence.
  const lastRealizedRef = useRef<number>(0);
  useEffect(() => {
    const realized = snap?.realized ?? 0;
    if (realized !== lastRealizedRef.current) {
      lastRealizedRef.current = realized;
      // Only auto-save if we have a session loaded and trades exist
      if (meta && candles && candles.length > 0 && autoSaveEnabledRef.current) {
        const t = setTimeout(() => saveSession(true), 2000);
        return () => clearTimeout(t);
      }
    }
  }, [snap?.realized, meta, candles?.length]);

  // Periodic auto-save every 60 seconds if there are unsaved trades.
  useEffect(() => {
    if (!meta || !candles || candles.length === 0) return;
    const id = setInterval(() => {
      const eng = engineRef.current;
      if (eng && eng.fills.length > 0 && autoSaveEnabledRef.current) {
        // Only save if P&L changed since last save
        if (eng.realizedPnl !== lastSavedPnlRef.current) {
          saveSession(true);
        }
      }
    }, 60000);
    return () => clearInterval(id);
  }, [meta, candles?.length]);

  // Memoized brackets: stable reference unless values actually change.
  // The key captures current values; useMemo returns the cached object
  // when the key is identical, preventing re-renders from creating
  // a new object every 50ms tick.
  const bracketKey = `${plannedSL}|${plannedTP}|${engineRef.current?.stopLoss}|${engineRef.current?.takeProfit}`;
  const brackets = useMemo(() => {
    const eng = engineRef.current;
    return {
      plannedSL,
      plannedTP,
      activeSL: eng?.stopLoss ?? null,
      activeTP: eng?.takeProfit ?? null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bracketKey]);

  // Per-position realized P&L: capture session realized baseline when a
  // position opens (qty 0 -> positive). Position realized = session - baseline.
  // Survives partial sells and add-on buys; resets on next open.
  const posRealizedBaseline = useRef(0);
  const prevPosQty = useRef(0);
  const engForPnl = engineRef.current;
  const curQty = engForPnl?.positionQty ?? 0;
  if (prevPosQty.current === 0 && curQty > 0) {
    posRealizedBaseline.current = engForPnl?.realizedPnl ?? 0;
    // Subscription quota: a NEW position just opened — on ANY path
    // (market buy, limit fill, step/play tick) — and will consume
    // one daily slot when it is recorded. Adds never reach here
    // (qty already positive), closes never reach here.
    if (quotaUserIdRef.current) quotaOpenedRef.current += 1;
  }
  prevPosQty.current = curQty;
  const positionRealized = (engForPnl?.realizedPnl ?? 0) - posRealizedBaseline.current;

  // --- Psychology Guard V1 (position-based) ---
  const [guardThresholds, setGuardThresholds] = useState<GuardThreshold[]>(() => loadThresholds());
  const [guardLockout, setGuardLockout] = useState<LockoutState | null>(() => loadLockout());
  const [guardUserId, setGuardUserId] = useState<string | null>(null);
  // Ref mirror for use inside the tick-loop closure (which captures initial values).
  const guardUserIdRef = useRef<string | null>(null);
  useEffect(() => { guardUserIdRef.current = guardUserId; }, [guardUserId]);
  // Quota buy gate: identity mirror + the initial entitlement load
  // (later refreshes ride the session/save sync points).
  useEffect(() => {
    quotaUserIdRef.current = guardUserId;
    if (guardUserId) void syncQuotaFromServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardUserId]);
  // Guest trade limit (5/day, guests only).
  const [guestRemaining, setGuestRemaining] = useState<number>(GUEST_DAILY_LIMIT);
  const [showGuestModal, setShowGuestModal] = useState(false);

  // Refresh guest remaining count (guests only; signed-in always see full).
  const refreshGuestTrades = async () => {
    if (guardUserId) {
      setGuestRemaining(GUEST_DAILY_LIMIT);
      return;
    }
    const r = await getGuestTradesRemaining(
      isSupabaseConfigured() ? createClient() : null,
      getGuestFingerprint()
    );
    setGuestRemaining(r);
  };

  // Load guest count on mount and when auth state resolves.
  useEffect(() => {
    refreshGuestTrades();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardUserId]);

  // On mount: sync lockout across browsers.
  // Signed-in: via profiles table. Guest: via device fingerprint.
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          setGuardUserId(user.id);
          const remote = await loadLockoutRemote(supabase, user.id);
          if (remote) {
            const merged = mergeLockouts(loadLockout(), remote);
            if (merged) {
              saveLockout(merged); // sync local cache
              setGuardLockout(merged);
            }
          }
        } else {
          // Guest: check device fingerprint for cross-browser lockout.
          const fp = deviceFingerprint();
          const remote = await loadGuestLockoutRemote(supabase, fp);
          if (remote) {
            const merged = mergeLockouts(loadLockout(), remote);
            if (merged) {
              saveLockout(merged);
              setGuardLockout(merged);
            }
          }
        }
      } catch { /* offline — localStorage fallback stands */ }
    })();
  }, []);
  const [guardWarned, setGuardWarned] = useState(false);
  const guardBaseline = useRef<PositionBaseline | null>(null);
  const guardLastTrigger = useRef<number>(0); // highest threshold already acted on
  const guardPrevQty = useRef(0);

  // Track position baseline: set on open (0 -> N), update on adds, clear on close.
  const gQty = engForPnl?.positionQty ?? 0;
  const gAvg = engForPnl?.positionAvg ?? 0;
  if (guardPrevQty.current === 0 && gQty > 0) {
    guardBaseline.current = { shares: gQty, avgEntry: gAvg, value: gQty * gAvg };
    guardLastTrigger.current = 0;
    setGuardWarned(false);
  } else if (guardPrevQty.current > 0 && gQty > guardPrevQty.current) {
    // Added shares: extend baseline to new total.
    guardBaseline.current = { shares: gQty, avgEntry: gAvg, value: gQty * gAvg };
  } else if (gQty === 0 && guardPrevQty.current > 0) {
    guardBaseline.current = null;
    guardLastTrigger.current = 0;
    setGuardWarned(false);
  }
  guardPrevQty.current = gQty;

  const guardLoss = calculatePositionLoss(
    guardBaseline.current,
    positionRealized,
    engForPnl?.unrealizedPnl() ?? 0
  );
  const guardLossPct = guardLoss?.lossPct ?? null;

  // Evaluate thresholds (highest applicable, once per crossing).
  const hitThreshold = guardLossPct != null ? activeThreshold(guardLossPct, guardThresholds) : null;
  if (hitThreshold && hitThreshold.lossPct > guardLastTrigger.current && guardBaseline.current) {
    guardLastTrigger.current = hitThreshold.lossPct;
    if (hitThreshold.lockMinutes > 0) {
      const lock: LockoutState = {
        expiry: Date.now() + hitThreshold.lockMinutes * 60_000,
        threshold: hitThreshold.lossPct,
        startedAt: Date.now(),
      };
      saveLockout(lock);
      setGuardLockout(lock);
      setGuardWarned(false);
      // Sync to Supabase for cross-browser persistence.
      // Signed-in: profiles table. Guest: device fingerprint.
      if (isSupabaseConfigured()) {
        const supabase = createClient();
        if (guardUserId) {
          saveLockoutRemote(supabase, guardUserId, lock);
        } else {
          saveGuestLockoutRemote(supabase, deviceFingerprint(), lock);
        }
      }
    } else {
      setGuardWarned(true);
    }
  }

  // Lockout expiry check (for display; loadLockout also cleans on read).
  const nowTs = Date.now();
  const lockoutActive = guardLockout != null && guardLockout.expiry > nowTs;
  if (guardLockout && !lockoutActive) {
    clearLockout();
    setGuardLockout(null);
    if (guardUserId && isSupabaseConfigured()) {
      clearLockoutRemote(createClient(), guardUserId);
    }
  }

  // Install engine guard: blocks buys (market + limit) during lockout.
  // Sells, SL/TP triggers, and historical replay are never blocked.
  if (engForPnl) {
    engForPnl.tradeGuard = lockoutActive
      ? () => `Psychology Guard: new entries locked for ${formatCountdown(guardLockout!.expiry - Date.now())} (${guardLockout!.threshold}% position loss). Exits allowed.`
      : null;
  }

  // Countdown ticker to refresh remaining-time display.
  const [, setGuardTick] = useState(0);
  useEffect(() => {
    if (!lockoutActive) return;
    const id = setInterval(() => setGuardTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [lockoutActive]);

  const buyErr = (qty: number): string | null => {
    const eng = engineRef.current;
    if (!eng) return "Load a session first.";
    const rec = drRec();
    const q = Math.floor(qty);
    if (!(qty > 0)) {
      rec?.recordOrderRejected({ side: "buy", qty: q, reason: "Enter a share quantity." }, drCtx());
      return "Enter a share quantity.";
    }
    // Psychology Guard: block entries during lockout (engine also enforces).
    if (eng.tradeGuard) {
      const msg = eng.tradeGuard();
      if (msg) {
        rec?.recordOrderRejected({ side: "buy", qty: q, reason: msg }, drCtx());
        return msg;
      }
    }
    rec?.recordOrderSubmitted({ orderType: "market", side: "buy", qty: q }, drCtx());
    const f = eng.buy(q);
    if (f) {
      // Activate any planned SL/TP on the new position.
      if (plannedSL != null || plannedTP != null) {
        eng.setBrackets(plannedSL, plannedTP);
        drBracketsChanged(plannedSL, plannedTP, "control", "active");
        drBracketsChanged(null, null, "control", "planned");
        setPlannedLevels(null, null);
      }
    }
    bump();
    if (!f) {
      rec?.recordOrderRejected({ side: "buy", qty: q, reason: "Not enough virtual cash for that size." }, drCtx());
      return "Not enough virtual cash for that size.";
    }
    return null;
  };
  const sellErr = (qty: number): string | null => {
    const eng = engineRef.current;
    if (!eng) return "Load a session first.";
    const rec = drRec();
    const q = Math.floor(qty);
    rec?.recordOrderSubmitted({ orderType: "market", side: "sell", qty: q }, drCtx());
    const f = eng.sell(q);
    bump();
    if (!f) {
      rec?.recordOrderRejected({ side: "sell", qty: q, reason: "No open position to sell." }, drCtx());
      return "No open position to sell.";
    }
    return null;
  };

  // Guest trade limit gate: wraps buyErr for new positions (guests only).
  // Adds, closes, failed orders, and signed-in users are never gated.
  const gateBuy = async (qty: number): Promise<string | null> => {
    const eng = engineRef.current;
    if (!eng) return "Load a session first.";
    const isNewPosition = eng.positionQty === 0;
    const isGuest = !guardUserId; // works with or without Supabase (localStorage fallback)
    // Subscription daily-quota gate (signed-in only): the 4th
    // new-position buy must not execute — show the upgrade modal
    // instead. The DB cap at save/draft time remains the backstop;
    // guests skip this entirely (their gate is below).
    if (isNewPosition && !isGuest) {
      // Entitlement ref empty (sync raced or RPC failed earlier):
      // refresh just-in-time so the gate never silently evaluates
      // on "unknown" when one bounded re-read can settle it.
      if (!entitlementRef.current) await refreshQuotaJit();
      if (quotaBuyBlocked()) {
        setShowUpgradeModal(true);
        return quotaBlockMessage();
      }
    }
    // Pre-check: block before consuming if already at limit.
    if (isNewPosition && isGuest) {
      const remaining = await getGuestTradesRemaining(
        isSupabaseConfigured() ? createClient() : null,
        getGuestFingerprint()
      );
      setGuestRemaining(remaining);
      if (remaining <= 0) {
        setShowGuestModal(true);
        return "Daily guest limit reached (5 trades).";
      }
    }
    const result = buyErr(qty);
    // Consume only on successful NEW position open.
    if (result === null && isNewPosition && isGuest) {
      const consumed = await consumeGuestTrade(
        isSupabaseConfigured() ? createClient() : null,
        getGuestFingerprint()
      );
      const remaining = await getGuestTradesRemaining(
        isSupabaseConfigured() ? createClient() : null,
        getGuestFingerprint()
      );
      setGuestRemaining(remaining);
    }
    return result;
  };

  // Basic trading hotkeys (Phase A1). Disabled while typing in inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const eng = engineRef.current;
      if (!eng) return;
      const key = e.key;
      const match = (binding: string) => key.toLowerCase() === binding.toLowerCase();

      if (match(DEFAULT_HOTKEYS.buy)) {
        e.preventDefault();
        gateBuy(Math.floor(Number(orderQty) || 0));
      } else if (match(DEFAULT_HOTKEYS.exit)) {
        e.preventDefault();
        if (eng.positionQty > 0) sellErr(eng.positionQty);
      } else if (match(DEFAULT_HOTKEYS.cancelOrders)) {
        e.preventDefault();
        eng.cancelAllOrders();
        bump();
      } else if (match(DEFAULT_HOTKEYS.playPause)) {
        e.preventDefault();
        if (playing) stopTimer();
        else { setEnded(false); setPlayNonce((n) => n + 1); setPlaying(true); }
      } else if (match(DEFAULT_HOTKEYS.stepForward)) {
        e.preventDefault();
        if (!playing) {
          // Daily Replay: the hotkey must release sealed candles at
          // the held end exactly like the Step button does.
          if (drPhaseRef.current === "active") void drStepNext();
          else { eng.step(); setEnded(eng.atEnd); bump(); }
        }
      } else if (match(DEFAULT_HOTKEYS.speed05)) { setSpeed(0.5); }
      else if (match(DEFAULT_HOTKEYS.speed1)) { setSpeed(1); }
      else if (match(DEFAULT_HOTKEYS.speed2)) { setSpeed(2); }
      else if (match(DEFAULT_HOTKEYS.speed4)) { setSpeed(4); }
      else if (match(DEFAULT_HOTKEYS.speed8)) { setSpeed(8); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, orderQty, buyErr, sellErr, stopTimer, bump, drStepNext]);

  const placeLimitErr = (side: "buy" | "sell", qty: number, price: number): string | null => {
    const eng = engineRef.current;
    if (!eng) return "Load a session first.";
    // Subscription daily-quota gate (signed-in only), mirroring the
    // guest pre-check below: never even place a new-position limit
    // buy when no daily slot is left.
    if (side === "buy" && eng.positionQty === 0 && guardUserIdRef.current && quotaBuyBlocked()) {
      setShowUpgradeModal(true);
      return quotaBlockMessage();
    }
    // Guest limit applies to limit buys too (not just market buys).
    // Note: consumption happens when the limit order FILLS (see fill handling),
    // so we only pre-check here to block placement at the limit.
    if (side === "buy" && eng.positionQty === 0 && !guardUserIdRef.current) {
      // Async pre-check: run synchronously-blocked via the caller's error display.
      // We do a best-effort sync check using cached remaining count.
      if (guestRemaining !== null && guestRemaining <= 0) {
        setShowGuestModal(true);
        return "Daily guest limit reached (5 trades).";
      }
    }
    const pendingBefore = new Set(eng.pendingOrders.map((o) => o.id));
    const err = eng.placeLimitOrder(side, qty, price);
    const rec = drRec();
    if (err) {
      // Engine refused synchronously — the order exists nowhere and
      // is never persisted (a rejected placement cannot resurrect).
      rec?.recordOrderRejected({ side, qty, reason: err }, drCtx());
    } else {
      // The accepted order is the one pending entry that is new.
      const placed = eng.pendingOrders.find((o) => !pendingBefore.has(o.id));
      // Daily Replay: register the order server-side under a fresh
      // persistent uuid BEFORE recording, so the timeline events and
      // the authoritative order row share the same identity.
      let orderUuid: string | undefined;
      const tracker = drOrderTrackerRef.current;
      const info = drInfoRef.current;
      if (placed && tracker && info && drPhaseRef.current === "active") {
        orderUuid = newDrOrderId();
        const row: DrOrderRow = {
          id: orderUuid,
          attemptId: info.attemptId,
          side: placed.side,
          orderType: "limit",
          qty: placed.qty,
          filledQty: 0,
          limitPrice: placed.limitPrice,
          status: "working",
          engineOrderId: placed.id,
        };
        tracker.track(placed.id, row);
        persistDrOrderPlace(row);
      }
      rec?.recordOrderSubmitted(
        { orderType: "limit", side, qty, requestedPrice: price, orderUuid },
        drCtx()
      );
      rec?.recordLimitPlaced({ side, qty, limitPrice: price, orderUuid }, drCtx());
    }
    bump();
    return err;
  };

  const saveSession = async (isAutoSave = false) => {
    // Daily Replay has its own save path (see completeDailyReplay):
    // routing a DR session through here would wrongly apply its P&L to
    // the persistent Trade Lab balance as a delta.
    if (drPhaseRef.current === "active" || drPhaseRef.current === "done") return;
    const eng = engineRef.current;
    if (!eng || !candles || !meta) return;
    if (!isSupabaseConfigured()) {
      if (!isAutoSave) setSaveMsg("Supabase is not configured — sessions cannot be saved yet.");
      return;
    }
    // Auto-save only for signed-in users
    if (isAutoSave && !autoSaveEnabled) return;
    if (!isAutoSave) setSaving(true);
    setSaveMsg(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        if (!isAutoSave) throw new Error("Please sign in to save sessions.");
        return;
      }
      const sessionData = {
        user_id: user.id,
        ticker: meta.ticker,
        trade_date: meta.tradeDate,
        source: meta.source,
        candles,
        start_index: meta.startIndex,
        final_cash: eng.cash,
        realized_pnl: eng.realizedPnl,
      };
      let sessionId: string | null = null;
      /* Subscriptions path (migration subscriptions-v1): the save runs
       * through the security-definer save_replay_session RPC — ONE
       * transaction that upserts the session, replaces the fills,
       * regroups closed trades server-side (groupFillsIntoTrades
       * parity, pinned by the SQL harness) and consumes quota for NEW
       * trade keys only; the balance is the same delta-guarded value
       * the legacy path computes (passed in, stored verbatim). Falls
       * back to the legacy client writes below ONLY when the RPC does
       * not exist yet (pre-migration database). A quota rejection
       * never falls back — that would bypass the cap. */
      {
        const deltaNow = eng.realizedPnl - lastSavedPnlRef.current;
        const balanceArg = isFinite(deltaNow) && deltaNow !== 0 ? balanceRef.current + deltaNow : null;
        const { data: rpcId, error: rpcErr } = await supabase.rpc("save_replay_session", {
          p_session_id: savedSessionIdRef.current,
          p_session: {
            ticker: meta.ticker, trade_date: meta.tradeDate, source: meta.source,
            candles, start_index: meta.startIndex,
            final_cash: eng.cash, realized_pnl: eng.realizedPnl,
          },
          p_fills: eng.fills.map((f) => ({
            side: f.side, qty: f.qty, price: f.price, candleIndex: f.candleIndex,
            time: f.time, realizedPnl: f.realizedPnl, note: f.note ?? null,
          })),
          p_account_balance: balanceArg,
        });
        if (!rpcErr && rpcId) {
          sessionId = rpcId as string;
          savedSessionIdRef.current = sessionId;
        } else if (rpcErr) {
          const q = parseQuotaError(rpcErr);
          if (q) throw new Error(quotaMessage(q));
          const missing = rpcErr.code === "PGRST202" || rpcErr.code === "42883"
            || /save_replay_session/.test(rpcErr.message ?? "");
          if (!missing) throw new Error(rpcErr.message);
          // else: pre-migration database — legacy path below.
        }
      }
      if (!sessionId) {
      // Upsert: update existing auto-saved session, or insert new one
      if (savedSessionIdRef.current) {
        const { error } = await supabase
          .from("replay_sessions")
          .update(sessionData)
          .eq("id", savedSessionIdRef.current)
          .eq("user_id", user.id);
        if (error) throw new Error(error.message);
        sessionId = savedSessionIdRef.current;
        // Replace trades with current fills
        await supabase.from("session_trades").delete().eq("session_id", sessionId);
      } else {
        const { data: s, error } = await supabase
          .from("replay_sessions")
          .insert(sessionData)
          .select("id")
          .single();
        if (error || !s) throw new Error(error?.message ?? "Save failed.");
        sessionId = s.id;
        savedSessionIdRef.current = sessionId;
      }
      if (eng.fills.length > 0) {
        const { error: tErr } = await supabase.from("session_trades").insert(
          eng.fills.map((f) => ({
            session_id: sessionId,
            user_id: user.id,
            side: f.side,
            qty: f.qty,
            price: f.price,
            candle_index: f.candleIndex,
            candle_time: new Date(f.time).toISOString(),
            realized_pnl: f.realizedPnl,
            note: f.note ?? null,
          }))
        );
        if (tErr) throw new Error(tErr.message);
      }
      }
      // Update persistent account balance with this session's realized P&L.
      // For auto-save, only apply the DELTA since last save to avoid double-counting.
      // (On the RPC path the same value was already stored inside the
      // save transaction; persistBalance below rewrites it identically
      // and keeps the local balance state on the one existing path.)
      const pnl = eng.realizedPnl;
      const lastPnl = lastSavedPnlRef.current;
      const delta = pnl - lastPnl;
      if (isFinite(delta) && delta !== 0) {
        await persistBalance(balanceRef.current + delta);
        lastSavedPnlRef.current = pnl;
      }
      // Quota gate sync point: the save just recorded this
      // session's new trades server-side — refresh the daily count
      // so the gate tracks the server, not stale local opens.
      await syncQuotaFromServer();
      if (!isAutoSave) {
        setSaveMsg("Session saved — find it under My Sessions.");
      } else {
        setSaveMsg("Auto-saved.");
        // Clear the auto-save message after 3 seconds
        setTimeout(() => setSaveMsg((m) => m === "Auto-saved." ? null : m), 3000);
      }
    } catch (e) {
      if (!isAutoSave) setSaveMsg(e instanceof Error ? e.message : "Save failed.");
    } finally {
      if (!isAutoSave) setSaving(false);
    }
  };

  /* Daily Replay completion: save the finished attempt to the journal
   * via replay_sessions/session_trades like a normal session — by now
   * every candle has been legitimately revealed to this user — but
   * WITHOUT the profiles.account_balance delta (DR money is separate),
   * then mark the attempt finished server-side with the session link. */
  const completeDailyReplay = useCallback(async () => {
    const eng = engineRef.current;
    const feed = drFeedRef.current;
    const info = drInfoRef.current;
    if (!eng || !feed || !info) return;
    // Settle fills/orders from the final candle FIRST: a limit order
    // that filled on it must reach its server row as 'filled' before
    // the settle-all below marks the leftovers cancelled. (The sync
    // is idempotent; the version effect will re-run it as a no-op.)
    drSyncFills();
    drRecorderRef.current?.record(
      "session_completed",
      { realizedPnl: eng.realizedPnl, equity: eng.equity() },
      drCtx()
    );
    // Any order still working at the end is extinguished with the
    // session: settle its server row as cancelled so it can never be
    // restored (the attempt is about to be marked finished anyway).
    drSettleTrackedOrders();
    setDrFinal({ realized: eng.realizedPnl, equity: eng.equity() });
    setDrPhase("done");
    try {
      if (!isSupabaseConfigured()) {
        setDrSaveMsg("Replay complete. (Session saving is unavailable — Supabase is not configured.)");
        return;
      }
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setDrSaveMsg("Replay complete. (Not signed in — session was not saved.)");
        return;
      }
      // Completion is ONE server-side transaction (strategies
      // migration): dr_complete_attempt locks the attempt row, and a
      // retry or concurrent second call returns the EXISTING session
      // id without inserting — an attempt can never produce two
      // journal sessions. The session saves with source
      // 'daily_replay'; ticker/date are read server-side from the
      // attempt's own dataset.
      let completedSessionId: string | null = null;
      const fillsPayload = eng.fills.map((f) => ({
        side: f.side,
        qty: f.qty,
        price: f.price,
        candle_index: f.candleIndex,
        candle_time: new Date(f.time).toISOString(),
        realized_pnl: f.realizedPnl,
        note: f.note ?? null,
      }));
      const { data: completedId, error: cErr } = await supabase.rpc("dr_complete_attempt", {
        p_attempt_id: info.attemptId,
        p_candles: feed.candles,
        p_start_index: info.startIndex,
        p_final_cash: eng.cash,
        p_realized_pnl: eng.realizedPnl,
        p_fills: fillsPayload,
      });
      if (cErr && !isMissingDrFunction(cErr, "dr_complete_attempt")) throw cErr;
      if (cErr) {
        // The strategies migration is not applied on this deployment
        // yet: complete exactly as before it existed (direct inserts
        // + dr_finish_attempt, source 'twelvedata'). Nothing about
        // today's behavior changes until the migration lands.
        const { data: s, error } = await supabase
          .from("replay_sessions")
          .insert({
            user_id: user.id,
            ticker: info.ticker,
            trade_date: info.tradeDate,
            source: "twelvedata",
            candles: feed.candles,
            start_index: info.startIndex,
            final_cash: eng.cash,
            realized_pnl: eng.realizedPnl,
          })
          .select("id")
          .single();
        if (error || !s) throw error ?? new Error("Daily Replay session save failed.");
        completedSessionId = s.id;
        if (eng.fills.length > 0) {
          const { error: tErr } = await supabase.from("session_trades").insert(
            fillsPayload.map((f) => ({ ...f, session_id: s.id, user_id: user.id }))
          );
          if (tErr) throw tErr;
        }
        const { error: fErr } = await supabase.rpc("dr_finish_attempt", {
          p_attempt_id: info.attemptId,
          p_session_id: s.id,
        });
        if (fErr) throw fErr;
      } else if (!completedId) {
        throw new Error("Daily Replay completion returned no session.");
      }
      if (!cErr && completedId) completedSessionId = String(completedId);
      // The attempt is finished server-side: the resume hint is spent.
      try { localStorage.removeItem(DAILY_REPLAY_STATE_KEY); } catch { /* ignore */ }
      await flushDrEvents();
      setDrSaveMsg("Saved to your journal — find it under My Sessions.");
      /* Trade-draft reconciliation (post-completion, best-effort):
       * link each final-generation draft to its grouped journal
       * trade, create any draft the live writer missed, supersede
       * earlier-generation leftovers, and copy annotations forward
       * for already-finalized drafts. The completion transaction
       * above is untouched and already committed — a failure here is
       * swallowed and the reconciler is safely re-runnable. */
      if (completedSessionId) {
        try {
          const trades = groupFillsIntoTrades(
            fillsPayload.map((f) => ({ ...f, session_id: completedSessionId as string })) as unknown as RawFill[],
            { id: completedSessionId, ticker: info.ticker, trade_date: info.tradeDate, source: "daily_replay" }
          );
          const existing = await fetchDraftsForAttempts(supabase, [info.attemptId]);
          const plan = reconcileDrafts({
            attemptId: info.attemptId,
            sessionId: completedSessionId,
            events: drRecorderRef.current?.all ?? [],
            trades,
            drafts: existing,
            allowCreate: true,
          });
          const rowsByKey = new Map<string, DrDraftRow>();
          for (const d of existing) rowsByKey.set(d.draftKey, d);
          for (const payload of plan.creates) {
            const res = await upsertDraft(supabase, user.id, payload);
            if (res.error) {
              if (isDraftsStorageMissing(res.error)) {
                drDraftsMissingRef.current = true;
                setDrDraftsAvailable(false);
              }
              continue;
            }
            if (res.data) rowsByKey.set(res.data.draftKey, res.data);
          }
          for (const m of plan.mappings) {
            const target = m.draftId
              ? m.draftId
              : (rowsByKey.get(m.draftKey)?.id ?? m.draftKey);
            await writeDraftMapping(supabase, target, m.finalizedSessionId, m.finalizedTradeKey);
          }
          for (const id of plan.supersedeDraftIds) {
            await supersedeDraft(supabase, id);
          }
          for (const m of plan.mappings) {
            const row = rowsByKey.get(m.draftKey);
            if (row && row.status === "finalized") {
              await copyDraftMetaForward(
                supabase, user.id, m.draftKey, m.finalizedTradeKey, m.finalizedSessionId
              );
            }
          }
          if (!drDraftsMissingRef.current) {
            const refreshed = await fetchDraftsForAttempts(supabase, [info.attemptId]);
            setDrDraftRows(refreshed);
          }
        } catch { /* reconciliation never blocks or un-saves completion */ }
      }
    } catch (e) {
      setDrSaveMsg(
        `Replay complete — journal save failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
    // The timeline flushes regardless of how the journal save went.
    await flushDrEvents();
  }, []);

  /* User-triggered EARLY completion: end the session at the CURRENT
   * candle instead of waiting for the end of the feed, through the
   * exact same completion path as the end-of-feed effect below —
   * same drCompletedRef guard (no double completion; the RPC is
   * itself idempotent), same fills sync, same working-order
   * settlement, same post-completion draft reconciliation. The saved
   * session holds only the candles revealed so far; the remaining
   * candles stay sealed on the server and unseen. Playback stops
   * first so no further candle is released while the completion
   * payload is built, and a one-candle release already in flight is
   * allowed to land so the saved set is the feed's settled prefix. */
  const requestCompleteDrNow = useCallback(async () => {
    if (drPhaseRef.current !== "active" || drCompletedRef.current) return;
    drCompletedRef.current = true;
    setDrCompleteConfirm(false);
    stopTimer();
    setPlaying(false);
    for (let i = 0; i < 100 && drAdvancingRef.current; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await completeDailyReplay();
  }, [completeDailyReplay, stopTimer]);

  // Fires when the play/step flow reports the end. In Daily Replay that
  // only counts once the feed is finished (every candle released); at
  // the merely-held end it is a buffering state, not completion.
  useEffect(() => {
    if (!ended || drPhase !== "active") return;
    const feed = drFeedRef.current;
    if (!feed || !feed.finished) {
      setEnded(false);
      return;
    }
    if (drCompletedRef.current) return;
    drCompletedRef.current = true;
    void completeDailyReplay();
  }, [ended, drPhase, completeDailyReplay]);

  /* ---------------- Decision Timeline plumbing ----------------
   * flushDrEvents / drSyncFills / drBracketsChanged / drCtx are plain
   * closures (not hooks) used by handlers defined across this file;
   * they only ever run in response to user actions or effects, after
   * the component body has fully initialized. */

  /** The recorder, only while a Daily Replay attempt is on screen. */
  const drRec = (): DrEventRecorder | null =>
    drPhaseRef.current === "active" || drPhaseRef.current === "done"
      ? drRecorderRef.current
      : null;

  /** Current market-candle context for an event. */
  const drCtx = (): { marketIdx: number | null; marketTs: number | null } => {
    const e = engineRef.current;
    if (!e) return { marketIdx: null, marketTs: null };
    return {
      marketIdx: e.index,
      marketTs: e.candles[e.index]?.t ?? null,
    };
  };

  /** Feed an SL/TP application (drag or control, planned or active). */
  const drBracketsChanged = (
    sl: number | null,
    tp: number | null,
    method: DrBracketMethod,
    scope: DrBracketScope
  ): void => {
    const rec = drRec();
    if (!rec) return;
    const e = engineRef.current;
    rec.recordBrackets(sl, tp, method, scope, drCtx(), {
      avgEntry: e && e.positionQty > 0 ? e.positionAvg : null,
      direction: "long", // the engine is long-only in this round
    });
  };

  /**
   * Persist recorded events through the serialized flusher
   * (lib/drEventFlush.ts). If the events table is missing (migration
   * not applied yet), the flusher latches that and stops trying —
   * the timeline still works in-page and at completion, and nothing
   * crashes. Other failures keep the events pending for the next
   * flush. Never throws.
   *
   * The recorder, attempt id, and flush state are captured at call
   * time, so a flush queued for one attempt always writes that
   * attempt's events against that attempt's own state — even if a new
   * attempt has started by the time the queued flush runs.
   */
  const flushDrEvents = async (): Promise<void> => {
    const rec = drRecorderRef.current;
    const info = drInfoRef.current;
    if (!rec || !info) return;
    const attemptId = info.attemptId;
    const state = drFlushStateRef.current;
    await drEventFlusherRef.current.flush(
      state,
      () => rec.all,
      async (pending) => {
        if (!isSupabaseConfigured()) return "skip";
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return "skip";
        // Upsert with ignore-duplicates on the (attempt_id, seq)
        // unique constraint: a batch retried after an uncertain
        // failure (rows landed, response lost) used to die with 23505
        // and wedge every later flush at the same offset — now the
        // already-landed rows are simply skipped and the rest still
        // insert.
        const { error } = await supabase.from("daily_replay_events").upsert(
          pending.map((e) => ({
            attempt_id: attemptId,
            user_id: user.id,
            seq: e.seq,
            type: e.type,
            wall_ts: new Date(e.wallTs).toISOString(),
            market_idx: e.marketIdx,
            market_ts: e.marketTs,
            payload: e.payload,
          })),
          { onConflict: "attempt_id,seq", ignoreDuplicates: true }
        );
        if (error) throw error;
        return "sent";
      },
      isDrStorageMissing
    );
  };

  /* ---------------- Persistent working orders (v2) ----------------
   * Every limit order the engine accepts during a Daily Replay
   * attempt is registered server-side (dr_place_order) under a fresh
   * uuid — the persistent identity the Decision Timeline events also
   * carry as orderUuid. Status changes flow through dr_update_order
   * only. All ops for one order are serialized on a per-order chain:
   * a fill observed a tick after placement can never reach the
   * server before the placement insert lands. Failures never crash
   * trading: if the v2 migration is missing we latch that and stop
   * trying (the order still works in-page; it just won't survive a
   * refresh — the pre-v2 behavior); other errors are swallowed per
   * op, and an update for a row the server never got fails as
   * "order not found" and simply drops. */

  /** Run `op` after every previously queued op for this order. */
  const enqueueDrOrderOp = (orderId: string, op: () => Promise<void>): void => {
    if (drOrdersMissingRef.current) return;
    const chains = drOrderChainsRef.current;
    const prev = chains.get(orderId) ?? Promise.resolve();
    const next = prev
      .then(op)
      .catch((e) => {
        if (isDrStorageMissing(e)) drOrdersMissingRef.current = true;
      });
    chains.set(orderId, next);
    // Drop the chain entry once it drains, unless a newer op queued.
    void next.then(() => {
      if (chains.get(orderId) === next) chains.delete(orderId);
    });
  };

  /** Register a freshly accepted engine order server-side. */
  const persistDrOrderPlace = (row: DrOrderRow): void => {
    const info = drInfoRef.current;
    if (!info) return;
    enqueueDrOrderOp(row.id, async () => {
      if (!isSupabaseConfigured()) return;
      const supabase = createClient();
      const { error } = await supabase.rpc("dr_place_order", {
        p_attempt_id: info.attemptId,
        p_order_id: row.id,
        p_side: row.side,
        p_qty: row.qty,
        p_limit_price: row.limitPrice,
        p_engine_order_id: row.engineOrderId != null ? String(row.engineOrderId) : null,
      });
      if (error) throw error;
    });
  };

  /** Persist a batch of tracker-decided status transitions. */
  const persistDrOrderUpdates = (ops: DrOrderUpdateOp[]): void => {
    for (const op of ops) {
      enqueueDrOrderOp(op.orderId, async () => {
        if (!isSupabaseConfigured()) return;
        const supabase = createClient();
        const { error } = await supabase.rpc("dr_update_order", {
          p_order_id: op.orderId,
          p_status: op.status,
          p_filled_qty: op.filledQty,
        });
        if (error) throw error;
      });
    }
  };

  /**
   * Settle every still-tracked order as cancelled (session reset /
   * attempt completion: the engine extinguished them, so their
   * server rows must end terminal or a resume would resurrect them).
   * Used at the reset call sites and at completion; tick-driven
   * removals are settled by the departure diff in drSyncFills.
   */
  const drSettleTrackedOrders = (): void => {
    const tracker = drOrderTrackerRef.current;
    if (!tracker || tracker.size === 0) return;
    const ops: DrOrderUpdateOp[] = tracker.all().map((row) => ({
      orderId: row.id,
      status: "cancelled" as const,
      filledQty: row.filledQty,
    }));
    tracker.clear();
    persistDrOrderUpdates(ops);
  };

  /* ---------------- Trade drafts: capture + persistence ----------------
   * Observation-only side effects: every helper below runs AFTER the
   * recorder/engine work it observes, catches everything, and never
   * gates a fill, an order, or completion. */

  /** Show a drafts notice; "ok" notices auto-dismiss when a timeout
   *  is given, "warn" notices persist until dismissed or a retry
   *  succeeds (a success replaces them with the "ok" notice). */
  const showDrDraftNotice = (
    notice: { text: string; tone: "ok" | "warn" } | null,
    autoDismissMs?: number
  ): void => {
    if (drNoticeTimeoutRef.current) {
      clearTimeout(drNoticeTimeoutRef.current);
      drNoticeTimeoutRef.current = null;
    }
    setDrDraftNotice(notice);
    if (notice && autoDismissMs) {
      drNoticeTimeoutRef.current = setTimeout(() => {
        setDrDraftNotice((cur) => (cur === notice ? null : cur));
      }, autoDismissMs);
    }
  };

  /** Snapshot the workspace chart as a PNG blob (null on ANY
   *  failure). Oversized captures are re-encoded at 0.75× then 0.5×
   *  until they fit the screenshot bucket's MAX_BYTES limit. */
  const captureChartBlob = async (): Promise<Blob | null> => {
    try {
      const handle = drCaptureRef.current;
      if (!handle) return null;
      const canvas = handle();
      if (!canvas) return null;
      const toBlob = (c: HTMLCanvasElement): Promise<Blob | null> =>
        new Promise((resolve) => {
          try { c.toBlob((b) => resolve(b), "image/png"); } catch { resolve(null); }
        });
      let blob = await toBlob(canvas);
      if (!blob) return null;
      for (const factor of [0.75, 0.5]) {
        if (!blob || blob.size <= MAX_BYTES) break;
        const smaller = document.createElement("canvas");
        smaller.width = Math.max(1, Math.floor(canvas.width * factor));
        smaller.height = Math.max(1, Math.floor(canvas.height * factor));
        const ctx = smaller.getContext("2d");
        if (!ctx) break;
        ctx.drawImage(canvas, 0, 0, smaller.width, smaller.height);
        const next = await toBlob(smaller);
        if (!next) break;
        blob = next;
      }
      return blob;
    } catch {
      return null;
    }
  };

  /** Copy a draft-key annotation row forward to a finalized trade
   *  key (only when a draft-key row exists and the target has none). */
  const copyDraftMetaForward = async (
    supabase: ReturnType<typeof createClient>,
    userId: string,
    fromKey: string,
    toKey: string,
    sessionId: string | null
  ): Promise<void> => {
    try {
      const { data: src } = await supabase
        .from("journal_trade_meta")
        .select("*")
        .eq("trade_key", fromKey)
        .maybeSingle();
      if (!src) return;
      const { data: existing } = await supabase
        .from("journal_trade_meta")
        .select("trade_key")
        .eq("trade_key", toKey)
        .maybeSingle();
      if (existing) return;
      const copy: Record<string, unknown> = { ...(src as Record<string, unknown>) };
      delete copy.id;
      delete copy.created_at;
      copy.user_id = userId;
      copy.trade_key = toKey;
      copy.session_id = sessionId;
      copy.updated_at = new Date().toISOString();
      await supabase.from("journal_trade_meta").upsert(copy, { onConflict: "user_id,trade_key" });
    } catch { /* best-effort — the draft-key row remains the record */ }
  };

  /**
   * Persist one closed cycle's draft, then (never blocking the saved
   * state) upload its entry/exit auto-captures and record their
   * outcomes on the row. Failures are visible and retryable: the
   * payload is kept in drFailedPayloadsRef and the strip's Retry
   * button re-calls this with it. NEVER throws.
   */
  const persistDrDraft = async (
    payload: DrDraftPayload,
    closeCandleIndex: number
  ): Promise<void> => {
    const draftKey = payload.draft_key;
    const clearSaveState = () =>
      setDrDraftSaveStates((s) => {
        const next = { ...s };
        delete next[draftKey];
        return next;
      });
    try {
      setDrDraftSaveStates((s) => ({ ...s, [draftKey]: "saving" }));
      if (drDraftsMissingRef.current) {
        setDrDraftsAvailable(false);
        clearSaveState();
        return;
      }
      if (!isSupabaseConfigured()) {
        drFailedPayloadsRef.current.set(draftKey, payload);
        setDrDraftSaveStates((s) => ({ ...s, [draftKey]: "failed" }));
        showDrDraftNotice({
          tone: "warn",
          text: "Trade closed — draft could not be saved (not signed in). It can be recovered from the attempt timeline.",
        });
        return;
      }
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        drFailedPayloadsRef.current.set(draftKey, payload);
        setDrDraftSaveStates((s) => ({ ...s, [draftKey]: "failed" }));
        showDrDraftNotice({
          tone: "warn",
          text: "Trade closed — draft could not be saved (not signed in). It can be recovered from the attempt timeline.",
        });
        return;
      }
      const res = await upsertDraft(supabase, user.id, payload);
      if (res.error) {
        if (isDraftsStorageMissing(res.error)) {
          drDraftsMissingRef.current = true;
          setDrDraftsAvailable(false);
          clearSaveState();
          return;
        }
        drFailedPayloadsRef.current.set(draftKey, payload);
        setDrDraftSaveStates((s) => ({ ...s, [draftKey]: "failed" }));
        // Subscription quota rejection gets the structured limit
        // message (the draft stays recoverable from the timeline;
        // upgrading lifts the cap — the trade itself already closed).
        const quota = parseQuotaError(res.error);
        showDrDraftNotice({
          tone: "warn",
          text: quota
            ? `Trade closed — draft NOT saved. ${quotaMessage(quota)}`
            : "Trade closed — draft NOT saved yet.",
        });
        return;
      }
      let row = res.data;
      if (!row) {
        const existing = await fetchDraftsForAttempts(supabase, [payload.attempt_id]);
        row = existing.find((d) => d.draftKey === draftKey) ?? null;
      }
      if (row) {
        const savedRow = row;
        setDrDraftRows((prev) => [
          ...prev.filter((d) => d.draftKey !== savedRow.draftKey),
          savedRow,
        ]);
        setDrDraftsAvailable(true);
      }
      drFailedPayloadsRef.current.delete(draftKey);
      setDrDraftSaveStates((s) => ({ ...s, [draftKey]: "saved" }));
      showDrDraftNotice({ tone: "ok", text: "Trade closed — draft saved." }, 4000);
      // Quota gate sync point: the draft insert just consumed a
      // daily slot server-side — refresh so the next buy gates on
      // the true count.
      void syncQuotaFromServer();
      if (!row) return;
      /* Auto-captures: strictly after the saved state above. */
      try {
        const pending = drPendingEntryCaptureRef.current;
        const matched = pending && pending.draftKey === draftKey ? pending : null;
        if (matched) drPendingEntryCaptureRef.current = null;
        let entryOutcome: Record<string, unknown>;
        if (matched && matched.blob) {
          const up = await uploadScreenshotBlob(
            supabase, user.id, draftKey,
            `auto-entry-c${matched.candleIndex + 1}.png`, matched.blob
          );
          entryOutcome = up.error
            ? { status: "failed", candleIndex: matched.candleIndex }
            : { status: "captured", path: up.path, candleIndex: matched.candleIndex };
        } else if (matched) {
          entryOutcome = { status: matched.status, candleIndex: matched.candleIndex };
        } else {
          entryOutcome = { status: "skipped" };
        }
        let exitOutcome: Record<string, unknown>;
        if (searchParams.get("chart") === "canvas" || !drCaptureRef.current) {
          exitOutcome = { status: "skipped", candleIndex: closeCandleIndex };
        } else {
          const exitBlob = await new Promise<Blob | null>((resolve) => {
            requestAnimationFrame(() => {
              void captureChartBlob().then(resolve);
            });
          });
          if (exitBlob) {
            const up = await uploadScreenshotBlob(
              supabase, user.id, draftKey,
              `auto-exit-c${closeCandleIndex + 1}.png`, exitBlob
            );
            exitOutcome = up.error
              ? { status: "failed", candleIndex: closeCandleIndex }
              : { status: "captured", path: up.path, candleIndex: closeCandleIndex };
          } else {
            exitOutcome = { status: "failed", candleIndex: closeCandleIndex };
          }
        }
        const autoCapture = { entry: entryOutcome, exit: exitOutcome };
        const upd = await updateDraftAutoCapture(supabase, row.id, autoCapture);
        if (!upd.error) {
          const rowId = row.id;
          setDrDraftRows((prev) =>
            prev.map((d) => (d.id === rowId ? { ...d, autoCapture } : d))
          );
        }
      } catch { /* captures are evidence, never a save blocker */ }
    } catch {
      drFailedPayloadsRef.current.set(draftKey, payload);
      setDrDraftSaveStates((s) => ({ ...s, [draftKey]: "failed" }));
      showDrDraftNotice({ tone: "warn", text: "Trade closed — draft NOT saved yet." });
    }
  };

  /** After a session_reset is recorded: any still-open draft from an
   *  earlier generation is superseded (its fills were wiped by the
   *  reset and will never reach the saved session). Best-effort
   *  server-side; the strip also derives superseded-ness read-side. */
  const drAfterReset = (): void => {
    drPendingEntryCaptureRef.current = null;
    const rec = drRecorderRef.current;
    if (!rec) return;
    const gen = rec.all.filter((e) => e.type === "session_reset").length;
    for (const row of drDraftRowsRef.current) {
      if (row.status !== "draft" || row.resetGeneration >= gen) continue;
      setDrDraftRows((prev) =>
        prev.map((d) => (d.id === row.id ? { ...d, status: "superseded" as const } : d))
      );
      void (async () => {
        try {
          if (!isSupabaseConfigured() || drDraftsMissingRef.current) return;
          const supabase = createClient();
          await supersedeDraft(supabase, row.id);
        } catch { /* best-effort; read-side derivation still shows it */ }
      })();
    }
  };

  /** Resume-time reconciliation: fetch the attempt's drafts, create
   *  any the restored stream shows closed but un-drafted, and adopt
   *  the merged set. Best-effort; a missing table latches honestly. */
  const drSyncDraftsFromStream = async (
    attemptId: string,
    events: DrEvent[]
  ): Promise<void> => {
    try {
      if (!isSupabaseConfigured()) return;
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const existing = await fetchDraftsForAttempts(supabase, [attemptId]);
      const merged = [...existing];
      const known = new Set(existing.map((d) => d.draftKey));
      for (const d of existing) drDraftHandledRef.current.add(d.draftKey);
      for (const payload of draftsForAttempt(attemptId, events)) {
        if (known.has(payload.draft_key)) continue;
        const res = await upsertDraft(supabase, user.id, payload);
        if (res.error) {
          if (isDraftsStorageMissing(res.error)) {
            drDraftsMissingRef.current = true;
            setDrDraftsAvailable(false);
            return;
          }
          continue;
        }
        if (res.data) {
          merged.push(res.data);
          drDraftHandledRef.current.add(res.data.draftKey);
        }
      }
      setDrDraftRows(merged);
      setDrDraftsAvailable(true);
    } catch { /* drafts are recoverable from the stream at any time */ }
  };

  /** Re-fetch the current attempt's draft rows (drawer onChanged). */
  const refreshDrDraftRows = async (): Promise<void> => {
    const info = drInfoRef.current;
    if (!info || !isSupabaseConfigured()) return;
    try {
      const supabase = createClient();
      const rows = await fetchDraftsForAttempts(supabase, [info.attemptId]);
      if (!drDraftsMissingRef.current) setDrDraftRows(rows);
    } catch { /* keep the rows already on screen */ }
  };

  /** Finalize confirm callback for the shared dialog (strip entry
   *  point): flip the flag, copy any draft-key annotations forward
   *  when a finalized key is known, then verify the flag landed
   *  before the dialog may show its success state. */
  const finalizeDrDraftFromStrip = async (row: DrDraftRow): Promise<void> => {
    if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not signed in.");
    await finalizeDraft(supabase, row.id);
    if (row.finalizedTradeKey) {
      await copyDraftMetaForward(
        supabase, user.id, row.draftKey, row.finalizedTradeKey, row.finalizedSessionId
      );
    }
    const rows = await fetchDraftsForAttempts(supabase, [row.attemptId]).catch(() => null);
    const fresh = rows?.find((d) => d.id === row.id);
    if (fresh && fresh.status !== "finalized") {
      throw new Error("Finalize did not land — please try again.");
    }
    if (rows && !drDraftsMissingRef.current) setDrDraftRows(rows);
  };

  /**
   * Observe engine fills centrally (market/limit fills from handlers,
   * bracket triggers + limit fills from the tick loop) and feed them
   * to the recorder exactly once each. A shrinking fills array means
   * the engine was reset — the shadow restarts, history stays.
   *
   * The same pass settles persistent orders: fills are collected
   * first, the order tracker diffs tracked orders against the
   * engine's current pendingOrders (matching departed orders to this
   * pass's limit fills), and only then are the fills recorded — so a
   * limit fill's order_filled event carries its persistent orderUuid.
   */
  const drSyncFills = (): void => {
    const e = engineRef.current;
    const rec = drRecorderRef.current;
    if (!e || !rec) return;
    if (drPhaseRef.current !== "active" && drPhaseRef.current !== "done") return;
    if (e.fills.length < drSeenFillsRef.current) {
      drSeenFillsRef.current = 0;
      rec.resetTradingState();
    }
    const newFills: Fill[] = [];
    while (drSeenFillsRef.current < e.fills.length) {
      newFills.push(e.fills[drSeenFillsRef.current++]);
    }
    let fillOrderId = new Map<Fill, string>();
    const tracker = drOrderTrackerRef.current;
    if (tracker && drPhaseRef.current === "active") {
      const settled = tracker.syncDepartures(
        new Set(e.pendingOrders.map((o) => o.id)),
        newFills
      );
      fillOrderId = settled.fillOrderId;
      if (settled.updates.length > 0) persistDrOrderUpdates(settled.updates);
    }
    for (const f of newFills) {
      const wasFlat = rec.positionQty === 0;
      rec.recordFill({
        side: f.side,
        qty: f.qty,
        price: f.price,
        candleIndex: f.candleIndex,
        time: f.time,
        note: f.note,
        realizedPnl: f.realizedPnl,
        orderUuid: fillOrderId.get(f),
      });
      if (f.side === "buy" && wasFlat) {
        // Risk snapshot at first entry, from the levels now in force.
        const sl = e.stopLoss ?? plannedSL;
        const tp = e.takeProfit ?? plannedTP;
        const risk =
          sl != null ? Math.abs(f.price - sl) * f.qty : null;
        const rr =
          sl != null && tp != null && Math.abs(f.price - sl) > 0
            ? Math.abs(tp - f.price) / Math.abs(f.price - sl)
            : null;
        rec.recordRiskSnapshot(
          {
            entry: f.price,
            qty: f.qty,
            stopLoss: sl,
            takeProfit: tp,
            plannedRisk: risk,
            rewardRisk: rr,
          },
          { marketIdx: f.candleIndex, marketTs: f.time }
        );
      }
      /* Trade drafts (observation only — after recordFill/snapshot,
       * never gating them): stage the entry capture at a first entry
       * fill, and persist the draft when a sell fill closes a cycle. */
      if (f.side === "buy" && wasFlat && drInfoRef.current) {
        try {
          const attemptId = drInfoRef.current.attemptId;
          const split = splitCyclesByGeneration(rec.all);
          const gen = split.lastGeneration;
          // The cycle this fill just opened carries its own
          // cycleIndex (the value buildDraftPayload will key its
          // draft with at close): the open cycle of this generation.
          const openCycle = split.cycles.find(
            (c) => c.generation === gen && !c.closed
          );
          const idx = openCycle
            ? openCycle.cycleIndex
            : split.cycles.filter((c) => c.generation === gen && c.closed).length + 1;
          const key = draftKeyFor(attemptId, gen, idx);
          if (searchParams.get("chart") === "canvas") {
            drPendingEntryCaptureRef.current = {
              draftKey: key, candleIndex: f.candleIndex, blob: null, status: "skipped",
            };
          } else {
            const captureCandle = f.candleIndex;
            requestAnimationFrame(() => {
              void captureChartBlob().then((blob) => {
                drPendingEntryCaptureRef.current = {
                  draftKey: key,
                  candleIndex: captureCandle,
                  blob,
                  status: blob ? "captured" : "failed",
                };
              });
            });
          }
        } catch { /* capture staging never gates the fill */ }
      }
      if (f.side === "sell" && !wasFlat && rec.positionQty === 0) {
        try {
          const split = splitCyclesByGeneration(rec.all);
          const cycle = latestClosedCycle(rec.all);
          const info = drInfoRef.current;
          if (cycle && info) {
            const payload = buildDraftPayload(info.attemptId, cycle, split.lastGeneration);
            if (!drDraftHandledRef.current.has(payload.draft_key)) {
              drDraftHandledRef.current.add(payload.draft_key);
              void persistDrDraft(payload, f.candleIndex);
            }
          }
        } catch { /* draft persistence never gates the fill */ }
      }
    }
  };

  // Fills can appear on any bump (tick batch, step, order) — sync after
  // every render in which the version advanced.
  useEffect(() => {
    drSyncFills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const eng = engineRef.current;
  const daily = snap ? snap.realized + snap.unreal : 0;
  const isDr = drPhase === "active" || drPhase === "done";
  // In Daily Replay the chart session key must be stable while the
  // sealed array grows — the standard key embeds candles.length.
  const chartSessionKey =
    isDr && drInfo
      ? `dr|${drInfo.attemptId}|${timeframe}`
      : `${meta?.ticker}|${meta?.tradeDate}|${meta?.source}|${candles?.length}|${timeframe}`;
  // Locked/selected-candle highlight (Daily Replay only). Preview: the
  // band follows the currently selected starting candle. Active/done:
  // it is pinned to the attempt's locked starting candle (drInfo
  // .startIndex into the feed's array — the same index resume restores
  // from), so it survives pan/zoom, pause/play, and refresh/resume,
  // and it never moves for the life of the attempt. Purely visual:
  // the lock, timestamps, and execution are untouched.
  const drPreviewKey = drPreview
    ? drDatasetKey(drPreview.meta.ticker, drPreview.meta.tradeDate, drPreview.candles.length)
    : null;
  const drPreviewGate =
    drPreview && drPreviewKey
      ? premarketWarningGate({
          premarketAvailable: drPreview.premarketAvailable,
          datasetKey: drPreviewKey,
          dismissedKey: drPremarketDismissedKey,
        })
      : null;
  const drPreviewBand = drPreview
    ? highlightBandFor(drPreview.candles, drPreview.selected)
    : null;
  const drActiveBand =
    isDr && drInfo && candles
      ? highlightBandFor(candles, drInfo.startIndex)
      : null;
  /* Trade drafts strip derivations: rows in (generation, cycle)
   * order; a still-"draft" row from an earlier generation than the
   * live stream's is superseded by derivation even if the best-effort
   * server update has not landed. */
  const drStreamGen = drEvents.filter((e) => e.type === "session_reset").length;
  const drDraftRowsSorted = [...drDraftRows].sort(
    (a, b) => a.resetGeneration - b.resetGeneration || a.cycleIndex - b.cycleIndex
  );
  const drFailedDraftKeys = Object.entries(drDraftSaveStates)
    .filter(([, s]) => s === "failed")
    .map(([k]) => k);
  const drReviewRow = drReviewDraftKey
    ? (drDraftRows.find((d) => d.draftKey === drReviewDraftKey) ?? null)
    : null;

  return (
    <div className="ws">
      {drPhase === "preview" && drPreview && (
        <div className="ws-welcome" style={{ maxWidth: 1120, margin: "0 auto", width: "100%" }}>
          <div
            style={{
              background: "rgba(251,191,36,0.10)",
              border: "1px solid rgba(251,191,36,0.45)",
              borderRadius: 8,
              padding: "10px 14px",
              fontWeight: 800,
              letterSpacing: "0.04em",
              color: "#fbbf24",
              fontSize: 14,
              textAlign: "center",
            }}
          >
            FULL-DAY PREVIEW — FUTURE CANDLES ARE VISIBLE
          </div>
          {drPreviewGate?.showWarning && (
            <div
              role="alert"
              style={{
                display: "flex", alignItems: "flex-start", gap: 10,
                background: "rgba(251,191,36,0.08)",
                border: "1px solid rgba(251,191,36,0.45)",
                borderRadius: 8, padding: "10px 14px", marginTop: 10,
                fontSize: 13,
              }}
            >
              <span style={{ color: "#fbbf24", fontSize: 15 }}>⚠</span>
              <div style={{ lineHeight: 1.45, flex: 1 }}>
                <div style={{ fontWeight: 700, color: "#fbbf24", letterSpacing: "0.02em" }}>
                  PREMARKET DATA UNAVAILABLE
                </div>
                <div style={{ color: "var(--muted)" }}>
                  Historical premarket data is unavailable for this session. The replay
                  starts at 9:30 AM ET using verified regular-market data.
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setDrPremarketDismissedKey(drPreviewKey)}
                style={{ flexShrink: 0 }}
              >
                Got it
              </button>
              <button
                onClick={() => setDrPremarketDismissedKey(drPreviewKey)}
                title="Dismiss"
                aria-label="Dismiss premarket warning"
                style={{
                  background: "none", border: "none", color: "var(--muted)",
                  cursor: "pointer", fontSize: 16, padding: "2px 6px", flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          )}
          <p className="hint" style={{ marginTop: 10 }}>
            {drPreview.meta.ticker} · {drPreview.meta.tradeDate} · 1-minute candles ·{" "}
            {drPreview.candles.length} candles loaded. This preview is intentionally
            unsealed so you can inspect the whole day and choose where to begin —
            it is <b>not</b> a blind replay, and trading is disabled here. Click a
            candle on the chart (or set “Replay starts at” before loading) to choose
            your starting candle, then lock it: from that moment the server releases
            candles only as you advance.
          </p>
          {drPreview.warnings.length > 0 && (
            <div
              style={{
                background: "rgba(251,191,36,0.06)",
                border: "1px solid rgba(251,191,36,0.25)",
                borderRadius: 8,
                padding: "8px 12px",
                marginBottom: 10,
                fontSize: 12.5,
              }}
            >
              <b>Data warnings</b> (nothing was filled in or invented):
              <ul style={{ margin: "6px 0 0 0", paddingLeft: 18 }}>
                {drPreview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="ws-chart" style={{ position: "relative", height: 440 }}>
            <LwcChart
              candles={drPreview.candles}
              revealedCount={drPreview.candles.length}
              sessionKey={`dr-preview|${drPreview.meta.ticker}|${drPreview.meta.tradeDate}|${drPreview.candles.length}`}
              countdown={null}
              lastPrice={drPreview.candles[drPreview.selected].c}
              brackets={DR_EMPTY_BRACKETS}
              fitOnLoad
              fitAnchorIndex={drPreview.selected}
              onViewChange={(v) => { drPreviewViewRef.current = v; }}
              showFitAll
              highlightTimeSec={drPreviewBand?.timeSec ?? null}
              highlightSpanSec={drPreviewBand?.spanSec ?? 60}
              onCandleClick={(timeSec) => {
                // While the premarket warning is undismissed, candle
                // selection stays disabled (the chart itself remains
                // viewable and pannable).
                if (drPreviewGate?.blockSelection) return;
                const t = timeSec * 1000;
                let best = 0;
                let bestDist = Infinity;
                drPreview.candles.forEach((c, i) => {
                  const d = Math.abs(c.t - t);
                  if (d < bestDist) { bestDist = d; best = i; }
                });
                setDrPreview((p) => (p ? { ...p, selected: best } : p));
              }}
              onPlannedDrag={() => {}}
              onActiveDrag={() => {}}
              drawings={[]}
              onDrawingsChange={() => {}}
              drawingTool="select"
              onDrawingToolChange={() => {}}
            />
          </div>
          {(() => {
            const sel = drPreview.candles[drPreview.selected];
            return (
              <div
                style={{
                  display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center",
                  marginTop: 12, padding: "10px 14px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <span>
                  <b>Starting candle:</b> {drPreview.meta.tradeDate}{" "}
                  {formatEtTime(sel.t)} ET (#{drPreview.selected + 1} of{" "}
                  {drPreview.candles.length})
                </span>
                <span className="num">O {sel.o.toFixed(2)}</span>
                <span className="num">H {sel.h.toFixed(2)}</span>
                <span className="num">L {sel.l.toFixed(2)}</span>
                <span className="num">C {sel.c.toFixed(2)}</span>
                <span className="num">V {sel.v.toLocaleString()}</span>
              </div>
            );
          })()}
          {/* No strategy picker on this screen (2026-10-18 workflow
              fix): attempts lock unclassified — strategy_version_id
              stays null. Strategy management lives on the welcome
              screen / journal; nothing here selects or binds one. */}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button
              className="btn primary big"
              onClick={() => { setDrError(null); setDrConfirm(true); }}
              disabled={drPreviewGate?.blockSelection ?? false}
              title={drPreviewGate?.blockSelection ? "Dismiss the premarket warning above to choose a starting candle" : undefined}
            >
              Lock Starting Candle
            </button>
            <button className="btn big" onClick={startStandardFromPreview}>
              Start standard replay instead
            </button>
            <button className="btn big" onClick={exitDrPreview}>
              Back to data sources
            </button>
          </div>
          {drError && <div className="err" style={{ marginTop: 10 }}>{drError}</div>}
          {drConfirm && (
            <div
              style={{
                marginTop: 12, padding: "12px 14px",
                background: "rgba(16,185,129,0.06)",
                border: "1px solid rgba(16,185,129,0.35)", borderRadius: 8,
                fontSize: 13.5,
              }}
            >
              <b>Start Daily Replay?</b>
              <div style={{ margin: "8px 0", lineHeight: 1.7 }}>
                <div>Ticker: <b>{drPreview.meta.ticker}</b></div>
                <div>Date: <b>{drPreview.meta.tradeDate}</b></div>
                <div>Timeframe: <b>1 minute</b></div>
                <div>
                  Starting candle:{" "}
                  <b>
                    {drPreview.meta.tradeDate}{" "}
                    {formatEtTime(drPreview.candles[drPreview.selected].t)} ET
                  </b>
                </div>
                <div>
                  Starting balance: <b>{formatMoney(DAILY_REPLAY_STARTING_BALANCE)}</b>{" "}
                  (separate Daily Replay account — your Trade Lab balance is untouched)
                </div>
                <div style={{ color: "var(--muted)" }}>
                  Once locked, the starting point cannot be changed for this attempt,
                  and candles after it stay sealed on the server until you reach them.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn primary" onClick={confirmDrLock} disabled={drBusy}>
                  {drBusy ? "Locking…" : "Confirm — start Daily Replay"}
                </button>
                <button className="btn" onClick={() => setDrConfirm(false)} disabled={drBusy}>
                  Back
                </button>
              </div>
              {drError && <div className="err" style={{ marginTop: 8 }}>{drError}</div>}
            </div>
          )}
        </div>
      )}

      {drPhase !== "preview" && (!eng || !candles || !meta || !snap) && (
        <div className="ws-welcome">
          {loadingSession && <div className="hint">Loading saved session…</div>}
          {drResume && (
            <div
              style={{
                display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center",
                padding: "10px 12px", marginBottom: 12,
                background: "rgba(16,185,129,0.08)",
                border: "1px solid rgba(16,185,129,0.35)", borderRadius: 8,
                fontSize: 13,
              }}
            >
              <b style={{ color: "var(--emerald-bright)", letterSpacing: "0.04em" }}>
                RESUME DAILY REPLAY
              </b>
              <span>
                {drResume.ticker} · {drResume.tradeDate} — candle{" "}
                {drResume.position + 1} of {drResume.total}. Your starting
                candle stays locked; position, trades, and timeline are
                restored from the server.
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button
                  className="btn primary"
                  onClick={() => { void resumeDailyReplay(); }}
                  disabled={drResuming}
                >
                  {drResuming ? "Resuming…" : "Resume"}
                </button>
                <button
                  className="btn"
                  onClick={() => setDrResume(null)}
                  disabled={drResuming}
                >
                  Not now
                </button>
              </span>
            </div>
          )}
          {drError && (
            <div className="err" style={{ marginBottom: 12 }}>
              {drError}{" "}
              <button className="btn" onClick={() => setDrError(null)}>Dismiss</button>
            </div>
          )}
          <DataSourcePanel candles={candles} meta={meta} onLoad={handleLoad} onPreview={handleDrPreview} />
          <DrStrategyPanel
            strategies={drStrategies}
            versions={drStrategyVersions}
            attempts={drAttemptsList}
            available={drStrategiesAvailable}
            onChanged={() => { void loadDrStrategies(); }}
          />
          {saveMsg && <div className="err" style={{ marginTop: 12 }}>{saveMsg}</div>}
        </div>
      )}

      {eng && candles && meta && snap && (
        <>
          {/* Daily Replay status banner */}
          {isDr && drInfo && (
            <div className="dr-banner">
              <b className="dr-banner-title">
                {drPhase === "done" ? "DAILY REPLAY COMPLETE" : "DAILY REPLAY ACTIVE"}
              </b>
              <div className="dr-banner-facts">
                <span>
                  {drInfo.ticker} · {drInfo.tradeDate} · started{" "}
                  {formatEtTime(eng.candles[drInfo.startIndex]?.t ?? 0)} ET
                </span>
                <span title="The strategy version this attempt was locked under">
                  Strategy: <b>{drInfo.strategyLabel ?? "None recorded"}</b>
                </span>
                <span>
                  Candle {Math.min(eng.index + 1, drInfo.total)} of {drInfo.total}
                  {eng.candles[eng.index] ? ` · ${formatEtTime(eng.candles[eng.index].t)} ET` : ""}
                </span>
                <span title="Daily Replay uses its own $100,000 account — the Trade Lab balance is not touched">
                  DR balance: cash {formatMoney(snap.cash)} · equity {formatMoney(snap.equity)}
                </span>
                {drBuffering && <span style={{ color: "#fbbf24" }}>Loading next candles…</span>}
                {drFeedRef.current?.lastError && (
                  <span style={{ color: "#fbbf24" }}>{drFeedRef.current.lastError}</span>
                )}
              </div>
              {drPhase === "active" && (
                <button
                  className="btn primary"
                  onClick={() => setDrCompleteConfirm(true)}
                  disabled={drBuffering}
                  title="End this session at the current candle and save its closed trades to your journal now"
                >
                  Complete session now
                </button>
              )}
              <button className="btn" onClick={exitDailyReplay}>
                Exit Daily Replay
              </button>
            </div>
          )}
          {isDr && drInfo && drPhase === "active" && drCompleteConfirm && (
            <div
              style={{
                marginBottom: 8, padding: "12px 14px",
                background: "rgba(16,185,129,0.06)",
                border: "1px solid rgba(16,185,129,0.35)", borderRadius: 8,
                fontSize: 13.5,
              }}
            >
              <b>Complete this session now?</b>
              <div style={{ margin: "8px 0", lineHeight: 1.7 }}>
                <div>
                  The session ends at the current candle — candle{" "}
                  <b>
                    {Math.min(eng.index + 1, drInfo.total)} of {drInfo.total}
                  </b>
                  . The remaining candles stay sealed and unseen.
                </div>
                <div>Closed trades are saved to your journal now.</div>
                <div>Any working orders are cancelled.</div>
                {eng.positionQty > 0 && (
                  <div>
                    You still have an open position (
                    <b>{eng.positionQty} shares</b>) — it will be saved as
                    an open trade, the same as reaching the end of the day.
                  </div>
                )}
                <div style={{ color: "var(--muted)" }}>
                  This cannot be undone — the attempt is finished and
                  cannot be resumed.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn primary"
                  onClick={() => { void requestCompleteDrNow(); }}
                >
                  Complete session now
                </button>
                <button className="btn" onClick={() => setDrCompleteConfirm(false)}>
                  Keep replaying
                </button>
              </div>
            </div>
          )}
          {isDr && drError && (
            <div className="err" style={{ marginBottom: 8 }}>
              {drError}{" "}
              <button className="btn" onClick={() => setDrError(null)}>Dismiss</button>
            </div>
          )}
          {drPhase === "done" && drFinal && (
            <div
              style={{
                padding: "12px 14px", marginBottom: 8,
                background: "rgba(16,185,129,0.06)",
                border: "1px solid rgba(16,185,129,0.3)", borderRadius: 8,
                fontSize: 13.5, lineHeight: 1.6,
              }}
            >
              <b>Daily Replay complete</b> — {drInfo?.ticker} {drInfo?.tradeDate}. Final
              realized P&amp;L{" "}
              <b className={drFinal.realized >= 0 ? "pos" : "neg"}>
                {formatSigned(drFinal.realized)}
              </b>{" "}
              · final equity <b>{formatMoney(drFinal.equity)}</b>.
              {drSaveMsg && <div>{drSaveMsg}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <a className="btn" href="/sessions" style={{ textDecoration: "none" }}>
                  My Sessions
                </a>
                <button className="btn primary" onClick={exitDailyReplay}>
                  New session
                </button>
              </div>
            </div>
          )}
          {/* top strip: instrument + price + actions */}
          <div className="ws-top">
            <div className="ws-sym">
              <span className="ticker-name">{meta.ticker}</span>
              <span className="ticker-sub">{meta.tradeDate}</span>
              {meta.source === "sample"
                ? <span className="badge sample">Sample — simulated prices</span>
                : <span className="badge live">{meta.source === "twelvedata" ? "Twelve Data" : "CSV"} · real data</span>}
            </div>
            <div className="ws-quote">
              <span className="price-now num">{formatMoney(snap.price)}</span>
              <span className="hod-line">HOD <b className="num">{formatMoney(eng.hod)}</b></span>
            </div>
            <div className="ws-top-actions">
              {/* Persistent account balance — hidden in Daily Replay,
                  whose balance is separate (see the DR banner). */}
              {!isDr && (
              <>
              <span
                title="Account balance — carries P&L across sessions. Click ↺ to reset to $100,000."
                style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}
              >
                Balance <b className="num" style={{ color: "var(--emerald-bright)" }}>${accountBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                <button
                  onClick={resetBalance}
                  title="Reset balance to $100,000"
                  style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: "2px 4px" }}
                >
                  ↺
                </button>
              </span>
              {saveMsg && (
                saveMsg.startsWith("Session saved") ? (
                  <a href="/sessions" className="ok" style={{ fontSize: 12, textDecoration: "underline", cursor: "pointer" }}>
                    {saveMsg} →
                  </a>
                ) : (
                  <span className="err" style={{ fontSize: 12 }}>{saveMsg}</span>
                )
              )}
              </>
              )}
              <button className="btn" onClick={() => setDataOpen((v) => !v)}>Data</button>
              {!isDr && (
              <label
                title="Auto-save session for signed-in users (saves after each closed trade)"
                style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none" }}
              >
                <input
                  type="checkbox"
                  checked={autoSaveEnabled}
                  onChange={(e) => setAutoSaveEnabled(e.target.checked)}
                  style={{ accentColor: "var(--emerald)" }}
                />
                Auto-save
              </label>
              )}
              {!isDr && (
              <button className="btn primary" onClick={() => saveSession(false)} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              )}
            </div>
          </div>

          <div className="ws-main">
            {/* left: chart column */}
            <div className="ws-left">
              <ReplayControls
                compact
                playing={playing}
                canPlay={isDr ? drPhase === "active" : !eng.atEnd}
                ended={ended}
                onPlay={() => {
                  setEnded(false); setPlayNonce((n) => n + 1); setPlaying(true);
                  const rec = drRec();
                  if (rec) {
                    if (!drPlayStartedRef.current) {
                      drPlayStartedRef.current = true;
                      rec.record("session_started", {}, drCtx());
                    } else {
                      rec.record("session_resumed", {}, drCtx());
                    }
                  }
                }}
                onPause={() => { stopTimer(); drRec()?.record("session_paused", {}, drCtx()); }}
                onNext={isDr ? () => { void drStepNext(); } : () => { eng.step(); setEnded(eng.atEnd); bump(); }}
                onReset={() => { const wasPlaying = playing; stopTimer(); setEnded(false); drSyncFills(); drSettleTrackedOrders(); eng.reset(); drRec()?.record("session_reset", {}, drCtx()); drAfterReset(); bump(); if (wasPlaying) { setPlayNonce((n) => n + 1); setPlaying(true); } }}
                onRestart={() => { stopTimer(); setEnded(false); drSyncFills(); drSettleTrackedOrders(); eng.reset(); drRec()?.record("session_reset", {}, drCtx()); drAfterReset(); bump(); setPlayNonce((n) => n + 1); setPlaying(true); }}
                speed={speed}
                onSpeed={setSpeed}
                index={eng.index}
                total={isDr && drInfo ? drInfo.total : candles.length}
                progress={(eng.index + eng.formationProgress + 1) / Math.max(1, isDr && drInfo ? drInfo.total : candles.length)}
              />
              <div className="ws-chart" style={{ position: "relative" }}>
                {/* Timeframe selector — display only, never touches engine state.
                    Positioned top-right to avoid the drawing toolbar (top-left). */}
                <div
                  className="tf-selector"
                  role="group"
                  aria-label="Chart timeframe"
                  style={{
                    position: "absolute", top: 8, right: 8, zIndex: 5,
                    display: "flex", gap: 2, padding: 2,
                    background: "rgba(10,14,20,0.75)", borderRadius: 6,
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf.id}
                      onClick={() => setTimeframe(tf.id)}
                      aria-pressed={timeframe === tf.id}
                      title={`${tf.label} chart`}
                      style={{
                        padding: "3px 9px", fontSize: 11, fontWeight: 700,
                        border: "none", borderRadius: 4, cursor: "pointer",
                        background: timeframe === tf.id ? "var(--ggl-green, #42d879)" : "transparent",
                        color: timeframe === tf.id ? "#0a0e14" : "#9aa4b2",
                      }}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
                {/* Honest premarket notice — shown only when verified premarket data is unavailable.
                    Standard-replay surface only: Daily Replay attempts (active/done, incl.
                    resumed) never render it — the preview gate already informed the user. */}
                {premarketOverlayVisible({
                  phase: drPhase,
                  premarketUnavailable: meta?.premarketUnavailable ?? false,
                  dismissed: premarketNoticeDismissed,
                }) && (
                  <div
                    style={{
                      position: "absolute",
                      top: 12,
                      left: "50%",
                      transform: "translateX(-50%)",
                      zIndex: 30,
                      background: "rgba(15,23,42,0.95)",
                      border: "1px solid rgba(251,191,36,0.35)",
                      borderRadius: 8,
                      padding: "8px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      maxWidth: "90%",
                      boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
                    }}
                  >
                    <span style={{ color: "#fbbf24", fontSize: 14 }}>⚠</span>
                    <div style={{ fontSize: 12, lineHeight: 1.4 }}>
                      <div style={{ fontWeight: 700, color: "#fbbf24", letterSpacing: "0.02em" }}>
                        PREMARKET DATA UNAVAILABLE
                      </div>
                      <div style={{ color: "var(--muted)" }}>
                        Historical premarket data isn't available for this session.
                        Replay starts at 9:30 AM ET using verified regular-market data.
                      </div>
                    </div>
                    <button
                      onClick={() => setPremarketNoticeDismissed(true)}
                      title="Dismiss"
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--muted)",
                        cursor: "pointer",
                        fontSize: 16,
                        padding: "2px 6px",
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
                {searchParams.get("chart") === "canvas" ? (
                <CandleChart
                  candles={chartCandles ?? eng.displayCandles}
                  revealedCount={(chartCandles ?? eng.displayCandles).length}
                  historyCount={meta.startIndex}
                  sessionKey={chartSessionKey}
                  overlays={{
                    hod: eng.hod,
                    stopLoss: eng.stopLoss,
                    takeProfit: eng.takeProfit,
                    fills: eng.fills,
                    lastPrice: snap.price,
                    pendingOrders: eng.pendingOrders.map((o) => ({ side: o.side, price: o.limitPrice })),
                    countdown: tfCountdown,
                  }}
                />
                ) : (
                  <LwcChart
                    candles={chartCandles ?? eng.displayCandles}
                    revealedCount={(chartCandles ?? eng.displayCandles).length}
                    sessionKey={chartSessionKey}
                    countdown={tfCountdown}
                    lastPrice={snap.price}
                    brackets={brackets}
                    showFitAll={isDr}
                    stableScale={isDr}
                    initialView={
                      isDr && drInitialViewRef.current
                        ? {
                            targetSpacingPx: drInitialViewRef.current.targetSpacingPx,
                            viewKey: drInitialViewRef.current.viewKey,
                          }
                        : undefined
                    }
                    highlightTimeSec={isDr ? (drActiveBand?.timeSec ?? null) : undefined}
                    highlightSpanSec={drActiveBand?.spanSec ?? 60}
                    captureHandleRef={drCaptureRef}
                    onPlannedDrag={(sl, tp) => { setPlannedLevels(sl, tp); drBracketsChanged(sl, tp, "drag", "planned"); }}
                    onActiveDrag={(sl, tp) => {
                      const e = engineRef.current;
                      if (e) { e.setBrackets(sl, tp); drBracketsChanged(sl, tp, "drag", "active"); bump(); }
                    }}
                    drawings={drawings}
                    onDrawingsChange={setDrawings}
                    drawingTool={drawingTool}
                    onDrawingToolChange={setDrawingTool}
                  />
                )}
              </div>
              {/* persistent P&L strip */}
              <div className="ws-pnl">
                <div className="pnl-cell">
                  <div className="tk">Realized</div>
                  <div className={`tv num ${snap.realized >= 0 ? "pos" : "neg"}`}>{formatSigned(snap.realized)}</div>
                </div>
                <div className="pnl-cell">
                  <div className="tk">Unrealized</div>
                  <div className={`tv num ${snap.unreal >= 0 ? "pos" : "neg"}`}>{formatSigned(snap.unreal)}</div>
                </div>
                <div className="pnl-cell">
                  <div className="tk">Daily P/L</div>
                  <div className={`tv num ${daily >= 0 ? "pos" : "neg"}`}>{formatSigned(daily)}</div>
                </div>
                <div className="pnl-cell">
                  <div className="tk">Position</div>
                  <div className="tv num">{snap.qty > 0 ? `${snap.qty} @ ${formatMoney(snap.avg)}` : "—"}</div>
                </div>
                <div className="pnl-cell">
                  <div className="tk">Cash</div>
                  <div className="tv num">{formatMoney(snap.cash)}</div>
                </div>
                <div className="pnl-cell equity">
                  <div className="tk">Equity</div>
                  <div className="tv num">{formatMoney(snap.equity)}</div>
                </div>
              </div>
            </div>

            {/* right: order entry + ledger */}
            <aside className="ws-right">
              {/* Guard alert banner — visible on all tabs when warning/lockout active */}
              {(lockoutActive || guardWarned) && (
                <div
                  className={`guard-banner ${lockoutActive ? "lock" : "warn"}`}
                  onClick={() => setRightTab("guard")}
                  title="View Psychology Guard"
                >
                  <span>{lockoutActive ? "🔒" : "⚠️"}</span>
                  <span>
                    {lockoutActive
                      ? `Entries locked (${guardLockout!.threshold}% loss)`
                      : `Loss ${(guardLossPct ?? 0).toFixed(1)}% — approaching lockout`}
                  </span>
                  {lockoutActive && (
                    <span className="guard-time">
                      {formatCountdown(guardLockout!.expiry - Date.now())}
                    </span>
                  )}
                </div>
              )}
              <div className="ws-tabs" role="tablist">
                {(["order", "risk", "guard"] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={rightTab === t}
                    onClick={() => setRightTab(t)}
                    className={`ws-tab ${rightTab === t ? "active" : ""}`}
                  >
                    {t === "order" ? "Order" : t === "risk" ? "Risk" : "Guard"}
                    {t === "guard" && (lockoutActive || guardWarned) && (
                      <span className="tab-dot" />
                    )}
                  </button>
                ))}
              </div>
              <div style={{ display: rightTab === "order" ? "block" : "none" }}>
              {/* Guest trade counter (guests only) */}
              {!guardUserId && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "7px 12px",
                    marginBottom: 8,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: guestRemaining > 0 ? "#94a3b8" : "#fb7185",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8,
                  }}
                  title="Free practice trades reset daily at midnight UTC"
                >
                  <span>Guest Trades</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {guestRemaining}/{GUEST_DAILY_LIMIT} Remaining Today
                  </span>
                </div>
              )}
              <TradingPanel
                snap={snap}
                qty={orderQty}
                onQtyChange={setOrderQty}
                plannedSL={plannedSL}
                plannedTP={plannedTP}
                plannedEntry={plannedEntry}
                activeSL={brackets.activeSL}
                activeTP={brackets.activeTP}
                hasPosition={eng.positionQty > 0}
                onBuy={gateBuy}
                onSell={sellErr}
                onPlaceLimit={placeLimitErr}
                onCancelOrder={(id) => {
                  const o = eng.pendingOrders.find((x) => x.id === id);
                  if (eng.cancelOrder(id) && o) {
                    // Daily Replay: settle the persistent row in the
                    // same action — the tracker hands back the row so
                    // the departure diff never sees (or double-settles)
                    // this cancel.
                    const row = drOrderTrackerRef.current?.take(id);
                    if (row) {
                      persistDrOrderUpdates([
                        { orderId: row.id, status: "cancelled", filledQty: row.filledQty },
                      ]);
                    }
                    drRec()?.recordOrderCancelled(
                      {
                        orderId: id,
                        side: o.side,
                        qty: o.qty,
                        limitPrice: o.limitPrice,
                        orderUuid: row?.id,
                      },
                      drCtx()
                    );
                  }
                  bump();
                }}
                onSetBrackets={(sl, tp) => {
                  const eng = engineRef.current;
                  if (!eng) return;
                  // Normalize to valid tick increments for consistency.
                  const nSL = sl != null ? normalizePrice(sl) : null;
                  const nTP = tp != null ? normalizePrice(tp) : null;
                  if (eng.positionQty > 0) {
                    // Position open: active brackets on the engine.
                    eng.setBrackets(nSL, nTP);
                    drBracketsChanged(nSL, nTP, "control", "active");
                  } else {
                    // Flat: planned levels only (dashed, no engine effect).
                    setPlannedLevels(nSL, nTP);
                    drBracketsChanged(nSL, nTP, "control", "planned");
                  }
                  bump();
                }}
                disabled={false}
              />
              </div>
              <div className="ws-tabpanel-risk" style={{ display: rightTab === "risk" ? "block" : "none" }}>
              <RiskCalculator
                currentPrice={snap.price}
                cash={snap.cash}
                plannedSL={plannedSL}
                plannedTP={plannedTP}
                plannedEntry={plannedEntry}
                activeSL={brackets.activeSL}
                activeTP={brackets.activeTP}
                hasPosition={eng.positionQty > 0}
                positionAvg={eng.positionAvg}
                positionQty={eng.positionQty}
                positionRealized={positionRealized}
                unrealizedPnl={snap.unreal}
                onPlannedChange={(sl, tp) => {
                  const nSL = sl != null ? normalizePrice(sl) : null;
                  const nTP = tp != null ? normalizePrice(tp) : null;
                  setPlannedLevels(nSL, nTP);
                  drBracketsChanged(nSL, nTP, "control", "planned");
                }}
                onActiveChange={(sl, tp) => {
                  const e = engineRef.current;
                  const nSL = sl != null ? normalizePrice(sl) : null;
                  const nTP = tp != null ? normalizePrice(tp) : null;
                  if (e) { e.setBrackets(nSL, nTP); drBracketsChanged(nSL, nTP, "control", "active"); bump(); }
                }}
                onApplyBrackets={(sl, tp) => {
                  setPlannedLevels(sl, tp);
                  drBracketsChanged(sl, tp, "control", "planned");
                  bump();
                }}
                onBuySized={gateBuy}
                disabled={false}
              />
              </div>
              <div className="ws-tabpanel-guard" style={{ display: rightTab === "guard" ? "block" : "none" }}>
              <PsychologyGuardPanel
                accountBalance={accountBalance}
                baseline={guardBaseline.current}
                positionQty={eng.positionQty}
                positionAvg={eng.positionAvg}
                positionPnl={guardLoss?.pnl ?? null}
                lossPct={guardLossPct}
                lockout={lockoutActive ? guardLockout : null}
                warned={guardWarned}
                thresholds={guardThresholds}
                onThresholdsChange={(t) => {
                  setGuardThresholds(t);
                  saveThresholds(t);
                }}
              />
              </div>
            </aside>
          </div>

          {/* Daily Replay — Decision Timeline (review). Collapsible
              section BELOW the chart + controls row (chart-first
              layout, 2026-10-18): collapsed by default so the chart
              keeps the height; auto-opens when the session completes.
              Toggling only shows/hides this section — replay state,
              playback and the engine are untouched. */}
          {isDr && (
            <div
              style={{
                marginTop: 10, padding: "8px 12px",
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8,
              }}
            >
              <button
                type="button"
                onClick={() => setDrTimelineOpen((o) => !o)}
                aria-expanded={drTimelineOpen}
                style={{
                  display: "flex", width: "100%", alignItems: "center", gap: 8,
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  color: "inherit", fontWeight: 700, fontSize: 13, textAlign: "left",
                }}
              >
                <span aria-hidden>{drTimelineOpen ? "▾" : "▸"}</span>
                <span>Decision Timeline ({drEvents.length} events)</span>
                {drFlushStateRef.current.missing && (
                  <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 12 }}>
                    — on this device until Daily Replay storage is enabled
                  </span>
                )}
              </button>
              {drTimelineOpen && (
                <>
                  {drHistoryNote && (
                    <div style={{ marginTop: 8, color: "#fbbf24", fontSize: 12.5 }}>
                      {drHistoryNote}
                    </div>
                  )}
                  <div style={{ marginTop: 8, maxHeight: 260, overflowY: "auto", fontSize: 12.5, lineHeight: 1.9 }}>
                    {drEvents.map((e) => (
                      <div key={e.seq} style={{ display: "flex", gap: 8 }}>
                        <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                          {formatDrClock(e.marketTs ?? e.wallTs)}
                        </span>
                        <span>{describeDrEvent(e)}</span>
                      </div>
                    ))}
                    {drEvents.length === 0 && (
                      <div className="hint">No events recorded yet.</div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Daily Replay — Trade Drafts (per-cycle durable records).
              Collapsible, COLLAPSED BY DEFAULT (chart-first layout,
              2026-10-18): the compact header always carries the
              counts that matter — total drafts, how many still await
              review, and any NOT-saved failure — so nothing urgent is
              hidden by the collapse. */}
          {isDr && (
            <div
              className="card"
              style={{ marginTop: 10, padding: "10px 12px" }}
            >
              <button
                type="button"
                onClick={() => setDrDraftsOpen((o) => !o)}
                aria-expanded={drDraftsOpen}
                style={{
                  display: "flex", width: "100%", alignItems: "center", gap: 8, flexWrap: "wrap",
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  color: "inherit", textAlign: "left",
                }}
              >
                <span aria-hidden>{drDraftsOpen ? "▾" : "▸"}</span>
                <span style={{ fontWeight: 700, fontSize: 13 }}>Trade Drafts</span>
                {drDraftsAvailable !== false && (() => {
                  const failedKeys = drFailedDraftKeys.filter((k) => !drDraftRows.some((d) => d.draftKey === k));
                  const total = drDraftRowsSorted.length + failedKeys.length;
                  const toReview = drDraftRowsSorted.filter(
                    (r) => r.status === "draft" && !(r.resetGeneration < drStreamGen)
                  ).length;
                  const notSaved = failedKeys.length
                    + drDraftRowsSorted.filter((r) => drDraftSaveStates[r.draftKey] === "failed").length;
                  return (
                    <span className="hint" style={{ fontSize: 12 }}>
                      {total} draft{total === 1 ? "" : "s"}
                      {toReview > 0 ? ` · ${toReview} to review` : ""}
                      {notSaved > 0 && (
                        <span style={{ color: "#f6465d", fontWeight: 600 }}> · {notSaved} NOT saved</span>
                      )}
                    </span>
                  );
                })()}
              </button>
              {drDraftsOpen && (<>
              {drDraftNotice && (
                <div
                  style={{
                    display: "flex", gap: 8, alignItems: "center", marginTop: 8,
                    fontSize: 12.5,
                    color: drDraftNotice.tone === "ok" ? "var(--emerald-bright)" : "#fbbf24",
                  }}
                >
                  <span>{drDraftNotice.text}</span>
                  {drDraftNotice.tone === "warn" && drDraftNotice.text.includes("limit reached") && (
                    <a
                      href="/pricing"
                      className="btn primary"
                      style={{ padding: "1px 8px", fontSize: 11.5, textDecoration: "none" }}
                    >
                      Upgrade to Pro
                    </a>
                  )}
                  {drDraftNotice.tone === "warn" && (
                    <button
                      className="btn"
                      style={{ padding: "1px 8px", fontSize: 11.5 }}
                      onClick={() => showDrDraftNotice(null)}
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              )}
              {drDraftsAvailable === false ? (
                <p className="hint" style={{ margin: "8px 0 0" }}>
                  Trade drafts are not enabled on this deployment yet (its database update
                  has not been applied). Closed trades still save to the journal when the
                  replay completes.
                </p>
              ) : (
                <>
                  {drDraftRowsSorted.length === 0 && drFailedDraftKeys.length === 0 && (
                    <p className="hint" style={{ margin: "8px 0 0" }}>
                      Closed trades in this replay will appear here as drafts.
                    </p>
                  )}
                  <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                    {drDraftRowsSorted.map((row) => {
                      const saveState = drDraftSaveStates[row.draftKey];
                      const derivedSuperseded =
                        row.status === "draft" && row.resetGeneration < drStreamGen;
                      const chip =
                        saveState === "saving"
                          ? "saving…"
                          : saveState === "failed"
                            ? "NOT saved"
                            : derivedSuperseded || row.status === "superseded"
                              ? "Superseded"
                              : row.status === "finalized"
                                ? "Finalized"
                                : saveState === "saved"
                                  ? "Draft · saved"
                                  : "Draft";
                      const chipColor =
                        saveState === "failed"
                          ? "#f6465d"
                          : saveState === "saving"
                            ? "#fbbf24"
                            : derivedSuperseded || row.status === "superseded"
                              ? "var(--muted)"
                              : row.status === "finalized"
                                ? "var(--emerald-bright)"
                                : "var(--muted)";
                      return (
                        <div
                          key={row.draftKey}
                          style={{
                            display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center",
                            fontSize: 12.5, padding: "6px 8px",
                            background: "rgba(255,255,255,0.02)",
                            border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6,
                          }}
                        >
                          <span>
                            Trade {row.cycleIndex} · closed at candle #
                            {row.closeFillCandleIndex + 1} ·{" "}
                            <span className="num">{formatSigned(row.realizedPnl)}</span>
                          </span>
                          <span style={{ color: chipColor, fontWeight: 600 }}>{chip}</span>
                          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                            {saveState === "failed" && (
                              <button
                                className="btn"
                                style={{ padding: "2px 10px", fontSize: 11.5 }}
                                onClick={() => {
                                  const p = drFailedPayloadsRef.current.get(row.draftKey);
                                  if (p) void persistDrDraft(p, p.close_fill_candle_index);
                                }}
                              >
                                Retry
                              </button>
                            )}
                            <button
                              className="btn"
                              style={{ padding: "2px 10px", fontSize: 11.5 }}
                              onClick={() => setDrReviewDraftKey(row.draftKey)}
                            >
                              Review Draft
                            </button>
                            {row.status === "draft" && !derivedSuperseded && (
                              <button
                                className="btn primary"
                                style={{ padding: "2px 10px", fontSize: 11.5 }}
                                onClick={() => setDrFinalizeTarget(row)}
                              >
                                Finalize Trade
                              </button>
                            )}
                          </span>
                        </div>
                      );
                    })}
                    {/* Cycles whose draft write failed have no row yet —
                        they stay visible here with their retry. */}
                    {drFailedDraftKeys
                      .filter((k) => !drDraftRows.some((d) => d.draftKey === k))
                      .map((k) => {
                        const p = drFailedPayloadsRef.current.get(k);
                        if (!p) return null;
                        return (
                          <div
                            key={k}
                            style={{
                              display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center",
                              fontSize: 12.5, padding: "6px 8px",
                              background: "rgba(246,70,93,0.05)",
                              border: "1px solid rgba(246,70,93,0.25)", borderRadius: 6,
                            }}
                          >
                            <span>
                              Trade {p.cycle_index} · closed at candle #
                              {p.close_fill_candle_index + 1} ·{" "}
                              <span className="num">{formatSigned(p.realized_pnl)}</span>
                            </span>
                            <span style={{ color: "#f6465d", fontWeight: 600 }}>NOT saved</span>
                            <span style={{ marginLeft: "auto" }}>
                              <button
                                className="btn"
                                style={{ padding: "2px 10px", fontSize: 11.5 }}
                                onClick={() => { void persistDrDraft(p, p.close_fill_candle_index); }}
                              >
                                Retry
                              </button>
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </>
              )}
              </>)}
            </div>
          )}

          {/* Trade draft review drawer */}
          {drReviewRow && (
            <DrDraftReview
              draft={drReviewRow}
              ticker={drInfo?.ticker ?? null}
              tradeDate={drInfo?.tradeDate ?? null}
              attemptStatus={drPhase === "done" ? "finished" : "active"}
              events={drEvents}
              boundStrategyId={(() => {
                const link = drAttemptsList.find((a) => a.id === drReviewRow.attemptId);
                return link?.strategyVersionId
                  ? (resolveVersionContext(link.strategyVersionId, drStrategies, drStrategyVersions)?.strategy.id ?? null)
                  : null;
              })()}
              onClose={() => setDrReviewDraftKey(null)}
              onChanged={() => { void refreshDrDraftRows(); }}
            />
          )}

          {/* Finalize confirmation — the ONE shared dialog, also used
              by the journal drafts card and the review drawer. */}
          {drFinalizeTarget && (
            <DrFinalizeConfirm
              summary={{
                ticker: drInfo?.ticker ?? null,
                tradeDate: drInfo?.tradeDate ?? null,
                cycleIndex: drFinalizeTarget.cycleIndex,
                realizedPnl: drFinalizeTarget.realizedPnl,
              }}
              onConfirm={() => finalizeDrDraftFromStrip(drFinalizeTarget)}
              onClose={() => setDrFinalizeTarget(null)}
            />
          )}

          {/* Guest daily limit modal */}
          {showGuestModal && (
            <GuestLimitModal
              onCreateAccount={() => {
                setShowGuestModal(false);
                window.location.href = "/login";
              }}
              onDismiss={() => setShowGuestModal(false)}
            />
          )}

          {/* Subscription daily-limit modal (buy-time quota gate) */}
          {showUpgradeModal && (() => {
            const ent = entitlementRef.current;
            const limit = ent?.trades_limit ?? FREE_TRADES_PER_DAY;
            const used = ent
              ? Math.min(
                  quotaCombinedUsed({
                    signedIn: true, isPro: ent.is_pro,
                    dailyUsed: ent.trades_used,
                    sessionOpened: quotaOpenedRef.current,
                    dailyLimit: ent.trades_limit,
                  }),
                  limit
                )
              : limit;
            return (
              <UpgradeModal
                used={used}
                limit={limit}
                onDismiss={() => setShowUpgradeModal(false)}
              />
            );
          })()}

          {/* data source popover */}
          {dataOpen && (
            <div className="ws-data-pop" role="dialog" aria-label="Data source">
              <button className="mini-x ws-data-x" onClick={() => setDataOpen(false)} title="Close">✕</button>
              <DataSourcePanel candles={candles} meta={meta} onLoad={handleLoad} onPreview={handleDrPreview} />
            </div>
          )}
          {searchParams.get("diag") === "1" && eng && (
            <DiagPanel
              playing={playing}
              candleIndex={eng.index}
              formationProgress={eng.formationProgress}
              speed={speed}
            />
          )}
        </>
      )}
    </div>
  );
}

export default function ReplayPage() {
  return (
    <Suspense fallback={<div className="hint">Loading…</div>}>
      <ReplayPageInner />
    </Suspense>
  );
}
