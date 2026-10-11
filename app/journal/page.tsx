"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";
import { groupFillsIntoTrades, calcMetrics, calcRealTrade, parseBrokerCsv, parseWithMapping, autoMapColumns, MAPPABLE_FIELDS, groupImportedFills, fmtPnl, fmtPct, type GroupedTrade, type RawFill, type RealFill, type RealTradeCalc, type BrokerParseResult, type ImportedTrade } from "../../lib/journal";

type Tab = "overview" | "trades" | "review" | "calendar";
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

function periodStart(p: Period): Date | null {
  const now = new Date();
  switch (p) {
    case "today": return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "week": { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0); return d; }
    case "month": return new Date(now.getFullYear(), now.getMonth(), 1);
    case "30d": { const d = new Date(now); d.setDate(d.getDate() - 30); return d; }
    case "90d": { const d = new Date(now); d.setDate(d.getDate() - 90); return d; }
    case "ytd": return new Date(now.getFullYear(), 0, 1);
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
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  // Filters
  const [fTicker, setFTicker] = useState("");
  const [fSetup, setFSetup] = useState("");
  const [fWinLoss, setFWinLoss] = useState("");
  const [showRealForm, setShowRealForm] = useState(false);
  const [showImport, setShowImport] = useState(false);

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

  // Filter by source + period + search
  const filtered = useMemo(() => {
    const start = periodStart(period);
    return unified.filter((t) => {
      if (sourceFilter !== "all" && t.source !== sourceFilter) return false;
      if (start && new Date(t.tradeDate) < start) return false;
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

  if (loading) return <div className="wrap" style={{ padding: 40 }}><p className="hint">Loading journal…</p></div>;
  if (error) return <div className="wrap" style={{ padding: 40 }}><div className="err">{error}</div><p style={{ marginTop: 12 }}><Link href="/replay">← Back to simulator</Link></p></div>;

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <h2 style={{ margin: "0 0 4px" }}>Trade Journal</h2>
      <p className="hint" style={{ margin: "0 0 16px" }}>Your Trade DNA — every trade, graded and reviewed.</p>

      <div className="tabs" style={{ marginBottom: 12 }}>
        {(["overview", "trades", "review", "calendar"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "overview" ? "Overview" : t === "trades" ? "All Trades" : t === "review" ? "Trade Review" : "Calendar"}
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

      {tab === "overview" && <OverviewTab metrics={metrics} simMetrics={simMetrics} realMetrics={realMetrics} cumPnl={cumPnl} trades={filtered} period={period} setPeriod={setPeriod} sourceFilter={sourceFilter} onSelect={(k) => { setSelectedKey(k); setTab("review"); }} onAddRealTrade={() => { setTab("trades"); setShowRealForm(true); }} onImportBroker={() => { setTab("trades"); setShowImport(true); }} />}
      {tab === "trades" && <TradesTab trades={filtered} metas={metas} fTicker={fTicker} setFTicker={setFTicker} fSetup={fSetup} setFSetup={setFSetup} fWinLoss={fWinLoss} setFWinLoss={setFWinLoss} onSelect={(k) => { setSelectedKey(k); setTab("review"); }} onRealTradeSaved={load} showRealForm={showRealForm} setShowRealForm={setShowRealForm} showImport={showImport} setShowImport={setShowImport} />}
      {tab === "review" && <ReviewTab tradeKey={selectedKey} simTrade={!isRealSelected ? (selected as GroupedTrade | null) : null} realTrade={isRealSelected ? (selected as RealTrade | null) : null} meta={selectedMeta} onSaved={load} />}
      {tab === "calendar" && <CalendarTab trades={closedFiltered} onSelectDay={() => {}} />}
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

function OverviewTab({ metrics, simMetrics, realMetrics, cumPnl, trades, period, setPeriod, sourceFilter, onSelect, onAddRealTrade, onImportBroker }: {
  metrics: ReturnType<typeof calcMetrics>;
  simMetrics: ReturnType<typeof calcMetrics>;
  realMetrics: ReturnType<typeof calcMetrics>;
  cumPnl: number[];
  trades: UnifiedTrade[];
  period: Period;
  setPeriod: (p: Period) => void;
  sourceFilter: SourceFilter;
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
function TradesTab({ trades, metas, fTicker, setFTicker, fSetup, setFSetup, fWinLoss, setFWinLoss, onSelect, onRealTradeSaved, showRealForm, setShowRealForm, showImport, setShowImport }: {
  trades: UnifiedTrade[]; metas: Record<string, TradeMeta>;
  fTicker: string; setFTicker: (v: string) => void;
  fSetup: string; setFSetup: (v: string) => void;
  fWinLoss: string; setFWinLoss: (v: string) => void;
  onSelect: (k: string) => void;
  onRealTradeSaved: () => void;
  showRealForm: boolean; setShowRealForm: (v: boolean | ((p: boolean) => boolean)) => void;
  showImport: boolean; setShowImport: (v: boolean | ((p: boolean) => boolean)) => void;
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
        <button className="btn primary" onClick={() => setShowRealForm((v) => !v)} style={{ marginLeft: "auto" }}>
          {showRealForm ? "Cancel" : "+ Add Real Trade"}
        </button>
        <button className="btn" onClick={() => setShowImport((v) => !v)}>
          {showImport ? "Cancel" : "⭳ Import from Broker"}
        </button>
      </div>
      {showRealForm && <RealTradeForm onSaved={() => { setShowRealForm(false); onRealTradeSaved(); }} />}
      {showImport && <BrokerImportForm onSaved={() => { setShowImport(false); onRealTradeSaved(); }} />}
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", textAlign: "left" }}>
              {["Date", "Symbol", "Src", "Dir", "Entry", "Qty", "P&L", "Setup", "Grade"].map((h) => (
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
function ReviewTab({ tradeKey, simTrade, realTrade, meta, onSaved }: {
  tradeKey: string | null;
  simTrade: GroupedTrade | null;
  realTrade: RealTrade | null;
  meta: TradeMeta | null | undefined;
  onSaved: () => void;
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
      </div>

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
function RealTradeForm({ onSaved }: { onSaved: () => void }) {
  const [ticker, setTicker] = useState("");
  const [company, setCompany] = useState("");
  const [broker, setBroker] = useState("Webull");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [strategy, setStrategy] = useState("");
  // Fills: start with one entry fill
  const [fills, setFills] = useState<{ side: "buy" | "sell"; qty: string; price: string; fees: string; time: string }[]>([
    { side: "buy", qty: "", price: "", fees: "", time: "" },
  ]);
  const [stopLoss, setStopLoss] = useState("");
  const [target, setTarget] = useState("");
  const [floatShares, setFloatShares] = useState("");
  const [rvol, setRvol] = useState("");
  const [marketCond, setMarketCond] = useState("");
  const [l2tas, setL2Tas] = useState("");
  const [setup, setSetup] = useState("");
  const [hodClass, setHodClass] = useState("");
  const [grade, setGrade] = useState("");
  const [entryReason, setEntryReason] = useState("");
  const [notes, setNotes] = useState("");
  const [lessons, setLessons] = useState("");
  const [emotions, setEmotions] = useState<string[]>([]);
  const [mistakes, setMistakes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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

  const save = async () => {
    if (!ticker.trim()) { setMsg("Ticker is required."); return; }
    const validFills = fills.filter((f) => f.qty && f.price && Number(f.qty) > 0 && Number(f.price) > 0);
    if (validFills.length === 0) { setMsg("Add at least one fill with quantity and price."); return; }
    setSaving(true); setMsg(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");

      const { data: trade, error: tErr } = await supabase.from("journal_real_trades").insert({
        user_id: user.id,
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
      }).select("id").single();
      if (tErr) throw new Error(tErr.message);

      const fillRows = validFills.map((f) => ({
        trade_id: trade.id,
        user_id: user.id,
        side: f.side,
        qty: Number(f.qty),
        price: Number(f.price),
        fees: f.fees ? Number(f.fees) : 0,
        fill_time: f.time ? new Date(`${date}T${f.time}`).toISOString() : null,
        note: null,
      }));
      const { error: fErr } = await supabase.from("journal_real_fills").insert(fillRows);
      if (fErr) throw new Error(fErr.message);

      // Save Trade DNA annotations via shared meta table
      const tradeKey = `real:${trade.id}`;
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

      setMsg("Saved.");
      onSaved();
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
      <h4 style={{ margin: "0 0 4px" }}>Add Real Trade</h4>
      <p className="hint" style={{ margin: "0 0 16px" }}>From your broker — never touches the simulator.</p>

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
            <span>Gross <b className="num" style={{ color: preview.grossRealized >= 0 ? "var(--emerald-bright)" : "#f6465d" }}>{fmtPnl(preview.grossRealized)}</b></span>
            <span>Fees <b className="num">{fmtPnl(-preview.totalFees)}</b></span>
            <span>Net <b className="num" style={{ color: preview.netRealized >= 0 ? "var(--emerald-bright)" : "#f6465d" }}>{fmtPnl(preview.netRealized)}</b></span>
            {preview.openQty > 0 && <span style={{ color: "#fbbf24" }}>Open: {preview.openQty} shares</span>}
            {preview.rMultiple != null && <span>R <b className="num">{preview.rMultiple.toFixed(2)}</b></span>}
          </div>
        </div>
      )}

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
        <button className="btn primary big" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Real Trade"}</button>
        {msg && <span style={{ marginLeft: 12, fontSize: 13 }}>{msg}</span>}
      </div>
    </div>
  );
}

/* ---------------- Calendar ---------------- */
function CalendarTab({ trades, onSelectDay }: { trades: UnifiedTrade[]; onSelectDay: (d: string) => void }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });

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
          return (
            <div key={i} className="card"
              style={{
                padding: 8, minHeight: 64, cursor: info ? "pointer" : "default",
                background: info ? (info.pnl > 0 ? "rgba(16,185,129,0.08)" : info.pnl < 0 ? "rgba(246,70,93,0.08)" : undefined) : undefined,
                border: info ? (info.pnl > 0 ? "1px solid rgba(16,185,129,0.25)" : info.pnl < 0 ? "1px solid rgba(246,70,93,0.25)" : undefined) : undefined,
              }}
              onClick={() => info && onSelectDay(key)}>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{d}</div>
              {info && <div className="num" style={{ fontSize: 13, fontWeight: 700, color: info.pnl > 0 ? "var(--emerald-bright)" : info.pnl < 0 ? "#f6465d" : "var(--muted)" }}>{fmtPnl(info.pnl)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
