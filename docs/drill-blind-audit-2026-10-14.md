# Breakout Drill — Blind Redesign Audit & Implementation (2026-10-14)

Branch: `breakout-drills` (on top of `74aba17`, the sim rebuild).
Scope: spoiler removal, practice modes, decision checkpoint, reveal,
scoring. The simulation engine (DrillSim/SimClock), candle/L2/T&S sync,
and HOD system from `74aba17` are unchanged. `/replay` byte-untouched.
No Phase 5, no new persistence.

Baseline before changes (verified): verify 33 + verify-flow 46 +
verify-fixes 38 + verify-e2e 52 + verify-sim 143 = **312/312 green**,
`tsc --noEmit` clean, `next build` passes.

## 1. Leak audit — every spoiler path found (pre-fix)

Selection screen (`app/drills/page.tsx`, fully server-rendered):
- **L1 — Card title** = the classification, verbatim ("Clean HOD
  Breakout", "Weak HOD Breakout", "Ambiguous HOD Action").
- **L2 — Difficulty badge + color**: Beginner green / Intermediate
  amber / Advanced red. Difficulty correlates with category; Ambiguous
  is uniquely "Advanced" (a 1:1 tell), Clean/Weak share "Beginner".
- **L3 — Card description** narrates the outcome ("…then breaks out",
  "conviction is missing", "violently reverses. Watch the wick").
- **L4 — URL** `/drills/hod-clean-001` etc.: the route param itself is
  the answer; shareable/bookmarkable, visible in history.
- **L5 — "(Trap)"** in the failed title: a second spoiler channel.
- L6 (minor) — exact candle count per card (scenario fingerprint).

Runner (`app/drills/[id]/page.tsx`):
- **R1 — Difficulty label in the header at ALL phases**, incl. mid-run.
- **R2 — Intro renders `scenario.description` verbatim** (same text as L3).
- **R3 — Checkpoint had no "ambiguous" option**: options were
  clean/weak/failed/not_sure, so the answer space itself differed from
  the classification space.
- **R4 — "Next Drill" href** embedded the next scenario's leaky id and
  cycled in fixed library order (clean → weak → failed → ambiguous).
- R5 — Page `<title>`: no per-route metadata; root layout title is
  generic ("Grow Green Lab") and leaks nothing. OK as-is.
- R6 — The runner header already used a neutral title mid-run (from the
  `74aba17` rebuild, RC8); the teaching-phase title swap is a reveal,
  which is correct behavior.

Scoring/lifecycle (pre-fix):
- `gradeAnswer` (types.ts): exact match correct; `not_sure` → partial,
  never wrong; ANY committed answer on an ambiguous scenario → partial.
  No action/decision dimension existed at all.
- The checkpoint answer was a single click with a `useRef` guard —
  effectively locked, but not a recorded decision object: no sim
  timestamp, no action, no seal concept.
- "Reset" in the header restarted the sim at any point in
  running/resolving (deliberate). Reset during `resolving` let a user
  skip ever being graded — retained behavior, now harmless: Reset
  archives the locked decision instead of erasing it.
- `DrillAttempt` was (and remains) an unused type: no attempt history
  is persisted anywhere (in-session only). Unchanged by this redesign.
- Minor quirk found: moving the confidence slider after an untouched
  interaction displayed "3/5" while recording nothing (display default
  ≠ state). Fixed incidentally: the checkpoint now selects-then-locks.

Threat-model note (honest limitation): scenario definitions ship in
the client bundle (they must — the sim runs client-side, same as
/replay). A user determined to inspect the JS bundle or React props
can find the classification, as before this change. This redesign
removes every *presented* leak — picker, URLs, headers, intros,
payloads consumed by the UI — which is the exercise-integrity surface.
Server-side scenario delivery would be a different architecture and
is out of scope.

## 2. Implementation

New modules:
- **`lib/drills/catalog.ts`** — the only surface selection screens
  consume. `BLIND_CATALOG` exposes exactly `{slug, label, number,
  candleCount}` per drill. Numbers (weak 23, ambiguous 31, clean 47,
  failed 58) are non-sequential and difficulty-uncorrelated: by
  ascending number, difficulties run beginner → advanced → beginner →
  intermediate (asserted non-monotonic by test). Routes are opaque
  slugs: `d-047` (blind), `f-<category>` (focused), resolved by
  `resolveDrillSlug`. `pickBlindScenario(seed)` draws uniformly via
  mulberry32; same seed → same drill (reproducible; the seed is
  stored in sessionStorage by the picker and shown ONLY at review,
  alongside the drill number and scenario seed).
- **`lib/drills/decision.ts`** — `DecisionLedger`: `record()` succeeds
  exactly once per attempt and freezes the decision (classification,
  action, confidence, `simTimeMs`, `candleIndex`, `recordedAt`);
  `seal()` at reveal makes recording impossible; `startNewAttempt()`
  (Reset/Replay) archives the locked decision untouched and clears
  the lock — a new attempt never resurrects or edits a completed one.
- **`lib/drills/scoring.ts`** — all scoring rules in one place
  (verbatim summary in §3), plus `buildReviewModel`, the only surface
  that pairs a locked decision with the classification.
- **`lib/drills/types.ts`** — added `DecisionClassification`
  ("ambiguous" is both the no-trade read and the uncertainty answer)
  and `IntendedAction`. `gradeAnswer`/`DrillAnswer` untouched.

Pages:
- **`app/drills/page.tsx`** — Blind Practice is the default screen:
  explainer, "Start a Random Blind Drill" (seeded draw), and neutral
  "HOD Drill #NNN" cards (label + candle count, no description or
  difficulty). Focused Learning is a separate, visually distinct
  section linking to its own route.
- **`app/drills/focused/page.tsx`** (new) — names the four categories
  on purpose, each linking to its `f-…` slug.
- **`app/drills/[id]/page.tsx`** — resolves opaque slugs; header shows
  the neutral label + mode chip at every phase until teaching (title
  swaps to the scenario title only at reveal); difficulty removed
  everywhere; intro is generic blind/focused text (no scenario
  description); the checkpoint is now select-then-lock: classification
  (Clean / Weak / Failed–Trap / Ambiguous–No Trade) + intended action
  (Enter / Wait / Skip) + optional confidence, then "Lock In Decision"
  records into the ledger with the sim timestamp. The teaching screen
  shows the locked decision, the actual classification, separate
  read/decision verdicts + overall score, checkpoint-time action
  rationale, evidence, missed-point teaching, lessons, and the
  reproducibility line. "Next" is mode-aware: blind → fresh seeded
  random draw; focused → back to the category picker. Reset/Replay go
  through `ledger.startNewAttempt()`.

## 3. Scoring rules (verbatim summary; code: lib/drills/scoring.ts)

Recognition and decision are scored separately; overall = average ×100.
Classification: exact match = correct (1.0) — including "Ambiguous /
No Trade" on a genuinely ambiguous scenario, where it IS the correct
read. "Ambiguous / No Trade" (uncertainty) on any other scenario =
partial (0.5) — the historical contract: an honest not-sure is never a
confident wrong answer. A committed directional read on an ambiguous
scenario = partial (0.5). Anything else = incorrect (0).
Action: clean → Enter appropriate (1.0), Wait acceptable (0.5), Skip
inappropriate (0). weak → Wait appropriate, Skip acceptable, Enter
inappropriate. failed → Skip appropriate, Wait acceptable, Enter
inappropriate (buying the rejection top is the trap error). ambiguous
→ Wait and Skip both appropriate, Enter inappropriate. Decisions are
judged on information available at the checkpoint, never on outcome.

Relationship to legacy `gradeAnswer`: identical verdicts for committed
answers on non-ambiguous scenarios (asserted by test). The scored
"ambiguous" answer formalizes the old `not_sure`, with one deliberate
upgrade: on a genuinely ambiguous scenario it is now *correct* rather
than partial — the old UI couldn't express it because the checkpoint
offered no "ambiguous" option.

## 4. Tests

New suite `lib/drills/verify-blind.ts` — **171/171 passed**:
- Leak: catalog JSON contains no title/description/id/classification/
  difficulty strings; public entries expose only the four safe fields;
  slugs match `d-NNN`; numbers unique, non-sequential, and do not sort
  by difficulty; resolved runner labels hide classification in both modes.
- Resolution: all blind + focused slugs resolve correctly; the legacy
  leaky id `hod-clean-001` and unknown slugs no longer resolve.
- Randomization: 4,000 seeds — all four types reached, each within
  850–1,150 draws (≈uniform); same-seed reproducibility; slug helper
  agrees with the picker.
- Ledger: first record locks; second record rejected with the original
  byte-identical; decisions frozen (mutation attempts no-op); record
  after seal rejected; new attempt archives the original untouched and
  permits a fresh record; decision-free attempts archive nothing.
- Scoring: the full 4×4 classification and 4×3 action matrices against
  the documented tables; overall-score spot checks (100 / 50 / 0);
  agreement with legacy `gradeAnswer` where the contracts overlap.
- Integration: a real `DrillSim` run to its checkpoint records a
  decision whose `candleIndex` equals the scenario checkpoint index and
  whose `simTimeMs` equals the sim clock exactly; `buildReviewModel`
  reveals classification + scores only from a locked decision.

Regression: verify 33/33, verify-flow 46/46, verify-fixes 38/38,
verify-e2e 52/52, verify-sim 143/143 — **312/312 pre-existing checks
stay green; 483 total**. `tsc --noEmit` clean; `next build` passes
(routes: `/drills` static, `/drills/focused` static, `/drills/[id]`
dynamic, 8.51 kB).

Not verified here (needs the parent's browser QA): DOM-level rendering
of the picker/runner (that no classification string appears in the
rendered DOM pre-reveal), mobile layout in a real viewport, and the
click-through flow (checkpoint select → lock → resolving → teaching,
reset-during-resolving, Next Blind Drill navigation).

## 5. Post-QA fixes (browser QA round 1 on `65d915c`)

- **Next Blind Drill looked dead.** Root cause: the button pushed the
  URL of a fresh random draw; whenever the draw repeated the drill
  already on screen (1-in-4 per click), the push targeted the identical
  URL — a router no-op: no param change, no remount, and the `[id]`
  reset effect never fired, so the review stayed up. Fix:
  `drawNextBlindSlug` (catalog.ts) redraws until the slug differs,
  with a bounded catalog fallback; the URL now always changes, so the
  runner always remounts into a fresh intro. (Focused mode's "Next" is
  a plain Link to `/drills/focused` — a different route, unaffected.)
- **Lock time could read two ways.** The page stamped the decision
  from the LIVE sim clock at click time. The scheduler advances in
  frames of up to 48 ticks and only notices the checkpoint afterwards,
  so the live clock can sit up to ~23.5 sim-seconds past the checkpoint
  candle's close — a frame-dependent value, distinct from the candle
  boundary the review also reported. Fix: DrillSim captures a
  checkpoint snapshot (simTimeMs + candleIndex) at the exact tick the
  checkpoint candle finalizes; `buildDecision` stamps that; both
  review surfaces render one canonical string, `decisionLockLabel`
  ("10:00 · candle 15"), derived only from the ledger record.
- **Default confidence vanished.** An untouched slider recorded no
  confidence (state was null → `undefined`), and the review rendered
  the confidence chip only when a value existed. Fix: confidence state
  starts at `DEFAULT_CONFIDENCE` (3); `buildDecision` always stamps
  the effective value; the review always shows it via
  `effectiveConfidence`.
- **Draw clustering — investigated, mechanism sound (no change).** QA
  saw only d-031/d-047 in 6 picker presses. Empirical check over the
  ACTUAL seed path (uniform 31-bit seeds, as `randomRunSeed` produces;
  200k trials, plus 20k via an independent splitmix32 stream):
  first-draw quartiles ≈ 25% each (e.g. 5034/4878/5013/5075 per 5000
  expected) — no bias. The observed sample also fits chance: the
  probability that 6 uniform draws land within SOME single pair of
  scenarios is ≈9.2%, and dead Next clicks (defect 1) repeat the
  current drill in any press log. A deterministic realistic-seed
  distribution test now pins this in verify-blind §8.
