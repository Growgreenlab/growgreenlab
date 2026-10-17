# Breakout Drill — Non-Repeating Pool & Cycle Queue (2026-10-14)

Branch: `breakout-drills` (on top of `5aa91a7`). Scope: a 12-scenario
library (3 per classification) and a non-repeating, persistent cycle
queue for Blind Practice. The simulation (DrillSim/SimClock), the
checkpoint/DecisionLedger sealing, the scoring rules
(`lib/drills/scoring.ts`), and the reveal boundary are unchanged from
65d915c/5aa91a7. `/replay` untouched. No server persistence, no
accounts — all state is client-side.

## 1. Scenario library

12 scenarios in `lib/drills/scenarios.ts`: the original four
(hod-clean/weak/failed/ambiguous-001, seeds 21001–21004) plus two new
ones per classification (seeds 21005–21012; hod-failed-002 was tuned
to seed 21014 to land its blow-off fingerprint inside the failed
bands), each with a distinct
structure — e.g. clean: long-coil/retest-and-go vs fast vertical;
failed: no-coil vertical blow-off vs grind with fake acceptance before
the collapse; ambiguous: strong-break/no-extension vs soft poke that
refuses to fail. Distinctness is authored in the candle/volume
regimes (Level 2 / Time & Sales derive from the same ticks via the
existing orderflow). `verify-pool.ts` asserts each scenario's MEASURED
fingerprint (breakout volume multiple, close position, spike, post-
breakout behavior) matches its own classification, plus a
design-specific assertion per new scenario and pairwise
within-class distinctness.

Neutral numbering now spans all 12 (`lib/drills/catalog.ts`,
CATALOG_VERSION 2): numbers stay non-sequential and
difficulty-uncorrelated across the full set. Focused slugs: `f-clean`
etc. still resolve per category; `f-NNN` (e.g. `f-047`) resolves one
specific scenario in focused mode.

## 2. State model (lib/drills/cycle.ts)

One versioned localStorage record (`ggl-drill-pool-v1`, schema v1):

```
PoolState { version, active: DrillCycle, archives: DrillCycle[] }
DrillCycle {
  cycleId, catalogVersion,
  eligible: string[],            // opaque slugs, frozen at creation
  queue: string[],               // seeded shuffle — permutation of eligible
  started:   { slug -> startedAt },
  submitted: { slug -> SubmittedAttempt },
  createdAt, completedAt
}
SubmittedAttempt {               // written once, at seal time
  slug, actualClassification,    // revealed results data
  classification, action, confidence,       // the locked decision
  readVerdict, actionVerdict, readScore, actionScore, overall,
  lockLabel, scenarioSeed, submittedAt
}
```

Only opaque slugs (`d-NNN`) are ever persisted as keys — never
internal scenario ids, never a classification for an unsubmitted
drill. A submitted attempt carries its revealed classification
because it is results data (shown on the cycle-complete screen).
Display labels are derivable from the slug alone.

## 3. Submission semantics

- **Submitted = a decision SEALED in the DecisionLedger** for that
  scenario in that cycle. That seal is the single consumption event.
- Opening a drill, or starting it and leaving before sealing,
  consumes nothing (`started` is bookkeeping for resume order only).
- Serving: a started-but-unsubmitted drill is re-offered first
  (most recently started), then the next unsubmitted queue entry.
  A submitted drill is never served again in the cycle.
- **Idempotency:** submission is one transition keyed by
  (cycleId, slug). `submitAttempt` refuses a slug that is ineligible
  or already submitted and returns the state unchanged — the sealed
  record can never be duplicated or overwritten by double-clicks,
  retries, remounts, replaying a submitted drill, or a second tab
  acting on a stale snapshot.
- **Write path:** every mutation goes through `updatePool()`, which
  re-reads the stored record immediately before applying its
  transition and writes back in the same synchronous turn, so a tab
  never clobbers another tab's committed writes with a stale copy.
- **Concurrency limits (honest):** localStorage has no
  compare-and-swap. Within a tab, transitions are atomic (synchronous
  read-modify-write). Across tabs, the re-read-before-write narrows
  the race to a single synchronous window; two tabs submitting in
  that exact window could still interleave, and the idempotency guard
  absorbs duplicate submits of the same slug. No stronger guarantee
  is claimed — there is no server.
- **Corruption:** load validates and repairs conservatively —
  the queue is rebuilt into a true permutation of the frozen
  eligibility set, dangling started entries are dropped, and
  individually valid submitted records are preserved verbatim.
  Unparseable or wrong-version records fall back to a fresh pool.

## 4. Cycle completion & rollover

When every eligible drill is submitted, the drills home shows the
cycle-complete state: per-drill results (revealed classification vs
the user's locked read/action/confidence, read + decision verdicts,
score), aggregates (average score, read %, decision %), and an
explicit **Start New Cycle** action. Starting a new cycle archives
the finished cycle **verbatim** (sealed decisions are never deleted
or rewritten) and creates a fresh shuffled queue under a new cycle
id. Previous cycles' aggregates remain listed on the drills home.

## 5. New-scenario entry rule

A cycle's eligibility set is frozen at creation under the
CATALOG_VERSION then current. Scenarios added to the catalog later
do **not** join the active cycle (so nothing repeats and no submitted
attempt is invalidated); they enter at the next cycle boundary,
when `createCycle` snapshots the then-current catalog. Stored cycles
from an older, smaller catalog keep their frozen eligibility through
load/repair — verified in `verify-pool.ts` §7 with a simulated
10-drill legacy cycle under the 12-drill catalog.

## 6. Mode scope

- **Blind Practice** is governed by the cycle queue (picker serve /
  resume, runner mark-started + submit-on-seal, queue-driven Next).
  The old random-draw serving (`pickBlindScenario`) is no longer used
  by the UI; it remains in the catalog as a tested utility, as does
  `drawNextBlindSlug`.
- **Focused Learning** is deliberate practice and is NOT restricted
  by the queue: its picker lists each category's three drills by
  neutral number (`f-NNN` slugs), repeats are allowed, and focused
  runs never read or write cycle state.

## 7. Reproducibility

Blind runs are queue-served, so the review's reproducibility line now
rests on the scenario seed (unchanged: same seed + definition =
identical ticks, candles, book, and prints) and the persisted cycle
record. The old per-draw seed display was removed from the runner —
there is no draw anymore, and showing a stale seed would misstate
how the run was chosen.

## 8. Verification

`lib/drills/verify-pool.ts` covers: pool integrity (12 scenarios,
3/class, unique ids/seeds/slugs/numbers), per-scenario fingerprint vs
classification + pairwise distinctness, queue permutation +
determinism, submission rules (start-consumes-nothing, seal-consumes-
once, duplicate/stale-tab absorption), persistence round-trips
(refresh/reopen byte-for-byte, serving position, corruption repair),
a full 12-drill playthrough to completion with results aggregates,
Start New Cycle archive preservation, the frozen-eligibility rule,
and a leak scan over the persisted JSON. All pre-existing suites
(verify, verify-flow, verify-fixes, verify-e2e, verify-sim,
verify-blind) still run; two needed honest adjustments for the
12-scenario pool, disclosed in the delivery report:

- verify-sim's cross-scenario fingerprint ORDERING block keys on
  the original four scenarios by id (previously it keyed by
  classification, which at 12 scenarios would silently test only
  the last of each class). Per-scenario checks for all 12 live in
  verify-pool.
- verify-flow now imports the sim's BEHAVIOR_FOR map instead of a
  duplicated 4-entry local copy (which would have gone stale).
