"use client";

/**
 * /academy — the Trading Academy learning map.
 *
 * Twelve worlds from the master spec with honest status: World 2
 * (Candlestick Mastery) is available; Worlds 1 and 3–12 are Planned —
 * rendered as non-clickable planned cards, never empty shells. The
 * available world's card carries live progress from the Academy
 * progress store and a recommended next action driven by it.
 */
import Link from "next/link";
import { WORLDS } from "../../lib/academy/content";
import type { LessonProgress } from "../../lib/academy/progress";
import { useAcademyProgress } from "../../components/academy/useAcademyProgress";

function recommendedAction(p: LessonProgress | undefined): { label: string; hint: string } {
  if (!p || p.status === "not-started") {
    return { label: "Start Candlestick Mastery", hint: "The flagship lesson: build candles, watch them form, and pass the mastery check." };
  }
  if (p.status === "in-progress") {
    return {
      label: "Continue Candlestick Mastery",
      hint: p.lastPosition ? `Pick up where you left off (section: ${p.lastPosition}).` : "Pick up where you left off.",
    };
  }
  if (p.status === "completed") {
    return {
      label: "Review Candlestick Mastery",
      hint: `Activities complete${p.bestScore !== null ? ` — best mastery score ${p.bestScore}%` : ""}. Retake the mastery check any time to reach Mastered (80%+).`,
    };
  }
  return {
    label: "Candlestick Mastery — Mastered ✓",
    hint: `Best mastery score ${p.bestScore ?? 0}% across ${p.attempts} attempt${p.attempts === 1 ? "" : "s"}. Revisit any section whenever you like.`,
  };
}

export default function AcademyMapPage() {
  const { state, ready, synced } = useAcademyProgress();
  const flagship = state.lessons["candlestick-mastery"];
  const action = recommendedAction(flagship);

  return (
    <div className="ggl-academy">
      <p className="ggl-academy-eyebrow">Grow Green Lab · Trading Academy</p>
      <h1 className="ggl-academy-h1">Learn to read the market from evidence.</h1>
      <p className="ggl-academy-lede">
        Structured, interactive lessons that teach you how to think about market data: what it shows,
        what you can reasonably infer, and what remains unknown. No memorized patterns, no guaranteed
        outcomes — evidence first.
      </p>

      <div className="ggl-academy-banner" role="note">
        <strong>An honest note on readiness:</strong> completing Academy lessons builds knowledge and
        decision discipline. It is not proof of live-trading competence or future profitability, and it
        is never presented as such here.
      </div>

      <p className="ggl-academy-progress-note" aria-live="polite">
        {!ready
          ? "Loading your progress…"
          : synced
            ? "Progress is saved on this device and synced to your account."
            : "Progress is saved on this device only (guest mode) — it does not follow you to other devices, and clearing browser data removes it."}
      </p>

      <div className="ggl-academy-worlds">
        {WORLDS.map((w) => {
          if (w.status === "available" && w.lessonSlug) {
            return (
              <section key={w.slug} className="ggl-academy-world ggl-academy-world-live" aria-label={`World ${w.number}: ${w.title}`}>
                <div className="ggl-academy-world-top">
                  <span className="ggl-academy-world-num">World {w.number}</span>
                  <span className="ggl-academy-badge ggl-academy-badge-live">Available</span>
                </div>
                <h2>{w.title}</h2>
                <p className="ggl-academy-world-tag">{w.tagline}</p>
                <ul className="ggl-academy-topics">
                  {w.topics.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                {flagship && flagship.status !== "not-started" && (
                  <p className="ggl-academy-world-progress">
                    Your status: <strong>{flagship.status === "mastered" ? "Mastered ✓" : flagship.status === "completed" ? "Completed" : "In progress"}</strong>
                    {flagship.bestScore !== null ? ` · best score ${flagship.bestScore}%` : ""}
                    {flagship.attempts > 0 ? ` · ${flagship.attempts} attempt${flagship.attempts === 1 ? "" : "s"}` : ""}
                  </p>
                )}
                <p className="ggl-academy-next">
                  <span className="ggl-academy-next-label">Recommended next action</span>
                  <Link className="ggl-btn ggl-btn-primary" href={`/academy/${w.lessonSlug}`}>
                    {action.label}
                  </Link>
                  <span className="ggl-academy-next-hint">{action.hint}</span>
                </p>
              </section>
            );
          }
          return (
            <section
              key={w.slug}
              className="ggl-academy-world ggl-academy-world-planned"
              aria-label={`World ${w.number}: ${w.title} (planned)`}
              aria-disabled="true"
            >
              <div className="ggl-academy-world-top">
                <span className="ggl-academy-world-num">World {w.number}</span>
                <span className="ggl-academy-badge">Planned</span>
              </div>
              <h2>{w.title}</h2>
              <p className="ggl-academy-world-tag">{w.tagline}</p>
              <ul className="ggl-academy-topics">
                {w.topics.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              {w.prerequisites && <p className="ggl-academy-prereq">Prerequisites: {w.prerequisites}</p>}
              <p className="ggl-academy-planned-note">In development — not yet available. No placeholder lessons are published.</p>
            </section>
          );
        })}
      </div>

      <style>{`
        .ggl-academy { padding: 40px 0 72px; }
        .ggl-academy-eyebrow { color: var(--ggl-green); font-size: 12.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; margin: 0 0 10px; }
        .ggl-academy-h1 { font-size: clamp(28px, 4.5vw, 42px); line-height: 1.12; margin: 0 0 14px; color: var(--ggl-text); max-width: 720px; }
        .ggl-academy-lede { color: var(--ggl-text2); font-size: 16.5px; line-height: 1.65; max-width: 680px; margin: 0 0 22px; }
        .ggl-academy-banner { border: 1px solid var(--ggl-border); border-left: 3px solid var(--ggl-green); background: var(--ggl-card); border-radius: 10px; padding: 14px 16px; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.6; max-width: 760px; margin-bottom: 14px; }
        .ggl-academy-banner strong { color: var(--ggl-text); }
        .ggl-academy-progress-note { color: var(--ggl-muted); font-size: 13.5px; margin: 0 0 26px; }
        .ggl-academy-worlds { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
        .ggl-academy-world { background: var(--ggl-card); border: 1px solid var(--ggl-border); border-radius: 14px; padding: 22px; display: flex; flex-direction: column; gap: 10px; }
        .ggl-academy-world-live { border-color: rgba(66,216,121,0.45); }
        .ggl-academy-world-planned { opacity: 0.78; }
        .ggl-academy-world-top { display: flex; justify-content: space-between; align-items: center; }
        .ggl-academy-world-num { color: var(--ggl-muted); font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
        .ggl-academy-badge { font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ggl-muted); border: 1px solid var(--ggl-border); border-radius: 999px; padding: 3px 10px; }
        .ggl-academy-badge-live { color: var(--ggl-green); border-color: rgba(66,216,121,0.5); }
        .ggl-academy-world h2 { margin: 0; font-size: 20px; color: var(--ggl-text); }
        .ggl-academy-world-tag { margin: 0; color: var(--ggl-text2); font-size: 14.5px; line-height: 1.55; }
        .ggl-academy-topics { margin: 0; padding-left: 18px; color: var(--ggl-muted); font-size: 13.5px; line-height: 1.7; }
        .ggl-academy-prereq, .ggl-academy-planned-note { margin: 0; color: var(--ggl-muted); font-size: 13px; }
        .ggl-academy-world-progress { margin: 0; color: var(--ggl-text2); font-size: 14px; }
        .ggl-academy-next { margin: auto 0 0; display: flex; flex-direction: column; gap: 8px; }
        .ggl-academy-next-label { color: var(--ggl-muted); font-size: 11.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
        .ggl-academy-next .ggl-btn { align-self: flex-start; text-decoration: none; }
        .ggl-academy-next-hint { color: var(--ggl-text2); font-size: 13.5px; line-height: 1.5; }
        .ggl-academy a:focus-visible, .ggl-academy button:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
        @media (max-width: 640px) { .ggl-academy-worlds { grid-template-columns: 1fr; } .ggl-academy { padding-top: 26px; } }
      `}</style>
    </div>
  );
}
