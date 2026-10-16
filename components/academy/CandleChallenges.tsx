"use client";

/**
 * CandleChallenges — guided build-a-shape challenges (spec §5D).
 *
 * Each challenge starts from a deterministic seeded candle (values
 * vary by challenge and by retry), and evaluation is pure geometry
 * from candleMath.evaluateCandleChallenge — the feedback quotes the
 * learner's actual numbers. Retries are unlimited and re-seed the
 * starting candle.
 */
import { useMemo, useState } from "react";
import {
  challengeStartCandle,
  evaluateCandleChallenge,
  type Candle,
  type ChallengeVerdict,
} from "../../lib/academy/candleMath";
import { mulberry32, seededPick } from "../../lib/academy/rng";
import type { ChallengeDef } from "../../lib/academy/types";
import CandleBuilder from "./CandleBuilder";

function ChallengeCard({
  def,
  onActivity,
}: {
  def: ChallengeDef;
  onActivity?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const seed = def.startSeed + attempt * 131;
  const start = useMemo(() => challengeStartCandle(seed), [seed]);
  const minRange = useMemo(
    () => (def.rangeOptions.length > 0 ? seededPick(mulberry32(seed), def.rangeOptions) : null),
    [def.rangeOptions, seed]
  );
  const [candle, setCandle] = useState<Candle>(start);
  const [verdict, setVerdict] = useState<ChallengeVerdict | null>(null);
  const [passed, setPassed] = useState(false);

  // Re-seed the working candle whenever the attempt (seed) changes.
  const [seenSeed, setSeenSeed] = useState(seed);
  if (seenSeed !== seed) {
    setSeenSeed(seed);
    setCandle(start);
    setVerdict(null);
  }

  const check = () => {
    const v = evaluateCandleChallenge(def.kind, candle, minRange);
    setVerdict(v);
    if (v.passed) setPassed(true);
    onActivity?.();
  };

  const retry = () => {
    setAttempt((a) => a + 1);
    onActivity?.();
  };

  return (
    <article className="ggl-ch-card">
      <h3>
        {def.title} {passed && <span className="ggl-ch-done">✓ Done</span>}
      </h3>
      <p className="ggl-ch-instruction">
        {def.instruction}
        {minRange !== null ? ` Target range: at least $${minRange.toFixed(2)}.` : ""}
      </p>
      {/* key forces a fresh builder (fresh candle state) per attempt */}
      <CandleBuilder key={seed} initial={start} onCandleChange={setCandle} />
      <div className="ggl-ch-actions">
        <button type="button" className="ggl-btn ggl-btn-primary" onClick={check}>
          Check my candle
        </button>
        <button type="button" className="ggl-btn ggl-btn-ghost" onClick={retry}>
          Retry with new values
        </button>
      </div>
      <div aria-live="polite">
        {verdict && (
          <p className={`ggl-ch-feedback ${verdict.passed ? "ggl-ch-pass" : "ggl-ch-miss"}`}>
            <strong>{verdict.passed ? "That qualifies." : "Not yet."}</strong>{" "}
            {verdict.reasons.join(" ")}
          </p>
        )}
      </div>
      <style>{`
        .ggl-ch-card { border: 1px solid var(--ggl-border); border-radius: 12px; padding: 18px; background: var(--ggl-bg2); }
        .ggl-ch-card h3 { margin: 0 0 6px; color: var(--ggl-text); font-size: 16.5px; }
        .ggl-ch-done { color: var(--ggl-green); font-size: 13px; }
        .ggl-ch-instruction { color: var(--ggl-text2); font-size: 14.5px; line-height: 1.55; margin: 0 0 14px; }
        .ggl-ch-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
        .ggl-ch-actions .ggl-btn { min-height: 44px; }
        .ggl-ch-feedback { border-radius: 10px; padding: 12px 14px; font-size: 14.5px; line-height: 1.6; margin: 12px 0 0; color: var(--ggl-text2); }
        .ggl-ch-pass { border: 1px solid rgba(66,216,121,0.55); }
        .ggl-ch-miss { border: 1px solid rgba(240,180,41,0.55); }
        .ggl-ch-card button:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
      `}</style>
    </article>
  );
}

export default function CandleChallenges({
  challenges,
  onActivity,
}: {
  challenges: ChallengeDef[];
  onActivity?: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {challenges.map((def) => (
        <ChallengeCard key={def.id} def={def} onActivity={onActivity} />
      ))}
    </div>
  );
}
