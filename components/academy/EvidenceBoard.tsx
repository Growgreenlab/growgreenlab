"use client";

/**
 * EvidenceBoard — the Academy's recurring interaction (spec §6).
 *
 * Statements are classified into Observed Fact / Reasonable
 * Interpretation / Overreach / Needs More Data against a stated
 * context. The key is revealed ONLY after the learner commits a
 * classification for that statement. Feedback explains the evidence
 * behind the key and names the misconception the item targets.
 * Categories are full text labels (never color-only). First-try
 * results are reported per concept to the progress store's
 * misconception tracker; retries are always allowed.
 */
import { useRef, useState } from "react";
import {
  EVIDENCE_CATEGORIES,
  evidenceCategoryLabel,
  type EvidenceCategory,
  type EvidenceItem,
} from "../../lib/academy/types";

interface ItemState {
  chosen: EvidenceCategory | null;
  submitted: boolean;
  firstTryRecorded: boolean;
}

export default function EvidenceBoard({
  items,
  onConceptResult,
  onActivity,
  numberOffset = 0,
}: {
  items: EvidenceItem[];
  /** Called once per item, on its FIRST submission: (concept, correct). */
  onConceptResult?: (concept: string, correct: boolean) => void;
  onActivity?: () => void;
  /**
   * Statements are numbered from numberOffset + 1, so a lesson with
   * a second board (the explore-deeper set) continues the count
   * instead of restarting at 1. Default 0.
   */
  numberOffset?: number;
}) {
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const firstTry = useRef({ correct: 0, total: 0 });

  const get = (id: string): ItemState => states[id] ?? { chosen: null, submitted: false, firstTryRecorded: false };
  const set = (id: string, patch: Partial<ItemState>) =>
    setStates((s) => ({ ...s, [id]: { ...get(id), ...patch } }));

  const submit = (item: EvidenceItem) => {
    const st = get(item.id);
    if (!st.chosen || st.submitted) return;
    const correct = st.chosen === item.key;
    if (!st.firstTryRecorded) {
      firstTry.current.total += 1;
      if (correct) firstTry.current.correct += 1;
      onConceptResult?.(item.concept, correct);
    }
    set(item.id, { submitted: true, firstTryRecorded: true });
    onActivity?.();
  };

  const retry = (item: EvidenceItem) => set(item.id, { chosen: null, submitted: false });

  const doneCount = items.filter((i) => get(i.id).firstTryRecorded).length;

  return (
    <div className="ggl-eb">
      <p className="ggl-eb-summary" aria-live="polite">
        {doneCount === 0
          ? `${items.length} statements. Classify each one against its evidence — the answer appears only after you commit.`
          : `${doneCount} of ${items.length} classified · first-try correct: ${firstTry.current.correct} of ${firstTry.current.total}.`}
      </p>
      {items.map((item, n) => {
        const st = get(item.id);
        const correct = st.submitted && st.chosen === item.key;
        return (
          <article key={item.id} className="ggl-eb-card">
            <p className="ggl-eb-num">Statement {n + 1 + numberOffset}</p>
            <p className="ggl-eb-context">
              <span>Evidence shown:</span> {item.context}
            </p>
            <p className="ggl-eb-statement">“{item.statement}”</p>
            <div className="ggl-eb-options" role="group" aria-label={`Classify statement ${n + 1 + numberOffset}`}>
              {EVIDENCE_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  aria-pressed={st.chosen === cat.id}
                  disabled={st.submitted}
                  className={`ggl-eb-opt ${st.chosen === cat.id ? "ggl-eb-opt-on" : ""}`}
                  onClick={() => set(item.id, { chosen: cat.id })}
                  title={cat.blurb}
                >
                  {cat.label}
                </button>
              ))}
            </div>
            {!st.submitted ? (
              <button
                type="button"
                className="ggl-btn ggl-btn-primary"
                disabled={!st.chosen}
                onClick={() => submit(item)}
              >
                Commit classification
              </button>
            ) : (
              <div className="ggl-eb-feedback" aria-live="polite">
                <p>
                  <strong>{correct ? "Correct." : `Not quite — this is ${evidenceCategoryLabel(item.key)}.`}</strong>{" "}
                  {item.rationale}
                </p>
                {!correct && (
                  <>
                    <p>
                      <strong>Common misconception:</strong> {item.misconception}
                    </p>
                    <button type="button" className="ggl-btn ggl-btn-ghost" onClick={() => retry(item)}>
                      Try this one again
                    </button>
                  </>
                )}
              </div>
            )}
          </article>
        );
      })}
      <style>{`
        .ggl-eb-summary { color: var(--ggl-text2); font-size: 14.5px; margin: 0 0 14px; }
        .ggl-eb-card { border: 1px solid var(--ggl-border); background: var(--ggl-bg2); border-radius: 12px; padding: 18px; margin-bottom: 14px; }
        .ggl-eb-num { color: var(--ggl-muted); font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 8px; }
        .ggl-eb-context { color: var(--ggl-text2); font-size: 14px; line-height: 1.55; margin: 0 0 8px; }
        .ggl-eb-context span { color: var(--ggl-muted); font-weight: 700; }
        .ggl-eb-statement { color: var(--ggl-text); font-size: 16.5px; font-weight: 600; line-height: 1.5; margin: 0 0 14px; }
        .ggl-eb-options { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
        .ggl-eb-opt { background: transparent; border: 1px solid var(--ggl-border); color: var(--ggl-text2); border-radius: 999px; padding: 9px 14px; font-size: 13.5px; font-weight: 600; cursor: pointer; min-height: 44px; }
        .ggl-eb-card .ggl-btn { min-height: 44px; }
        .ggl-eb-opt-on { border-color: var(--ggl-green); color: var(--ggl-green); background: rgba(66,216,121,0.08); }
        .ggl-eb-opt:disabled { opacity: 0.65; cursor: default; }
        .ggl-eb-feedback { border-top: 1px solid var(--ggl-border); padding-top: 12px; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.6; }
        .ggl-eb-feedback p { margin: 0 0 8px; }
        .ggl-eb-feedback strong { color: var(--ggl-text); }
        .ggl-eb button:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
      `}</style>
    </div>
  );
}
