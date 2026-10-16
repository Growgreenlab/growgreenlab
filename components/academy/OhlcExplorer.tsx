"use client";

/**
 * Lesson 3 — Meet OHLC. One candle; the explorer highlights Open,
 * then High, then Low, then Close (CandleSvg's presentational
 * highlight prop), with a short definition, the example numbers, and
 * that term's one-question check. Only after all four does it show
 * them together.
 */

import { useState } from "react";
import CandleSvg, { type CandleHighlight } from "./CandleSvg";
import ExplanationCheck from "./ExplanationCheck";
import { makeCandle } from "@/lib/academy/candleMath";
import { L3_CHECKS } from "@/lib/academy/content";
import type { ChoiceQuestion } from "@/lib/academy/types";

const CANDLE = makeCandle({ open: 10.0, high: 10.6, low: 9.85, close: 10.4 });

interface Term {
  key: "open" | "high" | "low" | "close";
  label: string;
  definition: string;
  example: string;
}

const TERMS: Term[] = [
  {
    key: "open",
    label: "Open",
    definition: "The Open is the price at which the candle's period began.",
    example: "Our candle's period began at $10.00 — so the Open is $10.00. The gold line marks it.",
  },
  {
    key: "high",
    label: "High",
    definition: "The High is the highest price reached during that period.",
    example: "Price reached up to $10.60 — that highest point is the High, at the very top of the wick.",
  },
  {
    key: "low",
    label: "Low",
    definition: "The Low is the lowest price reached during that period.",
    example: "Price dipped to $9.85 at its lowest — that's the Low, at the very bottom of the wick.",
  },
  {
    key: "close",
    label: "Close",
    definition: "The Close is the price at which the period ended.",
    example: "The period ended at $10.40 — so the Close is $10.40. The gold line marks it.",
  },
];

export default function OhlcExplorer({
  questions,
  onActivity,
  onConceptResult,
}: {
  questions?: ChoiceQuestion[];
  onActivity: () => void;
  onConceptResult: (concept: string, correctFirstTry: boolean) => void;
}) {
  const checks = questions && questions.length === TERMS.length ? questions : L3_CHECKS;
  const [step, setStep] = useState(0);
  const finished = step >= TERMS.length;
  const term = finished ? null : TERMS[step];

  return (
    <div>
      <p style={{ textAlign: "center", color: "var(--ggl-text2)", margin: "0 0 8px" }} aria-live="polite">
        {finished ? "All four, together" : `Price ${step + 1} of 4 — ${term!.label}`}
      </p>

      {!finished && term && (
        <div key={term.key}>
          <CandleSvg candle={CANDLE} height={300} showValues={false} highlight={term.key as CandleHighlight} />
          <p style={{ fontSize: 17, lineHeight: 1.55, margin: "12px 0 4px" }}>
            <strong>{term.label}.</strong> {term.definition}
          </p>
          <p style={{ color: "var(--ggl-text2)", lineHeight: 1.55, margin: "0 0 14px" }}>{term.example}</p>
          <ExplanationCheck
            questions={[checks[step]]}
            onActivity={onActivity}
            onConceptResult={onConceptResult}
          />
          <div style={{ textAlign: "center", marginTop: 14 }}>
            <button
              type="button"
              className="ggl-btn"
              style={{ minHeight: 44 }}
              onClick={() => {
                onActivity();
                setStep(step + 1);
              }}
            >
              {step + 1 >= TERMS.length ? "See all four together" : `Next: ${TERMS[step + 1].label}`}
            </button>
          </div>
        </div>
      )}

      {finished && (
        <div>
          <CandleSvg candle={CANDLE} height={300} />
          <ul style={{ lineHeight: 1.7, margin: "12px 0" }}>
            <li><strong>Open $10.00</strong> — where the period began.</li>
            <li><strong>High $10.60</strong> — the highest price reached.</li>
            <li><strong>Low $9.85</strong> — the lowest price reached.</li>
            <li><strong>Close $10.40</strong> — where the period ended.</li>
          </ul>
          <p style={{ color: "var(--ggl-text2)", lineHeight: 1.6 }}>
            That's the whole candle: four prices, one period. Since the Close ($10.40) is above the
            Open ($10.00), this one is green — bullish.
          </p>
          <div style={{ textAlign: "center", marginTop: 10 }}>
            <button
              type="button"
              className="ggl-btn-ghost"
              style={{ minHeight: 44 }}
              onClick={() => setStep(0)}
            >
              Go through them again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
