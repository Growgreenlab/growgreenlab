# Breakout Drills — Upgrade Audit (2026-10-15)

Branch: `breakout-drills` @ `18d9a8b`. Production `main` @ `61ed4ae` — untouched.
Fresh baseline (re-run for this audit, `npx tsx lib/drills/verify-*.ts`):
verify 89, verify-sim 359, verify-blind 400, verify-fixes 110, verify-flow 138,
verify-flowpath 165, verify-pool 225, verify-e2e 156 — **1,642 passed, 0 failed.**

## 1. Architecture & authoritative market clock — VERIFIED SOUND

- One timeline: `lib/drills/sim.ts` (`DrillSim` + `SimClock`). Every candle,
  Level 2 book and Time & Sales print derives from the single seeded event
  sequence (ticksPerCandle=120 ticks/candle, mulberry32-class seeded RNG).
  No independent timers generate market behavior; the wall clock only advances
  the sim clock (speed model: s× = s sim-minutes per wall-minute).
- Determinism pinned by tests: byte-exact replay per seed (verify-flowpath),
  exact volume partition — prints sum to candle/window volume exactly
  (186/186 windows in the 2026-10-15 probe), no lookahead (flow is a function
  of revealed state only), chunking-invariant state derivation (`18d9a8b`).
- Pause freezes the sim clock and every derived surface identically
  (browser-QA'd repeatedly at 8x); reset re-seeds a clean run; no stale
  callback defects found in this audit.
- HOD state: `lib/drills/hodState.ts` machine + DrillSim's layered derivation,
  unified in `18d9a8b` — header label and order flow consume the SAME
  `sim.marketState`. Pinned failed-003 timeline: Testing → Rejected at the
  confirming close → Breaking → Accepting → Rejected, zero early flips.

## 2. Answer leakage — VERIFIED SEALED (presented surfaces)

Blind redesign (`65d915c`) + pool (`ef7ef52`) closed every presented-surface
leak found by the 2026-10-14 leak audit: neutral "HOD Drill #NNN" labels
(non-sequential, difficulty-uncorrelated), opaque `d-…`/`f-…` slugs (legacy
leaky ids no longer resolve), no titles/descriptions/difficulty anywhere
pre-decision, sealed `DecisionLedger` (`lib/drills/decision.ts`), cycle state
in localStorage stores opaque slugs only (`ggl-drill-pool-v1`). Leak scan is
part of verify-pool; blind suite = 400 checks. Disclosed standing limitation:
scenario definitions ship inside the client JS bundle (the sim is client-side)
— bundle-diving is out of scope; every *presented* surface is sealed.

## 3. Market realism — STRONG, with three documented residuals

F1–F10 (`480a3a4`/`486ad7e`/`c42d43a`) + residual pass (`b34193f`) delivered:
class-neutral approach baseline; event-triggered (not index-scheduled) flow
phases; prints priced at prevailing bid/ask by side (100%); volume-scaled
print counts with exact partition; volatility spread 2–6¢; per-scenario
personality scalars (seed-derived); Failed wall price-pinned at HOD+2¢ with
slow decay (presence 8%→79%); Weak resolution sell-lean; Clean breakout book
ratio damped (~2.2–2.6, no memorizable constant).

Documented residuals (deliberate, NOT defects to force-fix):
- R1: Checkpoint *aggregate* stats still identify Clean on scenario means
  (structural with 3 scenarios/class). Per-window overlap is 95%.
  Forcing the aggregates flat would break protected readability floors.
- R2: weak-003's resolution tape is balanced (~0.52) rather than net-sell.
- R3: Approach tape retains a mild Clean lean (0.552; failed-001 sits inside
  Clean's range, so no threshold shortcut exists).
No single observable metric deterministically separates any class
(best single rule: 11/12). Iceberg/spoof-style patterns are NOT simulated;
the book models absorption/replenishment via the F6/F7 mechanics. Adding
labeled spoof/iceberg patterns is a design change, not a fix (see plan).

## 4. Trader evaluation — THE GAP THIS UPGRADE CLOSES (spec §5)

Today (`lib/drills/scoring.ts`, 172 lines): classification verdict +
action verdict → one overall 0–100; review shows one per-class rationale
paragraph + one "what you missed" entry + scenario teaching lessons.
Missing, though the data already exists in the ledger/sim:
- Confirmation-vs-anticipation grading (was an Enter made before or after
  the confirming close? The checkpoint snapshot + scenario structure know).
- Confidence calibration (5/5-and-wrong vs 2/5-and-right are never named).
- Evidence-cited feedback (which checkpoint-time observables supported or
  contradicted the decision — state at lock is derived but not reported).
- Trap-error naming beyond the action verdict (failed + Enter).
Cross-cycle per-class tallies exist on the cycle-complete screen; per-drill
dimension feedback does not.

## 5. Difficulty progression — NOT BUILT (spec §6)

The 12-scenario pool serves a seeded no-repeat cycle; there is no explicit
progression (recognition → confirmation → traps → order-flow → conflicting
signals). Focused Learning groups by category only. A progression layer is a
new feature that changes how drills are served; it should ride on the §5
evaluation data (per-dimension results) rather than scenario re-design, and
is proposed as Stage C for explicit approval — it must not disturb the
pool's blind guarantees (frozen eligibility, boundary-join rules).

## 6. Features that MUST be preserved

Replay Lab (/replay) — untouched by this branch's drills work except the
shared LwcChart `fitOnLoad` prop (drills-only usage). Hotkeys, chart
interactions, Pause/Resume/Reset, speed model, blind + focused modes,
cycle persistence + archives, scoring math and its pinned semantics
(honest "Ambiguous" on non-ambiguous = partial 0.5, etc.).

## 7. Prioritized plan

- **P0 (this upgrade): §5 decision-evaluation layer** — additive only:
  new `lib/drills/evaluation.ts`, one teaching-screen section, new
  verify-eval suite. Zero changes to sim/flow/scoring math.
- **P1 (held for explicit approval): §6 progression layer** on cycle +
  evaluation data. No scenario changes.
- **P2 (held for explicit approval): labeled iceberg/spoof-style book
  patterns** — changes flow balance tuned in F1–F10; needs its own
  measurement pass like the flow audit.
- No P0 defects are open: baseline is 1,642/1,642 green and every §1–§4
  requirement in the upgrade spec is already implemented and QA'd except
  the §5 depth and §6 progression above.

## QA notes for this upgrade

Browser harness cannot emulate a mobile viewport (standing limitation —
mobile layout is verified by the owner's device pass, not claimed here).
All other §7 test areas already have suites; Stage B adds verify-eval.
