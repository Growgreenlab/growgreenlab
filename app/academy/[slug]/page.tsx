"use client";

/**
 * /academy/[slug] — the lesson shell.
 *
 * Renders any lesson from the typed content registry (lib/academy/
 * content.ts) through reusable section components — objectives,
 * concept blocks, interactive sections, assessment, journal, summary
 * with contextual product links. Unknown slugs render an honest
 * not-available state (planned worlds have no lesson shells at all).
 *
 * Progress wiring: opening the lesson marks it in-progress; section
 * interactions update the resume position; Evidence Board and
 * explanation first-misses feed the misconception tracker; assessment
 * attempts are recorded by the store (completed on submission,
 * mastered only at the threshold). Journal reflections save through
 * the same store. All of it fails soft to guest mode — see
 * lib/academy/progress.ts.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import {
  ASSESSMENT_ITEMS,
  CANDLE_CHALLENGES,
  EVIDENCE_ITEMS,
  EXPLANATION_QUESTIONS,
  getLessonBySlug,
  getWorld,
} from "../../../lib/academy/content";
import { makeCandle } from "../../../lib/academy/candleMath";
import {
  JOURNAL_PROMPTS,
  recordAttempt,
  recordMisconception,
  setReflection,
  touchLesson,
  type LessonProgress,
} from "../../../lib/academy/progress";
import type { LessonSection } from "../../../lib/academy/types";
import { useAcademyProgress } from "../../../components/academy/useAcademyProgress";
import CandleBuilder from "../../../components/academy/CandleBuilder";
import CandleChallenges from "../../../components/academy/CandleChallenges";
import FormationDemo from "../../../components/academy/FormationDemo";
import EvidenceBoard from "../../../components/academy/EvidenceBoard";
import ExplanationCheck from "../../../components/academy/ExplanationCheck";
import Assessment from "../../../components/academy/Assessment";
import JournalForm from "../../../components/academy/JournalForm";

const BUILDER_START = makeCandle({ open: 10.0, high: 10.6, low: 9.85, close: 10.4 });

function statusText(p: LessonProgress | undefined): string {
  if (!p || p.status === "not-started") return "Not started";
  if (p.status === "in-progress") return "In progress";
  if (p.status === "completed") return "Completed — mastery check below 80% so far";
  return "Mastered ✓";
}

export default function LessonPage() {
  const params = useParams();
  const slug = typeof params.slug === "string" ? params.slug : "";
  const lesson = getLessonBySlug(slug);
  const { state, ready, synced, update } = useAcademyProgress();

  useEffect(() => {
    if (lesson && ready) {
      update((s) => touchLesson(s, lesson.id, null, Date.now()));
    }
    // Only on first ready mount for this lesson.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson?.id, ready]);

  if (!lesson) {
    return (
      <div className="ggl-lesson">
        <p className="ggl-lesson-eyebrow">Grow Green Lab · Trading Academy</p>
        <h1 className="ggl-lesson-h1">This lesson isn&apos;t available yet.</h1>
        <p className="ggl-lesson-lede">
          There is no lesson at this address. Planned worlds are listed honestly on the learning map —
          we don&apos;t publish placeholder lessons.
        </p>
        <Link className="ggl-btn ggl-btn-primary" href="/academy">
          Back to the learning map
        </Link>
        <LessonStyles />
      </div>
    );
  }

  const world = getWorld(lesson.worldNumber);
  const progress = state.lessons[lesson.id];
  const reflections = state.reflections[lesson.id] ?? {};

  const activity = (sectionId: string) =>
    update((s) => touchLesson(s, lesson.id, sectionId, Date.now()));
  const conceptResult = (concept: string, correct: boolean) => {
    if (!correct) update((s) => recordMisconception(s, concept));
  };

  const renderInteractive = (section: LessonSection) => {
    switch (section.kind) {
      case "formation-demo":
        return <FormationDemo onActivity={() => activity(section.id)} />;
      case "candle-builder":
        return <CandleBuilder initial={BUILDER_START} onActivity={() => activity(section.id)} />;
      case "challenges":
        return <CandleChallenges challenges={CANDLE_CHALLENGES} onActivity={() => activity(section.id)} />;
      case "evidence-board":
        return (
          <EvidenceBoard
            items={EVIDENCE_ITEMS}
            onConceptResult={conceptResult}
            onActivity={() => activity(section.id)}
          />
        );
      case "explanation":
        return (
          <ExplanationCheck
            questions={EXPLANATION_QUESTIONS}
            onConceptResult={conceptResult}
            onActivity={() => activity(section.id)}
          />
        );
      case "assessment":
        return (
          <Assessment
            items={ASSESSMENT_ITEMS}
            threshold={lesson.masteryThreshold}
            bestScore={progress?.bestScore ?? null}
            attempts={progress?.attempts ?? 0}
            onAttempt={(scorePct) =>
              update((s) => recordAttempt(s, lesson.id, scorePct, lesson.masteryThreshold, true, Date.now()))
            }
          />
        );
      case "journal":
        return ready ? (
          <JournalForm
            key={lesson.id}
            prompts={JOURNAL_PROMPTS}
            initial={reflections}
            onSave={(values) =>
              update((s) =>
                Object.entries(values).reduce(
                  (acc, [k, v]) => setReflection(acc, lesson.id, k, v),
                  s
                )
              )
            }
          />
        ) : (
          <p className="ggl-lesson-note">Loading your journal…</p>
        );
      default:
        return null;
    }
  };

  return (
    <div className="ggl-lesson">
      <p className="ggl-lesson-eyebrow">
        <Link href="/academy">Trading Academy</Link> · World {lesson.worldNumber}
        {world ? ` — ${world.title}` : ""}
      </p>
      <h1 className="ggl-lesson-h1">{lesson.title}</h1>
      <p className="ggl-lesson-lede">{lesson.tagline}</p>
      <p className="ggl-lesson-meta">
        About {lesson.estimatedMinutes} minutes · {lesson.difficulty} · Prerequisites: {lesson.prerequisites}
      </p>
      <p className="ggl-lesson-status" aria-live="polite">
        Your status: <strong>{ready ? statusText(progress) : "Loading…"}</strong>
        {progress && progress.bestScore !== null ? ` · best mastery score ${progress.bestScore}%` : ""}
        {ready && !synced ? " · progress saved on this device (guest mode)" : ""}
        {ready && synced ? " · progress synced to your account" : ""}
      </p>

      {lesson.sections.map((section) => (
        <section key={section.id} id={section.id} className="ggl-lesson-section" aria-label={section.title}>
          <h2>{section.title}</h2>
          {section.kind === "objectives" && (
            <ul className="ggl-lesson-objectives">
              {lesson.objectives.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          )}
          {section.paragraphs.map((p, i) => (
            <p key={i} className="ggl-lesson-p">
              {p}
            </p>
          ))}
          {section.bullets.length > 0 && (
            <ul className="ggl-lesson-bullets">
              {section.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {renderInteractive(section)}
          {section.kind === "summary" && (
            <div className="ggl-lesson-next">
              <h3>Recommended next steps</h3>
              <p>
                Put the read into practice: the{" "}
                <Link href="/drills">Breakout Drills</Link> ask you to classify real-time simulated
                breakouts — Clean, Weak, Failed, Ambiguous — and lock a decision before the outcome,
                exactly the evidence discipline from this lesson. Then open the{" "}
                <Link href="/replay">Replay Lab</Link> to watch candles form tick-by-tick in full
                historical sessions and practise execution. These are recommendations, not
                requirements — your Academy progress is unaffected either way.
              </p>
              <p>
                <Link href="/academy">Back to the learning map</Link> to see what unlocks next
                (World 3 — Price Action and Chart Structure — is planned).
              </p>
            </div>
          )}
        </section>
      ))}

      <LessonStyles />
    </div>
  );
}

function LessonStyles() {
  return (
    <style>{`
      .ggl-lesson { padding: 40px 0 72px; max-width: 880px; }
      .ggl-lesson-eyebrow { color: var(--ggl-green); font-size: 12.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin: 0 0 10px; }
      .ggl-lesson-eyebrow a { color: var(--ggl-green); text-decoration: none; }
      .ggl-lesson-h1 { font-size: clamp(28px, 4.5vw, 40px); line-height: 1.15; margin: 0 0 12px; color: var(--ggl-text); }
      .ggl-lesson-lede { color: var(--ggl-text2); font-size: 16.5px; line-height: 1.65; margin: 0 0 10px; }
      .ggl-lesson-meta { color: var(--ggl-muted); font-size: 13.5px; margin: 0 0 8px; }
      .ggl-lesson-status { color: var(--ggl-text2); font-size: 14px; margin: 0 0 30px; }
      .ggl-lesson-status strong { color: var(--ggl-text); }
      .ggl-lesson-section { margin-bottom: 40px; scroll-margin-top: 84px; }
      .ggl-lesson-section h2 { color: var(--ggl-text); font-size: 23px; margin: 0 0 12px; }
      .ggl-lesson-p { color: var(--ggl-text2); font-size: 15.5px; line-height: 1.7; margin: 0 0 12px; }
      .ggl-lesson-objectives, .ggl-lesson-bullets { color: var(--ggl-text2); font-size: 15.5px; line-height: 1.7; padding-left: 20px; margin: 0 0 12px; }
      .ggl-lesson-note { color: var(--ggl-muted); font-size: 14px; }
      .ggl-lesson-next { border: 1px solid var(--ggl-border); border-left: 3px solid var(--ggl-green); background: var(--ggl-card); border-radius: 12px; padding: 16px 18px; margin-top: 16px; }
      .ggl-lesson-next h3 { color: var(--ggl-text); margin: 0 0 8px; font-size: 16.5px; }
      .ggl-lesson-next p { color: var(--ggl-text2); font-size: 14.5px; line-height: 1.65; margin: 0 0 10px; }
      .ggl-lesson-next a, .ggl-lesson a { color: var(--ggl-green); }
      .ggl-lesson a:focus-visible, .ggl-lesson button:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
      @media (max-width: 640px) { .ggl-lesson { padding-top: 26px; } }
    `}</style>
  );
}
