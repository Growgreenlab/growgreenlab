"use client";

/**
 * DrDraftReview — shared review drawer for ONE Daily Replay trade
 * draft (components/DrDraftReview.tsx; used by the replay page's
 * Trade Drafts strip and by the journal's Daily Replay Drafts
 * section — both import this exact contract).
 *
 * Everything shown is DERIVED at read time from the attempt's event
 * stream + the draft row's anchors: fills, plan and timeline come
 * from the draft's cycle (splitCyclesByGeneration, the one shared
 * cycle splitter); the draft row itself stores identity, status and
 * reconciliation anchors only. Screenshots live under the DRAFT key
 * pre-finalization (plus the finalized trade key's prefix once a
 * mapping exists — union listing, never copied). Annotations save to
 * journal_trade_meta under the draft key; finalizing flips the
 * draft's status flag only (it never writes journal rows) and copies
 * the draft-key meta row forward to the finalized key when one is
 * known and no row exists there yet. Since the 2026-10-18 workflow
 * fix, a finalized draft's trade is journal-visible immediately
 * (pre-completion row keyed by the draft key) — finalization here
 * goes through the ONE shared confirmation dialog
 * (components/DrFinalizeConfirm.tsx), same as every other entry
 * point.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, isSupabaseConfigured } from "../lib/supabaseClient";
import { formatMoney, formatSigned } from "../lib/engine";
import {
  describeDrEvent,
  formatDrClock,
  type DrEvent,
} from "../lib/dailyReplayEvents";
import { splitCyclesByGeneration } from "../lib/drTradeEvidence";
import {
  finalizeDraft,
  updateDraftAutoCapture,
  type DrDraftRow,
} from "../lib/drDrafts";
import {
  listScreenshots,
  removeScreenshots,
  uploadScreenshots,
} from "../lib/journalAttachments";
import {
  representativeSourceLabel,
  resolveRepresentative,
  withRepresentativeSelection,
} from "../lib/drRepresentative";
import {
  mapStrategyRow,
  mapStrategyVersionRow,
  type Strategy,
  type StrategyVersion,
} from "../lib/strategies";
import { probeStrategyAnnotationSupport } from "../lib/strategyClassification";
import StrategyTradedField, {
  resolveTradedStrategyId,
  tradedValueFromMeta,
  type TradedStrategyValue,
} from "./StrategyTradedField";
import DrFinalizeConfirm from "./DrFinalizeConfirm";

/* Annotation option lists — mirrored EXACTLY from app/journal/page.tsx
 * (its SETUPS / HOD_CLASSES / GRADES / EMOTIONS / MISTAKES constants),
 * so a draft reviewed here offers the journal's own vocabulary. */
const SETUPS = ["HOD breakout", "EMA pullback", "VWAP pullback", "Clean breakout", "Weak breakout", "Failed breakout", "Anticipation", "Other"];
const HOD_CLASSES = ["clean", "weak", "failed", "anticipation"];
const GRADES = ["A", "B", "C", "D"];
const EMOTIONS = ["FOMO", "Revenge trading", "Hesitation", "Overconfidence", "Impatience", "Fear of losing", "Calm and disciplined"];
const MISTAKES = ["Entered too early", "Chased price", "Moved stop loss", "Exited too early", "Held loser too long", "Broke trading rules", "Overtraded"];

interface MetaForm {
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
}

const EMPTY_FORM: MetaForm = {
  setup_tag: null,
  hod_class: null,
  exec_grade: null,
  entry_reasoning: null,
  exit_reasoning: null,
  followed_plan: null,
  confidence: null,
  emotional_tags: [],
  mistakes: [],
  notes: null,
  lessons: null,
  would_take_again: null,
};

interface AutoCaptureSide {
  path?: string;
  candleIndex?: number;
  status?: string;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function numOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function autoSide(raw: unknown): AutoCaptureSide | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    path: typeof o.path === "string" && o.path ? o.path : undefined,
    candleIndex: numOrNull(o.candleIndex) ?? undefined,
    status: typeof o.status === "string" ? o.status : undefined,
  };
}

/** Copy a draft-key journal_trade_meta row forward to the finalized
 *  trade key — only when a row exists at the draft key and none exists
 *  yet at the target (the finalized key is canonical once written). */
async function copyMetaForward(
  client: ReturnType<typeof createClient>,
  userId: string,
  fromKey: string,
  toKey: string,
  sessionId: string | null,
): Promise<void> {
  const { data: src } = await client
    .from("journal_trade_meta")
    .select("*")
    .eq("trade_key", fromKey)
    .maybeSingle();
  if (!src) return;
  const { data: existing } = await client
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
  await client.from("journal_trade_meta").upsert(copy, { onConflict: "user_id,trade_key" });
}

export default function DrDraftReview(props: {
  draft: DrDraftRow;
  ticker: string | null;
  tradeDate: string | null;
  attemptStatus: string | null;
  events: DrEvent[];
  onClose: () => void;
  onChanged: () => void;
  /** Optional in-app "View in Trade Journal" action for the finalize
   *  confirmation's success state (journal hosts). Defaults to a
   *  plain /journal link inside the dialog. */
  onViewInJournal?: () => void;
  /** The strategy the draft's attempt was BOUND to at lock time
   *  (strategies.id), when known. Pre-selects the "Strategy traded"
   *  annotation as a suggestion only — the annotation is the
   *  trader's to override and never rewrites the binding. */
  boundStrategyId?: string | null;
}) {
  const { draft, ticker, tradeDate, attemptStatus, events, onClose, onChanged, onViewInJournal, boundStrategyId } = props;

  /* ---- cycle resolution ---- */
  const cycle = useMemo(() => {
    const { cycles } = splitCyclesByGeneration(events);
    return (
      cycles.find(
        (c) => c.generation === draft.resetGeneration && c.cycleIndex === draft.cycleIndex,
      ) ?? null
    );
  }, [events, draft.resetGeneration, draft.cycleIndex]);

  const fills = useMemo(
    () => (cycle ? cycle.events.filter((e) => e.type === "order_filled") : []),
    [cycle],
  );
  const buyFills = useMemo(() => fills.filter((e) => e.payload.side === "buy"), [fills]);
  const sellFills = useMemo(() => fills.filter((e) => e.payload.side === "sell"), [fills]);
  const totalQtyBought = buyFills.reduce((s, e) => s + numOrZero(e.payload.qty), 0);
  const buyQtyForAvg = totalQtyBought;
  const sellQtyForAvg = sellFills.reduce((s, e) => s + numOrZero(e.payload.qty), 0);
  const avgEntry =
    buyQtyForAvg > 0
      ? buyFills.reduce((s, e) => s + numOrZero(e.payload.price) * numOrZero(e.payload.qty), 0) / buyQtyForAvg
      : null;
  const avgExit =
    sellQtyForAvg > 0
      ? sellFills.reduce((s, e) => s + numOrZero(e.payload.price) * numOrZero(e.payload.qty), 0) / sellQtyForAvg
      : null;

  /* ---- plan (snapshot + active-scope bracket walk) ---- */
  const plan = useMemo(() => {
    if (!cycle) return null;
    const snap = cycle.snapshot;
    const snapPayload = snap ? snap.payload : null;
    let finalStop = snapPayload ? numOrNull(snapPayload.stopLoss) : null;
    let finalTarget = snapPayload ? numOrNull(snapPayload.takeProfit) : null;
    const adjustments: DrEvent[] = [];
    for (const e of cycle.events) {
      if (e.type !== "bracket_set" && e.type !== "bracket_modified") continue;
      if (e.payload.scope !== "active") continue;
      adjustments.push(e);
      if (e.type === "bracket_set") {
        finalStop = numOrNull(e.payload.stopLoss);
        finalTarget = numOrNull(e.payload.takeProfit);
      } else if (e.payload.field === "stopLoss") {
        finalStop = numOrNull(e.payload.next);
      } else if (e.payload.field === "takeProfit") {
        finalTarget = numOrNull(e.payload.next);
      }
    }
    return { snapPayload, finalStop, finalTarget, adjustments };
  }, [cycle]);

  /* ---- decision timeline slice ---- */
  const timeline = useMemo(
    () =>
      [...events]
        .filter((e) => e.seq >= draft.eventFirstSeq && e.seq <= draft.eventLastSeq)
        .sort((a, b) => a.seq - b.seq),
    [events, draft.eventFirstSeq, draft.eventLastSeq],
  );

  /* ---- local lifecycle status (finalize flips it in place) ---- */
  const [localStatus, setLocalStatus] = useState(draft.status);
  useEffect(() => { setLocalStatus(draft.status); }, [draft.id, draft.status]);
  const effectiveStatus = localStatus;
  const statusLine =
    effectiveStatus === "draft"
      ? "Draft — not in journal analytics yet."
      : effectiveStatus === "finalized"
        ? "Finalized — in the journal (Trade Journal → Daily Replay / Backtest)."
        : "Superseded — this position closed before a replay reset; its fills were not carried into the saved session, so it cannot be finalized.";

  /* ---- screenshots ---- */
  const [userId, setUserId] = useState<string | null>(null);
  const [shots, setShots] = useState<{ path: string; url: string }[]>([]);
  const [shotErrors, setShotErrors] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadShots = useCallback(async () => {
    if (!isSupabaseConfigured()) { setShots([]); return; }
    try {
      const client = createClient();
      const { data: { user } } = await client.auth.getUser();
      if (!user) { setShots([]); return; }
      setUserId(user.id);
      const byPath = new Map<string, { path: string; url: string }>();
      for (const s of await listScreenshots(client, user.id, draft.draftKey)) {
        byPath.set(s.path, s);
      }
      if (draft.finalizedTradeKey) {
        for (const s of await listScreenshots(client, user.id, draft.finalizedTradeKey)) {
          byPath.set(s.path, s);
        }
      }
      setShots([...byPath.values()]);
    } catch {
      setShots([]);
    }
  }, [draft.draftKey, draft.finalizedTradeKey]);

  useEffect(() => { void loadShots(); }, [loadShots]);

  const entryCapture = autoSide(draft.autoCapture?.entry);
  const exitCapture = autoSide(draft.autoCapture?.exit);
  const captureBadgeFor = (path: string): string | null => {
    if (entryCapture?.path && entryCapture.path === path) {
      return `Entry capture — candle #${(entryCapture.candleIndex ?? 0) + 1} (captured at the entry fill; the candle was still forming)`;
    }
    if (exitCapture?.path && exitCapture.path === path) {
      return `Exit capture — candle #${(exitCapture.candleIndex ?? 0) + 1} (captured at the closing fill; the candle was still forming)`;
    }
    return null;
  };

  /* ---- representative screenshot (plan §2.2/§5 S1.3) ----
   * Resolved from the same record the export uses, so the badge here
   * and the package manifest can never disagree. The representative
   * sorts first in the gallery; every other image can be promoted via
   * "Use as representative", which merges a `representative` member
   * into the draft's auto_capture (entry/exit outcomes preserved). */
  const representative = useMemo(() => {
    if (!userId) return null;
    return resolveRepresentative({
      autoCapture: draft.autoCapture,
      listedPaths: shots.map((s) => s.path),
      draftKey: draft.draftKey,
      finalizedTradeKey: draft.finalizedTradeKey,
      userId,
      draftStatus: draft.status,
    });
  }, [userId, shots, draft.autoCapture, draft.draftKey, draft.finalizedTradeKey, draft.status]);

  const sortedShots = useMemo(() => {
    if (!representative) return shots;
    const rep = shots.find((s) => s.path === representative.path);
    if (!rep) return shots;
    return [rep, ...shots.filter((s) => s.path !== representative.path)];
  }, [shots, representative]);

  const [settingRep, setSettingRep] = useState<string | null>(null);
  const [repError, setRepError] = useState<string | null>(null);
  const handleUseAsRepresentative = async (path: string) => {
    setRepError(null);
    setSettingRep(path);
    try {
      if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
      const client = createClient();
      const merged = withRepresentativeSelection(draft.autoCapture, path, new Date().toISOString());
      const res = await updateDraftAutoCapture(client, draft.id, merged);
      if (res.error) throw new Error(res.error instanceof Error ? res.error.message : "Could not save the selection.");
      onChanged();
    } catch (e) {
      setRepError(e instanceof Error ? e.message : "Could not save the selection.");
    } finally {
      setSettingRep(null);
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setShotErrors([]);
    setUploading(true);
    try {
      if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
      const client = createClient();
      let uid = userId;
      if (!uid) {
        const { data: { user } } = await client.auth.getUser();
        if (!user) throw new Error("Not signed in.");
        uid = user.id;
        setUserId(uid);
      }
      const { errors } = await uploadScreenshots(client, uid, draft.draftKey, Array.from(files));
      if (errors.length > 0) setShotErrors(errors);
      await loadShots();
    } catch (e) {
      setShotErrors([e instanceof Error ? e.message : "Upload failed."]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemoveShot = async (path: string) => {
    try {
      if (!isSupabaseConfigured()) return;
      const client = createClient();
      await removeScreenshots(client, [path]);
      await loadShots();
    } catch { /* best-effort — list refresh reflects reality */ }
  };

  /* ---- annotations (journal_trade_meta under the draft key) ---- */
  const [form, setForm] = useState<MetaForm>(EMPTY_FORM);
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaMsg, setMetaMsg] = useState<string | null>(null);

  /* ---- strategy annotation (dark until its migration lands) ----
   * The probe decides whether the "Strategy traded" fields exist on
   * this database at all. Until they do, this drawer renders and
   * saves EXACTLY as before — the new selectors never mount and the
   * save payload never names the new columns. */
  const [annotationAvailable, setAnnotationAvailable] = useState(false);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategyVersions, setStrategyVersions] = useState<StrategyVersion[]>([]);
  const [tsValue, setTsValue] = useState<TradedStrategyValue | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!isSupabaseConfigured()) return;
      try {
        const client = createClient();
        const ok = await probeStrategyAnnotationSupport(client as unknown as Parameters<typeof probeStrategyAnnotationSupport>[0]);
        if (!alive) return;
        setAnnotationAvailable(ok);
        if (!ok) return;
        const [sRes, vRes] = await Promise.all([
          client.from("strategies").select("*").limit(200),
          client.from("strategy_versions").select("*").limit(1000),
        ]);
        if (!alive) return;
        if (!sRes.error && sRes.data) setStrategies((sRes.data as Record<string, unknown>[]).map((r) => mapStrategyRow(r)));
        if (!vRes.error && vRes.data) setStrategyVersions((vRes.data as Record<string, unknown>[]).map((r) => mapStrategyVersionRow(r)));
      } catch { if (alive) setAnnotationAvailable(false); }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setForm(EMPTY_FORM);
      setTsValue(null);
      setMetaMsg(null);
      if (!isSupabaseConfigured()) return;
      try {
        const client = createClient();
        const { data } = await client
          .from("journal_trade_meta")
          .select("*")
          .eq("trade_key", draft.draftKey)
          .maybeSingle();
        if (!alive) return;
        if (!data) {
          // No annotation row yet — the form still starts from the
          // bound-strategy suggestion so the field can be saved.
          setTsValue(tradedValueFromMeta(null, { suggestedStrategyId: boundStrategyId ?? null }));
          return;
        }
        const r = data as Record<string, unknown>;
        setTsValue(tradedValueFromMeta(r, { suggestedStrategyId: boundStrategyId ?? null }));
        setForm({
          setup_tag: typeof r.setup_tag === "string" ? r.setup_tag : null,
          hod_class: typeof r.hod_class === "string" ? r.hod_class : null,
          exec_grade: typeof r.exec_grade === "string" ? r.exec_grade : null,
          entry_reasoning: typeof r.entry_reasoning === "string" ? r.entry_reasoning : null,
          exit_reasoning: typeof r.exit_reasoning === "string" ? r.exit_reasoning : null,
          followed_plan: typeof r.followed_plan === "boolean" ? r.followed_plan : null,
          confidence: numOrNull(r.confidence),
          emotional_tags: Array.isArray(r.emotional_tags) ? (r.emotional_tags as string[]) : [],
          mistakes: Array.isArray(r.mistakes) ? (r.mistakes as string[]) : [],
          notes: typeof r.notes === "string" ? r.notes : null,
          lessons: typeof r.lessons === "string" ? r.lessons : null,
          would_take_again: typeof r.would_take_again === "boolean" ? r.would_take_again : null,
        });
      } catch { /* no meta yet — the empty form is the honest state */ }
    })();
    return () => { alive = false; };
  }, [draft.draftKey, boundStrategyId]);

  const saveMeta = async () => {
    setSavingMeta(true);
    setMetaMsg(null);
    try {
      if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
      const client = createClient();
      const { data: { user } } = await client.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const payload: Record<string, unknown> = {
        user_id: user.id,
        session_id: null,
        trade_key: draft.draftKey,
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
      if (annotationAvailable && tsValue) {
        // Strategy annotation (lit mode only): resolve the registry
        // row first (presets/customs materialize here, idempotently),
        // then persist by stable ID. hod_class is NOT written by the
        // new flow — the recorded slug supersedes it at read time
        // via the coalesce, and the legacy value stays untouched.
        payload.strategy_id = await resolveTradedStrategyId(client, user.id, tsValue, strategies, strategyVersions);
        payload.setup_class = tsValue.setupClass;
        payload.strategy_custom_label = tsValue.customLabel;
        payload.entry_trigger = tsValue.entryTrigger;
        delete payload.hod_class;
      }
      const { error } = await client
        .from("journal_trade_meta")
        .upsert(payload, { onConflict: "user_id,trade_key" });
      if (error) throw new Error(error.message);
      setMetaMsg("Saved.");
      onChanged();
    } catch (e) {
      setMetaMsg(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSavingMeta(false);
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
      <button key={val} type="button" onClick={() => toggleArr(field, val)}
        style={{
          padding: "4px 10px", borderRadius: 20, fontSize: 12, cursor: "pointer",
          background: active ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.05)",
          border: active ? "1px solid rgba(16,185,129,0.5)" : "1px solid rgba(255,255,255,0.1)",
          color: active ? "#34d399" : "var(--muted)",
        }}>{val}</button>
    );
  };

  /* ---- finalize (via the ONE shared confirmation dialog) ---- */
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const handleFinalize = async () => {
    if (effectiveStatus !== "draft" || !cycle) return;
    if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
    const client = createClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) throw new Error("Not signed in.");
    await finalizeDraft(client, draft.id);
    setLocalStatus("finalized");
    if (draft.finalizedTradeKey) {
      await copyMetaForward(client, user.id, draft.draftKey, draft.finalizedTradeKey, draft.finalizedSessionId);
    }
    onChanged();
  };

  const boolSelectValue = (v: boolean | null) => (v == null ? "" : v ? "yes" : "no");
  const parseBoolSelect = (v: string): boolean | null => (v === "" ? null : v === "yes");

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70, padding: 16 }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ padding: 20, maxWidth: 760, width: "100%", maxHeight: "90vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <h3 style={{ margin: "0 0 4px" }}>
              Draft Review{ticker ? <> — {ticker}</> : null}
              {tradeDate ? <span className="hint"> · {tradeDate}</span> : null}
            </h3>
            <div className="hint" style={{ fontSize: 12 }}>
              Trade {draft.cycleIndex}
              {attemptStatus ? <> · attempt {attemptStatus}</> : null}
              {" "}· draft key <span className="num">{draft.draftKey}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close draft review"
            style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 18, padding: "2px 6px", flexShrink: 0 }}
          >
            ×
          </button>
        </div>

        <p style={{ margin: "10px 0 0", fontSize: 13, color: effectiveStatus === "superseded" ? "#fbbf24" : "var(--muted)" }}>
          {statusLine}
        </p>

        {!cycle ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, fontSize: 13 }}>
              <div><span className="hint">First fill</span><div className="num">candle #{draft.firstFillCandleIndex + 1} · {draft.firstFillQty} @ {formatMoney(draft.firstFillPrice)}</div></div>
              <div><span className="hint">Close fill candle</span><div className="num">#{draft.closeFillCandleIndex + 1}</div></div>
              <div><span className="hint">Realized P&amp;L</span><div className="num">{formatSigned(draft.realizedPnl)}</div></div>
              <div><span className="hint">Timeline events</span><div className="num">seq {draft.eventFirstSeq}–{draft.eventLastSeq}</div></div>
              <div><span className="hint">Reset generation</span><div className="num">{draft.resetGeneration}</div></div>
            </div>
            <p style={{ marginTop: 10, fontSize: 13, color: "#fbbf24" }}>
              This draft&apos;s cycle could not be found in the loaded event stream — it is flagged for review and cannot be finalized from here.
            </p>
          </div>
        ) : (
          <>
            {/* Summary */}
            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, fontSize: 13 }}>
              <div><span className="hint">Avg Entry</span><div className="num">{avgEntry != null ? formatMoney(avgEntry) : "—"}</div></div>
              <div><span className="hint">Avg Exit</span><div className="num">{avgExit != null ? formatMoney(avgExit) : "—"}</div></div>
              <div><span className="hint">Qty bought</span><div className="num">{totalQtyBought}</div></div>
              <div><span className="hint">Realized P&amp;L</span><div className="num" style={{ color: draft.realizedPnl > 0 ? "var(--emerald-bright)" : draft.realizedPnl < 0 ? "#f6465d" : "var(--muted)" }}>{formatSigned(draft.realizedPnl)}</div></div>
            </div>
            <p className="hint" style={{ marginTop: 8, fontSize: 12 }}>
              Fees are not modeled by the replay engine — gross and net P&amp;L are identical.
            </p>

            {/* Fills */}
            {fills.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Fills</div>
                {fills.map((e) => (
                  <div key={e.seq} style={{ display: "flex", gap: 12, fontSize: 13, padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <span style={{ color: e.payload.side === "buy" ? "var(--emerald-bright)" : "#f6465d", fontWeight: 600, textTransform: "uppercase", width: 36 }}>
                      {String(e.payload.side ?? "")}
                    </span>
                    <span className="num">{numOrZero(e.payload.qty)} @ {formatMoney(numOrZero(e.payload.price))}</span>
                    <span className="hint">candle #{numOrZero(e.payload.candleIndex) + 1}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Plan */}
            <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Original plan</div>
              {plan?.snapPayload ? (
                <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                  <div>
                    <span className="hint">Original plan:</span>{" "}
                    entry {formatMoney(numOrZero(plan.snapPayload.entry))} × {numOrZero(plan.snapPayload.qty)}
                    {" "}· stop {plan.snapPayload.stopLoss != null ? formatMoney(numOrZero(plan.snapPayload.stopLoss)) : "—"}
                    {" "}· target {plan.snapPayload.takeProfit != null ? formatMoney(numOrZero(plan.snapPayload.takeProfit)) : "—"}
                    {plan.snapPayload.plannedRisk != null && <> · planned risk <span className="num">{formatMoney(numOrZero(plan.snapPayload.plannedRisk))}</span></>}
                    {plan.snapPayload.rewardRisk != null && <> · R:R <span className="num">{numOrZero(plan.snapPayload.rewardRisk).toFixed(2)}</span></>}
                  </div>
                  <div>
                    <span className="hint">Final levels:</span>{" "}
                    stop {plan.finalStop != null ? formatMoney(plan.finalStop) : "—"} · target {plan.finalTarget != null ? formatMoney(plan.finalTarget) : "—"}
                  </div>
                  {plan.adjustments.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <div className="hint" style={{ marginBottom: 4 }}>Adjustments</div>
                      {plan.adjustments.map((e) => (
                        <div key={e.seq} style={{ fontSize: 12.5 }}>{describeDrEvent(e)}</div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="hint" style={{ margin: 0, fontSize: 12.5 }}>
                  No risk snapshot was recorded for this cycle, so the original plan is not known.
                </p>
              )}
            </div>

            {/* Decision Timeline */}
            <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Decision Timeline</div>
              {timeline.length === 0 && (
                <p className="hint" style={{ margin: 0 }}>No timeline events in this draft&apos;s range.</p>
              )}
              <div style={{ display: "grid", gap: 3, maxHeight: 300, overflowY: "auto" }}>
                {timeline.map((e) => (
                  <div key={e.seq} style={{ fontSize: 12.5, display: "flex", gap: 10, padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <span className="num" style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                      {formatDrClock(e.marketTs ?? e.wallTs)}
                    </span>
                    <span>{describeDrEvent(e)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Screenshots */}
        <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Screenshots</div>
            <label className="btn" style={{ padding: "3px 10px", fontSize: 12, cursor: uploading ? "default" : "pointer" }}>
              {uploading ? "Uploading…" : "Add screenshots"}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                disabled={uploading}
                onChange={(e) => { void handleUpload(e.target.files); }}
              />
            </label>
          </div>
          {entryCapture && !entryCapture.path && (entryCapture.status === "failed" || entryCapture.status === "skipped") && (
            <div className="hint" style={{ fontSize: 12, marginBottom: 4 }}>
              Entry auto-capture: {entryCapture.status}. The entry moment cannot be recaptured after the fact — attach a screenshot, or choose one below as the representative instead.
            </div>
          )}
          {exitCapture && !exitCapture.path && (exitCapture.status === "failed" || exitCapture.status === "skipped") && (
            <div className="hint" style={{ fontSize: 12, marginBottom: 4 }}>Exit auto-capture: {exitCapture.status}</div>
          )}
          {repError && <div className="err" style={{ fontSize: 12.5, marginBottom: 8 }}>{repError}</div>}
          {shotErrors.length > 0 && (
            <div className="err" style={{ fontSize: 12.5, marginBottom: 8 }}>
              {shotErrors.map((err, i) => <div key={i}>{err}</div>)}
            </div>
          )}
          {shots.length === 0 ? (
            <p className="hint" style={{ margin: 0, fontSize: 12.5 }}>No screenshots yet.</p>
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {sortedShots.map((s) => {
                const badge = captureBadgeFor(s.path);
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
                    {badge && <div style={{ fontSize: 11, color: "var(--emerald-bright)", marginTop: 4 }}>{badge}</div>}
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: "2px 8px", fontSize: 11, marginTop: 4 }}
                        onClick={() => { void handleRemoveShot(s.path); }}
                      >
                        Remove
                      </button>
                      {!isRep && (
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: "2px 8px", fontSize: 11, marginTop: 4 }}
                          disabled={settingRep != null}
                          onClick={() => { void handleUseAsRepresentative(s.path); }}
                        >
                          {settingRep === s.path ? "Saving…" : "Use as representative"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Annotations */}
        <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Trade DNA</div>
          <div style={{ display: "grid", gap: 12 }}>
            {annotationAvailable && tsValue && (
              <StrategyTradedField
                strategies={strategies}
                versions={strategyVersions}
                value={tsValue}
                onChange={setTsValue}
              />
            )}
            <div className="field">
              <label>Setup</label>
              <select className="input" value={form.setup_tag ?? ""} onChange={(e) => setForm({ ...form, setup_tag: e.target.value || null })}>
                <option value="">— Select —</option>
                {SETUPS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {!annotationAvailable && (
                <div className="field">
                  <label>HOD Classification</label>
                  <select className="input" value={form.hod_class ?? ""} onChange={(e) => setForm({ ...form, hod_class: e.target.value || null })}>
                    <option value="">—</option>
                    {HOD_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}
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
            <div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Emotional state</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{EMOTIONS.map((e) => chip("emotional_tags", e))}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Mistakes</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{MISTAKES.map((e) => chip("mistakes", e))}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <div className="field">
                <label>Confidence (1–10)</label>
                <input className="input num" type="number" min={1} max={10} value={form.confidence ?? ""} onChange={(e) => setForm({ ...form, confidence: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div className="field">
                <label>Followed plan?</label>
                <select className="input" value={boolSelectValue(form.followed_plan)} onChange={(e) => setForm({ ...form, followed_plan: parseBoolSelect(e.target.value) })}>
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div className="field">
                <label>Would take again?</label>
                <select className="input" value={boolSelectValue(form.would_take_again)} onChange={(e) => setForm({ ...form, would_take_again: parseBoolSelect(e.target.value) })}>
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
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn primary" onClick={() => { void saveMeta(); }} disabled={savingMeta}>
              {savingMeta ? "Saving…" : "Save Review"}
            </button>
            {metaMsg && (
              <span style={{ marginLeft: 12, fontSize: 13, color: metaMsg === "Saved." ? "var(--emerald-bright)" : "#f6465d" }}>{metaMsg}</span>
            )}
          </div>
        </div>

        {/* Finalize — opens the shared confirmation dialog */}
        {effectiveStatus === "draft" && cycle && (
          <div style={{ marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" className="btn primary big" onClick={() => setFinalizeOpen(true)}>
              Finalize Trade
            </button>
          </div>
        )}
        {effectiveStatus === "draft" && !cycle && (
          <div style={{ marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
            <button type="button" className="btn primary big" disabled>Finalize Trade</button>
          </div>
        )}
      </div>
      {finalizeOpen && (
        <DrFinalizeConfirm
          summary={{ ticker, tradeDate, cycleIndex: draft.cycleIndex, realizedPnl: draft.realizedPnl }}
          onConfirm={handleFinalize}
          onClose={() => setFinalizeOpen(false)}
          onViewInJournal={onViewInJournal}
        />
      )}
    </div>
  );
}
