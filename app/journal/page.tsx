"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";
import { groupFillsIntoTrades, calcMetrics, calcRealTrade, validateRealFills, parseBrokerCsv, parseWithMapping, autoMapColumns, MAPPABLE_FIELDS, groupImportedFills, fmtPnl, fmtPct, type GroupedTrade, type RawFill, type RealFill, type RealTradeCalc, type BrokerParseResult, type ImportedTrade } from "../../lib/journal";
import { breakdown, riskMetrics, edgeInsights, dailyPnl, type AnalyticsTrade, type BreakdownDimension, type Insight } from "../../lib/journalAnalytics";
import { listScreenshots, removeScreenshots, uploadScreenshots, validateScreenshotFile } from "../../lib/journalAttachments";

type Tab = "overview" | "trades" | "review" | "calendar" | "analytics";
type Period = "today" | "week" | "month" | "30d" | "90d" | "ytd" | "all";
type SourceFilter = "all" | "simulator" | "real";

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
  const [period, setPeriod] = useState<Period>("all");
  const [trades, setTrades] = useState<GroupedTrade[]>([]);
  const [metas, setMetas] = useState<Record<string, TradeMeta>>({});
  const [realTrades, setRealTrades] = useState<RealTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedCalDay, setSelectedCalDay] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
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
          calc: calcRealTrade(rf, rt.direction, rt.stop_loss != null ? Number(rt.stop_loss) : null, rt.target != null ? Number(rt.target) : null),
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

  // Build unified trade list with source tags
  const unified: UnifiedTrade[] = useMemo(() => {
    const sim: UnifiedTrade[] = trades.map((t) => ({
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
      rMultiple: t.rMultiple,
    }));
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
    }));
    return [...sim, ...rl].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
  }, [trades, realTrades]);

  // Filter by source + period + search (date-string comparison avoids TZ bugs)
  const filtered = useMemo(() => {
    const startStr = periodStartStr(period);
    return unified.filter((t) => {
      if (sourceFilter !== "all" && t.source !== sourceFilter) return false;
      if (startStr && t.tradeDate < startStr) return false;
      if (fTicker && !t.ticker.toLowerCase().includes(fTicker.toLowerCase())) return false;
      if (fSetup && metas[t.key]?.setup_tag !== fSetup) return false;
      if (fWinLoss === "win" && t.realizedPnl <= 0) return false;
      if (fWinLoss === "loss" && t.realizedPnl >= 0) return false;
      return true;
    });
  }, [unified, sourceFilter, period, fTicker, fSetup, fWinLoss, metas]);

  // Closed trades only for metrics
  const closedFiltered = useMemo(() => filtered.filter((t) => !t.isOpen), [filtered]);
  const metrics = useMemo(() => calcMetrics(closedFiltered), [closedFiltered]);

  // Per-source metrics
  const simMetrics = useMemo(() => calcMetrics(closedFiltered.filter((t) => t.source === "simulator")), [closedFiltered]);
  const realMetrics = useMemo(() => calcMetrics(closedFiltered.filter((t) => t.source === "real")), [closedFiltered]);

  // Enriched view for Analytics: the SAME filtered closed set, joined with
  // Trade DNA annotations and the underlying records (timestamps, stop, risk).
  const analyticsTrades: AnalyticsTrade[] = useMemo(() => {
    const simByKey = new Map(trades.map((t) => [t.tradeKey, t]));
    const realById = new Map(realTrades.map((t) => [`real:${t.id}`, t]));
    return closedFiltered.map((t) => {
      const meta = metas[t.key];
      let entryTime: string | null = null;
      let exitTime: string | null = null;
      let stopLoss: number | null = null;
      let initialRisk: number | null = null;
      if (t.source === "simulator") {
        const g = simByKey.get(t.key);
        entryTime = g?.entryTime ?? null;
        exitTime = g?.exitTime ?? null;
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
      };
    });
  }, [closedFiltered, trades, realTrades, metas]);
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
        : trades.find((t) => t.tradeKey === selectedKey) ?? null)
    : null;
  const selectedMeta = selectedKey ? metas[selectedKey] : null;
  const isRealSelected = selectedKey?.startsWith("real:") ?? false;

  // Period-agnostic counts for the CURRENT source filter — the Overview
  // empty states key off these (not the both-sources total), so a user
  // with simulator trades still gets the real-market empty state + the
  // Add Real Trade action when they have no real trades.
  const sourceTotalCount = useMemo(
    () => unified.filter((t) => sourceFilter === "all" || t.source === sourceFilter).length,
    [unified, sourceFilter],
  );
  const sourceClosedCount = useMemo(
    () => unified.filter((t) => (sourceFilter === "all" || t.source === sourceFilter) && !t.isOpen).length,
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

  if (loading) return <div className="wrap" style={{ padding: 40 }}><p className="hint">Loading journal…</p></div>;
  if (error) return <div className="wrap" style={{ padding: 40 }}><div className="err">{error}</div><p style={{ marginTop: 12 }}><Link href="/replay">← Back to simulator</Link></p></div>;

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <h2 style={{ margin: "0 0 4px" }}>Trade Journal</h2>
      <p className="hint" style={{ margin: "0 0 16px" }}>Your Trade DNA — every trade, graded and reviewed.</p>

      <div className="tabs" style={{ marginBottom: 12 }}>
        {(["overview", "trades", "review", "calendar", "analytics"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "overview" ? "Overview" : t === "trades" ? "All Trades" : t === "review" ? "Trade Review" : t === "calendar" ? "Calendar" : "Analytics"}
          </button>
        ))}
      </div>

      {/* Source filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>Source:</span>
        {([["all", "All Trades"], ["simulator", "Simulator"], ["real", "Real Market"]] as [SourceFilter, string][]).map(([s, label]) => (
          <button key={s} onClick={() => setSourceFilter(s)}
            style={{
              padding: "4px 12px", borderRadius: 16, fontSize: 12, cursor: "pointer",
              background: sourceFilter === s ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.05)",
              border: sourceFilter === s ? "1px solid rgba(16,185,129,0.5)" : "1px solid rgba(255,255,255,0.1)",
              color: sourceFilter === s ? "#34d399" : "var(--muted)",
            }}>{label}</button>
        ))}
      </div>

      {notice && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "10px 14px", marginBottom: 16, borderRadius: 8, background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.4)", fontSize: 13 }}>
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
        </div>
      )}

      {tab === "overview" && <OverviewTab metrics={metrics} simMetrics={simMetrics} realMetrics={realMetrics} cumPnl={cumPnl} trades={filtered} sourceTotalCount={sourceTotalCount} sourceClosedCount={sourceClosedCount} period={period} setPeriod={setPeriod} sourceFilter={sourceFilter} avgR={analyticsRisk.avgR} maxDrawdown={analyticsRisk.maxDrawdownUSD} onSelect={(k) => { setSelectedKey(k); setTab("review"); }} onAddRealTrade={() => { setEditingReal(null); setTab("trades"); setShowRealForm(true); }} onImportBroker={() => { setTab("trades"); setShowImport(true); }} />}
      {tab === "trades" && <TradesTab trades={filtered} metas={metas} fTicker={fTicker} setFTicker={setFTicker} fSetup={fSetup} setFSetup={setFSetup} fWinLoss={fWinLoss} setFWinLoss={setFWinLoss} onSelect={(k) => { setSelectedKey(k); setTab("review"); }} onRealTradeSaved={handleRealTradeSaved} showRealForm={showRealForm} setShowRealForm={setShowRealForm} showImport={showImport} setShowImport={setShowImport} sourceFilter={sourceFilter} editingReal={editingReal} onEditReal={startEditReal} onDeleteReal={startDeleteReal} onCancelEdit={cancelEdit} />}
      {tab === "review" && <ReviewTab tradeKey={selectedKey} simTrade={!isRealSelected ? (selected as GroupedTrade | null) : null} realTrade={isRealSelected ? (selected as RealTrade | null) : null} meta={selectedMeta} onSaved={load} onEditReal={startEditReal} onDeleteReal={startDeleteReal} />}
      {tab === "calendar" && <CalendarTab trades={closedFiltered} metas={metas} selectedDay={selectedCalDay} onSelectDay={setSelectedCalDay} onSelectTrade={(k) => { setSelectedKey(k); setTab("review"); }} />}
      {tab === "analytics" && <AnalyticsTab trades={analyticsTrades} onSelect={(k) => { setSelectedKey(k); setTab("review"); }} />}

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
function SourceBadge({ source }: { source: "simulator" | "real" }) {
  const isReal = source === "real";
  return (
    <span style={{
      fontSize: 10, padding: "2px 8px", borderRadius: 10, fontWeight: 600,
      background: isReal ? "rgba(96,165,250,0.15)" : "rgba(16,185,129,0.12)",
      border: isReal ? "1px solid rgba(96,165,250,0.4)" : "1px solid rgba(16,185,129,0.3)",
      color: isReal ? "#93c5fd" : "#34d399",
    }}>{isReal ? "Real Market" : "Simulator"}</span>
  );
}

function OverviewTab({ metrics, simMetrics, realMetrics, cumPnl, trades, sourceTotalCount, sourceClosedCount, period, setPeriod, sourceFilter, avgR, maxDrawdown, onSelect, onAddRealTrade, onImportBroker }: {
  metrics: ReturnType<typeof calcMetrics>;
  simMetrics: ReturnType<typeof calcMetrics>;
  realMetrics: ReturnType<typeof calcMetrics>;
  cumPnl: number[];
  trades: UnifiedTrade[];
  /** All trades (open + closed) matching the source filter, any period */
  sourceTotalCount: number;
  /** Closed trades matching the source filter, any period */
  sourceClosedCount: number;
  period: Period;
  setPeriod: (p: Period) => void;
  sourceFilter: SourceFilter;
  avgR: number | null;
  maxDrawdown: number;
  onSelect: (k: string) => void;
  onAddRealTrade: () => void;
  onImportBroker: () => void;
}) {
  const periods: { id: Period; label: string }[] = [
    { id: "today", label: "Today" }, { id: "week", label: "Week" }, { id: "month", label: "Month" },
    { id: "30d", label: "30D" }, { id: "90d", label: "90D" }, { id: "ytd", label: "YTD" }, { id: "all", label: "All" },
  ];
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
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {periods.map((p) => (
          <button key={p.id} className={`tab ${period === p.id ? "active" : ""}`} onClick={() => setPeriod(p.id)} style={{ fontSize: 12 }}>{p.label}</button>
        ))}
      </div>

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
            {stat("Net P&L", fmtPnl(m.netPnl), m.netPnl)}
            {stat("Win Rate", fmtPct(m.winRate))}
            {stat("Total Trades", String(m.totalTrades))}
            {stat("Profit Factor", m.profitFactor == null ? "—" : m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2))}
            {stat("Avg Win", fmtPnl(m.avgWin), m.avgWin)}
            {stat("Avg Loss", fmtPnl(m.avgLoss), m.avgLoss)}
            {stat("Expectancy", fmtPnl(m.expectancy), m.expectancy)}
            {stat("Largest Win", fmtPnl(m.largestWin), m.largestWin)}
            {stat("Avg R", avgR == null ? "—" : `${avgR.toFixed(2)}R`)}
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
                <span><b>{t.ticker}</b> <span className="hint">{t.tradeDate} · {t.direction}</span> <SourceBadge source={t.source} />{t.isOpen && <span style={{ fontSize: 10, color: "#fbbf24", marginLeft: 6 }}>OPEN</span>}</span>
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
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- All Trades ---------------- */
function TradesTab({ trades, metas, fTicker, setFTicker, fSetup, setFSetup, fWinLoss, setFWinLoss, onSelect, onRealTradeSaved, showRealForm, setShowRealForm, showImport, setShowImport, sourceFilter, editingReal, onEditReal, onDeleteReal, onCancelEdit }: {
  trades: UnifiedTrade[]; metas: Record<string, TradeMeta>;
  fTicker: string; setFTicker: (v: string) => void;
  fSetup: string; setFSetup: (v: string) => void;
  fWinLoss: string; setFWinLoss: (v: string) => void;
  onSelect: (k: string) => void;
  onRealTradeSaved: (notice?: string) => void;
  showRealForm: boolean; setShowRealForm: (v: boolean | ((p: boolean) => boolean)) => void;
  showImport: boolean; setShowImport: (v: boolean | ((p: boolean) => boolean)) => void;
  sourceFilter: SourceFilter;
  editingReal: { trade: RealTrade; meta: TradeMeta | null } | null;
  onEditReal: (k: string) => void;
  onDeleteReal: (k: string) => void;
  onCancelEdit: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input className="input" placeholder="Search ticker…" value={fTicker} onChange={(e) => setFTicker(e.target.value)} style={{ maxWidth: 160 }} />
        <select className="input" value={fSetup} onChange={(e) => setFSetup(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="">All setups</option>
          {SETUPS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input" value={fWinLoss} onChange={(e) => setFWinLoss(e.target.value)} style={{ maxWidth: 140 }}>
          <option value="">Win/Loss</option>
          <option value="win">Winners</option>
          <option value="loss">Losers</option>
        </select>
        {sourceFilter !== "simulator" && (
          <>
            <button className="btn primary" onClick={() => { if (editingReal) onCancelEdit(); else setShowRealForm((v) => !v); }} style={{ marginLeft: "auto" }}>
              {editingReal ? "Cancel edit" : showRealForm ? "Cancel" : "+ Add Real Trade"}
            </button>
            <button className="btn" onClick={() => setShowImport((v) => !v)}>
              {showImport ? "Cancel" : "⭳ Import from Broker"}
            </button>
          </>
        )}
      </div>
      {showRealForm && (
        <RealTradeForm
          key={editingReal ? `edit-${editingReal.trade.id}` : "add"}
          editing={editingReal}
          onCancel={onCancelEdit}
          onSaved={(notice) => { setShowRealForm(false); onRealTradeSaved(notice); }}
        />
      )}
      {showImport && <BrokerImportForm onSaved={() => { setShowImport(false); onRealTradeSaved(); }} />}
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", textAlign: "left" }}>
              {["Date", "Symbol", "Src", "Dir", "Entry", "Qty", "P&L", "Setup", "Grade", "Actions"].map((h) => (
                <th key={h} style={{ padding: "10px 12px", color: "var(--muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const meta = metas[t.key];
              return (
                <tr key={t.key} onClick={() => onSelect(t.key)}
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", cursor: "pointer" }}>
                  <td style={{ padding: "10px 12px" }}>{t.tradeDate}</td>
                  <td style={{ padding: "10px 12px", fontWeight: 600 }}>{t.ticker}</td>
                  <td style={{ padding: "10px 12px" }}><SourceBadge source={t.source} /></td>
                  <td style={{ padding: "10px 12px" }}>{t.direction}{t.isOpen && <span style={{ fontSize: 10, color: "#fbbf24", marginLeft: 4 }}>OPEN</span>}</td>
                  <td className="num" style={{ padding: "10px 12px" }}>{t.entryPrice != null ? `$${t.entryPrice.toFixed(2)}` : "—"}</td>
                  <td className="num" style={{ padding: "10px 12px" }}>{t.qty}</td>
                  <td className="num" style={{ padding: "10px 12px", fontWeight: 700, color: t.realizedPnl > 0 ? "var(--emerald-bright)" : t.realizedPnl < 0 ? "#f6465d" : "var(--muted)" }}>{fmtPnl(t.realizedPnl)}</td>
                  <td style={{ padding: "10px 12px" }}>{meta?.setup_tag ?? "—"}</td>
                  <td style={{ padding: "10px 12px" }}>{meta?.exec_grade ?? "—"}</td>
                  <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                    {t.source === "real" ? (
                      <>
                        <button className="btn" style={{ padding: "3px 10px", fontSize: 12, marginRight: 6 }}
                          onClick={(e) => { e.stopPropagation(); onEditReal(t.key); }}>Edit</button>
                        <button className="btn" style={{ padding: "3px 10px", fontSize: 12, color: "#f6465d", borderColor: "rgba(246,70,93,0.4)" }}
                          onClick={(e) => { e.stopPropagation(); onDeleteReal(t.key); }}>Delete</button>
                      </>
                    ) : (
                      <span className="hint">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {trades.length === 0 && <p className="hint" style={{ padding: 20, textAlign: "center" }}>No trades match your filters.</p>}
      </div>
    </div>
  );
}

/* ---------------- Trade Review ---------------- */
/** Saved screenshots for the trade being reviewed (real trades only).
 *  Loads fresh signed URLs on mount / trade switch; renders nothing
 *  when the trade has no screenshots. */
function ReviewScreenshots({ tradeKey }: { tradeKey: string }) {
  const [shots, setShots] = useState<{ path: string; url: string }[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { if (alive) setShots([]); return; }
      const list = await listScreenshots(supabase, user.id, tradeKey);
      if (alive) setShots(list);
    })();
    return () => { alive = false; };
  }, [tradeKey]);

  if (shots.length === 0) return null;
  return (
    <div className="card" style={{ padding: 16 }}>
      <h4 style={{ margin: "0 0 12px" }}>Screenshots</h4>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {shots.map((s) => (
          <a key={s.path} href={s.url} target="_blank" rel="noreferrer" title="Open full size">
            <img src={s.url} alt="Trade screenshot" style={{ maxHeight: 200, maxWidth: 280, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", objectFit: "cover", display: "block" }} />
          </a>
        ))}
      </div>
    </div>
  );
}

function ReviewTab({ tradeKey, simTrade, realTrade, meta, onSaved, onEditReal, onDeleteReal }: {
  tradeKey: string | null;
  simTrade: GroupedTrade | null;
  realTrade: RealTrade | null;
  meta: TradeMeta | null | undefined;
  onSaved: () => void;
  onEditReal?: (k: string) => void;
  onDeleteReal?: (k: string) => void;
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
        session_id: isReal ? null : simTrade!.sessionId,
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
          <h3 style={{ margin: 0 }}>{displayTicker} <span className="hint">· {displayDate} · {displayDir}</span> <SourceBadge source={isReal ? "real" : "simulator"} /></h3>
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
        {isReal && (
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="btn" onClick={() => onEditReal?.(tradeKeyVal)}>Edit trade</button>
            <button className="btn" onClick={() => onDeleteReal?.(tradeKeyVal)}
              style={{ color: "#f6465d", borderColor: "rgba(246,70,93,0.4)" }}>Delete trade</button>
          </div>
        )}
      </div>

      {isReal && <ReviewScreenshots tradeKey={tradeKeyVal} />}

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
    .filter((f) => f.qty && f.price)
    .map((f, i) => ({ id: `p${i}`, side: f.side, qty: Number(f.qty), price: Number(f.price), fees: Number(f.fees || 0), fill_time: f.time || null }));
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
        <div key={i} className="fill-row" style={{ display: "grid", gridTemplateColumns: "80px 1fr 1fr 1fr 110px 32px", gap: 8, marginBottom: 8, alignItems: "end" }}>
          <div className="field" style={field}><label>Side</label>
            <select className="input" value={f.side} onChange={(e) => updateFill(i, "side", e.target.value)}>
              <option value="buy">Buy</option><option value="sell">Sell</option>
            </select></div>
          <div className="field" style={field}><label>Qty *</label><input className="input num" type="number" step="any" value={f.qty} onChange={(e) => updateFill(i, "qty", e.target.value)} /></div>
          <div className="field" style={field}><label>Price *</label><input className="input num" type="number" step="any" value={f.price} onChange={(e) => updateFill(i, "price", e.target.value)} /></div>
          <div className="field" style={field}><label>Fees $</label><input className="input num" type="number" step="any" value={f.fees} onChange={(e) => updateFill(i, "fees", e.target.value)} placeholder="0" /></div>
          <div className="field" style={field}><label>Time</label><input className="input" type="time" value={f.time} onChange={(e) => updateFill(i, "time", e.target.value)} /></div>
          <button className="btn" onClick={() => removeFill(i)} disabled={fills.length === 1} style={{ height: 38 }}>×</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button className="btn" onClick={() => addFill(direction === "long" ? "buy" : "sell")}>+ Add entry</button>
        <button className="btn" onClick={() => addFill(direction === "long" ? "sell" : "buy")}>+ Add exit</button>
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
                <SourceBadge source={t.source} />
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

function AnalyticsTab({ trades, onSelect }: { trades: AnalyticsTrade[]; onSelect: (k: string) => void }) {
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
      <div className="card" style={{ padding: 32, textAlign: "center" }}>
        <p className="hint" style={{ margin: 0 }}>No data — analytics need closed trades in the current filter selection. Adjust the source/period filters above, or log and close some trades first.</p>
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
