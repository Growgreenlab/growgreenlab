"use client";

/**
 * Assessment — the mastery check (spec §5F).
 *
 * A mixed set: classify rendered candles (keys derived from
 * candleMath), wick-interpretation choices, and facts-vs-claims
 * categorization drawn from the Evidence Board taxonomy. Scoring is
 * exercises.scoreAssessment — the result reflects the actual answers
 * (unanswered items count as incorrect), and the parent records the
 * attempt in the progress store. There is no mark-complete path:
 * "mastered" exists only at or above the threshold. Attempts are
 * unlimited; the best score is kept by the store.
 */
import { useState } from "react";
import { scoreAssessment, type AssessmentScore } from "../../lib/academy/exercises";
import type { AssessmentItem } from "../../lib/academy/types";
import CandleSvg from "./CandleSvg";

export default function Assessment({
  items,
  threshold,
  bestScore,
  attempts,
  onAttempt,
}: {
  items: AssessmentItem[];
  threshold: number;
  bestScore: number | null;
  attempts: number;
  onAttempt: (scorePct: number) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<AssessmentScore | null>(null);

  const answered = items.filter((i) => typeof answers[i.id] === "number").length;

  const submit = () => {
    const score = scoreAssessment(items, answers, threshold);
    setResult(score);
    onAttempt(score.scorePct);
  };

  const retake = () => {
    setAnswers({});
    setResult(null);
  };

  return (
    <div className="ggl-as">
      {(bestScore !== null || attempts > 0) && (
        <p className="ggl-as-history">
          Your record: {attempts} attempt{attempts === 1 ? "" : "s"}
          {bestScore !== null ? ` · best score ${bestScore}%` : ""}
          {bestScore !== null && bestScore >= threshold ? " · Mastered ✓" : ` · ${threshold}% needed for Mastered`}
        </p>
      )}
      {items.map((item, n) => {
        const pick = answers[item.id];
        const revealed = result !== null;
        const wasCorrect = revealed && result.perItem[item.id];
        return (
          <article key={item.id} className="ggl-as-card">
            <p className="ggl-as-num">
              Question {n + 1} of {items.length}
            </p>
            <p className="ggl-as-prompt">{item.prompt}</p>
            {item.candle && (
              <div className="ggl-as-candle">
                <CandleSvg candle={item.candle} height={210} showValues={false} />
                <p className="ggl-as-ohlc">
                  Open ${item.candle.open.toFixed(2)} · High ${item.candle.high.toFixed(2)} · Low $
                  {item.candle.low.toFixed(2)} · Close ${item.candle.close.toFixed(2)}
                </p>
              </div>
            )}
            <div role="radiogroup" aria-label={item.prompt} className="ggl-as-options">
              {item.options.map((opt, i) => (
                <label key={i} className={`ggl-as-opt ${pick === i ? "ggl-as-opt-on" : ""}`}>
                  <input
                    type="radio"
                    name={`as-${item.id}`}
                    checked={pick === i}
                    disabled={revealed}
                    onChange={() => setAnswers((s) => ({ ...s, [item.id]: i }))}
                  />
                  <span>{opt}</span>
                  {revealed && i === item.correctIndex && <span className="ggl-as-correct-tag">Correct answer</span>}
                </label>
              ))}
            </div>
            {revealed && (
              <p className={`ggl-as-feedback ${wasCorrect ? "ggl-as-ok" : "ggl-as-bad"}`} aria-live="polite">
                <strong>{wasCorrect ? "Correct." : "Not correct."}</strong> {item.rationale}
              </p>
            )}
          </article>
        );
      })}

      {!result ? (
        <div className="ggl-as-submit">
          <button type="button" className="ggl-btn ggl-btn-primary" onClick={submit}>
            Submit mastery check
          </button>
          <span className="ggl-as-note">
            {answered} of {items.length} answered — unanswered questions count as incorrect. Passing is{" "}
            {threshold}%+.
          </span>
        </div>
      ) : (
        <div className="ggl-as-result" aria-live="polite">
          <p className="ggl-as-score">
            You scored <strong>{result.scorePct}%</strong> ({result.correctCount} of {result.total} correct).{" "}
            {result.passed
              ? `That meets the ${threshold}% mastery bar — this lesson is now marked Mastered.`
              : `Mastery needs ${threshold}%. Review the feedback above, revisit any section, and retake whenever you're ready — attempts are unlimited.`}
          </p>
          <button type="button" className="ggl-btn ggl-btn-ghost" onClick={retake}>
            Retake the mastery check
          </button>
        </div>
      )}

      <style>{`
        .ggl-as-history { color: var(--ggl-text2); font-size: 14px; margin: 0 0 14px; }
        .ggl-as-card { border: 1px solid var(--ggl-border); background: var(--ggl-bg2); border-radius: 12px; padding: 18px; margin-bottom: 14px; }
        .ggl-as-num { color: var(--ggl-muted); font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 8px; }
        .ggl-as-prompt { color: var(--ggl-text); font-size: 16px; font-weight: 600; line-height: 1.55; margin: 0 0 12px; }
        .ggl-as-candle { margin-bottom: 10px; }
        .ggl-as-ohlc { text-align: center; color: var(--ggl-text2); font-size: 13.5px; margin: 4px 0 0; }
        .ggl-as-options { display: flex; flex-direction: column; gap: 8px; }
        .ggl-as-opt { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--ggl-border); border-radius: 10px; padding: 11px 13px; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.55; cursor: pointer; }
        .ggl-as-opt-on { border-color: var(--ggl-green); color: var(--ggl-text); }
        .ggl-as-opt input { accent-color: var(--ggl-green); width: 18px; height: 18px; margin-top: 2px; flex: none; }
        .ggl-as-correct-tag { margin-left: auto; color: var(--ggl-green); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; flex: none; }
        .ggl-as-feedback { border-radius: 10px; padding: 11px 13px; font-size: 14.5px; line-height: 1.6; margin: 12px 0 0; color: var(--ggl-text2); }
        .ggl-as-feedback strong { color: var(--ggl-text); }
        .ggl-as-ok { border: 1px solid rgba(66,216,121,0.55); }
        .ggl-as-bad { border: 1px solid rgba(246,70,93,0.55); }
        .ggl-as-submit { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
        .ggl-as-note { color: var(--ggl-muted); font-size: 13.5px; }
        .ggl-as-result { border: 1px solid var(--ggl-border); border-radius: 12px; padding: 16px; background: var(--ggl-card); }
        .ggl-as-score { color: var(--ggl-text2); font-size: 15.5px; line-height: 1.6; margin: 0 0 12px; }
        .ggl-as-score strong { color: var(--ggl-text); }
        .ggl-as button:focus-visible, .ggl-as input:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
      `}</style>
    </div>
  );
}
