"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import CandleChart from "../../components/CandleChart";
import LwcChart from "../../components/LwcChart";
import DiagPanel from "../../components/DiagPanel";
import CandleParityPanel from "../../components/CandleParityPanel";
import DataSourcePanel from "../../components/DataSourcePanel";
import ReplayControls from "../../components/ReplayControls";
import TradingPanel from "../../components/TradingPanel";
import RiskCalculator from "../../components/RiskCalculator";
import { ReplayEngine, formatMoney, formatSigned, countdownText, countdownTextFor, TICKS_PER_CANDLE, SECONDS_PER_CANDLE } from "../../lib/engine";
import type { Candle, SessionMeta } from "../../lib/types";
import { TIMEFRAMES, aggregateCandles, higherTimeframeProgress, timeframeMinutes, type TimeframeId } from "../../lib/marketData";
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
import {
  GUEST_DAILY_LIMIT,
  getGuestFingerprint,
  getGuestTradesRemaining,
  consumeGuestTrade,
} from "../../lib/guestTrades";

const START_CASH = 100_000;
const BALANCE_KEY = "ggl-account-balance";

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
  // Dev-only candle parity diagnostics (?diag=parity): captures the exact
  // bars LwcChart delivers to its series. Null cost when the flag is absent.
  const parityDiag = searchParams.get("diag") === "parity";
  const chartBarsRef = useRef<Candle[]>([]);
  const [premarketNoticeDismissed, setPremarketNoticeDismissed] = useState(false);
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
      // Diagnostics: track timer health.
      diag.timerFires++;
      if (diag.lastTimerFire !== null) {
        diag.maxFireGapMs = Math.max(diag.maxFireGapMs, now - diag.lastTimerFire);
      }
      diag.lastTimerFire = now;
      // Fell behind by more than a second (hidden tab / sleep / pause in
      // devtools): resume from the live edge instead of bursting.
      if (now - nextTick > 1000) nextTick = now;
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
    if (!(qty > 0)) return "Enter a share quantity.";
    // Psychology Guard: block entries during lockout (engine also enforces).
    if (eng.tradeGuard) {
      const msg = eng.tradeGuard();
      if (msg) return msg;
    }
    const f = eng.buy(Math.floor(qty));
    if (f) {
      // Activate any planned SL/TP on the new position.
      if (plannedSL != null || plannedTP != null) {
        eng.setBrackets(plannedSL, plannedTP);
        setPlannedLevels(null, null);
      }
    }
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

  // Guest trade limit gate: wraps buyErr for new positions (guests only).
  // Adds, closes, failed orders, and signed-in users are never gated.
  const gateBuy = async (qty: number): Promise<string | null> => {
    const eng = engineRef.current;
    if (!eng) return "Load a session first.";
    const isNewPosition = eng.positionQty === 0;
    const isGuest = !guardUserId; // works with or without Supabase (localStorage fallback)
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
        if (!playing) { eng.step(); setEnded(eng.atEnd); bump(); }
      } else if (match(DEFAULT_HOTKEYS.speed05)) { setSpeed(0.5); }
      else if (match(DEFAULT_HOTKEYS.speed1)) { setSpeed(1); }
      else if (match(DEFAULT_HOTKEYS.speed2)) { setSpeed(2); }
      else if (match(DEFAULT_HOTKEYS.speed4)) { setSpeed(4); }
      else if (match(DEFAULT_HOTKEYS.speed8)) { setSpeed(8); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, orderQty, buyErr, sellErr, stopTimer, bump]);

  const placeLimitErr = (side: "buy" | "sell", qty: number, price: number): string | null => {
    const eng = engineRef.current;
    if (!eng) return "Load a session first.";
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
    const err = eng.placeLimitOrder(side, qty, price);
    bump();
    return err;
  };

  const saveSession = async (isAutoSave = false) => {
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
      let sessionId: string;
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
      // Update persistent account balance with this session's realized P&L.
      // For auto-save, only apply the DELTA since last save to avoid double-counting.
      const pnl = eng.realizedPnl;
      const lastPnl = lastSavedPnlRef.current;
      const delta = pnl - lastPnl;
      if (isFinite(delta) && delta !== 0) {
        await persistBalance(balanceRef.current + delta);
        lastSavedPnlRef.current = pnl;
      }
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
              {/* Persistent account balance */}
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
              <button className="btn" onClick={() => setDataOpen((v) => !v)}>Data</button>
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
              <button className="btn primary" onClick={() => saveSession(false)} disabled={saving}>
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
                {/* Honest premarket notice — shown only when verified premarket data is unavailable */}
                {meta?.premarketUnavailable && !premarketNoticeDismissed && (
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
                  sessionKey={`${meta.ticker}|${meta.tradeDate}|${meta.source}|${candles.length}|${timeframe}`}
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
                    sessionKey={`${meta.ticker}|${meta.tradeDate}|${meta.source}|${candles.length}|${timeframe}`}
                    countdown={tfCountdown}
                    lastPrice={snap.price}
                    brackets={brackets}
                    onPlannedDrag={(sl, tp) => { setPlannedLevels(sl, tp); }}
                    onActiveDrag={(sl, tp) => {
                      const e = engineRef.current;
                      if (e) { e.setBrackets(sl, tp); bump(); }
                    }}
                    drawings={drawings}
                    onDrawingsChange={setDrawings}
                    drawingTool={drawingTool}
                    onDrawingToolChange={setDrawingTool}
                    onBarsPushed={parityDiag ? (bars) => { chartBarsRef.current = bars; } : undefined}
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
                onCancelOrder={(id) => { eng.cancelOrder(id); bump(); }}
                onSetBrackets={(sl, tp) => {
                  const eng = engineRef.current;
                  if (!eng) return;
                  // Normalize to valid tick increments for consistency.
                  const nSL = sl != null ? normalizePrice(sl) : null;
                  const nTP = tp != null ? normalizePrice(tp) : null;
                  if (eng.positionQty > 0) {
                    // Position open: active brackets on the engine.
                    eng.setBrackets(nSL, nTP);
                  } else {
                    // Flat: planned levels only (dashed, no engine effect).
                    setPlannedLevels(nSL, nTP);
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
                onPlannedChange={(sl, tp) => { setPlannedLevels(sl != null ? normalizePrice(sl) : null, tp != null ? normalizePrice(tp) : null); }}
                onActiveChange={(sl, tp) => {
                  const e = engineRef.current;
                  if (e) { e.setBrackets(sl != null ? normalizePrice(sl) : null, tp != null ? normalizePrice(tp) : null); bump(); }
                }}
                onApplyBrackets={(sl, tp) => {
                  setPlannedLevels(sl, tp);
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

          {/* data source popover */}
          {dataOpen && (
            <div className="ws-data-pop" role="dialog" aria-label="Data source">
              <button className="mini-x ws-data-x" onClick={() => setDataOpen(false)} title="Close">✕</button>
              <DataSourcePanel candles={candles} meta={meta} onLoad={handleLoad} />
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
          {parityDiag && eng && meta && candles && (
            <CandleParityPanel
              meta={meta}
              candles={candles}
              getEngine={() => engineRef.current}
              getChartBars={() =>
                searchParams.get("chart") === "canvas"
                  ? (engineRef.current?.displayCandles ?? [])
                  : chartBarsRef.current
              }
              chartKind={searchParams.get("chart") === "canvas" ? "canvas" : "lwc"}
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
