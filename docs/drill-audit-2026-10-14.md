# Breakout Drill — Engineering Audit (2026-10-14)

Branch: `breakout-drills` @ `845610f`. Scope: drill only. `/replay` untouched.
Method: full code read of `lib/engine.ts`, `lib/drills/{candleGen,scenarios,orderflow,types}.ts`,
`app/drills/[id]/page.tsx`, `components/{LwcChart,Level2Panel,TimeSalesPanel}.tsx`,
plus empirical probes against the live generators, plus the baseline test run
(existing verify suites: **169/169 green**; `tsc --noEmit` clean; `next build` passes).

## How one market event travels today

Scenario definition (`scenarios.ts`, seeded regimes → `candleGen.ts`) produces a
fixed candle array up front. `ReplayEngine` (shared with /replay) replays it:
each candle is re-formed tick-by-tick from a deterministic Brownian-bridge path
(`makeTicks`, seeded from the candle's own OHLCV) that is clamped to the true
[low, high], pinned to touch both extremes, and settles exactly on the true
close. The drill page runs a `setInterval`; each fire advances the engine one
tick, then (every 10 ticks) regenerates the Level 2 book and Time & Sales
prints from `orderflow.ts` using seeded stateless generators, and passes props
to `LwcChart` / panels.

The engine core is sound and is NOT the problem. The defects are almost all in
the drill layer around it: the chart data contract, the scheduler, the flow
generators, and the page's state machine.

## Root causes

### RC1 — The chart never receives the forming candle (candles "freeze, then jump")
`app/drills/[id]/page.tsx` passes `candles={scenario.candles}` (the full
scenario array) and `revealedCount={engine.index + 1}` to `LwcChart`.
`index + 1` counts only *finalized* candles, so the pushed series is
finalized-only: nothing on the chart moves except the last-price tag, and every
~7.5 s (at 8x) a complete, fully-formed candle pops in with its final OHLC.
`/replay` uses the correct contract — `candles={eng.displayCandles}`,
`revealedCount={displayCandles.length}` — where `displayCandles` includes the
live forming candle and `LwcChart`'s push logic updates the forming bar in
place and appends the finalized bar on finalize. Drills bypass that contract.
Passing the full scenario array is also a future-data hazard: correctness
depends entirely on `LwcChart` never reading past `revealedCount`.

### RC2 — No simulation clock: one `setInterval`, one tick per fire, no elapsed-time accounting
The page's interval fires one engine tick per callback regardless of how much
wall time actually elapsed. Consequences: browser timer jitter and background
tab throttling (intervals clamp to ~1 s) silently slow the simulation far
below the labelled speed; there is no catch-up policy at all; "speed" is
whatever the browser happens to deliver. Speed model as coded:
`tickMs = 1000 / ((ticksPerCandle/60) * speed)`, i.e. candle wall time =
60/speed seconds (1x = one simulated minute per 60 wall seconds — consistent
with the engine's `SECONDS_PER_CANDLE = 60` convention), except a
`Math.max(16, tickMs)` clamp quietly distorts the top speed. Speed changes
recreate the interval (no duplication — cleanup is correct), but nothing
rescales an accumulated position because there is no accumulator.

### RC3 — Level 2 ladder is geometrically broken (measured)
`generateBook` builds each rung as `price ± tickSize*(i+1) ± rng()*tickSize`
and rounds to cents. Adjacent rungs collapse onto the same price after
rounding. Probe over every scenario (252 books sampled for clean):
**~98% of books contain duplicate prices; ~2 disordered adjacent pairs per
book on average** (501 disordered pairs / 252 books). Only the best bid/ask
pair gets a crossed-book patch. Sizes are also fully re-randomized on every
update (RNG re-seeded per update), so depth teleports between updates — no
consumption, no replenishment, no continuity: the "random, unexplained jumps"
symptom. The failed-scenario "wall" rewrites a rung's price to
`level + 2*tickSize` without regard to ladder ordering, worsening RC3.

### RC4 — Time & Sales is not accounted to the market it claims to show
Prints are generated from `candle.v / FLOW_UPDATES_PER_CANDLE` — a divisor
heuristic, not the volume the engine actually traded in that window (the
engine tracks this precisely via its cumulative `volFrac` curve). Print size
then starts from `tickVolume * (0.4 + rng()*1.2)`: measured over a full candle,
**print volume sums to 1.06–1.16× the candle's volume**, varying randomly.
Print prices are the current price ± half a cent of jitter rather than the
window's actual tick prices, and the side bias uses the *instantaneous* tick
direction. Prints are decorations near the market, not records of it.

### RC5 — Flow phase is computed for the wrong candle (off by one)
The page derives `flowPhase = phaseForCandle(eng.index, …)` — `eng.index` is
the last *finalized* candle — while the book/prints are generated for the
*forming* candle (`eng.index + 1`). Around the checkpoint the book therefore
shows the previous candle's phase behavior (e.g. still "approach" flow while
the breakout candle is forming). Separately, the update-index mapping
(`min(11, floor(ticks/10))`) never emits index 0 and emits index 11 twice, so
the last two flow updates of every candle share one deterministic timestamp.

### RC6 — Missing transport controls and status (spec §6/§9 gaps)
There is no Pause, no Resume, and no Reset during a run (the only pause is
the automatic checkpoint), no elapsed simulated-time readout, and no
run-status indicator. A user cannot tell a throttled/frozen tab (RC2) from a
working drill.

### RC7 — HOD display is incomplete
The reference HOD line itself is correct (predefined `scenario.hod`, drawn
via `referenceLevels`, never computed from future candles). But the header
shows only the reference level + current price + a $ distance: no live
session high (distinct from the reference level), no % distance, and no
market state (approaching / testing / breaking / accepting / rejected).

### RC8 — The runner leaks the answer in its header
During intro/running/checkpoint the page header renders `scenario.title` —
literally "Clean HOD Breakout" / "Failed HOD Breakout (Trap)". Whatever the
picker choice, the drill itself announces the classification before the
checkpoint question. (The picker is a deliberate, labelled selection —
non-blind by design; the runner must not re-announce it.)

### RC9 — Scenario switching can strand stale state
`app/drills/[id]/page.tsx` never resets its state when the route `id`
changes. Next.js may reuse the component across `/drills/a → /drills/b`
navigation, leaving the previous scenario's engine, phase (e.g. "teaching"),
answer, book and prints attached to the new scenario's data.

### RC10 — Whole-page re-render per UI tick, panels coupled to price state
A single `tickVersion` state re-renders the entire page (chart + both panels +
header) up to every 6 ticks; book/prints live in the same render pass as the
price header. It works, but there are no isolation boundaries: every price
update re-renders the Level 2 and Time & Sales DOM.

### What is sound and stays
- `ReplayEngine` tick formation: deterministic, settles exactly on true
  OHLC, volume accumulates via a fixed cumulative curve, `revealed` /
  `displayCandles` boundary leaks nothing.
- Scenario generation: seeded regime model; HOD = pre-breakout max high;
  checkpoint = breakout + 1; the four scenarios have materially different
  regime parameters (drift, volatility, breakout volume multiple, close
  position, post-breakout drift).
- `gradeAnswer` semantics ("not_sure" never wrong; ambiguous = partial).
- `phaseForCandle`, `flowTimestamp`, SIMULATED labelling, `fitOnLoad`.

## Implementation plan (drill-scoped; engine untouched)

1. **New `lib/drills/sim.ts` — `DrillSim`**: the single owner of drill
   simulation state. Wraps one `ReplayEngine`; advances tick-by-tick;
   emits flow events (book + prints) exactly every `TICKS_PER_FLOW_UPDATE`
   ticks of the forming candle; owns the prints ring buffer (bounded),
   the previous book (for evolution), and all counters. Pure scheduler
   helpers (`ticksDue`, catch-up cap) live here for unit testing.
2. **Scheduler (page)**: `requestAnimationFrame` loop + accumulator.
   Sim time advances from elapsed wall time × speed; per-frame advance is
   capped (`MAX_FRAME_TICKS = 48`) and frame dt is clamped (250 ms) —
   excess backlog is *dropped, not replayed* (bounded catch-up policy:
   after a stall the drill resumes at labelled speed instead of bursting).
   Pause freezes the accumulator; resume re-anchors it. The event sequence
   depends only on tick count, never on frame timing or speed — chunking
   invariance is unit-tested.
3. **Chart contract**: pass `engine.displayCandles` +
   `revealedCount = displayCandles.length`, exactly like /replay.
4. **`orderflow.ts` repairs**: book ladder built in integer cents around
   the rounded last price (best bid = mid − 1¢ … best ask = mid + 1¢ …) —
   strictly ordered, unique, and always bracketing the last price.
   `generateBook` gains an optional previous snapshot and *evolves* sizes
   (bounded ±35% steps, drift toward behavior/phase depth targets,
   consumption shaving on the side price moved through, replenishment
   toward target). Failed wall boosts the ask rung at the level + 2¢ when
   that rung exists, size-only otherwise. `generatePrints` partitions the
   *actual* window volume exactly (sum of print sizes == window volume).
5. **Prints from the engine's real window**: DrillSim computes each flow
   window's traded volume from the forming candle's cumulative volume
   delta and the window's direction/last price from actual ticks, and
   passes those to `generatePrints`. Timestamps use the corrected
   update index 0..11 via `flowTimestamp`.
6. **Phase from the forming candle** (RC5 fix).
7. **Transport + status UI**: Pause/Resume and Reset buttons (running and
   resolving), elapsed sim time, status text, speed caption documenting
   the definition (1x = 1 simulated minute per 60 s; candle = 60/speed s).
8. **HOD header**: reference HOD, live session high (`engine.hod`),
   current price, distance in $ and %, and a state label from new pure
   `lib/drills/hodState.ts` computed only from revealed data.
9. **Leak fix**: neutral runner header ("HOD Breakout Drill" + difficulty)
   until the teaching screen, which keeps the real title.
10. **Lifecycle**: effect keyed on route `id` resets all drill state.
11. **Render isolation**: book/prints state update only on flow events;
    header/chart version updates on flow events, finalizes, or a 150 ms
    freshness tick — panels no longer re-render per price tick.
12. **Tests**: new `lib/drills/verify-sim.ts` in the existing verify style
    (candle aggregation, timing/chunking invariance, bounded catch-up,
    pause/resume/reset, L2/T&S invariants + exact volume accounting,
    scenario fingerprints, no-future-leak, blind snapshot surface), run
    alongside the existing four suites (169 checks) + `tsc` + build.

## Speed definition (documented, single source)
Speed `s` means **s simulated minutes per wall-clock minute**: one
1-minute candle forms in `60 / s` wall seconds. 1x is real time.
Labels [1, 2, 4, 8, 16, 32]x, default 8x (7.5 s per candle). The event
sequence and final state are identical at every speed.
