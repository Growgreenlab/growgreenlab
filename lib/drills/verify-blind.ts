/**
 * Blind Drills verification (2026-10-14 redesign):
 *  - Leak surface: the public blind catalog + resolved runner labels
 *    contain NO classification, title, description, difficulty, or
 *    internal id; slugs are opaque; drill numbers don't encode
 *    difficulty order.
 *  - Randomization: seeded blind pick is reproducible and uniform
 *    across all four scenario types.
 *  - Focused mode: category slugs resolve to the right scenario and
 *    stay flow-separated from blind slugs.
 *  - Decision ledger: one locked record per attempt, immutable,
 *    sealed at reveal, archived (never mutated) across new attempts.
 *  - Scoring: full 4x4 classification matrix + 4x3 action matrix
 *    against the documented rules in lib/drills/scoring.ts, plus the
 *    relationship to the legacy gradeAnswer contract.
 *  - Reveal timing: buildReviewModel is the only surface carrying the
 *    classification, and it is built from a locked decision.
 */
import { HOD_SCENARIOS, getScenario } from "./scenarios";
import {
  BLIND_CATALOG, FOCUSED_CATALOG, resolveDrillSlug,
  pickBlindScenario, blindSlugForSeed, drawNextBlindSlug,
} from "./catalog";
import {
  DecisionLedger, buildDecision, effectiveConfidence, decisionLockLabel,
  formatSimTimeMs, DEFAULT_CONFIDENCE, type DrillDecision,
} from "./decision";
import {
  scoreClassification, scoreAction, scoreDecision, buildReviewModel, missedKeyFor,
} from "./scoring";
import { gradeAnswer, type DecisionClassification, type IntendedAction } from "./types";
import { DrillSim, historyCountFor } from "./sim";
import { DRILL_TICKS_PER_CANDLE } from "./orderflow";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${name}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const CLASSES: DecisionClassification[] = ["clean", "weak", "failed", "ambiguous"];
const ACTIONS: IntendedAction[] = ["enter", "wait", "skip"];
const byClass = Object.fromEntries(HOD_SCENARIOS.map((s) => [s.classification, s]));

// ── 1. Blind leak surface ────────────────────────────────────────────
{
  const blob = JSON.stringify(BLIND_CATALOG).toLowerCase();
  for (const s of HOD_SCENARIOS) {
    check(`catalog hides title of ${s.id}`, !blob.includes(s.title.toLowerCase()));
    check(`catalog hides description of ${s.id}`, !blob.includes(s.description.toLowerCase().slice(0, 24)));
    check(`catalog hides id ${s.id}`, !blob.includes(s.id));
    check(`catalog hides classification ${s.classification}`, !blob.includes(`"${s.classification}"`));
    check(`catalog hides difficulty ${s.difficulty}`, !blob.includes(s.difficulty));
  }
  for (const word of ["beginner", "intermediate", "advanced", "trap", "weak", "clean", "failed", "ambiguous"]) {
    check(`catalog contains no "${word}"`, !blob.includes(word));
  }
  check("catalog has one entry per scenario", BLIND_CATALOG.length === HOD_SCENARIOS.length);
  for (const d of BLIND_CATALOG) {
    check(`slug ${d.slug} is opaque d-NNN`, /^d-\d{3}$/.test(d.slug));
    check(`label ${d.label} is neutral`, /^HOD Drill #\d{3}$/.test(d.label));
    check(`public entry ${d.slug} exposes only safe fields`,
      eq(Object.keys(d).sort(), ["candleCount", "label", "number", "slug"]));
  }
  const numbers = BLIND_CATALOG.map((d) => d.number);
  check("drill numbers are unique", new Set(numbers).size === numbers.length);
  check("drill numbers are non-sequential", !eq([...numbers].sort((a, b) => a - b), [1, 2, 3, 4]));

  // Numbers must not encode difficulty order: difficulties by ascending
  // drill number are neither non-decreasing nor non-increasing.
  const rank = { beginner: 0, intermediate: 1, advanced: 2 } as const;
  const diffSeq = BLIND_CATALOG.map((d) => {
    const r = resolveDrillSlug(d.slug)!;
    return rank[r.scenario.difficulty];
  });
  const nonDec = diffSeq.every((v, i) => i === 0 || v >= diffSeq[i - 1]);
  const nonInc = diffSeq.every((v, i) => i === 0 || v <= diffSeq[i - 1]);
  check("drill numbers do not sort by difficulty", !nonDec && !nonInc);
}

// ── 2. Slug resolution (blind + focused) ─────────────────────────────
{
  for (const d of BLIND_CATALOG) {
    const r = resolveDrillSlug(d.slug);
    check(`blind slug ${d.slug} resolves`, !!r);
    check(`blind slug ${d.slug} mode is blind`, r?.mode === "blind");
    check(`blind slug ${d.slug} label matches catalog`, r?.label === d.label);
    check(`blind slug ${d.slug} label hides classification`,
      !r!.label.toLowerCase().includes(r!.scenario.classification));
  }
  for (const f of FOCUSED_CATALOG) {
    const r = resolveDrillSlug(f.slug);
    check(`focused slug ${f.slug} resolves`, !!r);
    check(`focused slug ${f.slug} mode is focused`, r?.mode === "focused");
    check(`focused slug ${f.slug} hits category ${f.category}`,
      r?.scenario.classification === f.category);
    check(`focused slug ${f.slug} runner label is still neutral`,
      /^HOD Drill #\d{3}$/.test(r!.label));
  }
  check("focused catalog covers all four categories",
    eq(FOCUSED_CATALOG.map((f) => f.category).sort(), [...CLASSES].sort()));
  check("legacy leaky id no longer resolves", resolveDrillSlug("hod-clean-001") === undefined);
  check("unknown slug does not resolve", resolveDrillSlug("d-999") === undefined);
  check("garbage slug does not resolve", resolveDrillSlug("x-clean") === undefined);
}

// ── 3. Seeded blind randomization ────────────────────────────────────
{
  for (const seed of [0, 1, 42, 123456789, 2 ** 31 - 1]) {
    check(`pick is reproducible for seed ${seed}`,
      pickBlindScenario(seed).scenario.id === pickBlindScenario(seed).scenario.id);
    check(`slug helper agrees for seed ${seed}`,
      resolveDrillSlug(blindSlugForSeed(seed))?.scenario.id === pickBlindScenario(seed).scenario.id);
  }
  const counts: Record<string, number> = {};
  const N = 4000;
  for (let seed = 0; seed < N; seed++) {
    const c = pickBlindScenario(seed).scenario.classification;
    counts[c] = (counts[c] ?? 0) + 1;
  }
  for (const c of CLASSES) {
    check(`blind pick reaches ${c}`, (counts[c] ?? 0) > 0);
    check(`blind pick ~uniform for ${c} (${counts[c]}/${N})`,
      counts[c] >= 850 && counts[c] <= 1150);
  }
}

// ── 4. Decision ledger: locking, sealing, archiving ──────────────────
{
  const mk = (cls: DecisionClassification, act: IntendedAction, t = 1000): DrillDecision => ({
    classification: cls, action: act, confidence: 4, simTimeMs: t, candleIndex: 15, recordedAt: 1700000000000 + t,
  });
  const ledger = new DecisionLedger();
  check("ledger starts empty", ledger.current === null && ledger.archive.length === 0);
  check("first record succeeds", ledger.record(mk("clean", "enter")) === true);
  const lockedSnapshot = JSON.stringify(ledger.current);
  check("second record is rejected", ledger.record(mk("failed", "skip", 2000)) === false);
  check("locked decision unchanged after rejected record",
    JSON.stringify(ledger.current) === lockedSnapshot);
  check("locked decision is frozen", ledger.current !== null && Object.isFrozen(ledger.current));
  let mutationHeld = false;
  try {
    (ledger.current as DrillDecision).action = "skip";
  } catch { /* strict-mode TypeError on frozen write — expected */ }
  mutationHeld = ledger.current?.action === "enter";
  check("frozen decision cannot be mutated", mutationHeld);

  ledger.seal();
  check("ledger reports sealed", ledger.isSealed);
  check("record after seal is rejected", ledger.record(mk("weak", "wait", 3000)) === false);
  check("sealed decision unchanged", JSON.stringify(ledger.current) === lockedSnapshot);

  // Pause/resume have no ledger interaction (scheduler-level); a reset
  // starts a NEW attempt: the completed record is archived untouched.
  ledger.startNewAttempt();
  check("new attempt clears the lock", ledger.current === null);
  check("new attempt clears the seal", !ledger.isSealed);
  check("completed decision archived", ledger.archive.length === 1);
  check("archived decision is the original, unchanged",
    JSON.stringify(ledger.archive[0]) === lockedSnapshot);
  check("archived decision stays frozen", Object.isFrozen(ledger.archive[0]));
  check("new attempt can record", ledger.record(mk("failed", "skip", 4000)) === true);
  check("new record does not touch the archive",
    ledger.archive.length === 1 && JSON.stringify(ledger.archive[0]) === lockedSnapshot);
  ledger.startNewAttempt();
  check("second completion archives too", ledger.archive.length === 2);
  check("attempt with no decision archives nothing", (() => {
    const l2 = new DecisionLedger();
    l2.startNewAttempt();
    return l2.archive.length === 0;
  })());
}

// ── 5. Scoring matrix (documented rules, scoring.ts) ─────────────────
{
  const CLS_EXPECTED: Record<string, Record<string, [string, number]>> = {
    clean:     { clean: ["correct", 1], weak: ["incorrect", 0], failed: ["incorrect", 0], ambiguous: ["partial", 0.5] },
    weak:      { clean: ["incorrect", 0], weak: ["correct", 1], failed: ["incorrect", 0], ambiguous: ["partial", 0.5] },
    failed:    { clean: ["incorrect", 0], weak: ["incorrect", 0], failed: ["correct", 1], ambiguous: ["partial", 0.5] },
    ambiguous: { clean: ["partial", 0.5], weak: ["partial", 0.5], failed: ["partial", 0.5], ambiguous: ["correct", 1] },
  };
  const ACT_EXPECTED: Record<string, Record<string, [string, number]>> = {
    clean:     { enter: ["appropriate", 1], wait: ["acceptable", 0.5], skip: ["inappropriate", 0] },
    weak:      { enter: ["inappropriate", 0], wait: ["appropriate", 1], skip: ["acceptable", 0.5] },
    failed:    { enter: ["inappropriate", 0], wait: ["acceptable", 0.5], skip: ["appropriate", 1] },
    ambiguous: { enter: ["inappropriate", 0], wait: ["appropriate", 1], skip: ["appropriate", 1] },
  };
  for (const cls of CLASSES) {
    const scenario = byClass[cls];
    for (const ans of CLASSES) {
      const got = scoreClassification(scenario, ans);
      const [verdict, score] = CLS_EXPECTED[cls][ans];
      check(`classification ${cls} scenario × ${ans} answer → ${verdict}/${score}`,
        got.verdict === verdict && got.score === score);
    }
    for (const act of ACTIONS) {
      const got = scoreAction(scenario, act);
      const [verdict, score] = ACT_EXPECTED[cls][act];
      check(`action ${cls} scenario × ${act} → ${verdict}/${score}`,
        got.verdict === verdict && got.score === score);
    }
  }
  const d = (cls: DecisionClassification, act: IntendedAction): DrillDecision => ({
    classification: cls, action: act, simTimeMs: 900_000, candleIndex: 15, recordedAt: 1,
  });
  check("overall: perfect clean run = 100", scoreDecision(byClass.clean, d("clean", "enter")).overall === 100);
  check("overall: right read, trap entry = 50", scoreDecision(byClass.failed, d("failed", "enter")).overall === 50);
  check("overall: uncertainty + wait on ambiguous = 100", scoreDecision(byClass.ambiguous, d("ambiguous", "wait")).overall === 100);
  check("overall: wrong read + wrong action = 0", scoreDecision(byClass.clean, d("failed", "skip")).overall === 0);

  // Relationship to the legacy gradeAnswer contract: for committed
  // answers on non-ambiguous scenarios the verdicts agree; the
  // "ambiguous" answer is the scored form of the old "not_sure"
  // (never a confident wrong answer) and is CORRECT on ambiguous.
  for (const cls of ["clean", "weak", "failed"] as const) {
    for (const ans of ["clean", "weak", "failed"] as const) {
      const legacy = gradeAnswer(byClass[cls], ans);
      const now = scoreClassification(byClass[cls], ans);
      check(`gradeAnswer agrees (${cls} × ${ans})`,
        (now.verdict === "correct") === legacy.correct &&
        (now.verdict === "incorrect") === (!legacy.correct && !legacy.partial));
    }
    check(`uncertainty never scores as wrong (${cls})`,
      scoreClassification(byClass[cls], "ambiguous").verdict === "partial");
  }
  check("ambiguous answer on ambiguous scenario is correct",
    scoreClassification(byClass.ambiguous, "ambiguous").verdict === "correct");
  check("missedKeyFor maps uncertainty to not_sure teaching",
    missedKeyFor(byClass.clean, "ambiguous") === "not_sure");
  check("missedKeyFor passes committed answers through",
    missedKeyFor(byClass.failed, "clean") === "clean");
}

// ── 6. Reveal surface + decision timestamp from a real sim ───────────
{
  const scenario = getScenario("hod-failed-001")!;
  const sim = new DrillSim(scenario);
  let guard = 0;
  while (!sim.checkpointReached && guard++ < 100_000) sim.advance(10);
  check("sim reaches its checkpoint", sim.checkpointReached);
  const ledger = new DecisionLedger();
  const ok = ledger.record({
    classification: "failed", action: "enter", confidence: 5,
    simTimeMs: sim.simTimeMs, candleIndex: sim.engine.index, recordedAt: Date.now(),
  });
  check("decision records at the checkpoint", ok);
  check("decision candle index is the checkpoint candle",
    ledger.current?.candleIndex === scenario.checkpointIndex);
  check("decision sim time matches the sim clock",
    ledger.current?.simTimeMs === sim.ticksElapsed * (60_000 / DRILL_TICKS_PER_CANDLE));
  const review = buildReviewModel(scenario, ledger.current!);
  check("review model reveals the classification", review.classification === "failed");
  check("review model scores the locked decision",
    review.scores.classification.verdict === "correct" && review.scores.action.verdict === "inappropriate");
  check("review model carries action rationale", review.actionRationale.length > 20);
  const amb = buildReviewModel(byClass.ambiguous, {
    classification: "ambiguous", action: "skip", simTimeMs: 1, candleIndex: 1, recordedAt: 1,
  });
  check("ambiguous correct read surfaces the 'correct' teaching text",
    (amb.missed ?? "").toLowerCase().includes("correct"));
}

// ── 7. QA regressions: checkpoint snapshot, lock label, confidence ──
{
  // The decision timestamp is the checkpoint candle's close, captured by
  // DrillSim at the exact finalization tick — NOT the live clock at
  // click time, which the frame scheduler can carry up to a frame past
  // the boundary. Awkward 7-tick chunks force that overshoot here.
  for (const s of HOD_SCENARIOS) {
    const sim = new DrillSim(s);
    check(`no snapshot before the checkpoint (${s.id})`, sim.checkpointSnapshot === null);
    let guard = 0;
    while (!sim.checkpointReached && guard++ < 100_000) sim.advance(7);
    const snap = sim.checkpointSnapshot;
    check(`snapshot captured at the checkpoint (${s.id})`, snap !== null);
    check(`snapshot candle is the checkpoint candle (${s.id})`,
      snap?.candleIndex === s.checkpointIndex);
    const liveCandles = s.checkpointIndex - historyCountFor(s) + 1;
    check(`snapshot time is the exact candle boundary (${s.id})`,
      snap?.simTimeMs === liveCandles * 60_000);
    const snapJson = JSON.stringify(snap);
    sim.advance(480); // live clock moves well past the checkpoint…
    check(`snapshot never moves after capture (${s.id})`,
      JSON.stringify(sim.checkpointSnapshot) === snapJson);
    const led = new DecisionLedger();
    led.record(buildDecision({ classification: "clean", action: "enter", confidence: null }, snap!));
    check(`locked decision keeps the snapshot values (${s.id})`,
      led.current?.simTimeMs === snap!.simTimeMs && led.current?.candleIndex === snap!.candleIndex);
  }

  // One canonical derivation renders the lock time everywhere.
  check("formatSimTimeMs renders mm:ss",
    formatSimTimeMs(0) === "00:00" && formatSimTimeMs(600_000) === "10:00" && formatSimTimeMs(645_000) === "10:45");
  const dEx: DrillDecision = {
    classification: "weak", action: "wait", confidence: 3,
    simTimeMs: 600_000, candleIndex: 14, recordedAt: 1,
  };
  check("decisionLockLabel renders time + candle from the record alone",
    decisionLockLabel(dEx) === "10:00 · candle 15");

  // Confidence: untouched slider → the default is IN the record, and the
  // review's effective value therefore always exists.
  check("slider default is 3/5", DEFAULT_CONFIDENCE === 3);
  check("buildDecision stamps the default when confidence is untouched",
    buildDecision({ classification: "clean", action: "enter", confidence: null }, { simTimeMs: 1, candleIndex: 1 }).confidence === DEFAULT_CONFIDENCE);
  check("buildDecision stamps the default when confidence is omitted",
    buildDecision({ classification: "clean", action: "enter" }, { simTimeMs: 1, candleIndex: 1 }).confidence === DEFAULT_CONFIDENCE);
  check("buildDecision preserves an explicit confidence",
    buildDecision({ classification: "clean", action: "enter", confidence: 5 }, { simTimeMs: 1, candleIndex: 1 }).confidence === 5);
  check("effectiveConfidence reads the stamped value",
    effectiveConfidence(buildDecision({ classification: "clean", action: "enter", confidence: 2 }, { simTimeMs: 1, candleIndex: 1 })) === 2);
  check("effectiveConfidence falls back to the default for legacy records",
    effectiveConfidence({ classification: "clean", action: "enter", simTimeMs: 1, candleIndex: 1, recordedAt: 1 }) === DEFAULT_CONFIDENCE);
}

// ── 8. QA regressions: next-drill draw + realistic seed space ────────
{
  // One seed per slug, found by scanning the picker's own mapping.
  const seedForSlug = new Map<string, number>();
  for (let seed = 0; seed < 10_000 && seedForSlug.size < BLIND_CATALOG.length; seed++) {
    const slug = blindSlugForSeed(seed);
    if (!seedForSlug.has(slug)) seedForSlug.set(slug, seed);
  }
  check("a seed exists for every blind slug", seedForSlug.size === BLIND_CATALOG.length);

  for (const d of BLIND_CATALOG) {
    const sameSeed = seedForSlug.get(d.slug)!;
    const other = BLIND_CATALOG.find((x) => x.slug !== d.slug)!;
    const otherSeed = seedForSlug.get(other.slug)!;
    // Adversarial source: repeats the CURRENT drill's draw, then yields.
    let calls = 0;
    const adversarial = () => (++calls <= 3 ? sameSeed : otherSeed);
    const got = drawNextBlindSlug(d.slug, adversarial);
    check(`next draw skips repeats of the current drill (${d.slug})`,
      got.slug === other.slug && got.seed === otherSeed);
    // Degenerate source: NEVER yields a different drill → bounded
    // fallback must still land on a different drill.
    const stuck = drawNextBlindSlug(d.slug, () => sameSeed);
    check(`next draw escapes a stuck seed source (${d.slug})`,
      stuck.slug !== d.slug && !!resolveDrillSlug(stuck.slug));
  }

  // Deterministic stream of realistic run seeds (uniform 31-bit values,
  // the distribution randomRunSeed produces) via splitmix32, so this
  // test is reproducible — no Math.random in tests.
  const realisticSeed = (() => {
    let a = 987654321 >>> 0;
    return () => {
      a = (a + 0x9e3779b9) | 0;
      let t = a ^ (a >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15;
      t = Math.imul(t, 0x735a2d97);
      t ^= t >>> 15;
      return Math.floor(((t >>> 0) / 4294967296) * 2 ** 31);
    };
  })();

  // Check 4 (browser QA): the pick over the REALISTIC seed space must
  // be uniform — the sequential-seed test in §3 alone would not catch a
  // bias that only appears for large 31-bit seeds.
  const counts: Record<string, number> = {};
  const N = 20_000;
  for (let i = 0; i < N; i++) {
    const c = pickBlindScenario(realisticSeed()).scenario.classification;
    counts[c] = (counts[c] ?? 0) + 1;
  }
  for (const c of CLASSES) {
    check(`realistic-seed pick ~uniform for ${c} (${counts[c]}/${N})`,
      counts[c] >= 4250 && counts[c] <= 5750);
  }
  // And the next-drill draw over realistic seeds never serves the
  // current drill, while reaching every other drill.
  for (const d of BLIND_CATALOG) {
    const served = new Set<string>();
    let neverCurrent = true;
    for (let i = 0; i < 600; i++) {
      const { slug } = drawNextBlindSlug(d.slug, realisticSeed);
      if (slug === d.slug) neverCurrent = false;
      served.add(slug);
    }
    check(`next draw never repeats current (${d.slug})`, neverCurrent);
    check(`next draw reaches all other drills from (${d.slug})`, served.size === BLIND_CATALOG.length - 1);
  }
}

console.log(`\n=== BLIND RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
