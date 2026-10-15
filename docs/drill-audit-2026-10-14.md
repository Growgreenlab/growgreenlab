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

## Addendum (2026-10-15) — F1–F10 order-flow rebuild

A follow-up audit measured the *live* Level 2 / Time & Sales stream
(headless DrillSim runs, all 12 scenarios) and found the flow behaviors
were per-class templates riding on four structural simplifications:
index-scheduled phases, a fixed 2¢ spread, 1–2 prints per window, and
print side decoupled from print price. The F1–F10 rebuild (commits
`480a3a4`, `486ad7e`, and the Stage 3 test commit) replaced that
architecture while preserving determinism, exact volume partition, and
the single DrillSim timeline:

- **Event-triggered phases (F2).** DrillSim derives the flow phase per
  window from `hodMarketState` over revealed candles only
  (`flowPhaseForState`). "Testing" (coiling at the level) keeps
  approach character; breakout character begins at the cross itself;
  distribution begins on the first *finalized* close back below the
  level — rejection requires a confirming close, so the Failed lure
  survives inside the cross candle. Failed's fake acceptance keeps
  breakout character until rejection confirms.
- **Class-neutral approach (F1).** One shared baseline book and tape
  bias; class targets blend in via a ramp (`rampFor`: candle distance
  to the checkpoint, forced up by HOD proximity). Measured after:
  approach depth 2,497–3,263 and ratio 0.95–1.10 across ALL 12
  scenarios (Weak was ~1,060 depth before; Ambiguous ratio 1.35–1.72).
- **Volatility spread (F5).** Half-spread 1–3¢ from a per-window
  volatility EMA maintained by DrillSim (`halfSpreadForVol`). Quiet
  approach quotes ≈2¢ total; climactic windows widen to 6¢. Ladder
  invariants (integer cents, strictly ordered, brackets last price)
  are unchanged and still asserted per window.
- **Prints at the quote (F3).** A buy print is priced at the
  contemporaneous best ask, a sell at the best bid — the book
  DrillSim just generated for that window. Buy-at-ask went from 11%
  of buy prints to 100%; side and price can no longer contradict.
- **Volume-scaled print count (F4).** ~650 shares per print (clamp
  1–8 per window), exact partition preserved. Per-candle tape now
  concentrates near its bias: Clean cross-candle buy-share
  0.49/0.96/0.49 → 0.76/0.85/0.73 (with the at/above-level breakout
  buy-probability floor).
- **Damped Clean book (F6).** Breakout depth ratio ≈ 2.2–2.6 (was
  5.8–6.9, with ask totals a memorizable 543–555; now 1,011–1,210
  under personality jitter).
- **Price-pinned Failed wall (F7).** A wall target at level+2¢ while
  the ladder contains it, heavy sticky supply on the near ask rungs
  while price is at/above the level, and a ~5%/window decay floor so
  resting size persists instead of re-keying away. Wall presence in
  at/above-HOD breakout windows: 3% / 50%-of-2 / 21% → 79% / 100% / 62%.
- **Weak fade + replenishment (F8).** Resolution tape leans mildly
  net-sell once price is below the level (bleed scenarios' resolution
  buy-share 0.67/0.60 → 0.48/0.53; weak-001 0.37 → 0.41), and Weak's
  asks requote near-instantly (consumption-shave floor 0.92, faster
  ask step cap) so replenishment is a dynamic, not just thinness.
- **Per-scenario personality (F9).** Deterministic scalars from the
  scenario seed (`personalityFor`: depth scale 0.85–1.20, touch
  jitter, tape-bias jitter ±0.04, refill scale, wall scale). Class
  means stay in band; the shared statistical fingerprint is gone.
- **Ambiguous redesign.** The class fingerprint was a sine with a
  ~232-window period (longer than the approach). The lean is now
  re-randomized per candle, wobble is within-candle, buy-probability
  is capped at 0.7 with a per-candle phase offset, and the breakout
  book alternates its heavy side candle by candle (designed conflict).
  Approach depth CV 0.38–0.44 → 0.16–0.19; lag-1 autocorrelation
  0.73–0.79 → 0.09–0.35; cross-candle tape 0.81/0.95 → 0.57/0.43.
  Phantom size is kept, gated to breakout/resolution.
- **Path-level tests (F10).** `lib/drills/verify-flowpath.ts` asserts
  against the evolved book along real price paths: wall presence,
  distribution timing vs the first sub-HOD close, spread band and
  responsiveness, exact volume conservation, 100% quote-priced
  prints, approach-neutrality bands, and class-story bands.

Checkpoint leakage re-analysis (after): no single approach-phase
metric deterministically separates any class (best one-vs-rest
threshold rules reach at most 11/12 and each is broken by another
class's range). At the checkpoint, book+tape *in aggregate* identify
Clean (the designed confident read); per-window values overlap
broadly — 86% of individual Clean breakout windows fall inside the
value range spanned by other classes' windows — and no single metric
separates Weak / Failed / Ambiguous from each other at the snapshot
a user actually sees.
