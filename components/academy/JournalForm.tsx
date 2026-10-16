"use client";

/**
 * JournalForm — the lightweight decision journal (spec §8).
 *
 * Four structured reflection prompts. Ungraded free text, saved via
 * the progress store: on-device for guests, to the owner-RLS
 * academy_journal table when signed in and the migration is live.
 * Private by design — nothing here is ever shown to other learners.
 */
import { useState } from "react";
import type { JournalPrompt } from "../../lib/academy/types";

export default function JournalForm({
  prompts,
  initial,
  onSave,
}: {
  prompts: JournalPrompt[];
  initial: Record<string, string>;
  onSave: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  const save = () => {
    onSave(values);
    setSavedAt(Date.now());
    setDirty(false);
  };

  return (
    <div className="ggl-jf">
      {prompts.map((p) => (
        <div key={p.key} className="ggl-jf-row">
          <label htmlFor={`jf-${p.key}`}>{p.label}</label>
          <textarea
            id={`jf-${p.key}`}
            rows={3}
            value={values[p.key] ?? ""}
            placeholder="A sentence or two is plenty."
            onChange={(e) => {
              setValues((v) => ({ ...v, [p.key]: e.target.value }));
              setDirty(true);
            }}
          />
        </div>
      ))}
      <div className="ggl-jf-actions">
        <button type="button" className="ggl-btn ggl-btn-primary" onClick={save}>
          Save reflections
        </button>
        <span className="ggl-jf-status" aria-live="polite">
          {dirty
            ? "Unsaved changes."
            : savedAt
              ? "Saved — private to you."
              : "Private to you — never shown to other learners."}
        </span>
      </div>
      <style>{`
        .ggl-jf-row { margin-bottom: 14px; }
        .ggl-jf-row label { display: block; color: var(--ggl-text); font-weight: 600; font-size: 14.5px; margin-bottom: 6px; }
        .ggl-jf-row textarea { width: 100%; box-sizing: border-box; background: var(--ggl-bg2); border: 1px solid var(--ggl-border); color: var(--ggl-text); border-radius: 10px; padding: 11px 13px; font-size: 14.5px; line-height: 1.55; font-family: inherit; resize: vertical; }
        .ggl-jf-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
        .ggl-jf-status { color: var(--ggl-muted); font-size: 13.5px; }
        .ggl-jf textarea:focus-visible, .ggl-jf button:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
      `}</style>
    </div>
  );
}
