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
  phaseForCandle,
  flowTimestamp,
  FLOW_UPDATES_PER_CANDLE,
  TICKS_PER_FLOW_UPDATE,
  DRILL_TICKS_PER_CANDLE,
  type FlowBehavior,
  type FlowParams,
  type OrderBookSnapshot,
  type TradePrint,
} from "./orderflow";
import type { DrillScenario } from "./types";

/** Scenario id → order-flow behavior. Internal: never shown pre-answer. */
export const BEHAVIOR_FOR: Record<string, FlowBehavior> = {
  "hod-clean-001": "clean",
  "hod-weak-001": "weak",
  "hod-failed-001": "failed",
  "hod-ambiguous-001": "ambiguous",
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
      book: OrderBookSnapshot;
      prints: TradePrint[];
    }
  | { kind: "final"; candleIndex: number; candle: Candle };

export class DrillSim {
  readonly scenario: DrillScenario;
  readonly engine: ReplayEngine;
  private readonly fp: FlowParams;

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
  private checkpointSnap: { simTimeMs: number; candleIndex: number } | null = null;

  constructor(scenario: DrillScenario) {
    this.scenario = scenario;
    this.fp = {
      seed: scenario.seed,
      level: scenario.hod,
      behavior: BEHAVIOR_FOR[scenario.id] ?? "ambiguous",
    };
    const historyCount = historyCountFor(scenario);
    this.engine = new ReplayEngine(
      scenario.candles,
      100_000,
      historyCount,
      DRILL_TICKS_PER_CANDLE
    );
    const hist = scenario.candles[historyCount - 1];
    this.windowStartPrice = hist.c;
    this.lastPrice = hist.c;

    // Seed the panels with the last history candle's flow so Level 2 /
    // Time & Sales aren't empty when the drill starts.
    const phase = phaseForCandle(historyCount - 1, scenario.checkpointIndex);
    const ts = flowTimestamp(hist.t, FLOW_UPDATES_PER_CANDLE - 1);
    this.book = generateBook(this.fp, 0, hist.c, phase, ts);
    const seedPrints = generatePrints(
      this.fp,
      0,
      hist.c,
      Math.max(1, Math.round(hist.v / FLOW_UPDATES_PER_CANDLE)),
      phase,
      ts,
      0
    );
    this.prints = [...seedPrints].reverse().slice(0, PRINT_BUFFER_MAX);
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
    const phase = phaseForCandle(candleIndex, this.scenario.checkpointIndex);
    const flowTick = candleIndex * FLOW_UPDATES_PER_CANDLE + updateIndex;
    const ts = flowTimestamp(candle.t, updateIndex);

    const book = generateBook(this.fp, flowTick, this.lastPrice, phase, ts, this.book ?? undefined);
    this.book = book;
    const newPrints = generatePrints(this.fp, flowTick, this.lastPrice, windowVol, phase, ts, dir);
    if (newPrints.length > 0) {
      this.prints = [...[...newPrints].reverse(), ...this.prints].slice(0, PRINT_BUFFER_MAX);
    }
    this.windowStartPrice = this.lastPrice;

    return { kind: "flow", candleIndex, updateIndex, book, prints: newPrints };
  }
}
