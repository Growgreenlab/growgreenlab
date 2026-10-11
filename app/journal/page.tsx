"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";
import { groupFillsIntoTrades, calcMetrics, fmtPnl, fmtPct, type GroupedTrade, type RawFill } from "../../lib/journal";

type Tab = "overview" | "trades" | "review" | "calendar";
type Period = "today" | "week" | "month" | "30d" | "90d" | "ytd" | "all";

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

interface ManualTrade {
  id: string;
  ticker: string;
  trade_date: string;
  direction: "long" | "short";
  entry_price: number;
  exit_price: number | null;
  qty: number;
  realized_pnl: number | null;
  setup_tag: string | null;
  exec_grade: string | null;
  notes: string | null;
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
  const [manual, setManual] = useState<ManualTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Filters
  const [fTicker, setFTicker] = useState("");
  const [fSetup, setFSetup] = useState("");
  const [fWinLoss, setFWinLoss] = useState("");

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
          .order("created_at", { ascending: true });
        if (fills && fills.length > 0) {
          const grouped = groupFillsIntoTrades(fills as RawFill[], s);
          allTrades.push(...grouped);
        }
      }
      setTrades(allTrades);

      // Fetch annotations
      const { data: metaRows } = await supabase.from("journal_trade_meta").select("*");
      const metaMap: Record<string, TradeMeta> = {};
      for (const m of metaRows ?? []) metaMap[m.trade_key] = m;
      setMetas(metaMap);

      // Fetch manual trades
      const { data: manualRows } = await supabase
        .from("journal_manual_trades")
        .select("*")
        .order("trade_date", { ascending: false })
        .limit(500);
      setManual((manualRows ?? []) as ManualTrade[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load journal.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Filter trades by period
  const filtered = useMemo(() => {
    const start = periodStart(period);
    return trades.filter((t) => {
      if (start && new Date(t.tradeDate) < start) return false;
      if (fTicker && !t.ticker.toLowerCase().includes(fTicker.toLowerCase())) return false;
      if (fSetup && metas[t.tradeKey]?.setup_tag !== fSetup) return false;
      if (fWinLoss === "win" && t.realizedPnl <= 0) return false;
      if (fWinLoss === "loss" && t.realizedPnl >= 0) return false;
      return true;
    });
  }, [trades, period, fTicker, fSetup, fWinLoss, metas]);

  const metrics = useMemo(() => calcMetrics(filtered), [filtered]);

  // Cumulative P&L for chart (simple SVG)
  const cumPnl = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime());
    let cum = 0;
    return sorted.map((t) => { cum += t.realizedPnl; return cum; });
  }, [filtered]);

  const selected = selectedKey ? trades.find((t) => t.tradeKey === selectedKey) : null;
  const selectedMeta = selectedKey ? metas[selectedKey] : null;

  if (loading) return <div className="wrap" style={{ padding: 40 }}><p className="hint">Loading journal…</p></div>;
  if (error) return <div className="wrap" style={{ padding: 40 }}><div className="err">{error}</div><p style={{ marginTop: 12 }}><Link href="/replay">← Back to simulator</Link></p></div>;

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <h2 style={{ margin: "0 0 4px" }}>Trade Journal</h2>
      <p className="hint" style={{ margin: "0 0 16px" }}>Your Trade DNA — every trade, graded and reviewed.</p>

      <div className="tabs" style={{ marginBottom: 20 }}>
        {(["overview", "trades", "review", "calendar"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "overview" ? "Overview" : t === "trades" ? "All Trades" : t === "review" ? "Trade Review" : "Calendar"}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab metrics={metrics} cumPnl={cumPnl} trades={filtered} period={period} setPeriod={setPeriod} onSelect={(k) => { setSelectedKey(k); setTab("review"); }} />}
      {tab === "trades" && <TradesTab trades={filtered} metas={metas} fTicker={fTicker} setFTicker={setFTicker} fSetup={fSetup} setFSetup={setFSetup} fWinLoss={fWinLoss} setFWinLoss={setFWinLoss} onSelect={(k) => { setSelectedKey(k); setTab("review"); }} />}
      {tab === "review" && <ReviewTab trade={selected} meta={selectedMeta} onSaved={load} />}
      {tab === "calendar" && <CalendarTab trades={filtered} onSelectDay={() => {}} />}
    </div>
  );
}

/* ---------------- Overview ---------------- */
function OverviewTab({ metrics, cumPnl, trades, period, setPeriod, onSelect }: {
  metrics: ReturnType<typeof calcMetrics>;
  cumPnl: number[];
  trades: GroupedTrade[];
  period: Period;
  setPeriod: (p: Period) => void;
  onSelect: (k: string) => void;
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
          <p className="hint">Trade in the simulator, then your closed positions will appear here automatically.</p>
          <Link href="/replay" className="btn primary" style={{ marginTop: 8, display: "inline-block", textDecoration: "none" }}>Open Simulator</Link>
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
              <div key={t.tradeKey} onClick={() => onSelect(t.tradeKey)}
                style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.06)", cursor: "pointer" }}>
                <span><b>{t.ticker}</b> <span className="hint">{t.tradeDate} · {t.direction}</span></span>
                <span className="num" style={{ color: t.realizedPnl > 0 ? "var(--emerald-bright)" : t.realizedPnl < 0 ? "#f6465d" : "var(--muted)", fontWeight: 600 }}>{fmtPnl(t.realizedPnl)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- All Trades ---------------- */
function TradesTab({ trades, metas, fTicker, setFTicker, fSetup, setFSetup, fWinLoss, setFWinLoss, onSelect }: {
  trades: GroupedTrade[]; metas: Record<string, TradeMeta>;
  fTicker: string; setFTicker: (v: string) => void;
  fSetup: string; setFSetup: (v: string) => void;
  fWinLoss: string; setFWinLoss: (v: string) => void;
  onSelect: (k: string) => void;
}) {
  const [showManual, setShowManual] = useState(false);
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
        <button className="btn" onClick={() => setShowManual((v) => !v)} style={{ marginLeft: "auto" }}>
          {showManual ? "Cancel" : "+ Manual Trade"}
        </button>
      </div>
      {showManual && <ManualTradeForm onSaved={() => setShowManual(false)} />}
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", textAlign: "left" }}>
              {["Date", "Symbol", "Dir", "Entry", "Exit", "Qty", "P&L", "Setup", "Grade"].map((h) => (
                <th key={h} style={{ padding: "10px 12px", color: "var(--muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const meta = metas[t.tradeKey];
              return (
                <tr key={t.tradeKey} onClick={() => onSelect(t.tradeKey)}
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", cursor: "pointer" }}>
                  <td style={{ padding: "10px 12px" }}>{t.tradeDate}</td>
                  <td style={{ padding: "10px 12px", fontWeight: 600 }}>{t.ticker}</td>
                  <td style={{ padding: "10px 12px" }}>{t.direction}</td>
                  <td className="num" style={{ padding: "10px 12px" }}>${t.entryPrice.toFixed(2)}</td>
                  <td className="num" style={{ padding: "10px 12px" }}>${t.exitPrice.toFixed(2)}</td>
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
function ReviewTab({ trade, meta, onSaved }: { trade: GroupedTrade | null | undefined; meta: TradeMeta | null | undefined; onSaved: () => void }) {
  const [form, setForm] = useState<Partial<TradeMeta>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (meta) setForm(meta);
    else setForm({});
    setMsg(null);
  }, [trade?.tradeKey]);

  if (!trade) {
    return (
      <div className="card" style={{ padding: 32, textAlign: "center" }}>
        <p className="hint">Select a trade from All Trades or Overview to review it.</p>
      </div>
    );
  }

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const payload = {
        user_id: user.id,
        session_id: trade.sessionId,
        trade_key: trade.tradeKey,
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
          <h3 style={{ margin: 0 }}>{trade.ticker} <span className="hint">· {trade.tradeDate} · {trade.direction}</span></h3>
          <span className="num" style={{ fontSize: 22, fontWeight: 700, color: trade.realizedPnl > 0 ? "var(--emerald-bright)" : trade.realizedPnl < 0 ? "#f6465d" : "var(--muted)" }}>
            {fmtPnl(trade.realizedPnl)}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, fontSize: 13 }}>
          <div><span className="hint">Entry</span><div className="num">${trade.entryPrice.toFixed(2)}</div></div>
          <div><span className="hint">Exit</span><div className="num">${trade.exitPrice.toFixed(2)}</div></div>
          <div><span className="hint">Qty</span><div className="num">{trade.qty}</div></div>
          <div><span className="hint">Fills</span><div className="num">{trade.fills.length}</div></div>
        </div>
        {trade.sessionId && (
          <p style={{ marginTop: 12 }}><Link href={`/replay?session=${trade.sessionId}`} style={{ fontSize: 13 }}>↩ Open replay session</Link></p>
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

/* ---------------- Manual Trade Form ---------------- */
function ManualTradeForm({ onSaved }: { onSaved: () => void }) {
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [entry, setEntry] = useState("");
  const [exit, setExit] = useState("");
  const [qty, setQty] = useState("");
  const [setup, setSetup] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    if (!ticker.trim() || !entry || !qty) { setMsg("Ticker, entry price, and quantity are required."); return; }
    setSaving(true); setMsg(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const entryP = Number(entry), exitP = exit ? Number(exit) : null, q = Number(qty);
      if (!isFinite(entryP) || entryP <= 0 || !isFinite(q) || q <= 0) throw new Error("Invalid entry price or quantity.");
      let pnl: number | null = null;
      if (exitP != null && isFinite(exitP)) {
        pnl = direction === "long" ? (exitP - entryP) * q : (entryP - exitP) * q;
      }
      const { error } = await supabase.from("journal_manual_trades").insert({
        user_id: user.id,
        ticker: ticker.trim().toUpperCase(),
        trade_date: date,
        direction,
        entry_price: entryP,
        exit_price: exitP,
        qty: q,
        realized_pnl: pnl,
        setup_tag: setup || null,
        notes: notes || null,
      });
      if (error) throw new Error(error.message);
      setMsg("Saved.");
      onSaved();
      window.location.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <h4 style={{ margin: "0 0 12px" }}>Add Manual Trade</h4>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
        <div className="field"><label>Ticker *</label><input className="input mono" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AAPL" /></div>
        <div className="field"><label>Date *</label><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="field"><label>Direction</label><select className="input" value={direction} onChange={(e) => setDirection(e.target.value as "long" | "short")}><option value="long">Long</option><option value="short">Short</option></select></div>
        <div className="field"><label>Entry Price *</label><input className="input num" type="number" step="any" value={entry} onChange={(e) => setEntry(e.target.value)} /></div>
        <div className="field"><label>Exit Price</label><input className="input num" type="number" step="any" value={exit} onChange={(e) => setExit(e.target.value)} placeholder="—" /></div>
        <div className="field"><label>Quantity *</label><input className="input num" type="number" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
        <div className="field"><label>Setup</label><select className="input" value={setup} onChange={(e) => setSetup(e.target.value)}><option value="">—</option>{SETUPS.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><label>Notes</label><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Trade"}</button>
        {msg && <span style={{ marginLeft: 12, fontSize: 13 }}>{msg}</span>}
      </div>
    </div>
  );
}

/* ---------------- Calendar ---------------- */
function CalendarTab({ trades, onSelectDay }: { trades: GroupedTrade[]; onSelectDay: (d: string) => void }) {
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
