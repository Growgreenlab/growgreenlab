"use client";

/**
 * FormationDemo — watch a candle form from a simulated price path
 * (spec §5B). Play / pause / step / reset over a deterministic seeded
 * path; the forming candle is derived tick-by-tick by
 * candleMath.formationFromPath. A prediction control commits the
 * learner to a final-direction call BEFORE the interval completes;
 * only the elapsed part of the path is ever drawn, so the outcome
 * cannot leak. Never autoplays (reduced-motion friendly by default).
 */
import { useEffect, useMemo, useState } from "react";
import {
  classifyCandle,
  classLabel,
  formationFromPath,
  generatePricePath,
  type CandleClass,
} from "../../lib/academy/candleMath";
import CandleSvg from "./CandleSvg";

const PATH_SEED = 20261015;

export default function FormationDemo({ onActivity }: { onActivity?: () => void }) {
  const path = useMemo(() => generatePricePath(PATH_SEED, 10.0, 49), []);
  const frames = useMemo(() => formationFromPath(path), [path]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [prediction, setPrediction] = useState<CandleClass | null>(null);

  const finished = idx >= frames.length - 1;
  const frame = frames[idx];
  const finalClass = classifyCandle(frames[frames.length - 1].candle);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setIdx((i) => {
        if (i >= frames.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 130);
    return () => clearInterval(t);
  }, [playing, frames.length]);

  useEffect(() => {
    if (finished) setPlaying(false);
  }, [finished]);

  const reset = () => {
    setPlaying(false);
    setIdx(0);
    setPrediction(null);
  };

  // Elapsed-path sparkline (elapsed only — the future is never drawn).
  const elapsed = path.slice(0, idx + 1);
  const lo = Math.min(...path);
  const hi = Math.max(...path);
  const sx = (i: number) => 8 + (i / (path.length - 1)) * 284;
  const sy = (p: number) => 52 - ((p - lo) / Math.max(0.01, hi - lo)) * 44;
  const points = elapsed.map((p, i) => `${sx(i).toFixed(1)},${sy(p).toFixed(1)}`).join(" ");

  return (
    <div className="ggl-fd">
      <div className="ggl-fd-grid">
        <div>
          <CandleSvg candle={frame.candle} height={240} />
          <p className="ggl-fd-status" aria-live="polite">
            {finished
              ? `Interval complete — the final price became the Close. Final candle: ${classLabel(finalClass)}.`
              : `Forming… price $${frame.price.toFixed(2)} · tick ${idx + 1} of ${frames.length}`}
          </p>
        </div>
        <div>
          <svg viewBox="0 0 300 60" width="100%" height={60} role="img"
            aria-label={`Simulated price path so far: ${elapsed.length} of ${path.length} prices shown`}
            style={{ background: "var(--ggl-bg2)", border: "1px solid var(--ggl-border)", borderRadius: 10 }}>
            <polyline points={points} fill="none" stroke="var(--ggl-green)" strokeWidth={2} />
          </svg>
          <p className="ggl-fd-note">
            Simulated price path (educational data). Only the elapsed part is drawn — the rest of the
            interval has not happened yet.
          </p>

          <fieldset className="ggl-fd-predict">
            <legend>Predict before it finishes: how will this candle close?</legend>
            {(["bullish", "bearish", "doji"] as CandleClass[]).map((c) => (
              <label key={c} className="ggl-fd-radio">
                <input
                  type="radio"
                  name="fd-prediction"
                  value={c}
                  checked={prediction === c}
                  disabled={finished}
                  onChange={() => {
                    setPrediction(c);
                    onActivity?.();
                  }}
                />
                {classLabel(c)}
                {c === "doji" ? " (closes ≈ its open)" : c === "bullish" ? " (closes above its open)" : " (closes below its open)"}
              </label>
            ))}
          </fieldset>
          {finished && (
            <p className="ggl-fd-verdict" aria-live="polite">
              {prediction === null
                ? "You didn't commit to a prediction this time — try again after Reset. Predicting before the reveal is the habit being trained."
                : prediction === finalClass
                  ? `Your prediction (${classLabel(prediction)}) matched the final candle. Note what it was based on — the forming body can still flip late in an interval.`
                  : `Your prediction was ${classLabel(prediction)}; the candle finished ${classLabel(finalClass)}. A forming candle's current direction is not its final direction — the last ticks decide.`}
            </p>
          )}
        </div>
      </div>

      <div className="ggl-fd-controls">
        <button type="button" className="ggl-btn ggl-btn-primary" onClick={() => { setPlaying((p) => !p); onActivity?.(); }} disabled={finished}>
          {playing ? "Pause" : idx === 0 ? "Play" : "Resume"}
        </button>
        <button type="button" className="ggl-btn ggl-btn-ghost" onClick={() => { setIdx((i) => Math.min(frames.length - 1, i + 1)); onActivity?.(); }} disabled={finished}>
          Step forward
        </button>
        <button type="button" className="ggl-btn ggl-btn-ghost" onClick={reset}>
          Reset
        </button>
      </div>

      <div className="ggl-fd-explain">
        <p>
          <strong>What survives the interval:</strong> the completed candle keeps only four numbers — the
          Open (first price), the High and Low (extremes), and the Close (final price). The path price
          took between them — the order of the highs and lows, the pauses, the speed — is{" "}
          <strong>not recoverable from the finished candle</strong>. Two intervals with completely
          different paths can produce the identical candle.
        </p>
      </div>

      <style>{`
        .ggl-fd-grid { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; gap: 20px; align-items: start; }
        .ggl-fd-status { color: var(--ggl-text2); font-size: 14px; text-align: center; margin: 8px 0 0; }
        .ggl-fd-note { color: var(--ggl-muted); font-size: 12.5px; margin: 6px 0 14px; }
        .ggl-fd-predict { border: 1px solid var(--ggl-border); border-radius: 10px; padding: 12px 14px; margin: 0 0 12px; display: flex; flex-direction: column; gap: 7px; }
        .ggl-fd-predict legend { color: var(--ggl-text); font-weight: 700; font-size: 14px; padding: 0 4px; }
        .ggl-fd-radio { color: var(--ggl-text2); font-size: 14.5px; display: flex; gap: 8px; align-items: center; min-height: 44px; }
        .ggl-fd-controls .ggl-btn { min-height: 44px; }
        .ggl-fd-radio input { accent-color: var(--ggl-green); width: 18px; height: 18px; }
        .ggl-fd-verdict { background: var(--ggl-bg2); border: 1px solid var(--ggl-border); border-left: 3px solid var(--ggl-green); border-radius: 10px; padding: 12px 14px; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.6; margin: 0; }
        .ggl-fd-controls { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
        .ggl-fd-explain { background: var(--ggl-card); border: 1px solid var(--ggl-border); border-radius: 10px; padding: 14px 16px; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.65; }
        .ggl-fd-explain p { margin: 0; }
        .ggl-fd-explain strong { color: var(--ggl-text); }
        .ggl-fd button:focus-visible, .ggl-fd input:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
        @media (max-width: 720px) { .ggl-fd-grid { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
