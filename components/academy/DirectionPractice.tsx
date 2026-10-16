"use client";

/**
 * Lesson 2 — direction practice. One candle at a time from a seeded
 * sequence that ramps from obvious to near the doji tolerance. The
 * learner picks Bullish / Bearish / Doji; the verdict comes ONLY from
 * classifyCandle, and the feedback quotes the actual open/close
 * numbers and restates the rule. Direction never implies prediction.
 */

import { useMemo, useState } from "react";
import CandleSvg from "./CandleSvg";
import {
  classifyCandle,
  candleGeometry,
  makeCandle,
  type Candle,
  type CandleClass,
} from "@/lib/academy/candleMath";
import { mulberry32 } from "@/lib/academy/rng";

interface RawCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Stages: obvious → clear doji → moderate → near tolerance → subtle doji. */
const STAGES: RawCandle[][] = [
  // 1–2: obvious, large bodies
  [
    { open: 10.0, high: 10.58, low: 9.94, close: 10.5 },
    { open: 5.0, high: 5.44, low: 4.95, close: 5.38 },
    { open: 20.0, high: 20.85, low: 19.9, close: 20.72 },
  ],
  [
    { open: 10.5, high: 10.56, low: 9.94, close: 10.0 },
    { open: 8.4, high: 8.46, low: 7.88, close: 7.95 },
    { open: 12.6, high: 12.67, low: 12.0, close: 12.06 },
  ],
  // 3: a clear doji
  [
    { open: 10.0, high: 10.42, low: 9.58, close: 10.01 },
    { open: 6.0, high: 6.31, low: 5.69, close: 5.99 },
    { open: 15.0, high: 15.52, low: 14.48, close: 15.02 },
  ],
  // 4–5: moderate bodies
  [
    { open: 10.0, high: 10.31, low: 9.9, close: 10.22 },
    { open: 10.25, high: 10.33, low: 9.84, close: 9.95 },
    { open: 7.1, high: 7.29, low: 6.94, close: 7.22 },
  ],
  // 6: nearer the tolerance, but still a real body
  [
    { open: 10.0, high: 10.5, low: 9.5, close: 10.08 },
    { open: 10.08, high: 10.56, low: 9.54, close: 10.0 },
    { open: 4.0, high: 4.26, low: 3.74, close: 4.04 },
  ],
  // 7: one more subtle doji to finish
  [
    { open: 10.0, high: 10.62, low: 9.5, close: 10.04 },
    { open: 12.0, high: 12.41, low: 11.56, close: 11.97 },
    { open: 9.5, high: 9.86, low: 9.1, close: 9.52 },
  ],
];

const CHOICES: { cls: CandleClass; label: string }[] = [
  { cls: "bullish", label: "Bullish (green)" },
  { cls: "bearish", label: "Bearish (red)" },
  { cls: "doji", label: "Doji" },
];

function buildSequence(seed: number): Candle[] {
  const rng = mulberry32(seed);
  return STAGES.map((pool) => makeCandle(pool[Math.floor(rng() * pool.length)]));
}

function ruleText(candle: Candle): string {
  const cls = classifyCandle(candle);
  const g = candleGeometry(candle);
  const o = candle.open.toFixed(2);
  const c = candle.close.toFixed(2);
  if (cls === "bullish") {
    return `the close ($${c}) is higher than the open ($${o}), so this candle is bullish.`;
  }
  if (cls === "bearish") {
    return `the close ($${c}) is lower than the open ($${o}), so this candle is bearish.`;
  }
  return `the open ($${o}) and close ($${c}) are nearly equal — the body is $${g.body.toFixed(2)} of a $${g.range.toFixed(2)} range, inside the 5% doji tolerance — so this candle is a doji.`;
}

export default function DirectionPractice({
  onActivity,
  onConceptResult,
}: {
  onActivity: () => void;
  onConceptResult: (concept: string, correctFirstTry: boolean) => void;
}) {
  const sequence = useMemo(() => buildSequence(20261015), []);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<CandleClass | null>(null);
  const [done, setDone] = useState(false);

  const candle = sequence[idx];
  const correct = picked !== null && picked === classifyCandle(candle);

  const pick = (cls: CandleClass) => {
    if (picked !== null) return;
    onActivity();
    setPicked(cls);
    onConceptResult("candle-direction", cls === classifyCandle(candle));
  };

  const next = () => {
    if (idx + 1 >= sequence.length) {
      setDone(true);
    } else {
      setIdx(idx + 1);
      setPicked(null);
    }
  };

  if (done) {
    return (
      <div className="ggl-panel" style={{ textAlign: "center" }}>
        <p style={{ fontSize: 17, margin: "4px 0 8px" }}>
          <strong>Nice work — that's the whole set.</strong>
        </p>
        <p style={{ color: "var(--ggl-text2)", margin: 0, lineHeight: 1.6 }}>
          Every answer came from the same comparison: close versus open. Remember, a candle's
          direction only describes the candle itself — it never predicts the next one.
        </p>
        <button
          type="button"
          className="ggl-btn-ghost"
          style={{ minHeight: 44, marginTop: 14 }}
          onClick={() => {
            setIdx(0);
            setPicked(null);
            setDone(false);
          }}
        >
          Practise again
        </button>
      </div>
    );
  }

  return (
    <div>
      <p style={{ textAlign: "center", color: "var(--ggl-text2)", margin: "0 0 8px" }} aria-live="polite">
        Candle {idx + 1} of {sequence.length}
      </p>
      <CandleSvg key={idx} candle={candle} height={300} showValues={false} revealClassification={false} />
      <p style={{ textAlign: "center", margin: "10px 0 4px" }}>
        Open <strong>${candle.open.toFixed(2)}</strong> · Close <strong>${candle.close.toFixed(2)}</strong>
      </p>
      <p style={{ textAlign: "center", color: "var(--ggl-text2)", margin: "0 0 12px" }}>
        Compare the close with the open. Which is this candle?
      </p>
      <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
        {CHOICES.map((ch) => (
          <button
            key={ch.cls}
            type="button"
            className="ggl-btn-ghost"
            style={{ minHeight: 44 }}
            aria-pressed={picked === ch.cls}
            disabled={picked !== null}
            onClick={() => pick(ch.cls)}
          >
            {ch.label}
          </button>
        ))}
      </div>
      <div aria-live="polite" style={{ minHeight: 56, textAlign: "center", marginTop: 12 }}>
        {picked !== null && (
          <>
            <p style={{ margin: "0 0 10px", lineHeight: 1.55 }}>
              {correct ? "Exactly right — " : "Not quite, and that's okay — "}
              {ruleText(candle)}
            </p>
            <button type="button" className="ggl-btn" style={{ minHeight: 44 }} onClick={next}>
              {idx + 1 >= sequence.length ? "Finish" : "Next candle"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
