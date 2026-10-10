"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import CandleChart from "../../components/CandleChart";
import DataSourcePanel from "../../components/DataSourcePanel";
import ReplayControls from "../../components/ReplayControls";
import TradingPanel from "../../components/TradingPanel";
import { ReplayEngine, formatMoney, formatSigned, TICKS_PER_CANDLE } from "../../lib/engine";
import type { Candle, SessionMeta } from "../../lib/types";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";

const START_CASH = 100_000;

function ReplayPageInner() {
  const searchParams = useSearchParams();
  const engineRef = useRef<ReplayEngine | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [version, setVersion] = useState(0);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  // Play loop: wall-clock paced ticks so each 1-minute candle forms
  // gradually in real time (one simulated minute per 1/speed seconds),
  // with the price ticking live as the candle builds.
  useEffect(() => {
    if (!playing) return;
    const eng = engineRef.current;
    if (!eng) return;
    let last = performance.now();
    let acc = 0;
    const id = setInterval(() => {
      const now = performance.now();
      acc += ((now - last) / 1000) * speed * TICKS_PER_CANDLE;
      last = now;
      let finished = false;
      let guard = 0;
      while (acc >= 1 && guard++ < 1000) {
        acc -= 1;
        const r = eng.tick();
        if (r.atEnd) { finished = true; acc = 0; break; }
      }
      bump();
      if (finished) stopTimer();
    }, 50);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed]);

  const handleLoad = useCallback((cs: Candle[], m: SessionMeta) => {
    stopTimer();
    engineRef.current = new ReplayEngine(cs, START_CASH, m.startIndex);
    setCandles(cs);
    setMeta(m);
    setSaveMsg(null);
    bump();
  }, [bump, stopTimer]);

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
        const eng = new ReplayEngine(cs, START_CASH, s.start_index ?? 0);
        // fast-forward through the recorded fills to rebuild state,
        // replaying each at its exact recorded price for P/L fidelity
        const fills = (trades ?? []).slice().sort((a, b) => a.candle_index - b.candle_index);
        for (const t of fills) {
          while (eng.index < t.candle_index) eng.step();
          if (t.side === "buy") eng.buyAt(Number(t.qty), Number(t.price), t.candle_index, new Date(t.candle_time).getTime());
          else eng.sellAt(Number(t.qty), Number(t.price), t.candle_index, new Date(t.candle_time).getTime());
        }
        engineRef.current = eng;
        setCandles(cs);
        setMeta({ ticker: s.ticker, tradeDate: s.trade_date, source: s.source, startIndex: s.start_index ?? 0 });
        bump();
      } catch (e) {
        setSaveMsg(e instanceof Error ? e.message : "Failed to load session.");
      } finally {
        setLoadingSession(false);
      }
    })();
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
      stopLoss: eng.stopLoss,
      takeProfit: eng.takeProfit,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, candles]);

  const buyErr = (qty: number): string | null => {
    const eng = engineRef.current;
    if (!eng) return "Load a session first.";
    if (!(qty > 0)) return "Enter a share quantity.";
    const f = eng.buy(Math.floor(qty));
    bump();
    return f ? null : "Not enough virtual cash for that size.";
  };
  const sellErr = (qty: number): string | null => {
    const eng = engineRef.current;
    if (!eng) return "Load a session first.";
    const f = eng.sell(Math.floor(qty));
    bump();
    return f ? null : "No open position to sell.";
  };

  const saveSession = async () => {
    const eng = engineRef.current;
    if (!eng || !candles || !meta) return;
    if (!isSupabaseConfigured()) {
      setSaveMsg("Supabase is not configured — sessions cannot be saved yet.");
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in to save sessions.");
      const { data: s, error } = await supabase
        .from("replay_sessions")
        .insert({
          user_id: user.id,
          ticker: meta.ticker,
          trade_date: meta.tradeDate,
          source: meta.source,
          candles,
          start_index: meta.startIndex,
          final_cash: eng.cash,
          realized_pnl: eng.realizedPnl,
        })
        .select("id")
        .single();
      if (error || !s) throw new Error(error?.message ?? "Save failed.");
      if (eng.fills.length > 0) {
        const { error: tErr } = await supabase.from("session_trades").insert(
          eng.fills.map((f) => ({
            session_id: s.id,
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
      setSaveMsg("Session saved — find it under My Sessions.");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const eng = engineRef.current;

  return (
    <div>
      <div className="section">
        <DataSourcePanel candles={candles} meta={meta} onLoad={handleLoad} />
      </div>

      {loadingSession && <div className="hint">Loading saved session…</div>}

      {eng && candles && meta && snap && (
        <>
          <div className="section card">
            <div className="chart-head">
              <div>
                <div className="ticker-name">{meta.ticker}</div>
                <div className="ticker-sub">{meta.tradeDate}</div>
                <div style={{ marginTop: 8 }}>
                  {meta.source === "sample"
                    ? <span className="badge sample">Sample data — not real market prices</span>
                    : <span className="badge live">{meta.source === "twelvedata" ? "Twelve Data" : "CSV"} · real data</span>}
                </div>
              </div>
              <div>
                <div className="price-now num">{formatMoney(snap.price)}</div>
                <div className="hod-line">HOD <span className="num" style={{ color: "var(--amber)", fontWeight: 700 }}>{formatMoney(eng.hod)}</span></div>
              </div>
            </div>
            <div className="chart-frame">
              <CandleChart
                candles={eng.displayCandles}
                revealedCount={eng.displayCandles.length}
                overlays={{
                  hod: eng.hod,
                  stopLoss: eng.stopLoss,
                  takeProfit: eng.takeProfit,
                  fills: eng.fills,
                  lastPrice: snap.price,
                }}
              />
            </div>
          </div>

          <div className="section grid2">
            <div>
              <ReplayControls
                playing={playing}
                canPlay={!eng.atEnd}
                onPlay={() => setPlaying(true)}
                onPause={stopTimer}
                onNext={() => { eng.step(); bump(); }}
                onReset={() => { stopTimer(); eng.reset(); bump(); }}
                speed={speed}
                onSpeed={setSpeed}
                index={eng.index}
                total={candles.length}
                progress={(eng.index + eng.formationProgress + 1) / Math.max(1, candles.length)}
              />
              <div className="section">
                <button className="btn big" onClick={saveSession} disabled={saving}>
                  {saving ? "Saving…" : "💾 Save session"}
                </button>
                {saveMsg && <div className={saveMsg.startsWith("Session saved") ? "ok" : "err"}>{saveMsg}</div>}
              </div>
              <div className="section card">
                <h3>Session P/L</h3>
                <div className="tiles">
                  <div className="tile">
                    <div className="tk">Realized</div>
                    <div className={`tv num ${snap.realized >= 0 ? "pos" : "neg"}`}>{formatSigned(snap.realized)}</div>
                  </div>
                  <div className="tile">
                    <div className="tk">Unrealized</div>
                    <div className={`tv num ${snap.unreal >= 0 ? "pos" : "neg"}`}>{formatSigned(snap.unreal)}</div>
                  </div>
                  <div className="tile hero-tile">
                    <div className="tk">Equity</div>
                    <div className="tv num">{formatMoney(snap.equity)}</div>
                  </div>
                </div>
              </div>
            </div>
            <TradingPanel
              snap={snap}
              onBuy={buyErr}
              onSell={sellErr}
              onSetBrackets={(sl, tp) => { eng.setBrackets(sl, tp); bump(); }}
              disabled={false}
            />
          </div>
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
