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
 */
import { useState } from "react";
import {
  candleGeometry,
  classifyCandle,
  classLabel,
  setCandleField,
  type Candle,
  type CandleInput,
} from "../../lib/academy/candleMath";
import CandleSvg from "./CandleSvg";

const FIELDS: { key: keyof CandleInput; label: string; hint: string }[] = [
  { key: "open", label: "Open", hint: "First price of the interval" },
  { key: "high", label: "High", hint: "Highest price reached" },
  { key: "low", label: "Low", hint: "Lowest price reached" },
  { key: "close", label: "Close", hint: "Final price of the interval" },
];

const SLIDER_MIN = 0;
const SLIDER_MAX = 20;

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
  const g = candleGeometry(candle);
  const cls = classifyCandle(candle);

  const set = (field: keyof CandleInput, value: number) => {
    if (!Number.isFinite(value)) return; // non-numeric input: keep the last valid candle
    const next = setCandleField(candle, field, value);
    setCandle(next);
    onCandleChange?.(next);
    onActivity?.();
  };

  const reset = () => {
    setCandle(initial);
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
              onChange={(e) => set(f.key, Number(e.target.value))}
              aria-label={`${f.label} slider`}
              className="ggl-cb-slider"
            />
            <span className="ggl-cb-dollar">$</span>
            <input
              id={`cb-num-${f.key}`}
              type="number"
              min={0}
              step={0.01}
              value={candle[f.key]}
              onChange={(e) => set(f.key, Number(e.target.value))}
              className="ggl-cb-num"
              inputMode="decimal"
            />
          </div>
        ))}
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
        .ggl-cb-slider { width: 100%; accent-color: var(--ggl-green); min-height: 32px; }
        .ggl-cb-dollar { color: var(--ggl-muted); }
        .ggl-cb-num { background: var(--ggl-bg2); border: 1px solid var(--ggl-border); color: var(--ggl-text); border-radius: 8px; padding: 9px 10px; font-size: 15px; width: 100%; }
        .ggl-cb-readouts { background: var(--ggl-bg2); border: 1px solid var(--ggl-border); border-radius: 10px; padding: 12px 14px; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.55; }
        .ggl-cb-readouts p { margin: 0 0 6px; }
        .ggl-cb-readouts strong { color: var(--ggl-text); }
        .ggl-cb-note { color: var(--ggl-muted); font-size: 13px; margin: 0 !important; }
        .ggl-cb input:focus-visible, .ggl-cb button:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
        @media (max-width: 720px) {
          .ggl-cb { grid-template-columns: 1fr; }
          .ggl-cb-row { grid-template-columns: 92px 1fr auto 84px; }
        }
      `}</style>
    </div>
  );
}
