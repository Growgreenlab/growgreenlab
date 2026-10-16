"use client";

/**
 * CandleBuilder — interactive OHLC construction (flagship, spec §5A).
 *
 * Four sliders + four numeric inputs, all funnelling through
 * candleMath.setCandleField, so the OHLC invariant holds on EVERY
 * input path: drag the High below the Close and the High clamps at
 * the Close instead of creating an impossible candle. Readouts
 * (range, body, wicks, classification) update immediately and come
 * from the same pinned math as the tests.
 *
 * NUMERIC INPUTS EDIT A DRAFT, NOT THE CANDLE: each field keeps a
 * local text draft while it is focused, so typing a full value
 * ("10.50") is never validated — and mangled — mid-keystroke. The
 * draft commits through the same clamping path on blur and on
 * Enter; Escape reverts the draft to the actual value; when the
 * field is not focused it displays the actual value. Text that is
 * not a number restores the previous value and says so.
 *
 * CLAMPING IS ANNOUNCED, NEVER SILENT: whenever a committed value
 * (typed or slid) is moved by the OHLC invariants, a short notice
 * near the controls names the field, the entered value, the applied
 * value, and the rule in plain words. It clears on the next
 * successful unclamped change.
 */
import { useState } from "react";
import {
  candleGeometry,
  classifyCandle,
  classLabel,
  setCandleField,
  PRICE_CEILING,
  PRICE_FLOOR,
  type Candle,
  type CandleInput,
} from "../../lib/academy/candleMath";
import CandleSvg from "./CandleSvg";

type FieldKey = keyof CandleInput;

const FIELDS: { key: FieldKey; label: string; hint: string }[] = [
  { key: "open", label: "Open", hint: "First price of the interval" },
  { key: "high", label: "High", hint: "Highest price reached" },
  { key: "low", label: "Low", hint: "Lowest price reached" },
  { key: "close", label: "Close", hint: "Final price of the interval" },
];

const SLIDER_MIN = 0;
const SLIDER_MAX = 20;

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Pure: snap any incoming control value to exact cents. Range inputs
 * can hand back raw float32 artifacts (10.4 arriving as
 * 10.399999618530272); nothing reaches candle state unrounded.
 */
export const roundToCents = (n: number): number => Math.round(n * 100) / 100;

/**
 * Pure: the only string form a builder price is ever displayed or
 * seeded into a draft in — cents-rounded, two decimals — so an input
 * can never show a raw unrounded float.
 */
export const formatBuilderValue = (n: number): string => roundToCents(n).toFixed(2);
const labelOf = (field: FieldKey) => FIELDS.find((f) => f.key === field)?.label ?? field;

/** The plain-words rule that forced a committed value to move. */
function clampReason(field: FieldKey, entered: number, applied: number, next: Candle): string {
  if (field === "high" && applied > entered) {
    return `the High can't sit below the higher of Open and Close (${money(Math.max(next.open, next.close))})`;
  }
  if (field === "low" && applied < entered) {
    return `the Low can't sit above the lower of Open and Close (${money(Math.min(next.open, next.close))})`;
  }
  if (entered < PRICE_FLOOR || entered > PRICE_CEILING) {
    return `prices in this builder stay between ${money(PRICE_FLOOR)} and ${money(PRICE_CEILING)}`;
  }
  return "the candle rule — Low ≤ Open/Close ≤ High — has to hold";
}

export default function CandleBuilder({
  initial,
  onCandleChange,
  onActivity,
}: {
  initial: Candle;
  onCandleChange?: (c: Candle) => void;
  onActivity?: () => void;
}) {
  const [candle, setCandle] = useState<Candle>(initial);
  // Per-field numeric drafts: an entry exists only while that field
  // is being edited. Absent entry = the input shows the actual value.
  const [drafts, setDrafts] = useState<Partial<Record<FieldKey, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const g = candleGeometry(candle);
  const cls = classifyCandle(candle);

  /**
   * The single commit path for sliders and typed values alike.
   * Announces the clamp when the invariant moved the entered value;
   * clears any earlier notice on a clean, unclamped change.
   */
  const applyValue = (field: FieldKey, value: number): Candle => {
    const next = setCandleField(candle, field, value);
    if (next[field] !== roundToCents(value)) {
      setNotice(
        `${labelOf(field)}: you entered ${money(value)}, but ${clampReason(field, value, next[field], next)} — so it was set to ${money(next[field])}.`
      );
    } else {
      setNotice(null);
    }
    setCandle(next);
    onCandleChange?.(next);
    onActivity?.();
    return next;
  };

  const onSlider = (field: FieldKey, value: number) => {
    if (!Number.isFinite(value)) return;
    const next = applyValue(field, roundToCents(value));
    // Keep a mid-edit draft of this same field in sync with the slide.
    setDrafts((d) => (d[field] === undefined ? d : { ...d, [field]: formatBuilderValue(next[field]) }));
  };

  const startDraft = (field: FieldKey) =>
    setDrafts((d) => (d[field] === undefined ? { ...d, [field]: formatBuilderValue(candle[field]) } : d));

  const endDraft = (field: FieldKey) =>
    setDrafts((d) => {
      if (d[field] === undefined) return d;
      const next = { ...d };
      delete next[field];
      return next;
    });

  /** Commit a field's draft (blur / Enter). Invalid text restores. */
  const commitDraft = (field: FieldKey) => {
    const raw = drafts[field];
    if (raw === undefined) return;
    endDraft(field);
    const trimmed = raw.trim();
    const value = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(value)) {
      setNotice(
        trimmed === ""
          ? `${labelOf(field)} was left blank, so it was restored to ${money(candle[field])}.`
          : `${labelOf(field)} entry "${trimmed}" wasn't a number, so it was restored to ${money(candle[field])}.`
      );
      return;
    }
    applyValue(field, value);
  };

  /** Escape: revert the draft to the actual value, commit nothing. */
  const cancelDraft = (field: FieldKey) =>
    setDrafts((d) => (d[field] === undefined ? d : { ...d, [field]: formatBuilderValue(candle[field]) }));

  const reset = () => {
    setCandle(initial);
    setDrafts({});
    setNotice(null);
    onCandleChange?.(initial);
  };

  return (
    <div className="ggl-cb">
      <div className="ggl-cb-chart">
        <CandleSvg candle={candle} />
      </div>
      <div className="ggl-cb-controls">
        {FIELDS.map((f) => (
          <div key={f.key} className="ggl-cb-row">
            <label className="ggl-cb-label" htmlFor={`cb-num-${f.key}`}>
              {f.label}
              <span className="ggl-cb-hint">{f.hint}</span>
            </label>
            <input
              type="range"
              min={SLIDER_MIN}
              max={SLIDER_MAX}
              step={0.01}
              value={Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, candle[f.key]))}
              onChange={(e) => onSlider(f.key, Number(e.target.value))}
              aria-label={`${f.label} slider`}
              className="ggl-cb-slider"
            />
            <span className="ggl-cb-dollar">$</span>
            <input
              id={`cb-num-${f.key}`}
              type="number"
              min={0}
              step={0.01}
              value={drafts[f.key] ?? formatBuilderValue(candle[f.key])}
              onFocus={() => startDraft(f.key)}
              onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
              onBlur={() => commitDraft(f.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitDraft(f.key);
                else if (e.key === "Escape") cancelDraft(f.key);
              }}
              className="ggl-cb-num"
              inputMode="decimal"
            />
          </div>
        ))}
        <div aria-live="polite">
          {notice && (
            <p className="ggl-cb-notice" role="status">
              {notice}
            </p>
          )}
        </div>
        <div className="ggl-cb-readouts" aria-live="polite">
          <p>
            <strong>{classLabel(cls)}</strong> — close {cls === "bullish" ? "above" : cls === "bearish" ? "below" : "≈"} open.
            Range <strong>${g.range.toFixed(2)}</strong> · Body <strong>${g.body.toFixed(2)}</strong> (
            {(g.bodyRatio * 100).toFixed(0)}% of range) · Upper wick <strong>${g.upperWick.toFixed(2)}</strong> ·
            Lower wick <strong>${g.lowerWick.toFixed(2)}</strong>
          </p>
          <p className="ggl-cb-note">
            Classification rule used here: a body of at most 5% of the range counts as a doji.
          </p>
        </div>
        <button type="button" className="ggl-btn ggl-btn-ghost" onClick={reset}>
          Reset candle
        </button>
      </div>
      <style>{`
        .ggl-cb { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; gap: 20px; align-items: start; }
        .ggl-cb-controls { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
        .ggl-cb-row { display: grid; grid-template-columns: 118px 1fr auto 92px; gap: 10px; align-items: center; }
        .ggl-cb-label { font-weight: 700; color: var(--ggl-text); font-size: 14.5px; display: flex; flex-direction: column; }
        .ggl-cb-hint { font-weight: 400; color: var(--ggl-muted); font-size: 12px; }
        .ggl-cb-slider { width: 100%; accent-color: var(--ggl-green); min-height: 44px; }
        .ggl-cb-dollar { color: var(--ggl-muted); }
        .ggl-cb-num { background: var(--ggl-bg2); border: 1px solid var(--ggl-border); color: var(--ggl-text); border-radius: 8px; padding: 10px 12px; font-size: 16px; min-height: 44px; width: 100%; }
        .ggl-cb .ggl-btn { min-height: 44px; }
        .ggl-cb-notice { border: 1px solid rgba(240,180,41,0.55); border-radius: 10px; padding: 10px 12px; color: var(--ggl-text2); font-size: 14px; line-height: 1.55; margin: 0; }
        .ggl-cb-readouts { background: var(--ggl-bg2); border: 1px solid var(--ggl-border); border-radius: 10px; padding: 12px 14px; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.55; }
        .ggl-cb-readouts p { margin: 0 0 6px; }
        .ggl-cb-readouts strong { color: var(--ggl-text); }
        .ggl-cb-note { color: var(--ggl-muted); font-size: 13px; margin: 0 !important; }
        .ggl-cb input:focus-visible, .ggl-cb button:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
        @media (max-width: 720px) {
          .ggl-cb { grid-template-columns: 1fr; }
          .ggl-cb-row { grid-template-columns: 92px 1fr auto 96px; }
        }
      `}</style>
    </div>
  );
}
