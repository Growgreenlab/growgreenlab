"use client";

/**
 * Lesson 1 — tap-to-reveal candle anatomy. One large candle, four
 * friendly targets (Body, Upper wick, Lower wick, the period itself),
 * each revealing a one-line plain-English explanation. Keyboard
 * operable (real buttons, aria-expanded); nothing else on the step.
 */

import { useState } from "react";
import CandleSvg, { type CandleHighlight } from "./CandleSvg";
import { makeCandle } from "@/lib/academy/candleMath";

const CANDLE = makeCandle({ open: 10.0, high: 10.62, low: 9.84, close: 10.42 });

interface Part {
  id: string;
  label: string;
  highlight: CandleHighlight;
  text: string;
}

const PARTS: Part[] = [
  {
    id: "body",
    label: "The body",
    highlight: "body",
    text: "The thick part. It runs from the opening price to the closing price — in this candle, from $10.00 up to $10.42.",
  },
  {
    id: "upper-wick",
    label: "The upper wick",
    highlight: "upper-wick",
    text: "The thin line on top. Price reached as high as $10.62 during the period — higher than where the body ends.",
  },
  {
    id: "lower-wick",
    label: "The lower wick",
    highlight: "lower-wick",
    text: "The thin line at the bottom. Price dipped as low as $9.84 during the period — lower than where the body begins.",
  },
  {
    id: "period",
    label: "The period",
    highlight: null,
    text: "This whole candle is one period of time — one minute, five minutes, or whatever the chart is set to. When the period ends, the candle is finished.",
  },
];

export default function TapRevealCandle({ onActivity }: { onActivity: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const active = PARTS.find((p) => p.id === openId) ?? null;

  return (
    <div>
      <CandleSvg candle={CANDLE} height={320} highlight={active?.highlight ?? null} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginTop: 12 }}>
        {PARTS.map((p) => {
          const expanded = openId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className="ggl-btn-ghost"
              style={{ minHeight: 44 }}
              aria-expanded={expanded}
              aria-controls="ggl-tap-reveal-panel"
              onClick={() => {
                onActivity();
                setOpenId(expanded ? null : p.id);
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div id="ggl-tap-reveal-panel" aria-live="polite" style={{ minHeight: 48, textAlign: "center", marginTop: 12 }}>
        {active ? (
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55 }}>
            <strong>{active.label}:</strong> {active.text}
          </p>
        ) : (
          <p style={{ margin: 0, color: "var(--ggl-text2)" }}>Tap a part of the candle to see what it is.</p>
        )}
      </div>
    </div>
  );
}
