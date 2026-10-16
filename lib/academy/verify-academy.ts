/**
 * Verify: Trading Academy (lib/academy/*).
 *
 * Pins: candle invariants under fuzz + boundary inputs, classification
 * incl. the 5% doji tolerance edges, geometry, formation derivation,
 * challenge evaluation, Evidence Board answer-key integrity, choice /
 * assessment scoring incl. the 80% threshold, progress state machine
 * + guest→account merge rules + parse tolerance, and the content
 * validator rejecting malformed definitions.
 */
import {
  candleGeometry,
  challengeStartCandle,
  classifyCandle,
  evaluateCandleChallenge,
  formationFromPath,
  generatePricePath,
  isValidCandle,
  makeCandle,
  setCandleField,
  DOJI_BODY_RATIO,
  type Candle,
} from "./candleMath";
import { mulberry32 } from "./rng";
import {
  ASSESSMENT_ITEMS,
  CANDLE_CHALLENGES,
  EVIDENCE_ITEMS,
  EXPLANATION_QUESTIONS,
  L1_CHECKS,
  L3_CHECKS,
  LESSONS,
  WORLDS,
  getLessonsForWorld,
  validateAcademyContent,
  validateAssessmentItems,
  validateChallenges,
  validateChoiceQuestions,
  validateEvidenceItems,
  validateLesson,
  validateLessons,
  validateSectionReferences,
  validateStatedCounts,
  validateWorlds,
} from "./content";
import { scoreAssessment, scoreChoiceQuestions, scoreEvidenceItems } from "./exercises";
import {
  completeLesson,
  emptyAcademyState,
  fromServerStatus,
  mergeAcademyStates,
  mergeForSync,
  parseAcademyState,
  recordAttempt,
  recordMisconception,
  setReflection,
  toServerStatus,
  touchLesson,
  translateLegacyProgress,
  type AcademyState,
} from "./progress";
import type { ChallengeKind, EvidenceCategory } from "./types";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL: ${name}`);
  }
}
const approx = (a: number, b: number) => Math.abs(a - b) < 0.011;

/* ================= candle construction & invariants ================= */
{
  const rng = mulberry32(42);
  let allValid = true;
  let allInDomain = true;
  for (let i = 0; i < 3000; i++) {
    const raw = {
      open: (rng() - 0.2) * 30,
      high: (rng() - 0.2) * 30,
      low: (rng() - 0.2) * 30,
      close: (rng() - 0.2) * 30,
    };
    const c = makeCandle(raw);
    if (!isValidCandle(c)) allValid = false;
    if (c.low < 0 || c.high > 100000) allInDomain = false;
    // The invariant in its exact form:
    if (!(c.low <= Math.min(c.open, c.close) + 1e-9 && Math.max(c.open, c.close) <= c.high + 1e-9)) allValid = false;
  }
  check("fuzz: 3000 random inputs always yield valid candles", allValid);
  check("fuzz: outputs stay inside the price domain", allInDomain);

  const eq = makeCandle({ open: 5, high: 5, low: 5, close: 5 });
  check("equal values: zero-range candle is valid", isValidCandle(eq) && eq.high - eq.low === 0);
  const inverted = makeCandle({ open: 10, high: 9, low: 11, close: 10.5 });
  check("inverted high/low clamps into a valid candle", isValidCandle(inverted) && inverted.high >= 10.5 && inverted.low <= 10);
  let threw = false;
  try {
    makeCandle({ open: NaN, high: 1, low: 1, close: 1 });
  } catch {
    threw = true;
  }
  check("non-finite input is rejected (throws), never fabricated", threw);
  let threwInf = false;
  try {
    makeCandle({ open: 1, high: Infinity, low: 1, close: 1 });
  } catch {
    threwInf = true;
  }
  check("infinite input is rejected (throws)", threwInf);

  const base = makeCandle({ open: 10, high: 10.6, low: 9.9, close: 10.4 });
  const dragged = setCandleField(base, "high", 10.1);
  check("setCandleField: high dragged below close clamps AT the close", dragged.high === 10.4 && isValidCandle(dragged));
  const draggedLow = setCandleField(base, "low", 10.2);
  check("setCandleField: low dragged above open clamps AT the open", draggedLow.low === 10 && isValidCandle(draggedLow));
  const moved = setCandleField(base, "close", 9.95);
  check("setCandleField: close below low pulls the low down", moved.low <= 9.95 && isValidCandle(moved));
}

/* ================= classification & geometry ================= */
{
  check("classify bullish", classifyCandle(makeCandle({ open: 10, high: 10.5, low: 9.9, close: 10.4 })) === "bullish");
  check("classify bearish", classifyCandle(makeCandle({ open: 10.4, high: 10.5, low: 9.9, close: 10 })) === "bearish");
  check("classify zero-range as doji", classifyCandle(makeCandle({ open: 5, high: 5, low: 5, close: 5 })) === "doji");
  // body exactly at the 5% tolerance edge -> doji (<=)
  const edge = makeCandle({ open: 10, high: 10.5, low: 9.5, close: 10.05 });
  const gEdge = candleGeometry(edge);
  check("doji tolerance edge: body/range == 5% classifies doji", approx(gEdge.bodyRatio, DOJI_BODY_RATIO) && classifyCandle(edge) === "doji");
  // body just over tolerance -> bullish
  const over = makeCandle({ open: 10, high: 10.5, low: 9.5, close: 10.06 });
  check("just over tolerance: classifies bullish, not doji", classifyCandle(over) === "bullish");
  // tiny body on a big range with close below open -> still doji, not bearish
  const tinyBear = makeCandle({ open: 10.02, high: 10.6, low: 9.4, close: 10.0 });
  check("tiny body (close<open) within tolerance is doji, not bearish", classifyCandle(tinyBear) === "doji");

  const g = candleGeometry(makeCandle({ open: 10, high: 10.6, low: 9.8, close: 10.2 }));
  check("geometry: range", approx(g.range, 0.8));
  check("geometry: body", approx(g.body, 0.2));
  check("geometry: upper wick", approx(g.upperWick, 0.4));
  check("geometry: lower wick", approx(g.lowerWick, 0.2));
  check("geometry: body+wicks == range", approx(g.body + g.upperWick + g.lowerWick, g.range));
  const g0 = candleGeometry(makeCandle({ open: 5, high: 5, low: 5, close: 5 }));
  check("geometry: zero-range ratios are 0, never NaN", g0.bodyRatio === 0 && g0.upperWickRatio === 0 && Number.isFinite(g0.lowerWickRatio));
}

/* ================= formation ================= */
{
  const path = [10, 10.5, 9.8, 10.2, 10.35];
  const frames = formationFromPath(path);
  const last = frames[frames.length - 1].candle;
  check("formation: final candle is O=first H=max L=min C=last",
    last.open === 10 && last.high === 10.5 && last.low === 9.8 && last.close === 10.35);
  check("formation: one frame per price", frames.length === path.length);
  check("formation: running high is monotonic", frames.every((f, i) => i === 0 || f.candle.high >= frames[i - 1].candle.high));
  check("formation: running low is monotonic", frames.every((f, i) => i === 0 || f.candle.low <= frames[i - 1].candle.low));
  check("formation: every frame candle valid", frames.every((f) => isValidCandle(f.candle)));
  let threw = false;
  try {
    formationFromPath([]);
  } catch {
    threw = true;
  }
  check("formation: empty path rejected", threw);

  const p1 = generatePricePath(7, 10, 49);
  const p2 = generatePricePath(7, 10, 49);
  const p3 = generatePricePath(8, 10, 49);
  check("price path: deterministic for a seed", JSON.stringify(p1) === JSON.stringify(p2));
  check("price path: differs across seeds", JSON.stringify(p1) !== JSON.stringify(p3));
  check("price path: length + starts at the start price", p1.length === 49 && p1[0] === 10);
  check("price path: all prices positive and finite", p1.every((p) => Number.isFinite(p) && p > 0));
}

/* ================= challenges ================= */
{
  const good: Record<string, Candle> = {
    bullish: makeCandle({ open: 10, high: 10.5, low: 9.9, close: 10.4 }),
    bearish: makeCandle({ open: 10.4, high: 10.5, low: 9.9, close: 10 }),
    doji: makeCandle({ open: 10, high: 10.4, low: 9.6, close: 10.02 }),
    "long-upper-wick": makeCandle({ open: 10, high: 10.9, low: 9.95, close: 10.1 }),
    "long-lower-wick": makeCandle({ open: 10.1, high: 10.15, low: 9.2, close: 10 }),
    "small-body-large-range": makeCandle({ open: 10, high: 10.45, low: 9.55, close: 10.05 }),
  };
  const bad: Record<string, Candle> = {
    bullish: makeCandle({ open: 10.4, high: 10.5, low: 9.9, close: 10 }),
    bearish: makeCandle({ open: 10, high: 10.5, low: 9.9, close: 10.4 }),
    doji: makeCandle({ open: 10, high: 10.5, low: 9.9, close: 10.4 }),
    "long-upper-wick": makeCandle({ open: 10, high: 10.2, low: 9.6, close: 10.1 }),
    "long-lower-wick": makeCandle({ open: 10.1, high: 10.6, low: 9.9, close: 10 }),
    "small-body-large-range": makeCandle({ open: 10, high: 10.3, low: 9.9, close: 10.25 }),
  };
  for (const kind of Object.keys(good) as ChallengeKind[]) {
    check(`challenge ${kind}: qualifying candle passes`,
      evaluateCandleChallenge(kind, good[kind], 0.5).passed === true);
    check(`challenge ${kind}: non-qualifying candle fails`,
      evaluateCandleChallenge(kind, bad[kind], 0.5).passed === false);
    check(`challenge ${kind}: verdict carries numeric feedback`,
      evaluateCandleChallenge(kind, bad[kind], 0.5).reasons.length > 0);
  }
  // minRange gate: same shape, range 0.45 fails a 0.5 target, passes 0.4
  const mid = makeCandle({ open: 10, high: 10.25, low: 9.8, close: 10.02 });
  check("small-body: range below the target fails even with a small body",
    evaluateCandleChallenge("small-body-large-range", mid, 0.5).passed === false);
  check("small-body: range at/above a lower target passes",
    evaluateCandleChallenge("small-body-large-range", mid, 0.4).passed === true);
  // challenge start candles are valid and seed-varying
  const starts = new Set(CANDLE_CHALLENGES.map((d) => JSON.stringify(challengeStartCandle(d.startSeed))));
  check("challenge starts: valid candles", CANDLE_CHALLENGES.every((d) => isValidCandle(challengeStartCandle(d.startSeed))));
  check("challenge starts: values vary across challenges", starts.size === CANDLE_CHALLENGES.length);
  const retryStart = challengeStartCandle(CANDLE_CHALLENGES[0].startSeed + 131);
  check("challenge starts: retry seed gives a different start", JSON.stringify(retryStart) !== JSON.stringify(challengeStartCandle(CANDLE_CHALLENGES[0].startSeed)));
}

/* ================= evidence board & scoring ================= */
{
  check("evidence bank ships 10+ items", EVIDENCE_ITEMS.length >= 10);
  check("evidence bank covers all four categories",
    (["fact", "interpretation", "overreach", "needs-data"] as EvidenceCategory[]).every((k) => EVIDENCE_ITEMS.some((i) => i.key === k)));
  const allRight: Record<string, EvidenceCategory> = {};
  const allWrong: Record<string, EvidenceCategory> = {};
  for (const item of EVIDENCE_ITEMS) {
    allRight[item.id] = item.key;
    allWrong[item.id] = item.key === "fact" ? "overreach" : "fact";
  }
  const sRight = scoreEvidenceItems(EVIDENCE_ITEMS, allRight);
  check("evidence scoring: all-correct scores full marks, no missed concepts",
    sRight.correct === sRight.total && sRight.missedConcepts.length === 0);
  const sWrong = scoreEvidenceItems(EVIDENCE_ITEMS, allWrong);
  check("evidence scoring: all-wrong scores zero", sWrong.correct === 0);
  check("evidence scoring: missed concepts reported",
    sWrong.missedConcepts.length > 0 && sWrong.missedConcepts.every((c) => EVIDENCE_ITEMS.some((i) => i.concept === c)));

  const qScore = scoreChoiceQuestions(
    EXPLANATION_QUESTIONS,
    Object.fromEntries(EXPLANATION_QUESTIONS.map((q) => [q.id, q.options.findIndex((o) => o.correct)]))
  );
  check("choice scoring: picking the keyed option scores correct", qScore.correct === qScore.total && qScore.total === EXPLANATION_QUESTIONS.length);
  const qWrong = scoreChoiceQuestions(
    EXPLANATION_QUESTIONS,
    Object.fromEntries(EXPLANATION_QUESTIONS.map((q) => [q.id, q.options.findIndex((o) => !o.correct)]))
  );
  check("choice scoring: wrong options score zero", qWrong.correct === 0);
}

/* ================= assessment ================= */
{
  const allRight = Object.fromEntries(ASSESSMENT_ITEMS.map((i) => [i.id, i.correctIndex]));
  const sAll = scoreAssessment(ASSESSMENT_ITEMS, allRight, 80);
  check("assessment: all correct = 100 and passes", sAll.scorePct === 100 && sAll.passed);
  const sNone = scoreAssessment(ASSESSMENT_ITEMS, {}, 80);
  check("assessment: unanswered counts incorrect (score 0, no false completion)", sNone.scorePct === 0 && !sNone.passed);
  // exactly-80 boundary with a synthetic 10-item set
  const ten = ASSESSMENT_ITEMS.slice(0, 10).map((i) => ({ ...i }));
  const eight = Object.fromEntries(ten.map((i, idx) => [i.id, idx < 8 ? i.correctIndex : (i.correctIndex + 1) % i.options.length]));
  const s80 = scoreAssessment(ten, eight, 80);
  check("assessment: exactly 80% passes at the default threshold", s80.scorePct === 80 && s80.passed);
  const seven = Object.fromEntries(ten.map((i, idx) => [i.id, idx < 7 ? i.correctIndex : (i.correctIndex + 1) % i.options.length]));
  check("assessment: 70% fails the 80% threshold", scoreAssessment(ten, seven, 80).passed === false);
  check("assessment: threshold is configurable (70 passes at 70)", scoreAssessment(ten, seven, 70).passed === true);
  // classify keys in the shipped bank agree with the pinned math
  check("assessment: every classify key matches classifyCandle",
    ASSESSMENT_ITEMS.filter((i) => i.kind === "classify" && i.candle).every((i) => {
      const cls = classifyCandle(i.candle!);
      return i.correctIndex === (cls === "bullish" ? 0 : cls === "bearish" ? 1 : 2);
    }));
  check("assessment bank: 10+ items incl. boundary/doji classify cases",
    ASSESSMENT_ITEMS.length >= 10 && ASSESSMENT_ITEMS.filter((i) => i.kind === "classify").length >= 5);
}

/* ================= progress: state machine ================= */
{
  let s = emptyAcademyState();
  s = touchLesson(s, "candlestick-mastery", null, 1000);
  check("progress: touch marks in-progress", s.lessons["candlestick-mastery"].status === "in-progress");
  s = touchLesson(s, "candlestick-mastery", "builder", 2000);
  check("progress: touch records resume position", s.lessons["candlestick-mastery"].lastPosition === "builder");

  let a = emptyAcademyState();
  a = recordAttempt(a, "L", 55, 80, true, 1000);
  check("attempts: below-threshold attempt with activities done -> completed",
    a.lessons["L"].status === "completed" && a.lessons["L"].attempts === 1 && a.lessons["L"].bestScore === 55);
  a = recordAttempt(a, "L", 40, 80, true, 2000);
  check("attempts: worse score keeps best + status", a.lessons["L"].bestScore === 55 && a.lessons["L"].status === "completed" && a.lessons["L"].attempts === 2);
  a = recordAttempt(a, "L", 90, 80, true, 3000);
  check("attempts: >= threshold -> mastered", a.lessons["L"].status === "mastered" && a.lessons["L"].bestScore === 90);
  a = recordAttempt(a, "L", 10, 80, true, 4000);
  check("attempts: mastered NEVER downgrades on a later weak attempt", a.lessons["L"].status === "mastered" && a.lessons["L"].attempts === 4);
  let b = emptyAcademyState();
  b = recordAttempt(b, "L", 79, 80, true, 1000);
  check("attempts: 79 < 80 is not mastered", b.lessons["L"].status !== "mastered");
  b = recordAttempt(b, "L", 80, 80, true, 1000);
  check("attempts: exactly 80 masters", b.lessons["L"].status === "mastered");

  let m = emptyAcademyState();
  m = recordMisconception(m, "wicks");
  m = recordMisconception(m, "wicks");
  check("misconceptions: counters accumulate per concept", m.misconceptions["wicks"] === 2);
  let r = setReflection(emptyAcademyState(), "L", "uncertain", "the path inside the candle");
  check("reflections: saved per lesson+prompt", r.reflections["L"]["uncertain"] === "the path inside the candle");
}

/* ================= progress: merge rules ================= */
{
  let guest = emptyAcademyState();
  guest = recordAttempt(guest, "L", 92, 80, true, 5000); // mastered, 1 attempt
  guest = setReflection(guest, "L", "uncertain", "guest note");
  let server = emptyAcademyState();
  server = touchLesson(server, "L", "anatomy", 1000);
  server = recordAttempt(server, "L", 30, 80, true, 1500); // completed, best 30, 1 attempt
  server = setReflection(server, "L", "evidence-used", "server note");

  const merged = mergeForSync(guest, server);
  check("merge: better status wins (mastered over completed)", merged.lessons["L"].status === "mastered");
  check("merge: bestScore is the max", merged.lessons["L"].bestScore === 92);
  check("merge: attempts take MAX, never summed (no double count)", merged.lessons["L"].attempts === 1);
  check("merge: reflections union across sources",
    merged.reflections["L"]["uncertain"] === "guest note" && merged.reflections["L"]["evidence-used"] === "server note");

  // server reflection wins a same-key conflict
  const guest2 = setReflection(emptyAcademyState(), "L", "uncertain", "guest version");
  const server2 = setReflection(emptyAcademyState(), "L", "uncertain", "server version");
  check("merge: server reflection wins a same-key conflict", mergeForSync(guest2, server2).reflections["L"]["uncertain"] === "server version");
  // merge can never downgrade: weaker second state changes nothing
  const weak = touchLesson(emptyAcademyState(), "L", null, 100);
  const strongFirst = mergeAcademyStates(guest, weak);
  check("merge: weaker state never downgrades", strongFirst.lessons["L"].status === "mastered" && strongFirst.lessons["L"].bestScore === 92);
  // misconceptions take max
  let mc1 = recordMisconception(emptyAcademyState(), "doji");
  mc1 = recordMisconception(mc1, "doji");
  const mc2 = recordMisconception(emptyAcademyState(), "doji");
  check("merge: misconception counters take max", mergeAcademyStates(mc1, mc2).misconceptions["doji"] === 2);
}

/* ================= progress: persistence parsing ================= */
{
  check("parse: null -> empty", parseAcademyState(null).lessons && Object.keys(parseAcademyState(null).lessons).length === 0);
  check("parse: garbage -> empty, no throw", Object.keys(parseAcademyState("{not json").lessons).length === 0);
  check("parse: wrong version -> empty", Object.keys(parseAcademyState(JSON.stringify({ version: 99, lessons: { L: { status: "mastered" } } })).lessons).length === 0);
  const good = JSON.stringify({
    version: 1,
    lessons: { L: { status: "mastered", bestScore: 88, attempts: 2, lastPosition: "assessment", updatedAt: 123 } },
    reflections: { L: { uncertain: "x" } },
    misconceptions: { wicks: 3 },
  });
  const parsed = parseAcademyState(good);
  check("parse: well-formed record round-trips",
    parsed.lessons["L"].status === "mastered" && parsed.lessons["L"].bestScore === 88 && parsed.misconceptions["wicks"] === 3);
  const mixed = JSON.stringify({
    version: 1,
    lessons: { good: { status: "completed", bestScore: 70, attempts: 1, lastPosition: null, updatedAt: 1 }, bad: { status: "hacked" } },
    reflections: {},
    misconceptions: {},
  });
  const pm = parseAcademyState(mixed);
  check("parse: invalid lesson entries dropped, valid kept", !!pm.lessons["good"] && !pm.lessons["bad"]);

  check("server status mapping round-trips",
    (["in-progress", "completed", "mastered"] as const).every((s) => fromServerStatus(toServerStatus(s)) === s));
  check("server status: not-started maps to started", toServerStatus("not-started") === "started");
}

/* ================= content registry & validator ================= */
{
  check("registry: shipped content validates clean", validateAcademyContent().length === 0);
  check("worlds: exactly 12, numbered 1..12", WORLDS.length === 12 && WORLDS.every((w, i) => w.number === i + 1));
  check("worlds: exactly one available (World 1, Candlestick Basics)",
    WORLDS.filter((w) => w.status === "available").length === 1 &&
    WORLDS[0].status === "available" && WORLDS[0].title === "Candlestick Basics" &&
    WORLDS[0].lessonSlug === "what-is-a-candlestick");
  check("worlds: World 2 is Stock Market Foundations, planned",
    WORLDS[1].title === "Stock Market Foundations" && WORLDS[1].status === "planned" && WORLDS[1].lessonSlug === null);
  check("worlds: planned worlds carry no lesson (no empty shells)",
    WORLDS.filter((w) => w.status === "planned").every((w) => w.lessonSlug === null));
  check("worlds: no stale pre-swap references remain",
    !JSON.stringify(WORLDS).includes("Candlestick Mastery") &&
    WORLDS.every((w) => !w.prerequisites.includes("World 2 — Candlestick") && !w.prerequisites.includes("World 1 — Stock Market")));
  check("worlds: swapped prerequisite strings updated",
    WORLDS[2].prerequisites === "World 1 — Candlestick Basics" &&
    WORLDS[3].prerequisites === "World 2 — Stock Market Foundations" &&
    WORLDS[4].prerequisites === "World 1 — Candlestick Basics" &&
    WORLDS[8].prerequisites === "Worlds 1, 3 and 5" &&
    WORLDS[10].prerequisites === "Worlds 1–10");
  check("worlds: every world named in a prerequisite exists",
    WORLDS.every((w) => {
      const re = /Worlds? (\d+)(?:–(\d+))?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(w.prerequisites)) !== null) {
        const from = Number(m[1]);
        const to = m[2] ? Number(m[2]) : from;
        for (let n = from; n <= to; n++) if (!WORLDS.some((x) => x.number === n)) return false;
      }
      return true;
    }));

  const basics = getLessonsForWorld(1);
  check("lessons: World 1 carries exactly 7 lessons, ordered 1..7",
    basics.length === 7 && basics.every((l, i) => l.order === i + 1 && l.worldNumber === 1));
  check("lessons: stable ids and slugs for L1–L7",
    JSON.stringify(basics.map((l) => l.id)) ===
      JSON.stringify(["candle-basics-1", "candle-basics-2", "candle-basics-3", "candle-basics-4", "candle-basics-5", "candle-basics-6", "candle-basics-7"]) &&
    JSON.stringify(basics.map((l) => l.slug)) ===
      JSON.stringify(["what-is-a-candlestick", "green-vs-red-candles", "meet-ohlc", "build-your-first-candlestick", "watch-a-candle-form", "read-what-the-candle-says", "beginner-practice-and-mastery"]));
  check("lessons: no lessons registered for planned worlds", getLessonsForWorld(2).length === 0 && LESSONS.length === 7);
  check("lessons: only Lesson 7 carries the assessment and journal",
    basics.filter((l) => l.sections.some((s) => s.kind === "assessment")).map((l) => l.id).join() === "candle-basics-7" &&
    basics.filter((l) => l.sections.some((s) => s.kind === "journal")).map((l) => l.id).join() === "candle-basics-7");
  check("lessons: Lesson 7 keeps the 80% mastery threshold", basics[6].masteryThreshold === 80);
  const kinds = basics.flatMap((l) => l.sections.map((s) => s.kind));
  check("path sections cover the full learning cycle",
    ["objectives", "concept", "tap-reveal", "direction-practice", "ohlc-explorer", "formation-demo", "candle-builder", "challenges", "evidence-board", "explanation", "assessment", "journal", "summary"].every((k) => kinds.includes(k as never)));
  check("banks unchanged: assessment ids (11, same order)",
    JSON.stringify(ASSESSMENT_ITEMS.map((i) => i.id)) ===
    JSON.stringify(["as-classify-bullish", "as-classify-bearish", "as-classify-doji", "as-classify-boundary", "as-classify-flat", "as-wick-choice", "as-categorize-fact", "as-categorize-overreach", "as-categorize-needs-data", "as-direction-prediction", "as-path-choice"]));
  check("banks unchanged: evidence ids (12, same order)",
    JSON.stringify(EVIDENCE_ITEMS.map((i) => i.id)) ===
    JSON.stringify(["ev-open-close", "ev-consistent-rise", "ev-buyers-control", "ev-will-continue", "ev-high-was", "ev-rejection-interpretation", "ev-sellers-control", "ev-doji-reversal", "ev-volume-fact", "ev-volume-institutions", "ev-support-question", "ev-bearish-meaning"]));
  check("beginner banks: L1 has 1 check, L3 has 4 (one per term), all valid",
    L1_CHECKS.length === 1 && L3_CHECKS.length === 4 &&
    validateChoiceQuestions(L1_CHECKS).length === 0 && validateChoiceQuestions(L3_CHECKS).length === 0);
  check("validator: duplicate lesson order in a world rejected",
    validateLessons([...basics, { ...basics[0], id: "candle-basics-x", slug: "extra" }]).length >= 1);
  check("validator: unknown section content reference rejected",
    validateSectionReferences([{ ...basics[0], sections: [{ id: "x", kind: "challenges", title: "X", paragraphs: [], bullets: [], contentIds: ["nope"] }] }]).length >= 1);

  // validator rejects malformed definitions
  const badLesson = { ...LESSONS[0], masteryThreshold: 140, sections: [LESSONS[0].sections[0], LESSONS[0].sections[0]] };
  check("validator: bad threshold + duplicate section ids rejected", validateLesson(badLesson).length >= 2);
  const badWorlds = WORLDS.map((w) => (w.number === 3 ? { ...w, lessonSlug: "ghost" } : w));
  check("validator: planned world with a lessonSlug rejected", validateWorlds(badWorlds).length >= 1);
  const badEvidence = EVIDENCE_ITEMS.map((i, idx) => (idx === 0 ? { ...i, rationale: " " } : i));
  check("validator: evidence item without rationale rejected", validateEvidenceItems(badEvidence).length >= 1);
  const badQuestions = EXPLANATION_QUESTIONS.map((q, idx) =>
    idx === 0 ? { ...q, options: q.options.map((o) => ({ ...o, correct: true })) } : q
  );
  check("validator: question with != 1 correct option rejected", validateChoiceQuestions(badQuestions).length >= 1);
  const badAssessment = ASSESSMENT_ITEMS.map((i, idx) => (idx === 0 ? { ...i, correctIndex: 99 } : i));
  check("validator: assessment correctIndex out of range rejected", validateAssessmentItems(badAssessment).length >= 1);
  const badChallenges = CANDLE_CHALLENGES.map((c) => (c.kind === "small-body-large-range" ? { ...c, rangeOptions: [] } : c));
  check("validator: small-body challenge without rangeOptions rejected", validateChallenges(badChallenges).length >= 1);

  // copy/count integrity — stated counts must equal the content arrays
  check("content counts: 6 challenges / 12 evidence / 3 explanations / 11 assessment items",
    CANDLE_CHALLENGES.length === 6 && EVIDENCE_ITEMS.length === 12 &&
    EXPLANATION_QUESTIONS.length === 3 && ASSESSMENT_ITEMS.length === 11);
  const lesson7 = LESSONS.find((l) => l.id === "candle-basics-7")!;
  const sectionPara = (kind: string) =>
    lesson7.sections.find((s) => s.kind === kind)?.paragraphs.join(" ") ?? "";
  check("copy derives: assessment intro states the real item count (not a hardcoded 'Ten')",
    sectionPara("assessment").includes(`${ASSESSMENT_ITEMS.length} questions`));
  const lesson6 = LESSONS.find((l) => l.id === "candle-basics-6")!;
  check("copy derives: subset intros state their real subset counts",
    sectionPara("challenges").includes("5 challenges") &&
    lesson6.sections.filter((s) => s.kind === "evidence-board").every((s) => s.paragraphs.join(" ").includes("6 statements")) &&
    sectionPara("explanation").includes(`${EXPLANATION_QUESTIONS.length} questions`));
  const doctoredLesson = {
    ...lesson7,
    sections: lesson7.sections.map((s) =>
      s.kind === "assessment" ? { ...s, paragraphs: ["Ten questions, honestly."] } : s
    ),
  };
  check("validator: a stated count that disagrees with the content is rejected",
    validateStatedCounts(doctoredLesson, {
      challenges: CANDLE_CHALLENGES.length,
      evidence: EVIDENCE_ITEMS.length,
      explanations: EXPLANATION_QUESTIONS.length,
      assessment: ASSESSMENT_ITEMS.length,
    }).length >= 1);
}

/* ================= completion vs mastery semantics ================= */
{
  let c = touchLesson(emptyAcademyState(), "candle-basics-1", null, 1000);
  c = completeLesson(c, "candle-basics-1", 2000);
  check("completion: completeLesson marks completed, never mastered",
    c.lessons["candle-basics-1"].status === "completed" &&
    c.lessons["candle-basics-1"].attempts === 0 && c.lessons["candle-basics-1"].bestScore === null);
  c = completeLesson(c, "candle-basics-1", 3000);
  check("completion: repeated completion is stable (still completed, not mastered)",
    c.lessons["candle-basics-1"].status === "completed");
  let mastered = recordAttempt(emptyAcademyState(), "candle-basics-7", 95, 80, true, 1000);
  mastered = completeLesson(mastered, "candle-basics-7", 2000);
  check("completion: completeLesson never downgrades a mastered record",
    mastered.lessons["candle-basics-7"].status === "mastered" && mastered.lessons["candle-basics-7"].bestScore === 95);
  check("mastery: only an assessment attempt at/above threshold masters (recordAttempt on L7)",
    recordAttempt(emptyAcademyState(), "candle-basics-7", 79, 80, true, 1).lessons["candle-basics-7"].status !== "mastered" &&
    recordAttempt(emptyAcademyState(), "candle-basics-7", 80, 80, true, 1).lessons["candle-basics-7"].status === "mastered");
}

/* ================= legacy progress compatibility ================= */
{
  const LEGACY = "candlestick-mastery";
  // absent: no legacy record -> state returned unchanged (same reference)
  const plain = emptyAcademyState();
  check("compat: absent legacy record leaves state untouched", translateLegacyProgress(plain) === plain);

  // mastered legacy -> L7 inherits score record; L1–L6 completed; reflections move
  let legacyMastered = recordAttempt(emptyAcademyState(), LEGACY, 92, 80, true, 5000);
  legacyMastered = setReflection(legacyMastered, LEGACY, "uncertain", "legacy note");
  const tm = translateLegacyProgress(legacyMastered);
  check("compat: legacy key removed after translation", !(LEGACY in tm.lessons) && !(LEGACY in tm.reflections));
  check("compat: mastered legacy -> Lesson 7 mastered with score + attempts",
    tm.lessons["candle-basics-7"].status === "mastered" &&
    tm.lessons["candle-basics-7"].bestScore === 92 && tm.lessons["candle-basics-7"].attempts === 1);
  check("compat: mastered legacy -> Lessons 1–6 completed",
    ["candle-basics-1", "candle-basics-2", "candle-basics-3", "candle-basics-4", "candle-basics-5", "candle-basics-6"]
      .every((id) => tm.lessons[id]?.status === "completed"));
  check("compat: legacy reflections move to Lesson 7", tm.reflections["candle-basics-7"]?.["uncertain"] === "legacy note");

  // completed (below-threshold) legacy -> same mapping, status completed
  const legacyCompleted = recordAttempt(emptyAcademyState(), LEGACY, 55, 80, true, 5000);
  const tc = translateLegacyProgress(legacyCompleted);
  check("compat: completed legacy -> Lesson 7 completed with its best score",
    tc.lessons["candle-basics-7"].status === "completed" && tc.lessons["candle-basics-7"].bestScore === 55);

  // in-progress legacy -> only Lesson 1 resumes; no score/attempts transfer
  const legacyStarted = touchLesson(emptyAcademyState(), LEGACY, "builder", 1000);
  const ti = translateLegacyProgress(legacyStarted);
  check("compat: in-progress legacy -> Lesson 1 in-progress with resume position",
    ti.lessons["candle-basics-1"]?.status === "in-progress" && ti.lessons["candle-basics-1"]?.lastPosition === "builder");
  check("compat: in-progress legacy -> no Lesson 7 record, no transferred scores",
    !("candle-basics-7" in ti.lessons) && ti.lessons["candle-basics-1"]?.attempts === 0 && ti.lessons["candle-basics-1"]?.bestScore === null);

  // conflict: existing new records merge by the better-state rules
  let conflict = recordAttempt(emptyAcademyState(), LEGACY, 92, 80, true, 5000);
  conflict = recordAttempt(conflict, LEGACY, 92, 80, true, 6000); // legacy attempts = 2
  conflict = recordAttempt(conflict, "candle-basics-7", 70, 80, true, 7000); // new L7 completed, best 70, 1 attempt
  const tx = translateLegacyProgress(conflict);
  check("compat conflict: better status + max score + max attempts win on Lesson 7",
    tx.lessons["candle-basics-7"].status === "mastered" &&
    tx.lessons["candle-basics-7"].bestScore === 92 && tx.lessons["candle-basics-7"].attempts === 2);
  let conflict2 = recordAttempt(emptyAcademyState(), LEGACY, 55, 80, true, 5000); // legacy completed
  conflict2 = recordAttempt(conflict2, "candle-basics-7", 95, 80, true, 6000); // new L7 mastered
  const tx2 = translateLegacyProgress(conflict2);
  check("compat conflict: an existing mastered Lesson 7 is never downgraded by legacy",
    tx2.lessons["candle-basics-7"].status === "mastered" && tx2.lessons["candle-basics-7"].bestScore === 95);

  // translation also fires on the load path (parse) and on merges (sync)
  const stored = JSON.stringify({
    version: 1,
    lessons: { [LEGACY]: { status: "mastered", bestScore: 88, attempts: 3, lastPosition: "assessment", updatedAt: 42 } },
    reflections: {},
    misconceptions: {},
  });
  const parsedLegacy = parseAcademyState(stored);
  check("compat: stored legacy record translates on load",
    !("candlestick-mastery" in parsedLegacy.lessons) && parsedLegacy.lessons["candle-basics-7"]?.bestScore === 88);
  const guestSide = touchLesson(emptyAcademyState(), LEGACY, null, 1000);
  const serverSide = recordAttempt(emptyAcademyState(), "candle-basics-7", 85, 80, true, 2000);
  const mergedLegacy = mergeForSync(guestSide, serverSide);
  check("compat: merge path translates legacy records too",
    !("candlestick-mastery" in mergedLegacy.lessons) &&
    mergedLegacy.lessons["candle-basics-1"]?.status === "in-progress" &&
    mergedLegacy.lessons["candle-basics-7"]?.status === "mastered");
}

console.log(`\n=== ACADEMY RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
