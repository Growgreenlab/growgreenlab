"use client";

/**
 * /academy/[slug] — the guided lesson shell.
 *
 * One section per step (Beginner-first redesign): teacher-voice copy,
 * a quiet "Lesson x of 7 · Step n of m" indicator, a level badge
 * (Learn / Try it yourself / Explore deeper), Back / Continue
 * navigation, and Explore-deeper sections folded into their step as a
 * collapsed disclosure. Lessons 1–6 end with an explicit
 * "Complete lesson" action (completeLesson — completion, never
 * mastery); Lesson 7 ends with the assessment + journal + summary,
 * where the assessment records its own states. Unknown slugs render
 * an honest not-available state.
 *
 * Progress wiring: opening the lesson marks it in-progress (never
 * complete); section interactions update the resume position;
 * Evidence Board and explanation first-misses feed the misconception
 * tracker; assessment attempts are recorded by the store (completed
 * on submission, mastered only at the threshold). All of it fails
 * soft to guest mode — see lib/academy/progress.ts.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ASSESSMENT_ITEMS,
  CANDLE_CHALLENGES,
  EVIDENCE_ITEMS,
  EXPLANATION_QUESTIONS,
  challengesByIds,
  evidenceByIds,
  getLessonBySlug,
  getLessonsForWorld,
  getWorld,
  questionsByIds,
} from "../../../lib/academy/content";
import { makeCandle } from "../../../lib/academy/candleMath";
import {
  JOURNAL_PROMPTS,
  completeLesson,
  recordAttempt,
  recordMisconception,
  setReflection,
  touchLesson,
  type LessonProgress,
} from "../../../lib/academy/progress";
import type { LessonLevel, LessonSection } from "../../../lib/academy/types";
import { useAcademyProgress } from "../../../components/academy/useAcademyProgress";
import CandleBuilder from "../../../components/academy/CandleBuilder";
import CandleChallenges from "../../../components/academy/CandleChallenges";
import FormationDemo from "../../../components/academy/FormationDemo";
import EvidenceBoard from "../../../components/academy/EvidenceBoard";
import ExplanationCheck from "../../../components/academy/ExplanationCheck";
import Assessment from "../../../components/academy/Assessment";
import JournalForm from "../../../components/academy/JournalForm";
import TapRevealCandle from "../../../components/academy/TapRevealCandle";
import DirectionPractice from "../../../components/academy/DirectionPractice";
import OhlcExplorer from "../../../components/academy/OhlcExplorer";

const BUILDER_START = makeCandle({ open: 10.0, high: 10.6, low: 9.85, close: 10.4 });

const LEVEL_LABELS: Record<LessonLevel, string> = {
  learn: "Learn",
  practice: "Try it yourself",
  explore: "Explore deeper",
};

function statusText(p: LessonProgress | undefined, hasAssessment: boolean): string {
  if (!p || p.status === "not-started") return "Not started";
  if (p.status === "in-progress") return "In progress";
  if (p.status === "completed") return hasAssessment ? "Completed — mastery check below 80% so far" : "Completed ✓";
  return "Mastered ✓";
}

interface Step {
  main: LessonSection;
  explore: LessonSection[];
}

/** Explore-deeper sections fold into the step they follow, not a step of their own. */
function buildSteps(sections: LessonSection[]): Step[] {
  const steps: Step[] = [];
  for (const s of sections) {
    if (s.level === "explore" && steps.length > 0) {
      steps[steps.length - 1].explore.push(s);
    } else {
      steps.push({ main: s, explore: [] });
    }
  }
  return steps;
}

export default function LessonPage() {
  const params = useParams();
  const slug = typeof params.slug === "string" ? params.slug : "";
  const lesson = getLessonBySlug(slug);
  const { state, ready, synced, update } = useAcademyProgress();
  const [stepIdx, setStepIdx] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const resumedRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (lesson && ready) {
      update((s) => touchLesson(s, lesson.id, null, Date.now()));
    }
    // Only on first ready mount for this lesson.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson?.id, ready]);

  // Moving to a different lesson restarts its step flow.
  useEffect(() => {
    setStepIdx(0);
    resumedRef.current = false;
  }, [lesson?.id]);

  // Resume where the learner left off (once per lesson visit).
  useEffect(() => {
    if (!lesson || !ready || resumedRef.current) return;
    resumedRef.current = true;
    const pos = state.lessons[lesson.id]?.lastPosition;
    if (!pos) return;
    const idx = buildSteps(lesson.sections).findIndex((st) => st.main.id === pos);
    if (idx > 0) setStepIdx(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson?.id, ready]);

  // On step change: back to the top of the lesson, focus on the heading.
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    topRef.current?.scrollIntoView({ block: "start" });
    headingRef.current?.focus();
  }, [stepIdx]);

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
  const worldLessons = getLessonsForWorld(lesson.worldNumber);
  const nextLesson = worldLessons.find((l) => l.order === lesson.order + 1) ?? null;
  const progress = state.lessons[lesson.id];
  const reflections = state.reflections[lesson.id] ?? {};
  const hasAssessment = lesson.sections.some((s) => s.kind === "assessment");
  const steps = buildSteps(lesson.sections);
  const step = steps[Math.min(stepIdx, steps.length - 1)];
  const isLastStep = stepIdx >= steps.length - 1;
  const isComplete = progress?.status === "completed" || progress?.status === "mastered";
  const lessonStatus = progress?.status ?? "not-started";

  const activity = (sectionId: string) =>
    update((s) => touchLesson(s, lesson.id, sectionId, Date.now()));
  const conceptResult = (concept: string, correct: boolean) => {
    if (!correct) update((s) => recordMisconception(s, concept));
  };

  const goToStep = (idx: number) => {
    const clamped = Math.max(0, Math.min(idx, steps.length - 1));
    setStepIdx(clamped);
    activity(steps[clamped].main.id);
  };

  const evidenceItemsFor = (s: LessonSection) =>
    s.contentIds ? evidenceByIds(s.contentIds) : EVIDENCE_ITEMS;

  /**
   * Statement numbering continues across a lesson's boards: the
   * offset for a board is the item count of every evidence-board
   * section before it in the lesson (Lesson 6's explore set follows
   * its first board, so it starts at 7, not 1).
   */
  const evidenceOffsetFor = (section: LessonSection): number => {
    let offset = 0;
    for (const s of lesson.sections) {
      if (s.id === section.id) break;
      if (s.kind === "evidence-board") offset += evidenceItemsFor(s).length;
    }
    return offset;
  };

  const renderInteractive = (section: LessonSection) => {
    switch (section.kind) {
      case "tap-reveal":
        return <TapRevealCandle onActivity={() => activity(section.id)} />;
      case "direction-practice":
        return (
          <DirectionPractice onActivity={() => activity(section.id)} onConceptResult={conceptResult} />
        );
      case "ohlc-explorer":
        return (
          <OhlcExplorer
            questions={section.contentIds ? questionsByIds(section.contentIds) : undefined}
            onActivity={() => activity(section.id)}
            onConceptResult={conceptResult}
          />
        );
      case "formation-demo":
        return <FormationDemo onActivity={() => activity(section.id)} />;
      case "candle-builder":
        return <CandleBuilder initial={BUILDER_START} onActivity={() => activity(section.id)} />;
      case "challenges":
        return (
          <CandleChallenges
            challenges={section.contentIds ? challengesByIds(section.contentIds) : CANDLE_CHALLENGES}
            onActivity={() => activity(section.id)}
          />
        );
      case "evidence-board":
        return (
          <EvidenceBoard
            items={evidenceItemsFor(section)}
            numberOffset={evidenceOffsetFor(section)}
            onConceptResult={conceptResult}
            onActivity={() => activity(section.id)}
          />
        );
      case "explanation":
        return (
          <ExplanationCheck
            questions={section.contentIds ? questionsByIds(section.contentIds) : EXPLANATION_QUESTIONS}
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

  const renderSectionBody = (section: LessonSection) => (
    <>
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
            <Link href="/academy">Back to the learning map</Link> to see what comes next
            (World 2 — Stock Market Foundations — is planned).
          </p>
        </div>
      )}
    </>
  );

  const levelLabel = LEVEL_LABELS[step.main.level ?? "learn"];

  return (
    <div className="ggl-lesson" ref={topRef}>
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
        Your status: <strong>{ready ? statusText(progress, hasAssessment) : "Loading…"}</strong>
        {progress && progress.bestScore !== null && hasAssessment ? ` · best mastery score ${progress.bestScore}%` : ""}
        {ready && !synced ? " · progress saved on this device (guest mode)" : ""}
        {ready && synced ? " · progress synced to your account" : ""}
      </p>

      <div className="ggl-lesson-progress" aria-label="Lesson progress">
        <span>
          Lesson {lesson.order} of {worldLessons.length} · Step {stepIdx + 1} of {steps.length}
        </span>
        <div className="ggl-lesson-progress-track" aria-hidden="true">
          <div
            className="ggl-lesson-progress-fill"
            style={{ width: `${((stepIdx + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <section key={step.main.id} className="ggl-lesson-section" aria-label={step.main.title}>
        <p className="ggl-lesson-badge">
          <span className="ggl-lesson-badge-chip">{levelLabel}</span>
        </p>
        <h2 ref={headingRef} tabIndex={-1} className="ggl-lesson-step-h2">
          {step.main.title}
        </h2>
        {renderSectionBody(step.main)}
        {step.explore.map((ex) => (
          <details key={ex.id} className="ggl-lesson-explore">
            <summary>Explore deeper — {ex.title.replace(/^Explore deeper:\s*/i, "")}</summary>
            <div className="ggl-lesson-explore-body">{renderSectionBody(ex)}</div>
          </details>
        ))}
      </section>

      <nav className="ggl-lesson-nav" aria-label="Lesson steps">
        <button
          type="button"
          className="ggl-btn-ghost"
          style={{ minHeight: 44 }}
          disabled={stepIdx === 0}
          onClick={() => goToStep(stepIdx - 1)}
        >
          ← Back
        </button>
        {!isLastStep && (
          <button
            type="button"
            className="ggl-btn ggl-btn-primary"
            style={{ minHeight: 44 }}
            onClick={() => goToStep(stepIdx + 1)}
          >
            Continue →
          </button>
        )}
        {isLastStep && !hasAssessment && !isComplete && (
          <button
            type="button"
            className="ggl-btn ggl-btn-primary"
            style={{ minHeight: 44 }}
            onClick={() => update((s) => completeLesson(s, lesson.id, Date.now()))}
          >
            Complete lesson ✓
          </button>
        )}
        {isLastStep && !hasAssessment && isComplete && (
          <span className="ggl-lesson-done" aria-live="polite">
            Lesson complete ✓
            {nextLesson && (
              <>
                {" · "}
                <Link href={`/academy/${nextLesson.slug}`}>
                  Next: Lesson {nextLesson.order} — {nextLesson.title} →
                </Link>
              </>
            )}
          </span>
        )}
        {isLastStep && hasAssessment && (
          <span className="ggl-lesson-done">
            {lessonStatus === "mastered" ? (
              <>Path mastered ✓ · <Link href="/academy">Back to the learning map</Link></>
            ) : (
              <Link href="/academy">Back to the learning map</Link>
            )}
          </span>
        )}
      </nav>

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
      .ggl-lesson-status { color: var(--ggl-text2); font-size: 14px; margin: 0 0 18px; }
      .ggl-lesson-status strong { color: var(--ggl-text); }
      .ggl-lesson-progress { display: flex; align-items: center; gap: 14px; color: var(--ggl-muted); font-size: 13.5px; margin: 0 0 26px; }
      .ggl-lesson-progress-track { flex: 1; height: 6px; border-radius: 999px; background: var(--ggl-border); overflow: hidden; }
      .ggl-lesson-progress-fill { height: 100%; background: var(--ggl-green); border-radius: 999px; transition: width 0.25s ease; }
      .ggl-lesson-section { margin-bottom: 28px; scroll-margin-top: 84px; }
      .ggl-lesson-section h2 { color: var(--ggl-text); font-size: 23px; margin: 0 0 12px; }
      .ggl-lesson-step-h2:focus { outline: none; }
      .ggl-lesson-step-h2:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
      .ggl-lesson-badge { margin: 0 0 8px; }
      .ggl-lesson-badge-chip { display: inline-block; padding: 3px 12px; border-radius: 999px; border: 1px solid var(--ggl-border); background: var(--ggl-card); color: var(--ggl-green); font-size: 12.5px; font-weight: 700; letter-spacing: 0.04em; }
      .ggl-lesson-p { color: var(--ggl-text2); font-size: 15.5px; line-height: 1.7; margin: 0 0 12px; }
      .ggl-lesson-objectives, .ggl-lesson-bullets { color: var(--ggl-text2); font-size: 15.5px; line-height: 1.7; padding-left: 20px; margin: 0 0 12px; }
      .ggl-lesson-note { color: var(--ggl-muted); font-size: 14px; }
      .ggl-lesson-explore { border: 1px solid var(--ggl-border); border-radius: 12px; background: var(--ggl-card); margin-top: 22px; }
      .ggl-lesson-explore summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; padding: 10px 16px; color: var(--ggl-text); font-weight: 600; font-size: 15px; }
      .ggl-lesson-explore-body { padding: 2px 16px 16px; }
      .ggl-lesson-nav { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--ggl-border); padding-top: 18px; }
      .ggl-lesson-done { color: var(--ggl-text2); font-size: 14.5px; }
      .ggl-lesson-done a { color: var(--ggl-green); }
      .ggl-lesson-next { border: 1px solid var(--ggl-border); border-left: 3px solid var(--ggl-green); background: var(--ggl-card); border-radius: 12px; padding: 16px 18px; margin-top: 16px; }
      .ggl-lesson-next h3 { color: var(--ggl-text); margin: 0 0 8px; font-size: 16.5px; }
      .ggl-lesson-next p { color: var(--ggl-text2); font-size: 14.5px; line-height: 1.65; margin: 0 0 10px; }
      .ggl-lesson-next a, .ggl-lesson a { color: var(--ggl-green); }
      .ggl-lesson a:focus-visible, .ggl-lesson button:focus-visible, .ggl-lesson summary:focus-visible { outline: 2px solid var(--ggl-green); outline-offset: 2px; }
      @media (max-width: 640px) { .ggl-lesson { padding-top: 26px; } }
    `}</style>
  );
}
