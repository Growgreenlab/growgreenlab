"use client";

/**
 * /academy — the Trading Academy learning map.
 *
 * Twelve worlds from the master spec with honest status: World 1
 * (Candlestick Basics) is available as a seven-lesson beginner path;
 * Worlds 2–12 are Planned — rendered as non-clickable planned cards,
 * never empty shells. The World 1 card lists every lesson with its
 * own live progress status and a recommended next action driven by
 * the first incomplete lesson.
 */
import Link from "next/link";
import { WORLDS, getLessonsForWorld } from "../../lib/academy/content";
import type { LessonProgress } from "../../lib/academy/progress";
import type { LessonDef } from "../../lib/academy/types";
import { useAcademyProgress } from "../../components/academy/useAcademyProgress";

function lessonStatusLabel(p: LessonProgress | undefined): string {
  if (!p || p.status === "not-started") return "Not started";
  if (p.status === "in-progress") return "In progress";
  if (p.status === "completed") return "Completed";
  return "Mastered ✓";
}

function recommendedAction(
  lessons: LessonDef[],
  byId: Record<string, LessonProgress>
): { label: string; hint: string; slug: string } {
  const mastery = lessons[lessons.length - 1];
  const masteryProgress = byId[mastery.id];
  if (masteryProgress?.status === "mastered") {
    return {
      label: "Candlestick Basics — Mastered ✓",
      hint: `Best mastery score ${masteryProgress.bestScore ?? 0}% across ${masteryProgress.attempts} attempt${masteryProgress.attempts === 1 ? "" : "s"}. Revisit any lesson whenever you like.`,
      slug: mastery.slug,
    };
  }
  const next = lessons.find((l) => {
    const s = byId[l.id]?.status ?? "not-started";
    return s !== "completed" && s !== "mastered";
  }) ?? mastery;
  const p = byId[next.id];
  const isMastery = next.id === mastery.id;
  if (isMastery && p?.status === "completed") {
    return {
      label: "Retake the mastery check",
      hint: `Lesson 7's activities are complete — best score ${p.bestScore ?? 0}% so far. Score 80% or higher to mark the path Mastered.`,
      slug: next.slug,
    };
  }
  if (p?.status === "in-progress") {
    return {
      label: `Continue Lesson ${next.order}: ${next.title}`,
      hint: "Pick up where you left off.",
      slug: next.slug,
    };
  }
  return {
    label: `Start Lesson ${next.order}: ${next.title}`,
    hint: isMastery
      ? "The final lesson: short practice, then the mastery check."
      : "One small idea at a time, with practice as you go.",
    slug: next.slug,
  };
}

export default function AcademyMapPage() {
  const { state, ready, synced } = useAcademyProgress();

  return (
    <div className="ggl-academy">
      <p className="ggl-academy-eyebrow">Grow Green Lab · Trading Academy</p>
      <h1 className="ggl-academy-h1">Learn to read the market from evidence.</h1>
      <p className="ggl-academy-lede">
        Structured, interactive lessons that teach you how to think about market data: what it shows,
        what you can reasonably infer, and what remains unknown. No memorized patterns, no guaranteed
        outcomes — evidence first. New to charts? Start with World 1, Lesson 1 — it assumes nothing.
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
          if (w.status === "available") {
            const lessons = getLessonsForWorld(w.number);
            const action = recommendedAction(lessons, state.lessons);
            const doneCount = lessons.filter((l) => {
              const s = state.lessons[l.id]?.status;
              return s === "completed" || s === "mastered";
            }).length;
            const masteryProgress = state.lessons[lessons[lessons.length - 1].id];
            return (
              <section key={w.slug} className="ggl-academy-world ggl-academy-world-live" aria-label={`World ${w.number}: ${w.title}`}>
                <div className="ggl-academy-world-top">
                  <span className="ggl-academy-world-num">World {w.number}</span>
                  <span className="ggl-academy-badge ggl-academy-badge-live">Available</span>
                </div>
                <h2>{w.title}</h2>
                <p className="ggl-academy-world-tag">{w.tagline}</p>
                <ol className="ggl-academy-lessons">
                  {lessons.map((l) => {
                    const lp = state.lessons[l.id];
                    return (
                      <li key={l.id}>
                        <Link className="ggl-academy-lesson-row" href={`/academy/${l.slug}`}>
                          <span className="ggl-academy-lesson-title">
                            <span className="ggl-academy-lesson-num">{l.order}.</span> {l.title}
                          </span>
                          <span className="ggl-academy-lesson-status">{lessonStatusLabel(lp)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
                {doneCount > 0 && (
                  <p className="ggl-academy-world-progress">
                    Your progress: <strong>{doneCount} of {lessons.length} lessons completed</strong>
                    {masteryProgress?.status === "mastered"
                      ? " · Path Mastered ✓"
                      : masteryProgress && masteryProgress.bestScore !== null
                        ? ` · best mastery score ${masteryProgress.bestScore}%`
                        : ""}
                  </p>
                )}
                <p className="ggl-academy-next">
                  <span className="ggl-academy-next-label">Recommended next action</span>
                  <Link className="ggl-btn ggl-btn-primary" href={`/academy/${action.slug}`}>
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
        .ggl-academy-lessons { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
        .ggl-academy-lesson-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; min-height: 44px; padding: 6px 8px; border-radius: 8px; color: var(--ggl-text); text-decoration: none; border-bottom: 1px solid var(--ggl-border); }
        .ggl-academy-lesson-row:hover { background: rgba(66,216,121,0.06); }
        .ggl-academy-lesson-num { color: var(--ggl-muted); font-weight: 700; }
        .ggl-academy-lesson-title { font-size: 14.5px; }
        .ggl-academy-lesson-status { color: var(--ggl-green); font-size: 12.5px; font-weight: 700; white-space: nowrap; }
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
