/**
 * Trading Academy — content registry (Stage 2) + the Candlestick
 * Basics seven-lesson beginner path (World 1).
 *
 * The registry lists all twelve worlds from the master spec with
 * honest status: only World 1 is "available"; the rest are "planned"
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
    slug: "candlestick-basics",
    title: "Candlestick Basics",
    tagline: "Start with one candle: build it, watch it form, and separate what it shows from what it cannot prove.",
    topics: ["What a candle shows", "Green vs. red candles", "Open, High, Low, Close", "Build your first candle", "Watch a candle form", "Reading evidence honestly"],
    status: "available",
    prerequisites: "",
    lessonSlug: "what-is-a-candlestick",
  },
  {
    number: 2,
    slug: "market-foundations",
    title: "Stock Market Foundations",
    tagline: "What a stock is, how prices form, and how trading sessions work.",
    topics: ["Shares & exchanges", "Bid, ask, spread, last price", "Market cap vs share price", "Sessions & extended hours", "Charts & timeframes", "Investing vs trading"],
    status: "planned",
    prerequisites: "",
    lessonSlug: null,
  },
  {
    number: 3,
    slug: "price-action-structure",
    title: "Price Action and Chart Structure",
    tagline: "Swings, trends, ranges, support and resistance as zones — and what a breakout actually is.",
    topics: ["Swing highs & lows", "Trends & ranges", "Support & resistance zones", "Breakouts, retests, failed moves", "Continuation vs reversal"],
    status: "planned",
    prerequisites: "World 1 — Candlestick Basics",
    lessonSlug: null,
  },
  {
    number: 4,
    slug: "order-execution",
    title: "Order Execution and Trading Mechanics",
    tagline: "Order types, fills, slippage, and why a stop price is not a guaranteed fill price.",
    topics: ["Market, limit, stop orders", "Buying, selling, shorting", "Fills & partial fills", "Slippage & liquidity", "Stop-loss & take-profit"],
    status: "planned",
    prerequisites: "World 2 — Stock Market Foundations",
    lessonSlug: null,
  },
  {
    number: 5,
    slug: "volume-activity",
    title: "Volume and Market Activity",
    tagline: "What volume measures, relative volume, and the limits of volume as evidence.",
    topics: ["Volume bars", "Relative volume (RVOL)", "Volume & price movement", "Volume in breakouts & pullbacks", "Limits of volume evidence"],
    status: "planned",
    prerequisites: "World 1 — Candlestick Basics",
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
    prerequisites: "Worlds 1, 3 and 5",
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
    prerequisites: "Worlds 1–10",
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
/* Beginner checks: Lesson 1 (one question) and Lesson 3 (one per term) */
/* ------------------------------------------------------------------ */

export const L1_CHECKS: ChoiceQuestion[] = [
  {
    id: "l1-candle-shows",
    concept: "candle-basics",
    prompt: "What does a candlestick show?",
    options: [
      {
        text: "A summary of how price moved during one period of time.",
        correct: true,
        feedback: "Exactly. One candle sums up one period — where price started, how far it travelled, and where it ended.",
      },
      {
        text: "The reason every trader decided to buy or sell.",
        correct: false,
        feedback: "Not quite. A candle records price movement. It does not record anyone's reasons.",
      },
      {
        text: "A promise about what the next candle will do.",
        correct: false,
        feedback: "Not quite. A candle describes the period that already happened. It makes no promise about the next one.",
      },
      {
        text: "Only the final price, and nothing else.",
        correct: false,
        feedback: "Close — the final price is in there, but a candle also keeps the period's first, highest, and lowest prices.",
      },
    ],
  },
];

export const L3_CHECKS: ChoiceQuestion[] = [
  {
    id: "l3-open",
    concept: "ohlc-open",
    prompt: "A candle's period began at $10.00. Which statement is accurate?",
    options: [
      {
        text: "The Open is $10.00 — the first price of the period.",
        correct: true,
        feedback: "Correct. Open always means the price the period started with.",
      },
      {
        text: "The Open is the highest price of the period.",
        correct: false,
        feedback: "Not quite — the highest price is the High. The Open is simply where the period began: $10.00.",
      },
      {
        text: "The Open is wherever the period ended.",
        correct: false,
        feedback: "Not quite — where the period ended is the Close. The Open is the first price: $10.00.",
      },
    ],
  },
  {
    id: "l3-high",
    concept: "ohlc-high",
    prompt: "During one period, price reached $10.20, $10.55, and $10.40. What is the High?",
    options: [
      {
        text: "$10.55 — the highest price reached during the period.",
        correct: true,
        feedback: "Correct. The High keeps the single highest price, even if price did not stay there.",
      },
      {
        text: "$10.40 — the last price mentioned.",
        correct: false,
        feedback: "Not quite. The last price would matter for the Close. The High is the highest price reached: $10.55.",
      },
      {
        text: "$10.20 — the first price mentioned.",
        correct: false,
        feedback: "Not quite. The first price would be the Open. The High is the highest price reached: $10.55.",
      },
    ],
  },
  {
    id: "l3-low",
    concept: "ohlc-low",
    prompt: "During one period, price dipped to $9.80 before recovering. What does $9.80 become?",
    options: [
      {
        text: "The Low — the lowest price reached during the period.",
        correct: true,
        feedback: "Correct. The Low keeps the single lowest price, even if price bounced back right away.",
      },
      {
        text: "The Close — because price recovered afterwards.",
        correct: false,
        feedback: "Not quite. The Close is the final price when the period ends. The lowest point reached is the Low: $9.80.",
      },
      {
        text: "Nothing — a price only counts if the period ends there.",
        correct: false,
        feedback: "Not quite. A brief dip still counts. The Low records the lowest price reached during the whole period.",
      },
    ],
  },
  {
    id: "l3-close",
    concept: "ohlc-close",
    prompt: "A period ends with a final price of $10.30. Which statement is accurate?",
    options: [
      {
        text: "The Close is $10.30 — the price the period ended with.",
        correct: true,
        feedback: "Correct. When the period ends, its final price becomes the Close.",
      },
      {
        text: "The Close is the average of all prices in the period.",
        correct: false,
        feedback: "Not quite. No averaging happens. The Close is simply the last price: $10.30.",
      },
      {
        text: "The Close must equal the Open.",
        correct: false,
        feedback: "Not quite. Open and Close are often different — that difference is the candle's body.",
      },
    ],
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
/* Candlestick Basics — the seven-lesson beginner path (World 1)       */
/* ------------------------------------------------------------------ */

const FIRST_EVIDENCE = EVIDENCE_ITEMS.slice(0, 6);
const REMAINING_EVIDENCE = EVIDENCE_ITEMS.slice(6);
const REMAINING_CHALLENGES = CANDLE_CHALLENGES.slice(1);

export const CANDLE_BASICS_LESSONS: LessonDef[] = [
  {
    id: "candle-basics-1",
    slug: "what-is-a-candlestick",
    worldNumber: 1,
    order: 1,
    title: "What Is a Candlestick?",
    tagline: "Let's start with just one candle.",
    objectives: [
      "Say, in your own words, what a candlestick shows.",
      "Point to the body and the wicks on a candle.",
      "Explain the difference between a one-minute candle and a five-minute candle.",
    ],
    estimatedMinutes: 4,
    difficulty: "Beginner",
    prerequisites: "None — this is the very first lesson.",
    masteryThreshold: 80,
    sections: [
      {
        id: "welcome",
        kind: "objectives",
        title: "Let's start with just one candle",
        paragraphs: [
          "A candlestick is a small picture of how price moved during one period of time.",
          "If the period is one minute, the candle summarizes that one minute. If the period is five minutes, it summarizes those five minutes. Same picture — a different amount of time inside it.",
        ],
        bullets: [],
      },
      {
        id: "meet-the-candle",
        kind: "tap-reveal",
        title: "Meet the candle",
        paragraphs: [
          "Here is one candle, nice and large. Tap each part to see what it is. There is nothing to memorize yet — just look.",
        ],
        bullets: [],
      },
      {
        id: "quick-check",
        kind: "explanation",
        title: "One quick check",
        paragraphs: [
          "One question, that's all. If you miss it, the feedback will show you why — that's how learning works here.",
        ],
        bullets: [],
        level: "practice",
        contentIds: ["l1-candle-shows"],
      },
    ],
  },
  {
    id: "candle-basics-2",
    slug: "green-vs-red-candles",
    worldNumber: 1,
    order: 2,
    title: "Green vs. Red Candles",
    tagline: "Two prices decide the color: where it opened, and where it closed.",
    objectives: [
      "Decide whether a candle is bullish or bearish by comparing its close with its open.",
      "Recognize a doji, where open and close finish equal or nearly equal.",
      "Explain why a candle's color never predicts the next candle.",
    ],
    estimatedMinutes: 5,
    difficulty: "Beginner",
    prerequisites: "Lesson 1 — What Is a Candlestick?",
    masteryThreshold: 80,
    sections: [
      {
        id: "two-prices",
        kind: "objectives",
        title: "Start with two prices",
        paragraphs: [
          "Every candle has an opening price and a closing price. To understand the color, we compare those two — nothing more.",
          "Notice where the candle opened. Then look at where it closed. That comparison is the whole rule.",
        ],
        bullets: [],
      },
      {
        id: "the-three-rules",
        kind: "concept",
        title: "The three rules",
        paragraphs: [
          "Green, or bullish: the closing price is higher than the opening price.",
          "Red, or bearish: the closing price is lower than the opening price.",
          "If the opening and closing prices are equal or nearly equal, the candle may be classified as a doji. In this Academy, nearly equal means the body — the gap between open and close — is at most 5% of the candle's full range.",
        ],
        bullets: [
          "Bullish and bearish describe this candle only.",
          "A green candle does not predict a green next candle.",
          "A red candle does not predict a red next candle.",
        ],
      },
      {
        id: "direction-practice",
        kind: "direction-practice",
        title: "Try it yourself",
        paragraphs: [
          "One candle at a time. Compare the close with the open, then choose. We'll start with obvious ones.",
        ],
        bullets: [],
        level: "practice",
      },
      {
        id: "color-is-not-a-forecast",
        kind: "concept",
        title: "Explore deeper: color is not a forecast",
        paragraphs: [
          "A color summarizes one finished period. The next period gets its own open, its own movement, and its own close — so it has to be read when it forms, not guessed from the candle before it.",
          "Good traders describe what a candle did. They are careful about claiming what the next one must do.",
        ],
        bullets: [],
        level: "explore",
      },
    ],
  },
  {
    id: "candle-basics-3",
    slug: "meet-ohlc",
    worldNumber: 1,
    order: 3,
    title: "Meet OHLC",
    tagline: "Four prices make every candle. We'll meet them one at a time.",
    objectives: [
      "Name the Open, High, Low, and Close of a candle.",
      "Point to where each of the four prices sits on the candle.",
      "Explain each price in one short sentence.",
    ],
    estimatedMinutes: 6,
    difficulty: "Beginner",
    prerequisites: "Lesson 2 — Green vs. Red Candles",
    masteryThreshold: 80,
    sections: [
      {
        id: "one-at-a-time",
        kind: "objectives",
        title: "Four prices, one at a time",
        paragraphs: [
          "OHLC is just four short words: Open, High, Low, Close. They sound technical, but each one is a simple idea.",
          "We will highlight one price at a time on the same candle. Take each step slowly.",
        ],
        bullets: [],
      },
      {
        id: "ohlc-explorer",
        kind: "ohlc-explorer",
        title: "Meet Open, High, Low, and Close",
        paragraphs: [
          "Follow the highlight. After each price, there is one easy question before we move on.",
        ],
        bullets: [],
        contentIds: ["l3-open", "l3-high", "l3-low", "l3-close"],
      },
      {
        id: "how-they-fit",
        kind: "concept",
        title: "Explore deeper: how the four prices fit together",
        paragraphs: [
          "The four prices always fit one rule: the Low is never above the lower of Open and Close, and the High is never below the higher of Open and Close.",
          "In plain words: the High must reach at least as high as both the start and the finish, and the Low must reach at least as low. A candle that breaks that rule isn't a candle — it's a data error.",
        ],
        bullets: [],
        level: "explore",
      },
    ],
  },
  {
    id: "candle-basics-4",
    slug: "build-your-first-candlestick",
    worldNumber: 1,
    order: 4,
    title: "Build Your First Candlestick",
    tagline: "Your turn. Change one price at a time and watch the candle respond.",
    objectives: [
      "Build a valid candle by setting Open, High, Low, and Close.",
      "Explain why the High and Low sometimes move when you set another price.",
      "Build a bullish candle on purpose.",
    ],
    estimatedMinutes: 8,
    difficulty: "Beginner",
    prerequisites: "Lesson 3 — Meet OHLC",
    masteryThreshold: 80,
    sections: [
      {
        id: "your-turn",
        kind: "objectives",
        title: "Your turn to build",
        paragraphs: [
          "You know the four prices now. In this lesson you set them yourself.",
          "Change one price at a time and watch what the candle does. There is no timer, and nothing here can be broken.",
        ],
        bullets: [],
      },
      {
        id: "builder",
        kind: "candle-builder",
        title: "Build a candle",
        paragraphs: [
          "Move the sliders or type exact values — the candle updates right away.",
          "One rule protects every candle: High can't be lower than the highest of Open and Close, and Low can't be higher than the lowest of Open and Close. If a number can't stay where you put it, the builder moves it to the nearest place that works and tells you why, in plain words.",
        ],
        bullets: [],
      },
      {
        id: "first-target",
        kind: "challenges",
        title: "Try it yourself: one target",
        paragraphs: [
          "Now use a fresh builder for one target shape. The feedback uses your candle's actual numbers, so read it — it tells you exactly what to adjust.",
        ],
        bullets: [],
        level: "practice",
        contentIds: ["ch-bullish"],
      },
      {
        id: "exact-numbers",
        kind: "concept",
        title: "Explore deeper: range, body, and wicks",
        paragraphs: [
          "Three measurements describe any candle. The range is High minus Low — the full distance price travelled. The body is the gap between Open and Close. The wicks are what's left: how far price travelled beyond the body, above and below.",
          "You never need to calculate these by hand — the builder shows them — but knowing what they mean makes every candle easier to read.",
        ],
        bullets: [],
        level: "explore",
      },
    ],
  },
  {
    id: "candle-basics-5",
    slug: "watch-a-candle-form",
    worldNumber: 1,
    order: 5,
    title: "Watch a Candle Form",
    tagline: "A candle isn't finished until its period ends. Watch one grow.",
    objectives: [
      "Describe how the body and wicks change while a candle is still forming.",
      "Make a prediction before a candle finishes, and compare it with the result calmly.",
      "Explain why an unfinished candle can still change direction.",
    ],
    estimatedMinutes: 5,
    difficulty: "Beginner",
    prerequisites: "Lesson 4 — Build Your First Candlestick",
    masteryThreshold: 80,
    sections: [
      {
        id: "still-forming",
        kind: "objectives",
        title: "A candle grows before it settles",
        paragraphs: [
          "So far, every candle you saw was finished. This time, watch one while it is still forming.",
          "The demonstration uses simulated prices made for this lesson — educational data, not a real market.",
        ],
        bullets: [],
      },
      {
        id: "formation",
        kind: "formation-demo",
        title: "Watch a candle form",
        paragraphs: [
          "See the starting price first. Before the candle finishes, make a prediction: will it close bullish, bearish, or as a doji?",
          "Then play it and compare. A prediction that misses is not a failure — noticing why it missed is the lesson.",
        ],
        bullets: [],
        level: "practice",
      },
      {
        id: "unfinished-can-change",
        kind: "concept",
        title: "Explore deeper: an unfinished candle can change",
        paragraphs: [
          "While a period is still running, the current price keeps moving — so the body can stretch, shrink, and even flip from green to red. Only the final price, at the period's end, becomes the Close.",
          "That's why careful traders wait for a candle to finish before describing what it did.",
        ],
        bullets: [],
        level: "explore",
      },
    ],
  },
  {
    id: "candle-basics-6",
    slug: "read-what-the-candle-says",
    worldNumber: 1,
    order: 6,
    title: "Read What the Candle Actually Says",
    tagline: "Separate what the candle shows from what we guess about it.",
    objectives: [
      "Tell an observation apart from an interpretation.",
      "Spot a conclusion the evidence doesn't support.",
      "Use Needs More Data when the evidence isn't enough.",
    ],
    estimatedMinutes: 10,
    difficulty: "Beginner",
    prerequisites: "Lesson 5 — Watch a Candle Form",
    masteryThreshold: 80,
    sections: [
      {
        id: "three-kinds-of-say",
        kind: "objectives",
        title: "Three kinds of saying",
        paragraphs: [
          "Here is one candle, read three ways. Observation: the candle closed below its opening price. Reasonable interpretation: price finished the period lower than it started. Unsupported conclusion: sellers definitely controlled every moment, or the next candle must be red.",
          "A candle summarizes price action. It does not directly reveal every trader's intentions — and honest reading means knowing the difference.",
        ],
        bullets: [],
      },
      {
        id: "evidence-start",
        kind: "evidence-board",
        title: "Try it yourself: sort the statements",
        paragraphs: [
          `For each of the ${FIRST_EVIDENCE.length} statements, judge it against the evidence shown: is it an Observed Fact, a Reasonable Interpretation, an Overreach, or something that Needs More Data? The answer appears only after you commit — and a wrong first answer is useful information, not a failure.`,
        ],
        bullets: [],
        level: "practice",
        contentIds: FIRST_EVIDENCE.map((i) => i.id),
      },
      {
        id: "evidence-more",
        kind: "evidence-board",
        title: "Explore deeper: more statements",
        paragraphs: [
          `Ready for more? These ${REMAINING_EVIDENCE.length} statements are trickier — some sound confident but claim more than the candle can prove.`,
        ],
        bullets: [],
        level: "explore",
        contentIds: REMAINING_EVIDENCE.map((i) => i.id),
      },
    ],
  },
  {
    id: "candle-basics-7",
    slug: "beginner-practice-and-mastery",
    worldNumber: 1,
    order: 7,
    title: "Beginner Practice and Mastery",
    tagline: "Bring the pieces together — short practice, then the mastery check.",
    objectives: [
      "Identify candle direction and candle parts without help.",
      "Build candle shapes on purpose.",
      "Interpret a finished candle without claiming more than it shows.",
      "Score at least 80% on the mastery check to mark this path Mastered.",
    ],
    estimatedMinutes: 15,
    difficulty: "Beginner",
    prerequisites: "Lessons 1–6 — the rest of Candlestick Basics",
    masteryThreshold: 80,
    sections: [
      {
        id: "put-it-together",
        kind: "objectives",
        title: "Put the pieces together",
        paragraphs: [
          "You've met every idea on this path: what a candle shows, green versus red, the four prices, building, forming, and honest reading.",
          "Now practice each one briefly, then take the mastery check. Every exercise explains itself after a mistake — a red cross alone teaches nothing.",
        ],
        bullets: [],
      },
      {
        id: "practice-challenges",
        kind: "challenges",
        title: "Try it yourself: short practice",
        paragraphs: [
          `Work through the ${REMAINING_CHALLENGES.length} challenges below. There is no timer and no penalty for retrying — rebuild as many times as you need.`,
        ],
        bullets: [],
        level: "practice",
        contentIds: REMAINING_CHALLENGES.map((c) => c.id),
      },
      {
        id: "explanations",
        kind: "explanation",
        title: "Explain it accurately",
        paragraphs: [
          `Knowing a shape is not the same as reasoning about it accurately. These ${EXPLANATION_QUESTIONS.length} questions ask which statement about a candle is actually supported. Each option carries its own feedback, so a wrong pick shows you which part of the statement went too far.`,
        ],
        bullets: [],
        level: "practice",
        contentIds: EXPLANATION_QUESTIONS.map((q) => q.id),
      },
      {
        id: "assessment",
        kind: "assessment",
        title: "Mastery check",
        paragraphs: [
          `${ASSESSMENT_ITEMS.length} questions across everything on this path: classifying candles (including boundary and doji cases), interpreting wicks without inventing intent, and sorting facts from claims. Score 80% or higher to mark this path Mastered. Attempts are unlimited, and your best score is kept — but a score only ever reflects the answers you actually gave.`,
          "Scored below 80%? The feedback under each question shows what to review — revisit that lesson above, then retake whenever you're ready.",
        ],
        bullets: [],
        level: "practice",
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
          "A candle is four numbers with one inviolable constraint. Bullish and bearish describe where the close landed relative to the open — nothing more. Wicks record that price travelled somewhere and did not stay there; why it retreated is an interpretation, never a fact a single candle can prove. And no candle, however dramatic, guarantees the next one.",
        ],
        bullets: [
          "Fact: what the numbers say. Interpretation: a story consistent with them. Overreach: certainty the data does not contain.",
          "When the evidence is incomplete, 'Needs More Data' — and waiting — is a correct, professional answer.",
        ],
      },
    ],
  },
];

export const LESSONS: LessonDef[] = [...CANDLE_BASICS_LESSONS];

export function getLessonBySlug(slug: string): LessonDef | null {
  return LESSONS.find((l) => l.slug === slug) ?? null;
}

export function getLessonsForWorld(worldNumber: number): LessonDef[] {
  return LESSONS.filter((l) => l.worldNumber === worldNumber).sort((a, b) => a.order - b.order);
}

export function getWorld(number: number): WorldDef | null {
  return WORLDS.find((w) => w.number === number) ?? null;
}

/* ------------------------------------------------------------------ */
/* Validation — malformed content must fail loudly, never render.      */
/* ------------------------------------------------------------------ */

/** Every structured choice question, across all lesson banks. */
export const ALL_CHOICE_QUESTIONS: ChoiceQuestion[] = [
  ...L1_CHECKS,
  ...L3_CHECKS,
  ...EXPLANATION_QUESTIONS,
];

export function questionsByIds(ids: readonly string[]): ChoiceQuestion[] {
  const byId = new Map(ALL_CHOICE_QUESTIONS.map((q) => [q.id, q]));
  return ids.flatMap((id) => {
    const q = byId.get(id);
    return q ? [q] : [];
  });
}

export function challengesByIds(ids: readonly string[]): ChallengeDef[] {
  const byId = new Map(CANDLE_CHALLENGES.map((c) => [c.id, c]));
  return ids.flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  });
}

export function evidenceByIds(ids: readonly string[]): EvidenceItem[] {
  const byId = new Map(EVIDENCE_ITEMS.map((i) => [i.id, i]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

const SECTION_KINDS = new Set([
  "objectives", "concept", "tap-reveal", "direction-practice", "ohlc-explorer",
  "formation-demo", "candle-builder", "challenges",
  "evidence-board", "explanation", "assessment", "journal", "summary",
]);
const SECTION_LEVELS = new Set(["learn", "practice", "explore"]);
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
  if (!Number.isInteger(lesson.order) || lesson.order < 1) errors.push(`lesson ${lesson.id}: order must be a positive integer`);
  if (!(lesson.masteryThreshold > 0 && lesson.masteryThreshold <= 100)) errors.push(`lesson ${lesson.id}: masteryThreshold out of (0,100]`);
  if (lesson.objectives.length === 0) errors.push(`lesson ${lesson.id}: no objectives`);
  if (lesson.sections.length === 0) errors.push(`lesson ${lesson.id}: no sections`);
  const sectionIds = new Set<string>();
  for (const s of lesson.sections) {
    if (sectionIds.has(s.id)) errors.push(`lesson ${lesson.id}: duplicate section id ${s.id}`);
    sectionIds.add(s.id);
    if (!SECTION_KINDS.has(s.kind)) errors.push(`lesson ${lesson.id}: unknown section kind ${s.kind}`);
    if (!s.title.trim()) errors.push(`lesson ${lesson.id}: section ${s.id} has no title`);
    if (s.level !== undefined && !SECTION_LEVELS.has(s.level)) errors.push(`lesson ${lesson.id}: section ${s.id} has unknown level ${s.level}`);
    if (s.contentIds !== undefined && (s.contentIds.length === 0 || s.contentIds.some((id) => !id.trim()))) {
      errors.push(`lesson ${lesson.id}: section ${s.id} has empty contentIds`);
    }
  }
  return errors;
}

/** Registry-level lesson integrity: unique ids/slugs, unique order per world. */
export function validateLessons(lessons: readonly LessonDef[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const orders = new Set<string>();
  for (const l of lessons) {
    if (ids.has(l.id)) errors.push(`lessons: duplicate id ${l.id}`);
    ids.add(l.id);
    if (slugs.has(l.slug)) errors.push(`lessons: duplicate slug ${l.slug}`);
    slugs.add(l.slug);
    const orderKey = `${l.worldNumber}:${l.order}`;
    if (orders.has(orderKey)) errors.push(`lessons: duplicate order ${l.order} in world ${l.worldNumber}`);
    orders.add(orderKey);
  }
  return errors;
}

/** Section contentIds must point at real bank entries for their kind. */
export function validateSectionReferences(lessons: readonly LessonDef[]): string[] {
  const errors: string[] = [];
  const known: Partial<Record<string, Set<string>>> = {
    challenges: new Set(CANDLE_CHALLENGES.map((c) => c.id)),
    "evidence-board": new Set(EVIDENCE_ITEMS.map((i) => i.id)),
    explanation: new Set(ALL_CHOICE_QUESTIONS.map((q) => q.id)),
    "ohlc-explorer": new Set(L3_CHECKS.map((q) => q.id)),
  };
  for (const l of lessons) {
    for (const s of l.sections) {
      const set = known[s.kind];
      if (!set || !s.contentIds) continue;
      for (const id of s.contentIds) {
        if (!set.has(id)) errors.push(`lesson ${l.id}: section ${s.id} references unknown ${s.kind} content id ${id}`);
      }
    }
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

const COUNT_WORD_VALUES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * Copy/count integrity: where a section's copy STATES how many
 * exercises it contains ("11 questions…", "the 6 challenges below"),
 * the stated number must equal the real content array. The flagship
 * copy derives these numbers from the arrays at definition time;
 * this check keeps any future hand-edit honest. A section that
 * states no count is not flagged — its component renders counts
 * from the data it is given.
 */
export function validateStatedCounts(
  lesson: LessonDef,
  expected: { challenges: number; evidence: number; explanations: number; assessment: number }
): string[] {
  const errors: string[] = [];
  const byKind: Partial<Record<string, { noun: string; count: number }>> = {
    challenges: { noun: "challenges", count: expected.challenges },
    "evidence-board": { noun: "statements", count: expected.evidence },
    explanation: { noun: "questions", count: expected.explanations },
    assessment: { noun: "questions", count: expected.assessment },
  };
  for (const s of lesson.sections) {
    const base = byKind[s.kind];
    if (!base) continue;
    // A section that selects a subset states the subset's count.
    const rule = s.contentIds ? { noun: base.noun, count: s.contentIds.length } : base;
    for (const p of s.paragraphs) {
      const re = new RegExp(
        `(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s+${rule.noun}\\b`,
        "gi"
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(p)) !== null) {
        const stated = /^\d+$/.test(m[1]) ? Number(m[1]) : COUNT_WORD_VALUES[m[1].toLowerCase()];
        if (stated !== rule.count) {
          errors.push(
            `lesson ${lesson.id}: section ${s.id} copy states ${stated} ${rule.noun} but the content defines ${rule.count}`
          );
        }
      }
    }
  }
  return errors;
}

/** All content problems in the shipped registry (must be empty). */
export function validateAcademyContent(): string[] {
  return [
    ...validateWorlds(WORLDS),
    ...validateLessons(LESSONS),
    ...LESSONS.flatMap(validateLesson),
    ...validateSectionReferences(LESSONS),
    ...LESSONS.flatMap((l) =>
      validateStatedCounts(l, {
        challenges: CANDLE_CHALLENGES.length,
        evidence: EVIDENCE_ITEMS.length,
        explanations: EXPLANATION_QUESTIONS.length,
        assessment: ASSESSMENT_ITEMS.length,
      })
    ),
    ...validateChallenges(CANDLE_CHALLENGES),
    ...validateEvidenceItems(EVIDENCE_ITEMS),
    ...validateChoiceQuestions(EXPLANATION_QUESTIONS),
    ...validateChoiceQuestions(L1_CHECKS),
    ...validateChoiceQuestions(L3_CHECKS),
    ...validateAssessmentItems(ASSESSMENT_ITEMS),
  ];
}

// Load-time gate: malformed content throws here (build/test time),
// never silently renders as a broken lesson.
const CONTENT_ERRORS = validateAcademyContent();
if (CONTENT_ERRORS.length > 0) {
  throw new Error(`Academy content validation failed:\n- ${CONTENT_ERRORS.join("\n- ")}`);
}
