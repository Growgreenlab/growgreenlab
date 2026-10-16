/**
 * Trading Academy — content registry (Stage 2) + Candlestick Mastery
 * lesson content (Stage 3).
 *
 * The registry lists all twelve worlds from the master spec with
 * honest status: only World 2 is "available"; the rest are "planned"
 * and render as planned — there are no empty lesson shells.
 *
 * VALIDATION: at module load, every definition is validated
 * (validateWorlds / validateLesson / bank validators). A malformed
 * definition throws here — failing the build/test run loudly — rather
 * than silently rendering a broken lesson.
 *
 * ANSWER KEYS: assessment "classify" items derive their correctIndex
 * from candleMath.classifyCandle at definition time, so the key can
 * never drift from the pinned math. Evidence Board keys are grounded
 * in each item's stated context, per the spec's taxonomy.
 */
import { classifyCandle, makeCandle } from "./candleMath";
import type {
  AssessmentItem,
  ChallengeDef,
  ChoiceQuestion,
  EvidenceItem,
  LessonDef,
  WorldDef,
} from "./types";

/* ------------------------------------------------------------------ */
/* Worlds (master spec §4)                                             */
/* ------------------------------------------------------------------ */

export const WORLDS: WorldDef[] = [
  {
    number: 1,
    slug: "market-foundations",
    title: "Stock Market Foundations",
    tagline: "What a stock is, how prices form, and how trading sessions work.",
    topics: ["Shares & exchanges", "Bid, ask, spread, last price", "Market cap vs share price", "Sessions & extended hours", "Charts & timeframes", "Investing vs trading"],
    status: "planned",
    prerequisites: "",
    lessonSlug: null,
  },
  {
    number: 2,
    slug: "candlestick-mastery",
    title: "Candlestick Mastery",
    tagline: "Build candles yourself, read bodies and wicks, and separate what a candle shows from what it cannot prove.",
    topics: ["Open, High, Low, Close", "Bodies & wicks", "Bullish, bearish, doji", "How a candle forms", "Candles in context"],
    status: "available",
    prerequisites: "",
    lessonSlug: "candlestick-mastery",
  },
  {
    number: 3,
    slug: "price-action-structure",
    title: "Price Action and Chart Structure",
    tagline: "Swings, trends, ranges, support and resistance as zones — and what a breakout actually is.",
    topics: ["Swing highs & lows", "Trends & ranges", "Support & resistance zones", "Breakouts, retests, failed moves", "Continuation vs reversal"],
    status: "planned",
    prerequisites: "World 2 — Candlestick Mastery",
    lessonSlug: null,
  },
  {
    number: 4,
    slug: "order-execution",
    title: "Order Execution and Trading Mechanics",
    tagline: "Order types, fills, slippage, and why a stop price is not a guaranteed fill price.",
    topics: ["Market, limit, stop orders", "Buying, selling, shorting", "Fills & partial fills", "Slippage & liquidity", "Stop-loss & take-profit"],
    status: "planned",
    prerequisites: "World 1 — Stock Market Foundations",
    lessonSlug: null,
  },
  {
    number: 5,
    slug: "volume-activity",
    title: "Volume and Market Activity",
    tagline: "What volume measures, relative volume, and the limits of volume as evidence.",
    topics: ["Volume bars", "Relative volume (RVOL)", "Volume & price movement", "Volume in breakouts & pullbacks", "Limits of volume evidence"],
    status: "planned",
    prerequisites: "World 2 — Candlestick Mastery",
    lessonSlug: null,
  },
  {
    number: 6,
    slug: "indicators-levels",
    title: "Indicators and Key Levels",
    tagline: "VWAP, moving averages, and key levels — derived from market data, never guarantees.",
    topics: ["VWAP", "EMA & SMA", "High of Day", "Previous close", "Premarket high & low", "Confluence & lag"],
    status: "planned",
    prerequisites: "World 3 — Price Action and Chart Structure",
    lessonSlug: null,
  },
  {
    number: 7,
    slug: "level2-time-sales",
    title: "Level 2 and Time & Sales",
    tagline: "Reading the order book and the tape — including what displayed orders cannot tell you.",
    topics: ["Bid/ask depth", "Displayed size", "Time & Sales prints", "Absorption & momentum reads", "Hidden liquidity", "Spoofing (concept)"],
    status: "planned",
    prerequisites: "World 4 — Order Execution and Trading Mechanics",
    lessonSlug: null,
  },
  {
    number: 8,
    slug: "risk-management",
    title: "Risk Management",
    tagline: "Risk per trade, position sizing, R-multiples, and the difference between a planned loss and an actual loss.",
    topics: ["Risk per trade", "Position sizing", "Stops & invalidation", "Risk/reward & R-multiples", "Partial exits", "Daily loss limits", "Fees & slippage"],
    status: "planned",
    prerequisites: "World 4 — Order Execution and Trading Mechanics",
    lessonSlug: null,
  },
  {
    number: 9,
    slug: "strategies-setups",
    title: "Strategies and Setup Recognition",
    tagline: "HOD breakouts, pullbacks, and retests — entry criteria, invalidation, and when to wait or skip.",
    topics: ["Clean, weak & failed breakouts", "Anticipation vs confirmation", "VWAP & EMA pullbacks", "Retests & reclaims", "Supporting vs contradictory evidence"],
    status: "planned",
    prerequisites: "Worlds 2, 3 and 5",
    lessonSlug: null,
  },
  {
    number: 10,
    slug: "psychology-discipline",
    title: "Trading Psychology and Discipline",
    tagline: "FOMO, revenge trading, and bias — process quality over financial outcome.",
    topics: ["FOMO & revenge trading", "Overtrading & hesitation", "Confirmation bias & loss aversion", "Pre-trade routines", "Journaling & review"],
    status: "planned",
    prerequisites: "",
    lessonSlug: null,
  },
  {
    number: 11,
    slug: "trade-analysis-capstone",
    title: "Complete Trade Analysis Capstone",
    tagline: "Integrate everything: structure, evidence, sizing, a decision — and an honest review of it.",
    topics: ["Full-context scenarios", "Evidence separation", "Position sizing under uncertainty", "Enter / Wait / Skip", "Decision review"],
    status: "planned",
    prerequisites: "Worlds 2–10",
    lessonSlug: null,
  },
  {
    number: 12,
    slug: "continuous-learning",
    title: "Advanced Practice and Continuous Learning",
    tagline: "Mixed challenges, weak-concept revision, and a personal learning plan.",
    topics: ["Mixed-skill challenges", "Misconception correction", "Personal learning plans", "Evidence-based review"],
    status: "planned",
    prerequisites: "World 11 — Capstone",
    lessonSlug: null,
  },
];

/* ------------------------------------------------------------------ */
/* Candlestick Mastery — the flagship lesson (World 2)                  */
/* ------------------------------------------------------------------ */

export const CANDLESTICK_MASTERY: LessonDef = {
  id: "candlestick-mastery",
  slug: "candlestick-mastery",
  worldNumber: 2,
  title: "Candlestick Mastery",
  tagline: "Can you build a candlestick? Construct candles, watch them form, and learn exactly what a finished candle does — and does not — tell you.",
  objectives: [
    "Construct a valid candle from any Open, High, Low, and Close, and explain the constraint that connects them.",
    "Classify a candle as bullish, bearish, or doji from its open-to-close relationship — and state the doji tolerance being used.",
    "Describe what bodies and wicks record, and label wick interpretations as interpretations, not facts.",
    "Explain why a candle's direction is not a prediction of the next candle.",
    "Sort market statements into Observed Fact, Reasonable Interpretation, Overreach, and Needs More Data.",
  ],
  estimatedMinutes: 25,
  difficulty: "Beginner",
  prerequisites: "None — this is a starting point.",
  masteryThreshold: 80,
  sections: [
    {
      id: "objectives",
      kind: "objectives",
      title: "What you will be able to do",
      paragraphs: [
        "A candlestick compresses everything a market did during one interval — one minute, five minutes, a day — into four numbers: the Open, the High, the Low, and the Close. This lesson teaches you to build candles yourself, because reading a candle is much easier once you have constructed one.",
        "It also teaches a discipline that runs through the whole Academy: separating what the data shows from what we infer from it, and from what we simply cannot know yet.",
      ],
      bullets: [],
    },
    {
      id: "anatomy",
      kind: "concept",
      title: "The four numbers",
      paragraphs: [
        "Open — the first price of the interval. High — the highest price reached during the interval. Low — the lowest price reached. Close — the final price when the interval ends.",
        "The thick part of the candle is the body: the span between Open and Close. The thin lines above and below are the wicks (also called shadows): they show how far price traveled beyond the body before the interval ended.",
        "These four numbers obey one constraint, always: Low ≤ the lower of Open/Close, and the higher of Open/Close ≤ High. A candle that breaks that rule is not a candle — it is a data error. The builder below enforces the rule for you, so watch what it does when you try to break it.",
      ],
      bullets: [
        "Range = High − Low: the full distance price traveled.",
        "Body = |Close − Open|: the distance between the first and last price.",
        "Upper wick = High − the higher of Open/Close. Lower wick = the lower of Open/Close − Low.",
      ],
    },
    {
      id: "formation",
      kind: "formation-demo",
      title: "Watch a candle form",
      paragraphs: [
        "Before you build your own, watch one form over time. The demonstration below plays a simulated price path (educational data, generated for this lesson — not a real market). The opening price sets the Open; as price moves, the running High and Low update and the body stretches and shrinks; when the interval ends, the last price becomes the Close.",
        "Before it finishes, make a prediction: will this candle close bullish, bearish, or as a doji? Committing to a prediction before the reveal is how the Academy trains evidence-based thinking.",
      ],
      bullets: [],
    },
    {
      id: "builder",
      kind: "candle-builder",
      title: "Build a candle",
      paragraphs: [
        "Now build one. Move the sliders or type exact values — the candle updates immediately, and the readouts show its range, body, and wicks. Try to create an invalid candle: drag the High below the Close, or the Low above the Open. The builder clamps the values instead, because a real candle cannot exist in that state.",
        "Notice the classification label. Bullish means only that the Close is above the Open. Bearish means only that the Close is below the Open. A doji is a candle whose body is at most 5% of its range — open and close are nearly the same price. Those labels describe the finished candle; they predict nothing.",
      ],
      bullets: [],
    },
    {
      id: "challenges",
      kind: "challenges",
      title: "Guided challenges",
      paragraphs: [
        "Use the builder to hit each target shape. There is no timer and no penalty for retrying — rebuild as many times as you need. The feedback uses your candle's actual numbers, so read it: it tells you exactly which measurement is off and by how much.",
      ],
      bullets: [],
    },
    {
      id: "evidence",
      kind: "evidence-board",
      title: "Evidence Board: fact, interpretation, overreach, or needs more data?",
      paragraphs: [
        "Traders constantly turn observations into stories. Some stories are reasonable; some claim far more than the data supports. For each statement below, judge it against the evidence shown: is it an Observed Fact, a Reasonable Interpretation, an Overreach, or something that Needs More Data? The answer is revealed only after you commit — and a wrong first answer is useful information, not a failure.",
      ],
      bullets: [],
    },
    {
      id: "explanations",
      kind: "explanation",
      title: "Explain it accurately",
      paragraphs: [
        "Knowing a shape is not the same as reasoning about it accurately. These questions ask which statement about a candle is actually supported. Each option carries its own feedback, so a wrong pick shows you which part of the statement went too far.",
      ],
      bullets: [],
    },
    {
      id: "assessment",
      kind: "assessment",
      title: "Mastery check",
      paragraphs: [
        "Ten questions across everything in this lesson: classifying candles (including boundary and doji cases), interpreting wicks without inventing intent, and sorting facts from claims. Score 80% or higher to mark this lesson Mastered. Attempts are unlimited, and your best score is kept — but a score only ever reflects the answers you actually gave.",
      ],
      bullets: [],
    },
    {
      id: "journal",
      kind: "journal",
      title: "Decision journal",
      paragraphs: [
        "Four short reflections, saved privately to your progress (on this device as a guest; to your account when you are signed in and sync is available). Honest answers here are worth more than a perfect score.",
      ],
      bullets: [],
    },
    {
      id: "summary",
      kind: "summary",
      title: "Key principles",
      paragraphs: [
        "A candle is four numbers with one inviolable constraint. Bullish and bearish describe where the close landed relative to the open — nothing more. Wicks record that price traveled somewhere and did not stay there; why it retreated is an interpretation, never a fact a single candle can prove. And no candle, however dramatic, guarantees the next one.",
      ],
      bullets: [
        "Fact: what the numbers say. Interpretation: a story consistent with them. Overreach: certainty the data does not contain.",
        "When the evidence is incomplete, 'Needs More Data' — and waiting — is a correct, professional answer.",
      ],
    },
  ],
};

export const LESSONS: LessonDef[] = [CANDLESTICK_MASTERY];

export function getLessonBySlug(slug: string): LessonDef | null {
  return LESSONS.find((l) => l.slug === slug) ?? null;
}

export function getWorld(number: number): WorldDef | null {
  return WORLDS.find((w) => w.number === number) ?? null;
}

/* ------------------------------------------------------------------ */
/* Guided challenges                                                   */
/* ------------------------------------------------------------------ */

export const CANDLE_CHALLENGES: ChallengeDef[] = [
  { id: "ch-bullish", kind: "bullish", title: "Build a bullish candle", instruction: "Make the close finish above the open, with a body bigger than the doji tolerance.", concept: "candle-direction", startSeed: 101, rangeOptions: [] },
  { id: "ch-bearish", kind: "bearish", title: "Build a bearish candle", instruction: "Make the close finish below the open, with a body bigger than the doji tolerance.", concept: "candle-direction", startSeed: 202, rangeOptions: [] },
  { id: "ch-doji", kind: "doji", title: "Build a doji", instruction: "Bring the close to nearly the open: body at most 5% of the total range.", concept: "doji", startSeed: 303, rangeOptions: [] },
  { id: "ch-upper-wick", kind: "long-upper-wick", title: "Build a long upper wick", instruction: "The upper wick must be at least 50% of the total range AND at least twice the body.", concept: "wicks", startSeed: 404, rangeOptions: [] },
  { id: "ch-lower-wick", kind: "long-lower-wick", title: "Build a long lower wick", instruction: "The lower wick must be at least 50% of the total range AND at least twice the body.", concept: "wicks", startSeed: 505, rangeOptions: [] },
  { id: "ch-small-body", kind: "small-body-large-range", title: "Small body, large range", instruction: "Body at most 25% of the range, with the total range at least the target shown.", concept: "wicks", startSeed: 606, rangeOptions: [0.4, 0.5, 0.6] },
];

/* ------------------------------------------------------------------ */
/* Evidence Board bank (World 2)                                       */
/* ------------------------------------------------------------------ */

export const EVIDENCE_ITEMS: EvidenceItem[] = [
  {
    id: "ev-open-close",
    concept: "fact-vs-claim",
    context: "A one-minute candle: Open $5.00, High $5.24, Low $4.98, Close $5.20.",
    statement: "The candle opened at $5.00 and closed at $5.20.",
    key: "fact",
    rationale: "Both numbers are printed in the candle's data. Nothing is inferred.",
    misconception: "Treating every sentence about a candle as an opinion — some are simply the data restated.",
  },
  {
    id: "ev-consistent-rise",
    concept: "fact-vs-claim",
    context: "A one-minute candle: Open $5.00, High $5.24, Low $4.98, Close $5.20.",
    statement: "Price finished the candle above its opening level, which is consistent with upward price movement during that interval.",
    key: "interpretation",
    rationale: "The close above the open is a fact; 'consistent with upward movement' is a careful reading of it. The wording claims consistency, not proof of what happened inside the interval.",
    misconception: "Assuming careful, hedged language must be a fact — an interpretation can be reasonable and still be an interpretation.",
  },
  {
    id: "ev-buyers-control",
    concept: "intent-overreach",
    context: "A one-minute candle: Open $5.00, High $5.24, Low $4.98, Close $5.20.",
    statement: "Buyers controlled every transaction in that candle, and the next candle must rise.",
    key: "overreach",
    rationale: "OHLC data does not record who initiated each trade, and no single candle guarantees the next one. Two unprovable claims are stacked on four numbers.",
    misconception: "Believing a bullish candle proves buyer control and predicts continuation.",
  },
  {
    id: "ev-will-continue",
    concept: "needs-more-data",
    context: "A one-minute candle: Open $5.00, High $5.24, Low $4.98, Close $5.20. Nothing else is shown.",
    statement: "Will this upward move continue over the next several candles?",
    key: "needs-data",
    rationale: "One candle cannot answer this. You would need surrounding candles, volume, nearby levels, and broader context — none of which is shown.",
    misconception: "Feeling that a strong-looking candle must contain its own forecast.",
  },
  {
    id: "ev-high-was",
    concept: "fact-vs-claim",
    context: "A candle: Open $10.00, High $10.60, Low $9.95, Close $10.05.",
    statement: "The highest price reached during this candle was $10.60.",
    key: "fact",
    rationale: "That is exactly what the High records.",
    misconception: "Confusing the High with where the candle 'ended up' — the close is $10.05, far below the high.",
  },
  {
    id: "ev-rejection-interpretation",
    concept: "wicks",
    context: "A candle: Open $10.00, High $10.60, Low $9.95, Close $10.05 — a long upper wick.",
    statement: "The long upper wick is consistent with price being rejected at higher levels.",
    key: "interpretation",
    rationale: "Price demonstrably reached $10.60 and closed at $10.05, so a retreat from the high is observed. Calling it 'rejection' is a plausible interpretation of that retreat — phrased here as consistency, not proof of anyone's intent.",
    misconception: "Upgrading 'consistent with rejection' into 'sellers rejected the price' as if intent were recorded.",
  },
  {
    id: "ev-sellers-control",
    concept: "intent-overreach",
    context: "A candle: Open $10.00, High $10.60, Low $9.95, Close $10.05 — a long upper wick.",
    statement: "Sellers took control of this stock and forced the price down from $10.60.",
    key: "overreach",
    rationale: "The candle shows price reached $10.60 and later printed $10.05. It does not show who acted, why, or that anyone 'forced' anything — intent and causation are not in the data.",
    misconception: "Reading a wick as a recording of one side's intentions.",
  },
  {
    id: "ev-doji-reversal",
    concept: "doji",
    context: "A candle: Open $8.00, High $8.30, Low $7.70, Close $8.01 — a doji (body 2% of range).",
    statement: "Because this candle is a doji, the next candle will reverse direction.",
    key: "overreach",
    rationale: "A doji records that open and close finished nearly equal. It contains no information that guarantees — or even schedules — a reversal.",
    misconception: "Treating candle names as predictions: 'doji' describes a shape, not a forecast.",
  },
  {
    id: "ev-volume-fact",
    concept: "volume-limits",
    context: "Two consecutive candles are shown with volume: the first traded 40,000 shares, the breakout candle traded 120,000 shares.",
    statement: "The breakout candle traded three times the volume of the candle before it.",
    key: "fact",
    rationale: "120,000 is three times 40,000 — arithmetic on displayed data, nothing inferred.",
    misconception: "Skipping the arithmetic and jumping straight to what the volume 'means'.",
  },
  {
    id: "ev-volume-institutions",
    concept: "volume-limits",
    context: "A breakout candle traded 120,000 shares, three times the previous candle's volume.",
    statement: "The high volume proves institutions were buying this breakout.",
    key: "overreach",
    rationale: "Volume counts shares changing hands; every buy is also a sell. It does not identify the participants, and it cannot prove any group's intent.",
    misconception: "Believing volume identifies who traded — it never does.",
  },
  {
    id: "ev-support-question",
    concept: "needs-more-data",
    context: "A single candle is shown on its own: Open $10.00, High $10.60, Low $9.95, Close $10.05. No earlier candles are visible.",
    statement: "Is there a support level just below this candle?",
    key: "needs-data",
    rationale: "Support is defined by how price behaved at a level in the past. With no earlier candles shown, there is nothing to judge from.",
    misconception: "Assuming the current candle's low is automatically 'support' — a level needs history.",
  },
  {
    id: "ev-bearish-meaning",
    concept: "candle-direction",
    context: "A candle: Open $10.00, High $10.10, Low $9.65, Close $9.70.",
    statement: "This candle is bearish because its close is below its open.",
    key: "fact",
    rationale: "That is the definition in use: bearish names the open-to-close relationship, and $9.70 is below $10.00. (It says nothing about the next candle.)",
    misconception: "Hearing 'bearish' as a prediction rather than a description of this candle.",
  },
];

/* ------------------------------------------------------------------ */
/* Explanation checks (structured, rubric feedback per option)         */
/* ------------------------------------------------------------------ */

export const EXPLANATION_QUESTIONS: ChoiceQuestion[] = [
  {
    id: "ex-bearish-meaning",
    concept: "candle-direction",
    prompt: "A candle opens at $10.00 and closes at $9.70. Which statement is accurate?",
    options: [
      {
        text: "It is bearish because the closing price is below the opening price.",
        correct: true,
        feedback: "Correct — 'bearish' names exactly that open-to-close relationship, nothing more.",
      },
      {
        text: "It is bearish, so the next candle will fall too.",
        correct: false,
        feedback: "The first half is right; the prediction is not supported. A candle's direction describes that candle — it does not schedule the next one.",
      },
      {
        text: "It proves sellers controlled every trade during the interval.",
        correct: false,
        feedback: "Needs revision: OHLC data does not record who initiated each trade, so control of 'every trade' cannot be proven from it.",
      },
      {
        text: "It is bullish because price bounced off the low.",
        correct: false,
        feedback: "Needs revision: bullish/bearish is decided by close versus open. The close ($9.70) is below the open ($10.00), whatever the wick did.",
      },
    ],
  },
  {
    id: "ex-upper-wick",
    concept: "wicks",
    prompt: "A candle has a long upper wick: it rose to $10.60 but closed at $10.05. Which statement is accurate?",
    options: [
      {
        text: "Price reached $10.60 during the interval and had retreated to $10.05 by the close; rejection at higher prices is one possible interpretation.",
        correct: true,
        feedback: "Correct — the travel and the retreat are observed; 'rejection' is labeled as an interpretation, which is the honest standard.",
      },
      {
        text: "Sellers stepped in at $10.60 and pushed the price down.",
        correct: false,
        feedback: "Needs revision: that states intent as fact. The candle shows where price went, not who acted or why.",
      },
      {
        text: "The next candle must fall because this one was rejected.",
        correct: false,
        feedback: "Needs revision: a finished candle never makes the next one compulsory.",
      },
      {
        text: "The wick shows every price the stock traded at during the interval.",
        correct: false,
        feedback: "Needs revision: the wick marks only the highest price. The path between the extremes is not recorded in OHLC.",
      },
    ],
  },
  {
    id: "ex-path",
    concept: "formation",
    prompt: "A completed candle shows Open $10.00, High $10.60, Low $9.90, Close $10.20. What can you reconstruct about the interval?",
    options: [
      {
        text: "Only the four summary numbers: the first price, the extremes, and the final price — not the order or path of the moves between them.",
        correct: true,
        feedback: "Correct — many different paths produce the identical candle. The path is not recoverable from OHLC alone.",
      },
      {
        text: "The exact sequence of prices, because the candle was built from them.",
        correct: false,
        feedback: "Needs revision: construction used a path, but the finished candle keeps only O, H, L, C. The sequence is lost.",
      },
      {
        text: "That price rose steadily from open to close.",
        correct: false,
        feedback: "Needs revision: the close is above the open, but price could have dipped to $9.90 first — indeed the Low proves it visited $9.90 at some point.",
      },
      {
        text: "That buyers were more active than sellers throughout.",
        correct: false,
        feedback: "Needs revision: activity by side is not part of OHLC data.",
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Mastery assessment (answer keys derived from candleMath)            */
/* ------------------------------------------------------------------ */

const CLASSIFY_OPTIONS = ["Bullish", "Bearish", "Doji"] as const;

function classifyItem(
  id: string,
  candle: { open: number; high: number; low: number; close: number },
  rationale: string
): AssessmentItem {
  const c = makeCandle(candle);
  const cls = classifyCandle(c);
  const correctIndex = cls === "bullish" ? 0 : cls === "bearish" ? 1 : 2;
  return {
    id,
    kind: "classify",
    concept: "candle-direction",
    prompt: "Classify this candle.",
    candle: c,
    options: [...CLASSIFY_OPTIONS],
    correctIndex,
    rationale,
  };
}

export const ASSESSMENT_ITEMS: AssessmentItem[] = [
  classifyItem(
    "as-classify-bullish",
    { open: 10.0, high: 10.45, low: 9.95, close: 10.4 },
    "Close $10.40 is above open $10.00, and the $0.40 body is 80% of the range — far beyond the 5% doji tolerance. Bullish."
  ),
  classifyItem(
    "as-classify-bearish",
    { open: 10.3, high: 10.35, low: 9.8, close: 9.9 },
    "Close $9.90 is below open $10.30 with a body well beyond the doji tolerance. Bearish."
  ),
  classifyItem(
    "as-classify-doji",
    { open: 8.0, high: 8.3, low: 7.7, close: 8.02 },
    "Body is $0.02 on a $0.60 range — about 3%, within the 5% doji tolerance. Open and close are nearly the same price: a doji."
  ),
  classifyItem(
    "as-classify-boundary",
    { open: 10.0, high: 10.5, low: 9.5, close: 10.06 },
    "A trap for the unwary: the body is $0.06 on a $1.00 range = 6%, just OVER the 5% doji tolerance, and the close is above the open. Bullish — barely, but by the stated rule."
  ),
  classifyItem(
    "as-classify-flat",
    { open: 5.0, high: 5.0, low: 5.0, close: 5.0 },
    "Zero range: open, high, low and close are all $5.00. No body at all — a doji by definition."
  ),
  {
    id: "as-wick-choice",
    kind: "choice",
    concept: "wicks",
    prompt: "A candle rises to $12.40 and closes at $11.90, leaving a long upper wick. Which statement is accurate?",
    candle: null,
    options: [
      "The wick proves sellers were in control of the stock.",
      "Price reached $12.40 and closed $0.50 below it; a retreat from the high is observed, and rejection at higher prices is a possible interpretation.",
      "The next candle will fall because this one was rejected.",
      "The wick means the high was a data error.",
    ],
    correctIndex: 1,
    rationale:
      "The travel to $12.40 and the close at $11.90 are observed facts. Why price retreated is interpretation; a prediction about the next candle is unsupported; the high is real data, not an error.",
  },
  {
    id: "as-categorize-fact",
    kind: "categorize",
    concept: "fact-vs-claim",
    prompt: "Context: a candle opened at $6.00, reached a high of $6.50, and closed at $6.44. Statement: 'The candle's high was $6.50.' Classify the statement.",
    candle: null,
    options: ["Observed Fact", "Reasonable Interpretation", "Overreach", "Needs More Data"],
    correctIndex: 0,
    rationale: "The high is printed in the data. Restating it is an observed fact.",
  },
  {
    id: "as-categorize-overreach",
    kind: "categorize",
    concept: "volume-limits",
    prompt: "Context: a breakout candle traded three times the volume of the previous candle. Statement: 'The high volume proves institutions were buying.' Classify the statement.",
    candle: null,
    options: ["Observed Fact", "Reasonable Interpretation", "Overreach", "Needs More Data"],
    correctIndex: 2,
    rationale: "Volume counts shares, not participants. It cannot identify who traded or prove intent — the claim goes beyond the evidence.",
  },
  {
    id: "as-categorize-needs-data",
    kind: "categorize",
    concept: "needs-more-data",
    prompt: "Context: one bullish candle is shown, nothing else. Statement: 'Will this stock hold above today's high for the rest of the week?' Classify the statement.",
    candle: null,
    options: ["Observed Fact", "Reasonable Interpretation", "Overreach", "Needs More Data"],
    correctIndex: 3,
    rationale: "A single candle cannot answer a question about the rest of the week. More candles, volume, levels and context would be needed — the honest classification is Needs More Data.",
  },
  {
    id: "as-direction-prediction",
    kind: "choice",
    concept: "candle-direction",
    prompt: "A candle is bearish: it closed below its open. What does that tell you about the NEXT candle?",
    candle: null,
    options: [
      "The next candle will also be bearish.",
      "Sellers will control the next candle.",
      "Nothing certain — 'bearish' describes this candle's open-to-close relationship only.",
      "Price cannot rise in the next candle.",
    ],
    correctIndex: 2,
    rationale:
      "Direction labels describe the finished candle. They are not predictions, and treating them as predictions is one of the most common beginner errors this lesson exists to correct.",
  },
  {
    id: "as-path-choice",
    kind: "choice",
    concept: "formation",
    prompt: "From a completed candle's Open, High, Low and Close alone, which of these can you recover?",
    candle: null,
    options: [
      "Every price the stock traded at during the interval, in order.",
      "The first price, the highest and lowest prices, and the final price — but not the path between them.",
      "The exact moment the high was reached.",
      "How many trades happened.",
    ],
    correctIndex: 1,
    rationale:
      "OHLC is a summary: four numbers survive the interval. Sequence, timing within the interval, and trade count are not in it.",
  },
];

/* ------------------------------------------------------------------ */
/* Validation — malformed content must fail loudly, never render.      */
/* ------------------------------------------------------------------ */

const SECTION_KINDS = new Set([
  "objectives", "concept", "formation-demo", "candle-builder", "challenges",
  "evidence-board", "explanation", "assessment", "journal", "summary",
]);
const EVIDENCE_KEYS = new Set(["fact", "interpretation", "overreach", "needs-data"]);
const CHALLENGE_KINDS = new Set([
  "bullish", "bearish", "doji", "long-upper-wick", "long-lower-wick", "small-body-large-range",
]);

export function validateWorlds(worlds: readonly WorldDef[]): string[] {
  const errors: string[] = [];
  const numbers = new Set<number>();
  for (const w of worlds) {
    if (!Number.isInteger(w.number) || w.number < 1 || w.number > 12) errors.push(`world ${w.slug}: number out of range`);
    if (numbers.has(w.number)) errors.push(`world ${w.slug}: duplicate number ${w.number}`);
    numbers.add(w.number);
    if (!w.title.trim()) errors.push(`world ${w.slug}: empty title`);
    if (w.status === "available" && !w.lessonSlug) errors.push(`world ${w.slug}: available but no lessonSlug`);
    if (w.status === "planned" && w.lessonSlug) errors.push(`world ${w.slug}: planned but carries a lessonSlug (would be an empty shell)`);
  }
  return errors;
}

export function validateLesson(lesson: LessonDef): string[] {
  const errors: string[] = [];
  if (!lesson.id.trim() || !lesson.slug.trim() || !lesson.title.trim()) errors.push("lesson: missing id/slug/title");
  if (!(lesson.masteryThreshold > 0 && lesson.masteryThreshold <= 100)) errors.push(`lesson ${lesson.id}: masteryThreshold out of (0,100]`);
  if (lesson.objectives.length === 0) errors.push(`lesson ${lesson.id}: no objectives`);
  if (lesson.sections.length === 0) errors.push(`lesson ${lesson.id}: no sections`);
  const sectionIds = new Set<string>();
  for (const s of lesson.sections) {
    if (sectionIds.has(s.id)) errors.push(`lesson ${lesson.id}: duplicate section id ${s.id}`);
    sectionIds.add(s.id);
    if (!SECTION_KINDS.has(s.kind)) errors.push(`lesson ${lesson.id}: unknown section kind ${s.kind}`);
    if (!s.title.trim()) errors.push(`lesson ${lesson.id}: section ${s.id} has no title`);
  }
  return errors;
}

export function validateChallenges(defs: readonly ChallengeDef[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const d of defs) {
    if (ids.has(d.id)) errors.push(`challenge: duplicate id ${d.id}`);
    ids.add(d.id);
    if (!CHALLENGE_KINDS.has(d.kind)) errors.push(`challenge ${d.id}: unknown kind ${d.kind}`);
    if (d.kind === "small-body-large-range" && d.rangeOptions.length === 0) errors.push(`challenge ${d.id}: small-body-large-range needs rangeOptions`);
    if (!d.instruction.trim()) errors.push(`challenge ${d.id}: empty instruction`);
  }
  return errors;
}

export function validateEvidenceItems(items: readonly EvidenceItem[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) errors.push(`evidence: duplicate id ${item.id}`);
    ids.add(item.id);
    if (!EVIDENCE_KEYS.has(item.key)) errors.push(`evidence ${item.id}: invalid key ${item.key}`);
    if (!item.context.trim() || !item.statement.trim()) errors.push(`evidence ${item.id}: empty context/statement`);
    if (!item.rationale.trim() || !item.misconception.trim()) errors.push(`evidence ${item.id}: missing rationale/misconception`);
    if (!item.concept.trim()) errors.push(`evidence ${item.id}: missing concept tag`);
  }
  return errors;
}

export function validateChoiceQuestions(qs: readonly ChoiceQuestion[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const q of qs) {
    if (ids.has(q.id)) errors.push(`question: duplicate id ${q.id}`);
    ids.add(q.id);
    if (q.options.length < 2) errors.push(`question ${q.id}: fewer than 2 options`);
    const correct = q.options.filter((o) => o.correct).length;
    if (correct !== 1) errors.push(`question ${q.id}: exactly one correct option required, found ${correct}`);
    for (const o of q.options) if (!o.feedback.trim()) errors.push(`question ${q.id}: option missing rubric feedback`);
  }
  return errors;
}

export function validateAssessmentItems(items: readonly AssessmentItem[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) errors.push(`assessment: duplicate id ${item.id}`);
    ids.add(item.id);
    if (item.options.length < 2) errors.push(`assessment ${item.id}: fewer than 2 options`);
    if (item.correctIndex < 0 || item.correctIndex >= item.options.length) errors.push(`assessment ${item.id}: correctIndex out of range`);
    if (item.kind === "classify" && !item.candle) errors.push(`assessment ${item.id}: classify item without a candle`);
    if (!item.rationale.trim()) errors.push(`assessment ${item.id}: missing rationale`);
  }
  return errors;
}

/** All content problems in the shipped registry (must be empty). */
export function validateAcademyContent(): string[] {
  return [
    ...validateWorlds(WORLDS),
    ...LESSONS.flatMap(validateLesson),
    ...validateChallenges(CANDLE_CHALLENGES),
    ...validateEvidenceItems(EVIDENCE_ITEMS),
    ...validateChoiceQuestions(EXPLANATION_QUESTIONS),
    ...validateAssessmentItems(ASSESSMENT_ITEMS),
  ];
}

// Load-time gate: malformed content throws here (build/test time),
// never silently renders as a broken lesson.
const CONTENT_ERRORS = validateAcademyContent();
if (CONTENT_ERRORS.length > 0) {
  throw new Error(`Academy content validation failed:\n- ${CONTENT_ERRORS.join("\n- ")}`);
}
