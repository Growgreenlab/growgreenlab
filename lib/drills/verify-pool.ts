/**
 * Non-repeating drill pool verification (2026-10-14):
 *  - Pool integrity: 12 scenarios, exactly 3 per classification,
 *    unique ids / seeds / slugs / neutral numbers.
 *  - Per-scenario fingerprints: each scenario's MEASURED breakout
 *    fingerprint matches its own classification (generalized from the
 *    4-scenario ordering checks in verify-sim, which now key on the
 *    original four by id), plus design-specific assertions per new
 *    scenario, plus within-class distinctness (no cosmetic duplicates).
 *  - Cycle queue: true permutation, seeded determinism, serve order
 *    (interrupted attempt first), submission = sealed decision only,
 *    idempotent submit (double-click / retry / stale-tab), persistence
 *    round-trips simulating refresh + reopen + re-ensure, corruption
 *    repair, full playthrough to cycle completion, Start New Cycle
 *    archiving byte-for-byte, and the new-scenario entry rule
 *    (eligibility frozen mid-cycle, joins at the boundary).
 *  - Leak scan: the persisted record and the eligible-slug surface
 *    carry no internal ids, titles, difficulties, or classifications
 *    of unsubmitted drills.
 */
import { HOD_SCENARIOS, getScenario } from "./scenarios";
import {
  BLIND_CATALOG, resolveDrillSlug, focusedSlugForScenario, scenariosForCategory,
} from "./catalog";
import {
  POOL_STORAGE_KEY, currentEligibleSlugs, createCycle, createPoolState,
  isCycleComplete, submittedCount, serveNextSlug, markStarted, submitAttempt,
  startNewCycle, cycleResults, labelForSlug, parsePool, serializePool,
  loadPool, ensurePool, updatePool,
  type PoolState, type SubmittedAttempt, type KeyValueStorage,
} from "./cycle";
import { scoreDecision } from "./scoring";
import { decisionLockLabel, effectiveConfidence, type DrillDecision } from "./decision";
import type { DecisionClassification, IntendedAction } from "./types";
import type { DrillScenario } from "./types";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${name}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const CLASSES: DecisionClassification[] = ["clean", "weak", "failed", "ambiguous"];
const APPROPRIATE: Record<string, IntendedAction> = {
  clean: "enter", weak: "wait", failed: "skip", ambiguous: "wait",
};

class MemoryStorage implements KeyValueStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

/** Build a valid submission exactly the way the runner page does. */
function attemptFor(
  slug: string,
  classification: DecisionClassification,
  action: IntendedAction,
  submittedAt: number,
  confidence = 4
): SubmittedAttempt {
  const scenario = resolveDrillSlug(slug)!.scenario;
  const d: DrillDecision = {
    classification, action, confidence,
    simTimeMs: 600_000, candleIndex: scenario.checkpointIndex,
    recordedAt: submittedAt - 1,
  };
  const scores = scoreDecision(scenario, d);
  return {
    slug,
    actualClassification: scenario.classification,
    classification,
    action,
    confidence: effectiveConfidence(d),
    readVerdict: scores.classification.verdict,
    actionVerdict: scores.action.verdict,
    readScore: scores.classification.score,
    actionScore: scores.action.score,
    overall: scores.overall,
    lockLabel: decisionLockLabel(d),
    scenarioSeed: scenario.seed,
    submittedAt,
  };
}

// =====================================================================
// 1. POOL INTEGRITY
// =====================================================================
console.log("\n=== Pool integrity ===");
{
  check("pool has exactly 12 scenarios", HOD_SCENARIOS.length === 12);
  for (const c of CLASSES) {
    check(`exactly 3 scenarios are ${c}`,
      HOD_SCENARIOS.filter((s) => s.classification === c).length === 3);
  }
  check("scenario ids unique", new Set(HOD_SCENARIOS.map((s) => s.id)).size === 12);
  check("scenario seeds unique", new Set(HOD_SCENARIOS.map((s) => s.seed)).size === 12);
  check("catalog has 12 entries", BLIND_CATALOG.length === 12);
  check("catalog slugs unique", new Set(BLIND_CATALOG.map((d) => d.slug)).size === 12);
  check("catalog numbers unique", new Set(BLIND_CATALOG.map((d) => d.number)).size === 12);
  for (const d of BLIND_CATALOG) {
    const r = resolveDrillSlug(d.slug);
    check(`${d.slug} resolves to a scenario with a pool seed`,
      r !== undefined && r.number === d.number && r.scenario.seed >= 21001);
  }
  check("the original four scenarios keep seeds 21001–21004",
    [21001, 21002, 21003, 21004].every((seed) =>
      HOD_SCENARIOS.some((s) => s.seed === seed)));
  for (const c of CLASSES) {
    const list = scenariosForCategory(c);
    check(`focused picker lists 3 ${c} drills by number`,
      list.length === 3 &&
      list.every((d, i) => i === 0 || d.number > list[i - 1].number));
    for (const d of list) {
      const r = resolveDrillSlug(focusedSlugForScenario(resolveDrillSlug(d.slug)!.scenario.id));
      check(`focused slug for ${d.slug} resolves focused + same scenario`,
        r?.mode === "focused" && r?.number === d.number);
    }
  }
}

// =====================================================================
// 2. PER-SCENARIO FINGERPRINTS vs CLASSIFICATION
// =====================================================================
console.log("\n=== Per-scenario fingerprints ===");
{
  const fp = (s: DrillScenario) => {
    const bi = s.checkpointIndex - 1;
    const bc = s.candles[bi];
    const pre = s.candles.slice(0, bi);
    const avgV = pre.reduce((a, c) => a + c.v, 0) / pre.length;
    const post = s.candles.slice(bi + 1);
    return {
      bi, bc,
      volMult: bc.v / avgV,
      closePos: (bc.c - bc.o) / Math.max(1e-9, bc.h - bc.o),
      spike: bc.h / s.hod - 1,
      final: s.candles[s.candles.length - 1].c,
      postMinLow: Math.min(...post.map((c) => c.l)),
      postMinClose: Math.min(...post.map((c) => c.c)),
      postMaxHigh: Math.max(...post.map((c) => c.h)),
    };
  };

  for (const s of HOD_SCENARIOS) {
    const f = fp(s);
    if (s.classification === "clean") {
      check(`${s.id}: clean volume expands ≥1.7x (${f.volMult.toFixed(2)})`, f.volMult >= 1.7);
      check(`${s.id}: clean close in top range ≥0.65 (${f.closePos.toFixed(2)})`, f.closePos >= 0.65);
      check(`${s.id}: clean ends above HOD`, f.final > s.hod);
    } else if (s.classification === "weak") {
      check(`${s.id}: weak volume flat <1.3x (${f.volMult.toFixed(2)})`, f.volMult < 1.3);
      check(`${s.id}: weak close position <0.6 (${f.closePos.toFixed(2)})`, f.closePos < 0.6);
      check(`${s.id}: weak fades below its breakout close`, f.final < f.bc.c);
    } else if (s.classification === "failed") {
      check(`${s.id}: failed climax volume ≥2.2x (${f.volMult.toFixed(2)})`, f.volMult >= 2.2);
      check(`${s.id}: failed rejection close ≤0.35 (${f.closePos.toFixed(2)})`, f.closePos <= 0.35);
      check(`${s.id}: failed spike ≥2% (${(f.spike * 100).toFixed(1)}%)`, f.spike >= 0.02);
      check(`${s.id}: failed trap completes — ends below HOD`, f.final < s.hod);
    } else if (s.classification === "ambiguous") {
      check(`${s.id}: ambiguous middling volume 0.9–1.6x (${f.volMult.toFixed(2)})`,
        f.volMult >= 0.9 && f.volMult <= 1.6);
      check(`${s.id}: ambiguous mid-range close 0.4–0.7 (${f.closePos.toFixed(2)})`,
        f.closePos >= 0.4 && f.closePos <= 0.7);
      check(`${s.id}: ambiguous never closes under HOD post-break`, f.postMinClose >= s.hod * 0.99);
      check(`${s.id}: ambiguous goes nowhere (|final vs HOD| ≤2%)`,
        Math.abs(f.final / s.hod - 1) <= 0.02);
    }
  }

  // Design-specific assertions for the 8 new scenarios.
  const F = (id: string) => fp(getScenario(id)!);
  const H = (id: string) => getScenario(id)!.hod;
  {
    const s = getScenario("hod-clean-002")!;
    const f = F(s.id);
    check("clean-002: retest holds — every post-breakout close ≥ HOD×0.998",
      s.candles.slice(f.bi + 1).every((c) => c.c >= s.hod * 0.998));
    check("clean-002: continuation carries ≥0.8% past HOD", f.final >= s.hod * 1.008);
    check("clean-002: late checkpoint (long coil)", s.checkpointIndex >= 16);
  }
  {
    const f = F("hod-clean-003");
    check("clean-003: never dips under HOD post-break (lows)", f.postMinLow >= H("hod-clean-003") * 0.998);
    check("clean-003: early checkpoint (fast vertical)",
      getScenario("hod-clean-003")!.checkpointIndex <= 12);
  }
  check("weak-002: slow bleed ends below HOD", F("hod-weak-002").final < H("hod-weak-002"));
  {
    const f = F("hod-weak-003");
    check("weak-003: choppy poke close mid-low (0.4–0.6)", f.closePos >= 0.4 && f.closePos < 0.6);
  }
  check("failed-002: blow-off spike ≥3.5%", F("hod-failed-002").spike >= 0.035);
  {
    const s = getScenario("hod-failed-003")!;
    const f = F(s.id);
    check("failed-003: fake acceptance — candle bi+2 still closes ≥ HOD",
      s.candles[f.bi + 2].c >= s.hod);
    check("failed-003: delayed collapse ends >1% under HOD", f.final < s.hod * 0.99);
  }
  {
    const s = getScenario("hod-ambiguous-002")!;
    const f = F(s.id);
    check("ambiguous-002: strong-ish volume (1.3–1.6x)", f.volMult >= 1.3 && f.volMult <= 1.6);
    check("ambiguous-002: strong close (0.6–0.7)", f.closePos >= 0.6 && f.closePos <= 0.7);
    check("ambiguous-002: zero extension — post highs ≤ HOD×1.03", f.postMaxHigh <= s.hod * 1.03);
    check("ambiguous-002: ends at/above HOD", f.final >= s.hod);
  }
  {
    const s = getScenario("hod-ambiguous-003")!;
    const f = F(s.id);
    check("ambiguous-003: soft volume (0.9–1.25x)", f.volMult >= 0.9 && f.volMult <= 1.25);
    check("ambiguous-003: soft close (0.4–0.55)", f.closePos >= 0.4 && f.closePos <= 0.55);
    check("ambiguous-003: dip holds — post closes ≥ HOD×0.995", f.postMinClose >= s.hod * 0.995);
    check("ambiguous-003: ends at/above HOD", f.final >= s.hod);
  }

  // Within-class distinctness: no cosmetic duplicates. Every pair of
  // same-class scenarios differs in candles AND in profile shape
  // (checkpoint position, or a material fingerprint difference).
  for (const c of CLASSES) {
    const group = HOD_SCENARIOS.filter((s) => s.classification === c);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const fa = fp(a), fb = fp(b);
        check(`${a.id} vs ${b.id}: different candle series`,
          !eq(a.candles, b.candles));
        check(`${a.id} vs ${b.id}: distinct profile (checkpoint/volume/close/spike)`,
          a.checkpointIndex !== b.checkpointIndex ||
          Math.abs(fa.volMult - fb.volMult) >= 0.1 ||
          Math.abs(fa.closePos - fb.closePos) >= 0.05 ||
          Math.abs(fa.spike - fb.spike) >= 0.005);
      }
    }
  }
}

// =====================================================================
// 3. QUEUE: permutation, determinism, serve order
// =====================================================================
console.log("\n=== Queue mechanics ===");
{
  const eligible = currentEligibleSlugs();
  check("eligibility = the 12 catalog slugs", eligible.length === 12);
  for (const seed of [1, 42, 999, 2 ** 31 - 1]) {
    const cycle = createCycle(seed, 1_700_000_000_000, 1);
    check(`queue is a true permutation (seed ${seed})`,
      cycle.queue.length === 12 &&
      new Set(cycle.queue).size === 12 &&
      eq([...cycle.queue].sort(), [...eligible].sort()));
    check(`cycle eligibility frozen at creation (seed ${seed})`, eq(cycle.eligible, eligible));
  }
  check("same seed → identical queue",
    eq(createCycle(42, 1, 1).queue, createCycle(42, 2, 1).queue));
  check("different seeds → different orders",
    !eq(createCycle(1, 1, 1).queue, createCycle(2, 1, 1).queue) ||
    !eq(createCycle(2, 1, 1).queue, createCycle(3, 1, 1).queue));
  check("label derivable from slug alone", labelForSlug("d-047") === "HOD Drill #047");
}

// =====================================================================
// 4. SUBMISSION RULES (via the storage write path, as the app calls it)
// =====================================================================
console.log("\n=== Submission rules ===");
{
  const storage = new MemoryStorage();
  const seed = 4242, t0 = 1_700_000_000_000;
  let state = ensurePool(storage, seed, t0);
  check("fresh pool: cycle 1, nothing submitted",
    state.active.cycleId.startsWith("cycle-1") && submittedCount(state.active) === 0);
  check("fresh pool serves the queue head", serveNextSlug(state) === state.active.queue[0]);

  const first = serveNextSlug(state)!;
  const second = state.active.queue.find((s) => s !== first)!;

  // Open + start, then LEAVE without sealing: nothing is consumed and
  // the interrupted attempt is served again before any fresh draw.
  state = updatePool(storage, seed, t0, (s) => markStarted(s, first, t0 + 10));
  check("starting consumes nothing", submittedCount(state.active) === 0);
  check("interrupted attempt is re-offered first", serveNextSlug(state) === first);
  state = updatePool(storage, seed, t0, (s) => markStarted(s, second, t0 + 20));
  check("most recently started unsubmitted is served first", serveNextSlug(state) === second);
  state = updatePool(storage, seed, t0, (s) => markStarted(s, second, t0 + 30));
  check("re-starting an already-started drill is a no-op",
    state.active.started[second] === t0 + 20);

  // Seal = submit: exactly once.
  const attempt = attemptFor(second, "clean", "enter", t0 + 100);
  state = updatePool(storage, seed, t0, (s) => submitAttempt(s, attempt).state);
  check("sealing submits exactly once", submittedCount(state.active) === 1);
  check("submitted drill leaves the started set", state.active.started[second] === undefined);
  check("submitted drill is never served again", serveNextSlug(state) === first);
  const sealedJson = JSON.stringify(state.active.submitted[second]);

  // Duplicate submit attempts (double-click, retry, remount): absorbed.
  const dup = attemptFor(second, "failed", "skip", t0 + 200);
  let appliedCount = 0;
  state = updatePool(storage, seed, t0, (s) => {
    const r = submitAttempt(s, dup);
    if (r.applied) appliedCount++;
    return r.state;
  });
  check("duplicate submit is not applied", appliedCount === 0);
  check("sealed record is never overwritten",
    JSON.stringify(state.active.submitted[second]) === sealedJson);
  check("still exactly one submission", submittedCount(state.active) === 1);

  // Unknown / ineligible slug: rejected.
  state = updatePool(storage, seed, t0, (s) => submitAttempt(s, { ...attempt, slug: "d-999" }).state);
  check("submit for a non-cycle slug is rejected", submittedCount(state.active) === 1);

  // Stale-tab simulation: a transition computed against an OLD snapshot
  // is applied by updatePool to the FRESH stored state — both records
  // survive (no lost update, no duplicate).
  const stale = state; // tab B's snapshot: only `second` submitted
  const attemptFirst = attemptFor(first, "weak", "wait", t0 + 300);
  state = updatePool(storage, seed, t0, (s) => submitAttempt(s, attemptFirst).state);
  check("fresh-state transition lands alongside the earlier one",
    submittedCount(state.active) === 2 &&
    state.active.submitted[first] !== undefined &&
    JSON.stringify(state.active.submitted[second]) === sealedJson);
  check("stale snapshot was not written back", submittedCount(stale.active) === 1);
}

// =====================================================================
// 5. PERSISTENCE: refresh / reopen / back-forward round-trips
// =====================================================================
console.log("\n=== Persistence round-trips ===");
{
  const storage = new MemoryStorage();
  const seed = 777, t0 = 1_700_100_000_000;
  let state = ensurePool(storage, seed, t0);
  const order = [...state.active.queue];
  // Play 3 drills, start a 4th, then "refresh": reload from storage.
  for (let i = 0; i < 3; i++) {
    const slug = serveNextSlug(state)!;
    const sc = resolveDrillSlug(slug)!.scenario;
    state = updatePool(storage, seed, t0, (s) => markStarted(s, slug, t0 + i));
    state = updatePool(storage, seed, t0, (s) =>
      submitAttempt(s, attemptFor(slug, sc.classification as DecisionClassification, APPROPRIATE[sc.classification], t0 + 100 + i)).state);
  }
  const interrupted = serveNextSlug(state)!;
  state = updatePool(storage, seed, t0, (s) => markStarted(s, interrupted, t0 + 50));

  const reloaded = loadPool(storage)!;
  check("reload restores the exact state (byte-for-byte)",
    serializePool(reloaded) === serializePool(state));
  check("reload restores the queue order", eq(reloaded.active.queue, order));
  check("reload restores the serving position", serveNextSlug(reloaded) === interrupted);
  check("reload restores submitted records", submittedCount(reloaded.active) === 3);
  check("re-ensure (reopen) does not reset the pool",
    ensurePool(storage, 999999, t0 + 999).active.cycleId === state.active.cycleId);
  check("stored record lives under the versioned key",
    storage.getItem(POOL_STORAGE_KEY) !== null);
  check("parse(serialize(state)) is the identity for a mid-cycle state",
    serializePool(parsePool(serializePool(state))!) === serializePool(state));

  // Corruption handling: garbage → null (caller falls back to fresh);
  // structural damage → repaired, sealed records preserved.
  check("non-JSON record parses to null", parsePool("{not json") === null);
  check("wrong schema version parses to null",
    parsePool(JSON.stringify({ version: 99, active: state.active, archives: [] })) === null);
  const damaged = JSON.parse(serializePool(state)) as PoolState;
  damaged.active.queue = [damaged.active.queue[0], damaged.active.queue[0], "d-999"];
  damaged.active.started = { ...damaged.active.started, "d-999": 1 };
  const repaired = parsePool(JSON.stringify(damaged))!;
  check("damaged queue repaired to a true permutation",
    repaired.active.queue.length === 12 && new Set(repaired.active.queue).size === 12);
  check("repair drops unknown slugs everywhere",
    !repaired.active.queue.includes("d-999") && repaired.active.started["d-999"] === undefined);
  check("repair preserves sealed records byte-for-byte",
    eq(repaired.active.submitted, state.active.submitted));
  const badRecord = JSON.parse(serializePool(state)) as PoolState;
  const someSlug = Object.keys(badRecord.active.submitted)[0];
  (badRecord.active.submitted[someSlug] as { overall: unknown }).overall = "lots";
  const repaired2 = parsePool(JSON.stringify(badRecord))!;
  check("an individually invalid record is dropped, the cycle survives",
    repaired2.active.submitted[someSlug] === undefined &&
    submittedCount(repaired2.active) === 2);
}

// =====================================================================
// 6. FULL PLAYTHROUGH → COMPLETION → RESULTS → NEW CYCLE
// =====================================================================
console.log("\n=== Full cycle playthrough ===");
{
  const storage = new MemoryStorage();
  const seed = 31337, t0 = 1_700_200_000_000;
  let state = ensurePool(storage, seed, t0);
  const servedOrder: string[] = [];
  let guard = 0;
  while (serveNextSlug(state) !== null && guard++ < 50) {
    const slug = serveNextSlug(state)!;
    servedOrder.push(slug);
    const sc = resolveDrillSlug(slug)!.scenario;
    state = updatePool(storage, seed, t0, (s) => markStarted(s, slug, t0 + guard));
    state = updatePool(storage, seed, t0, (s) =>
      submitAttempt(s, attemptFor(slug, sc.classification as DecisionClassification, APPROPRIATE[sc.classification], t0 + 1000 + guard)).state);
  }
  check("playthrough serves every drill exactly once",
    servedOrder.length === 12 && new Set(servedOrder).size === 12);
  check("serve order equals the queue order", eq(servedOrder, state.active.queue));
  check("cycle reports complete", isCycleComplete(state.active));
  check("completion timestamp recorded", state.active.completedAt !== null);
  check("nothing left to serve", serveNextSlug(state) === null);

  const results = cycleResults(state.active);
  check("results list all 12 in queue order",
    results.rows.length === 12 && eq(results.rows.map((r) => r.slug), state.active.queue));
  check("perfect play aggregates: avg 100, reads 100%, decisions 100%",
    results.avgOverall === 100 && results.readPct === 100 && results.actionPct === 100);

  // Scoring fidelity inside the stored record: a wrong trap play on a
  // failed drill stores read 0 / action 0 / overall 0.
  const failedSlug = BLIND_CATALOG.find((d) =>
    resolveDrillSlug(d.slug)!.scenario.classification === "failed")!.slug;
  const storedFailed = state.active.submitted[failedSlug];
  check("stored record carries the scenario seed + lock label",
    storedFailed.scenarioSeed === resolveDrillSlug(failedSlug)!.scenario.seed &&
    storedFailed.lockLabel.includes("candle"));

  const archiveJsonBefore = JSON.stringify(state.active);
  const cycled = startNewCycle(state, 555, t0 + 5000);
  check("new cycle archives the finished one verbatim",
    cycled.archives.length === 1 && JSON.stringify(cycled.archives[0]) === archiveJsonBefore);
  check("new cycle starts clean",
    submittedCount(cycled.active) === 0 &&
    Object.keys(cycled.active.started).length === 0 &&
    cycled.active.cycleId !== state.active.cycleId);
  check("new cycle queue is a fresh permutation of the current catalog",
    eq([...cycled.active.queue].sort(), [...currentEligibleSlugs()].sort()));
  // Later activity in the new cycle never mutates the archive.
  const slug = serveNextSlug(cycled)!;
  const sc = resolveDrillSlug(slug)!.scenario;
  const after = submitAttempt(cycled, attemptFor(slug, sc.classification as DecisionClassification, APPROPRIATE[sc.classification], t0 + 6000)).state;
  check("archived cycle is untouched by new-cycle activity",
    JSON.stringify(after.archives[0]) === archiveJsonBefore);
}

// =====================================================================
// 7. NEW-SCENARIO ENTRY RULE: eligibility frozen mid-cycle
// =====================================================================
console.log("\n=== New-scenario entry rule ===");
{
  // Simulate a cycle created when the pool had 10 drills: its stored
  // eligibility set (a 10-slug subset) must survive a parse against
  // today's 12-slug catalog untouched.
  const full = createPoolState(2024, 1_700_300_000_000);
  const ten = full.active.eligible.slice(0, 10);
  const legacy: PoolState = {
    version: full.version,
    archives: [],
    active: {
      ...full.active,
      eligible: ten,
      queue: full.active.queue.filter((s) => ten.includes(s)),
    },
  };
  const parsed = parsePool(serializePool(legacy))!;
  check("stored eligibility stays frozen at 10 under a 12-drill catalog",
    parsed.active.eligible.length === 10 && eq(parsed.active.eligible, ten));
  let s: PoolState = parsed;
  let guard = 0;
  while (serveNextSlug(s) !== null && guard++ < 30) {
    const slug = serveNextSlug(s)!;
    check(`frozen cycle never serves a late-joining drill (${slug})`, ten.includes(slug));
    const sc = resolveDrillSlug(slug)!.scenario;
    s = submitAttempt(s, attemptFor(slug, sc.classification as DecisionClassification, APPROPRIATE[sc.classification], 1_700_300_100_000 + guard)).state;
  }
  check("frozen cycle completes at its own 10", isCycleComplete(s.active) && submittedCount(s.active) === 10);
  const next = startNewCycle(s, 606, 1_700_300_200_000);
  check("late-joining scenarios enter at the cycle boundary",
    next.active.eligible.length === 12 && eq(next.active.eligible, currentEligibleSlugs()));
  check("boundary rollover preserves the frozen cycle's records",
    next.archives.length === 1 && submittedCount(next.archives[0]) === 10);
}

// =====================================================================
// 8. LEAK SCAN: persisted record + serving surface
// =====================================================================
console.log("\n=== Leak scan ===");
{
  const storage = new MemoryStorage();
  const seed = 8080, t0 = 1_700_400_000_000;
  let state = ensurePool(storage, seed, t0);
  const slug = serveNextSlug(state)!;
  const sc = resolveDrillSlug(slug)!.scenario;
  state = updatePool(storage, seed, t0, (s) => markStarted(s, slug, t0));
  state = updatePool(storage, seed, t0, (s) =>
    submitAttempt(s, attemptFor(slug, sc.classification as DecisionClassification, APPROPRIATE[sc.classification], t0 + 10)).state);
  state = startNewCycle(state, 9090, t0 + 20); // archive one, start another
  const json = storage.getItem(POOL_STORAGE_KEY)!;
  void json;
  const stored = serializePool(state);

  check("persisted record contains no internal scenario ids", !stored.includes("hod-"));
  for (const s of HOD_SCENARIOS) {
    check(`persisted record hides title of ${s.id}`, !stored.includes(s.title));
    check(`persisted record hides description of ${s.id}`,
      !stored.includes(s.description.slice(0, 24)));
  }
  for (const w of ["beginner", "intermediate", "advanced"]) {
    check(`persisted record contains no difficulty "${w}"`, !stored.toLowerCase().includes(w));
  }
  // Classifications may appear ONLY inside submitted attempts' revealed
  // fields. Strip those two fields from every record and rescan.
  const stripped = JSON.parse(stored) as PoolState;
  const stripCycle = (c: PoolState["active"]) => {
    for (const a of Object.values(c.submitted)) {
      delete (a as Partial<SubmittedAttempt>).actualClassification;
      delete (a as Partial<SubmittedAttempt>).classification;
    }
  };
  stripCycle(stripped.active);
  stripped.archives.forEach(stripCycle);
  const rest = JSON.stringify(stripped).toLowerCase();
  for (const w of ["clean", "weak", "failed", "ambiguous", "continuation", "trap"]) {
    check(`no classification leak outside revealed fields ("${w}")`, !rest.includes(w));
  }
  check("every started/submitted key is an opaque slug",
    [...Object.keys(state.active.started), ...Object.keys(state.active.submitted),
     ...Object.keys(state.archives[0].submitted)]
      .every((k) => /^d-\d{3}$/.test(k)));
  check("queue + eligibility carry slugs only",
    [...state.active.queue, ...state.active.eligible].every((k) => /^d-\d{3}$/.test(k)));
}

console.log(`\n=== POOL RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
