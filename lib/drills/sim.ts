/**
 * Breakout Drill — DrillSim: the ONE owner of drill simulation state.
 *
 * Architecture (audit RC1/RC2/RC4/RC5): there is exactly one market
 * timeline — the shared ReplayEngine's tick stream. DrillSim advances
 * that engine tick-by-tick and derives EVERYTHING the UI shows from the
 * same ticks:
 *
 *   scenario candles → ReplayEngine ticks → candle aggregation (engine)
 *                                          → Level 2 book (flow windows)
 *                                          → Time & Sales prints (flow windows)
 *
 * Flow windows: every TICKS_PER_FLOW_UPDATE ticks of the forming candle,
 * DrillSim reads the volume the engine actually traded in the window
 * (from the forming candle's cumulative volume) and the window's real
 * price direction, then generates the book and prints for that window.
 * Print sizes partition the window volume exactly, so T&S reconciles
 * with candle volume to the share.
 *
 * Determinism contract: the event sequence depends ONLY on the scenario
 * and the number of ticks advanced — never on wall-clock timing, frame
 * rate, or speed. Advancing 480 ticks in one call or in 48 calls of 10
 * produces identical books, prints, and final state (unit-tested).
 *
 * Speed definition (single, documented): speed s = s simulated minutes
 * per wall-clock minute. One 1-minute candle forms in 60/s wall seconds;
 * 1x is real time. Speed changes wall pacing only.
 */
import { ReplayEngine } from "../engine";
import type { Candle } from "../types";
import {
  generateBook,
  generatePrints,
  flowPhaseForState,
  rampFor,
  flowTimestamp,
  FLOW_UPDATES_PER_CANDLE,
  TICKS_PER_FLOW_UPDATE,
  DRILL_TICKS_PER_CANDLE,
  type FlowBehavior,
  type FlowContext,
  type FlowParams,
  type FlowPhase,
  type OrderBookSnapshot,
  type TradePrint,
} from "./orderflow";
import { hodMarketState, type HodMarketState } from "./hodState";
import type { DrillScenario } from "./types";

/** Scenario id → order-flow behavior. Internal: never shown pre-answer. */
export const BEHAVIOR_FOR: Record<string, FlowBehavior> = {
  "hod-clean-001": "clean",
  "hod-weak-001": "weak",
  "hod-failed-001": "failed",
  "hod-ambiguous-001": "ambiguous",
  "hod-clean-002": "clean",
  "hod-clean-003": "clean",
  "hod-weak-002": "weak",
  "hod-weak-003": "weak",
  "hod-failed-002": "failed",
  "hod-failed-003": "failed",
  "hod-ambiguous-002": "ambiguous",
  "hod-ambiguous-003": "ambiguous",
};

/** Max ticks one scheduler frame may advance (bounded catch-up). */
export const MAX_FRAME_TICKS = 48;
/** Frame dt beyond this is discarded, not caught up (stall → slow, never burst). */
export const MAX_FRAME_DT_MS = 250;
/** Time & Sales history bound (newest first). */
export const PRINT_BUFFER_MAX = 120;

/** Historical candles revealed instantly at drill start (rest forms live). */
export function historyCountFor(scenario: DrillScenario): number {
  return Math.max(2, Math.floor(scenario.checkpointIndex * 0.4));
}

/**
 * Wall-clock → tick accumulator for the UI scheduler. Pure logic, no
 * timers: the page feeds it rAF timestamps; tests feed it synthetic ones.
 * Pause = stop feeding it; resume = reset() so paused time never counts.
 */
export class SimClock {
  private acc = 0;
  private last: number | null = null;

  reset(): void {
    this.acc = 0;
    this.last = null;
  }

  /** Ticks due for this frame. Bounded: dt clamp + per-frame cap. */
  frame(nowMs: number, speed: number): number {
    if (this.last == null) {
      this.last = nowMs;
      return 0;
    }
    let dt = nowMs - this.last;
    this.last = nowMs;
    if (dt < 0) dt = 0;
    if (dt > MAX_FRAME_DT_MS) dt = MAX_FRAME_DT_MS; // drop stall time
    this.acc += (dt / 1000) * speed * (DRILL_TICKS_PER_CANDLE / 60);
    let due = Math.floor(this.acc);
    if (due > MAX_FRAME_TICKS) {
      due = MAX_FRAME_TICKS;
      this.acc = 0; // drop the backlog rather than bursting
    } else {
      this.acc -= due;
    }
    return due;
  }
}

export type SimEvent =
  | {
      kind: "flow";
      candleIndex: number;
      updateIndex: number;
      /** Event-derived flow phase for this window (F2). Generic market
       *  vocabulary only — never the scenario classification. */
      phase: FlowPhase;
      book: OrderBookSnapshot;
      prints: TradePrint[];
    }
  | { kind: "final"; candleIndex: number; candle: Candle };

export class DrillSim {
  readonly scenario: DrillScenario;
  readonly engine: ReplayEngine;
  private readonly fp: FlowParams;
  /** Candles pre-revealed at drill start; live events begin here. */
  private readonly historyCount: number;

  /** Live ticks advanced since start (the sim's position on its timeline). */
  ticksElapsed = 0;
  /** Current book (evolves from the previous snapshot each flow window). */
  book: OrderBookSnapshot | null = null;
  /** Newest-first, bounded print history. */
  prints: TradePrint[] = [];

  private ticksInCandle = 0;
  private printedVolThisCandle = 0;
  private windowStartPrice: number;
  private lastPrice: number;
  /** Previous flow window's price (volatility EMA input, F5). */
  private prevWindowPrice: number;
  /** Recent per-window volatility EMA, in cents (spread driver, F5). */
  private volEmaC = 0.6;
  /** Previous emitted window's flow phase (distribution ramp, #1). */
  private lastFlowPhase: FlowPhase | null = null;
  /** Consecutive Failed-resolution windows since the phase last
   *  entered resolution; drives ctx.distRamp. Starts "fully ramped"
   *  so no ramp is owed until a transition actually happens. */
  private distRampStep = FLOW_UPDATES_PER_CANDLE;
  private checkpointSnap: { simTimeMs: number; candleIndex: number } | null = null;

  constructor(scenario: DrillScenario) {
    this.scenario = scenario;
    this.fp = {
      seed: scenario.seed,
      level: scenario.hod,
      behavior: BEHAVIOR_FOR[scenario.id] ?? "ambiguous",
    };
    const historyCount = historyCountFor(scenario);
    this.historyCount = historyCount;
    this.engine = new ReplayEngine(
      scenario.candles,
      100_000,
      historyCount,
      DRILL_TICKS_PER_CANDLE
    );
    const hist = scenario.candles[historyCount - 1];
    this.windowStartPrice = hist.c;
    this.lastPrice = hist.c;
    this.prevWindowPrice = hist.c;

    // Seed the panels with the last history candle's flow so Level 2 /
    // Time & Sales aren't empty when the drill starts.
    const { phase, ctx } = this.flowContextFor(historyCount - 1);
    const ts = flowTimestamp(hist.t, FLOW_UPDATES_PER_CANDLE - 1);
    this.book = generateBook(this.fp, 0, hist.c, phase, ts, undefined, ctx);
    const seedPrints = generatePrints(
      this.fp,
      0,
      hist.c,
      Math.max(1, Math.round(hist.v / FLOW_UPDATES_PER_CANDLE)),
      phase,
      ts,
      0,
      this.book ?? undefined,
      ctx
    );
    this.prints = [...seedPrints].reverse().slice(0, PRINT_BUFFER_MAX);
  }

  /**
   * THE market-state derivation — one source of truth for everything
   * the user sees: the flow engine's phase/context AND the runner
   * header's state label both come from here, so the label can never
   * disagree with what the book and tape are doing. Derived from
   * REVEALED data only (finalized candles + the forming candle + the
   * last tick price), a pure function of the tick stream so far —
   * chunking-invariant, pause-safe.
   *
   * On top of the raw hodMarketState machine it applies the two
   * causal-timing rules the flow has always used:
   *  - a strict-cross rejection counts only once CONFIRMED by a
   *    finalized close back below the level (an intra-candle
   *    spike-and-fade is still the trap forming, not distribution);
   *  - for Failed, an exact-touch test rejection (the b34193f
   *    chapter) is a rejection even though the strict machine —
   *    which needs a wick or close strictly ABOVE the level — can
   *    never see it.
   */
  private deriveState(): HodMarketState {
    const level = this.scenario.hod;
    const revealed = this.engine.revealed;
    const live = hodMarketState(level, revealed, this.formingCandle());
    let state = live;
    if (live === "rejected") {
      // Rejection counts (flow AND header label) only once it is
      // confirmed by a finalized candle: a wick above the level that has since
      // FINALIZED below it (or an accepted close that a later finalized
      // candle lost). An intra-candle spike-and-fade inside the cross
      // candle itself is still the trap forming, not distribution —
      // the lure (buy tape, supported book, the wall) must survive
      // until the first close back below the level.
      const lastFinal = revealed[revealed.length - 1];
      const confirmed =
        !!lastFinal &&
        lastFinal.c < level &&
        revealed.some((cand) => cand.h > level) &&
        this.lastPrice < level;
      if (!confirmed) state = "breaking";
    } else if (
      BEHAVIOR_FOR[this.scenario.id] === "failed" &&
      this.touchRejectionOpen(revealed)
    ) {
      // Residual #1 — the exact-touch gap: hodMarketState needs a
      // strict cross (a close or wick ABOVE the level) to say
      // "rejected", so a test that reached the level exactly and fell
      // back (failed-003: candle 9 closes AT the level, candle 10
      // closes below it) never confirms there — and the book stayed
      // a neutral approach book for the whole grind that followed,
      // minutes after supply had in fact leaned in. For Failed's flow
      // that failed test IS the rejection chapter: distribution
      // character applies while the chapter is open. Scoped to the
      // failed behavior — every class's coil contains failed first
      // tests, and for them that is ordinary approach behavior, not
      // distribution (measured: a generic version recolored clean
      // and weak coils and diluted their cross-candle tape).
      state = "rejected";
    }
    return state;
  }

  /**
   * The market state the runner header displays, via the SAME
   * derivation the flow engine uses (deriveState). Before this getter
   * existed the page called the raw hodMarketState directly, so in
   * failed-003 the header stayed on "Testing HOD" / "Approaching
   * HOD" through the whole post-rejection grind while the book and
   * tape were already distributing — the strict machine cannot see
   * an exact-touch rejection, and it also flashes "rejected" on
   * intra-candle wick fades the flow deliberately treats as
   * unconfirmed. One derivation, no parallel condition.
   */
  get marketState(): HodMarketState {
    return this.deriveState();
  }

  /**
   * Flow phase + context for a candle, derived from REVEALED data only:
   * the HOD event state over finalized candles + the forming candle
   * (F2), the class-character ramp (F1), and the volatility EMA (F5).
   * Pure function of the tick stream so far — chunking-invariant.
   */
  private flowContextFor(candleIndex: number): { phase: FlowPhase; ctx: FlowContext } {
    const state = this.deriveState();
    const cp = this.scenario.checkpointIndex;
    return {
      phase: flowPhaseForState(state, candleIndex, cp, BEHAVIOR_FOR[this.scenario.id]),
      ctx: { ramp: rampFor(state, candleIndex, cp), state, volC: this.volEmaC },
    };
  }

  /**
   * Residual #1 — is a Failed "test rejection" chapter open? True
   * when the most recent LIVE chapter at the level is a decisive test
   * that failed: a live candle (at/after the pre-revealed history)
   * reached the level and closed at/near it, every finalized candle
   * since closed below it, the last finalized candle closed below it,
   * and the live price still hovers under the level (within ~1.5% —
   * if price falls away hard, the chapter is over). A later close at
   * or above the level (re-acceptance) closes the chapter. Pure
   * function of revealed candles + last price.
   */
  private touchRejectionOpen(revealed: Candle[]): boolean {
    const level = this.scenario.hod;
    const lastFinal = revealed[revealed.length - 1];
    if (!lastFinal || lastFinal.c >= level) return false;
    if (this.lastPrice >= level || this.lastPrice < level * 0.985) return false;
    for (let j = revealed.length - 1; j >= this.historyCount; j--) {
      const c = revealed[j];
      if (c.c >= level) return false; // (re-)acceptance close: chapter closed
      if (c.h >= level && c.c >= level * 0.995) return true; // decisive test
    }
    return false;
  }

  /** Simulated elapsed time (ms) — derived from ticks, never wall clock. */
  get simTimeMs(): number {
    return this.ticksElapsed * (60_000 / DRILL_TICKS_PER_CANDLE);
  }

  get atEnd(): boolean {
    return this.engine.atEnd && this.ticksInCandle === 0;
  }

  /** Checkpoint reached: the checkpoint candle has finalized. */
  get checkpointReached(): boolean {
    return this.engine.index >= this.scenario.checkpointIndex;
  }

  /**
   * The decision timestamp for the checkpoint: sim time + candle index
   * captured at the EXACT tick the checkpoint candle finalized. The UI
   * scheduler advances in whole frames (up to MAX_FRAME_TICKS) and only
   * notices the checkpoint after the frame, so the live sim clock can
   * sit up to a frame past the candle boundary when the modal opens —
   * decisions must be stamped with this snapshot, never with the live
   * (frame-dependent) clock, so the recorded lock time is a property
   * of the scenario, identical wherever it is displayed.
   */
  get checkpointSnapshot(): { simTimeMs: number; candleIndex: number } | null {
    return this.checkpointSnap;
  }

  /** The live forming candle snapshot, or null when none is forming. */
  formingCandle(): Candle | null {
    const dc = this.engine.displayCandles;
    return dc.length > this.engine.index + 1 ? dc[dc.length - 1] : null;
  }

  /**
   * Advance the simulation by up to `n` ticks, returning every event
   * produced (flow windows and candle finalizations) in order. Calling
   * this is the ONLY way sim time moves: pause = don't call it.
   */
  advance(n: number): SimEvent[] {
    const events: SimEvent[] = [];
    for (let k = 0; k < n; k++) {
      if (this.engine.atEnd) break;
      const r = this.engine.tick();
      this.ticksElapsed += 1;
      this.ticksInCandle += 1;
      const price = this.engine.displayPrice;
      this.lastPrice = price;

      if (this.ticksInCandle % TICKS_PER_FLOW_UPDATE === 0) {
        events.push(this.emitFlowWindow(r.finalized));
      }
      if (r.finalized) {
        events.push({
          kind: "final",
          candleIndex: this.engine.index,
          candle: this.engine.currentCandle,
        });
        if (
          this.checkpointSnap === null &&
          this.engine.index >= this.scenario.checkpointIndex
        ) {
          this.checkpointSnap = {
            simTimeMs: this.simTimeMs,
            candleIndex: this.engine.index,
          };
        }
        this.ticksInCandle = 0;
        this.printedVolThisCandle = 0;
        this.windowStartPrice = price;
      }
    }
    return events;
  }

  /** Drain instantly to the end (used by "Skip to Result"). */
  advanceToEnd(): SimEvent[] {
    const events: SimEvent[] = [];
    while (!this.engine.atEnd) {
      events.push(...this.advance(DRILL_TICKS_PER_CANDLE));
    }
    return events;
  }

  private emitFlowWindow(finalized: boolean): SimEvent {
    const eng = this.engine;
    const candleIndex = finalized ? eng.index : eng.index + 1;
    const candle = this.scenario.candles[candleIndex];
    const updateIndex = this.ticksInCandle / TICKS_PER_FLOW_UPDATE - 1;

    // Volume the engine actually traded in this window: cumulative
    // forming volume now, minus what earlier windows already printed.
    const cumV = finalized ? candle.v : (this.formingCandle()?.v ?? 0);
    const windowVol = Math.max(0, Math.round(cumV) - this.printedVolThisCandle);
    this.printedVolThisCandle += windowVol;

    const dir: 1 | -1 | 0 =
      this.lastPrice > this.windowStartPrice
        ? 1
        : this.lastPrice < this.windowStartPrice
          ? -1
          : 0;

    // F5: fold this window's move into the volatility EMA before the
    // book is quoted, so active windows widen the spread as they happen.
    const instVolC = Math.abs(this.lastPrice - this.prevWindowPrice) * 100;
    this.volEmaC = this.volEmaC * 0.65 + instVolC * 0.35;
    this.prevWindowPrice = this.lastPrice;

    // F2/F1: phase and class-character ramp from revealed price events.
    const { phase, ctx } = this.flowContextFor(candleIndex);
    // Residual #1: Failed's distribution ramps in over the first
    // candle after the phase (re-)enters resolution. Window-counted,
    // so it is a pure function of the tick stream (chunking-invariant).
    if (phase === "resolution" && BEHAVIOR_FOR[this.scenario.id] === "failed") {
      if (this.lastFlowPhase !== "resolution") this.distRampStep = 0;
      ctx.distRamp = Math.min(1, (this.distRampStep + 1) / FLOW_UPDATES_PER_CANDLE);
      this.distRampStep += 1;
    }
    this.lastFlowPhase = phase;
    const flowTick = candleIndex * FLOW_UPDATES_PER_CANDLE + updateIndex;
    const ts = flowTimestamp(candle.t, updateIndex);

    const book = generateBook(this.fp, flowTick, this.lastPrice, phase, ts, this.book ?? undefined, ctx);
    this.book = book;
    const newPrints = generatePrints(this.fp, flowTick, this.lastPrice, windowVol, phase, ts, dir, book, ctx);
    if (newPrints.length > 0) {
      this.prints = [...[...newPrints].reverse(), ...this.prints].slice(0, PRINT_BUFFER_MAX);
    }
    this.windowStartPrice = this.lastPrice;

    return { kind: "flow", candleIndex, updateIndex, phase, book, prints: newPrints };
  }
}
