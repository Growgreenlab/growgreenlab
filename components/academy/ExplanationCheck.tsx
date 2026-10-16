"use client";

/**
 * ExplanationCheck — structured explanation questions (spec §5E).
 *
 * Explanations are assessed through structured choices, never
 * exact-string matching: every option carries rubric feedback saying
 * which part of the statement is supported and which part needs
 * revision. The correct option is revealed only after committing.
 */
import { useState } from "react";
import type { ChoiceQuestion } from "../../lib/academy/types";

export default function ExplanationCheck({
  questions,
  onConceptResult,
  onActivity,
}: {
  questions: ChoiceQuestion[];
  onConceptResult?: (concept: string, correct: boolean) => void;
  onActivity?: () => void;
}) {
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({});

  return (
    <div className="ggl-ex">
      {questions.map((q, n) => {
        const pick = chosen[q.id];
        const done = submitted[q.id] === true;
        const pickedOption = typeof pick === "number" ? q.options[pick] : null;
        return (
          <article key={q.id} className="ggl-ex-card">
            <p className="ggl-ex-num">Question {n + 1}</p>
            <p className="ggl-ex-prompt">{q.prompt}</p>
            <div role="radiogroup" aria-label={q.prompt} className="ggl-ex-options">
              {q.options.map((opt, i) => (
                <label key={i} className={`ggl-ex-opt ${pick === i ? "ggl-ex-opt-on" : ""}`}>
                  <input
                    type="radio"
                    name={`ex-${q.id}`}
                    checked={pick === i}
                    disabled={done}
                    onChange={() => setChosen((s) => ({ ...s, [q.id]: i }))}
                  />
                  <span>{opt.text}</span>
                </label>
              ))}
            </div>
            {!done ? (
              <button
                type="button"
                className="ggl-btn ggl-btn-primary"
                disabled={typeof pick !== "number"}
                onClick={() => {
                  setSubmitted((s) => ({ ...s, [q.id]: true }));
                  onConceptResult?.(q.concept, pickedOption?.correct === true);
                  onActivity?.();
                }}
              >
                Commit answer
              </button>
            ) : (
              <div className="ggl-ex-feedback" aria-live="polite">
                <p>
                  <strong>{pickedOption?.correct ? "Accurate." : "Needs revision."}</strong>{" "}
                  {pickedOption?.feedback}
                </p>
                {!pickedOption?.correct && (
                  <p>
                    The accurate statement was:{" "}
                    <strong>“{q.options.find((o) => o.correct)?.text}”</strong> —{" "}
                    {q.options.find((o) => o.correct)?.feedback}
                  </p>
                )}
                <button
                  type="button"
                  className="ggl-btn ggl-btn-ghost"
                  onClick={() => {
                    setSubmitted((s) => ({ ...s, [q.id]: false }));
                    setChosen((s) => ({ ...s, [q.id]: -1 }));
                  }}
                >
                  Try again
                </button>
              </div>
            )}
          </article>
        );
      })}
      <style>{`
        .ggl-ex-card { border: 1px solid var(--ggl-border); background: var(--ggl-bg2); border-radius: 12px; padding: 18px; margin-bottom: 14px; }
        .ggl-ex-num { color: var(--ggl-muted); font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 8px; }
        .ggl-ex-prompt { color: var(--ggl-text); font-size: 16px; font-weight: 600; line-height: 1.55; margin: 0 0 14px; }
        .ggl-ex-options { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
        .ggl-ex-opt { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--ggl-border); border-radius: 10px; padding: 11px 13px; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.55; cursor: pointer; }
        .ggl-ex-opt-on { border-color: var(--ggl-green); color: var(--ggl-text); }
        .ggl-ex-opt input { accent-color: var(--ggl-green); width: 18px; height: 18px; margin-top: 2px; flex: none; }
        .ggl-ex-feedback { border-top: 1px solid var(--ggl-border); padding-top: 12px; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.6; }
        .ggl-ex-feedback p { margin: 0 0 8px; }
        .ggl-ex-feedback strong { color: var(--ggl-text); }
        .ggl-ex button:focus-visible, .ggl-ex input:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
      `}</style>
    </div>
  );
}
