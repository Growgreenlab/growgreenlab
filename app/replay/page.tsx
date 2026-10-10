"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import CandleChart from "../../components/CandleChart";
import LwcChart from "../../components/LwcChart";
import DataSourcePanel from "../../components/DataSourcePanel";
import ReplayControls from "../../components/ReplayControls";
import TradingPanel from "../../components/TradingPanel";
import { ReplayEngine, formatMoney, formatSigned, countdownText, TICKS_PER_CANDLE, SECONDS_PER_CANDLE } from "../../lib/engine";
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
  // Bumped to force the timer effect to re-run on restart even when
  // `playing` doesn't net-change (React batches setPlaying(false) +
  // setPlaying(true) into a no-op, which used to leave the replay frozen
  // with no timer running).
  const [playNonce, setPlayNonce] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [ended, setEnded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

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
      // Fell behind by more than a second (hidden tab / sleep / pause in
      // devtools): resume from the live edge instead of bursting.
      if (now - nextTick > 1000) nextTick = now;
      let ran = 0;
      let finished = false;
      while (nextTick <= now && ran < 60) {
        const r = eng.tick();
        ran++;
        nextTick += tickMs;
        if (r.atEnd) { finished = true; break; }
      }
      if (ran > 0) bump();
      if (finished) {
        done = true;
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setPlaying(false);
        setEnded(true);
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
    engineRef.current = new ReplayEngine(cs, START_CASH, m.startIndex);
    setCandles(cs);
    setMeta(m);
    setSaveMsg(null);
    setDataOpen(false);
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
        setEnded(false);
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
      pendingOrders: eng.pendingOrders,
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
  const placeLimitErr = (side: "buy" | "sell", qty: number, price: number): string | null => {
    const eng = engineRef.current;
    if (!eng) return "Load a session first.";
    const err = eng.placeLimitOrder(side, qty, price);
    bump();
    return err;
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
  const daily = snap ? snap.realized + snap.unreal : 0;

  return (
    <div className="ws">
      {(!eng || !candles || !meta || !snap) && (
        <div className="ws-welcome">
          {loadingSession && <div className="hint">Loading saved session…</div>}
          <DataSourcePanel candles={candles} meta={meta} onLoad={handleLoad} />
          {saveMsg && <div className="err" style={{ marginTop: 12 }}>{saveMsg}</div>}
        </div>
      )}

      {eng && candles && meta && snap && (
        <>
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
              {saveMsg && <span className={saveMsg.startsWith("Session saved") ? "ok" : "err"} style={{ fontSize: 12 }}>{saveMsg}</span>}
              <button className="btn" onClick={() => setDataOpen((v) => !v)}>Data</button>
              <button className="btn primary" onClick={saveSession} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>

          <div className="ws-main">
            {/* left: chart column */}
            <div className="ws-left">
              <ReplayControls
                compact
                playing={playing}
                canPlay={!eng.atEnd}
                ended={ended}
                onPlay={() => { setEnded(false); setPlayNonce((n) => n + 1); setPlaying(true); }}
                onPause={stopTimer}
                onNext={() => { eng.step(); setEnded(eng.atEnd); bump(); }}
                onReset={() => { const wasPlaying = playing; stopTimer(); setEnded(false); eng.reset(); bump(); if (wasPlaying) { setPlayNonce((n) => n + 1); setPlaying(true); } }}
                onRestart={() => { stopTimer(); setEnded(false); eng.reset(); bump(); setPlayNonce((n) => n + 1); setPlaying(true); }}
                speed={speed}
                onSpeed={setSpeed}
                index={eng.index}
                total={candles.length}
                progress={(eng.index + eng.formationProgress + 1) / Math.max(1, candles.length)}
              />
              <div className="ws-chart">
                {searchParams.get("chart") === "lwc" ? (
                  <LwcChart
                    candles={eng.displayCandles}
                    revealedCount={eng.displayCandles.length}
                    sessionKey={`${meta.ticker}|${meta.tradeDate}|${meta.source}|${candles.length}`}
                    countdown={playing ? countdownText(eng.formationProgress, speed) : null}
                    lastPrice={snap.price}
                  />
                ) : (
                <CandleChart
                  candles={eng.displayCandles}
                  revealedCount={eng.displayCandles.length}
                  historyCount={meta.startIndex}
                  sessionKey={`${meta.ticker}|${meta.tradeDate}|${meta.source}|${candles.length}`}
                  overlays={{
                    hod: eng.hod,
                    stopLoss: eng.stopLoss,
                    takeProfit: eng.takeProfit,
                    fills: eng.fills,
                    lastPrice: snap.price,
                    pendingOrders: eng.pendingOrders.map((o) => ({ side: o.side, price: o.limitPrice })),
                    countdown: playing ? countdownText(eng.formationProgress, speed) : null,
                  }}
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
              <TradingPanel
                snap={snap}
                onBuy={buyErr}
                onSell={sellErr}
                onPlaceLimit={placeLimitErr}
                onCancelOrder={(id) => { eng.cancelOrder(id); bump(); }}
                onSetBrackets={(sl, tp) => { eng.setBrackets(sl, tp); bump(); }}
                disabled={false}
              />
            </aside>
          </div>

          {/* data source popover */}
          {dataOpen && (
            <div className="ws-data-pop" role="dialog" aria-label="Data source">
              <button className="mini-x ws-data-x" onClick={() => setDataOpen(false)} title="Close">✕</button>
              <DataSourcePanel candles={candles} meta={meta} onLoad={handleLoad} />
            </div>
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
