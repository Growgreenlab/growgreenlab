"use client";

/**
 * /drills/[id] — Breakout Recognition drill runner.
 *
 * State machine: intro → running → checkpoint (paused) → resolving → teaching.
 *
 * Synchronization (see docs/drill-audit-2026-10-14.md): ONE simulation
 * owner (DrillSim, lib/drills/sim.ts) wraps the shared ReplayEngine.
 * A requestAnimationFrame scheduler converts wall time to ticks via
 * SimClock (bounded catch-up: stalls slow the drill, they never burst),
 * and DrillSim derives the chart (engine.displayCandles), Level 2, and
 * Time & Sales from the same tick stream. Pause stops the scheduler —
 * no ticks are requested, so no sim-driven state can change. Speed
 * rescales wall pacing only; the event sequence is speed-independent.
 *
 * Speed definition: s× = s simulated minutes per wall-clock minute
 * (one 1-minute candle forms in 60/s seconds; 1x is real time).
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getScenario, HOD_SCENARIOS } from "../../../lib/drills/scenarios";
import { gradeAnswer, type DrillAnswer, type BreakoutClassification } from "../../../lib/drills/types";
import { DrillSim, SimClock } from "../../../lib/drills/sim";
import { hodMarketState, HOD_STATE_LABEL } from "../../../lib/drills/hodState";
import LwcChart from "../../../components/LwcChart";
import Level2Panel from "../../../components/Level2Panel";
import TimeSalesPanel from "../../../components/TimeSalesPanel";

type DrillPhase = "intro" | "running" | "checkpoint" | "resolving" | "teaching";

const ANSWER_OPTIONS: { id: DrillAnswer; label: string }[] = [
  { id: "clean", label: "Clean Breakout" },
  { id: "weak", label: "Weak Breakout" },
  { id: "failed", label: "Failed Breakout / Trap" },
  { id: "not_sure", label: "Not Sure" },
];

const CLASS_LABEL: Record<BreakoutClassification, string> = {
  clean: "Clean Breakout",
  weak: "Weak Breakout",
  failed: "Failed Breakout / Trap",
  continuation: "Strong Continuation",
  ambiguous: "Ambiguous",
};

const DIFFICULTY_LABEL: Record<string, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

function fmtSimTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function DrillRunner() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const scenario = getScenario(id);

  const [phase, setPhase] = useState<DrillPhase>("intro");
  const [speed, setSpeed] = useState(8);
  const [paused, setPaused] = useState(false);
  const [, setUiVersion] = useState(0); // render pump
  const [answer, setAnswer] = useState<DrillAnswer | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [mobileTab, setMobileTab] = useState<"l2" | "ts">("l2");

  const simRef = useRef<DrillSim | null>(null);
  const clockRef = useRef<SimClock | null>(null);
  const answeredRef = useRef(false);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  // Scenario switch: Next.js may reuse this component across /drills/[id]
  // changes — never let a previous scenario's sim, phase, or answer leak
  // into the new one (audit RC9).
  useEffect(() => {
    simRef.current = null;
    clockRef.current = null;
    answeredRef.current = false;
    setPhase("intro");
    setAnswer(null);
    setConfidence(null);
    setPaused(false);
    setUiVersion(0);
  }, [id]);

  const startDrill = useCallback(() => {
    if (!scenario) return;
    simRef.current = new DrillSim(scenario);
    clockRef.current = new SimClock();
    answeredRef.current = false;
    setAnswer(null);
    setConfidence(null);
    setPaused(false);
    setUiVersion((v) => v + 1);
    setPhase("running");
  }, [scenario]);

  // The scheduler: the only place sim time is requested. Runs only while
  // running/resolving and not paused; cleanup cancels the frame loop, so
  // unmounts, phase changes, and pauses can never leave a timer behind.
  useEffect(() => {
    if ((phase !== "running" && phase !== "resolving") || paused) return;
    const sim = simRef.current;
    const clock = clockRef.current;
    if (!sim || !clock) return;
    clock.reset();

    let raf = 0;
    let lastUiPush = 0;
    const loop = (now: number) => {
      const due = clock.frame(now, speedRef.current);
      if (due > 0) {
        const events = sim.advance(due);
        const nowMs = performance.now();
        // Re-render on flow/finalize events, or at ~7 Hz for the live
        // price line — panels never re-render per tick (audit RC10).
        if (events.length > 0 || nowMs - lastUiPush >= 150) {
          lastUiPush = nowMs;
          setUiVersion((v) => v + 1);
        }
        if (!answeredRef.current && sim.checkpointReached) {
          setPhase("checkpoint");
          return; // no further frame: the scheduler stops with the phase
        }
        if (sim.atEnd) {
          setPhase("teaching");
          return;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase, paused, id]);

  const submitAnswer = (a: DrillAnswer) => {
    if (answeredRef.current || !scenario) return;
    answeredRef.current = true;
    setAnswer(a);
    setPaused(false);
    setPhase("resolving");
  };

  const skipToResult = () => {
    const sim = simRef.current;
    if (!sim) return;
    sim.advanceToEnd();
    setUiVersion((v) => v + 1);
    setPhase("teaching");
  };

  if (!scenario) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 16px", textAlign: "center" }}>
        <h2>Scenario not found</h2>
        <Link href="/drills">Back to drills</Link>
      </div>
    );
  }

  const sim = simRef.current;
  const grading = answer ? gradeAnswer(scenario, answer) : null;
  const nextScenario = HOD_SCENARIOS[(HOD_SCENARIOS.findIndex((s) => s.id === scenario.id) + 1) % HOD_SCENARIOS.length];

  // HOD header data — revealed data only (engine boundary), never the
  // scenario's future candles.
  const engine = sim?.engine ?? null;
  const displayCandles = engine ? engine.displayCandles : [];
  const livePrice = engine ? engine.displayPrice : scenario.candles[0].o;
  const liveHod = engine ? engine.hod : scenario.hod;
  const forming = sim ? sim.formingCandle() : null;
  const hodState = engine
    ? hodMarketState(scenario.hod, engine.revealed, forming)
    : "approaching";
  const distPct = ((livePrice - scenario.hod) / scenario.hod) * 100;

  const inRun = phase === "running" || phase === "resolving" || phase === "checkpoint";

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "16px" }}>
      {/* Header — neutral title until the teaching screen (audit RC8):
          the runner never announces the classification mid-drill. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <Link href="/drills" style={{ fontSize: 13, color: "var(--ggl-muted)" }}>← All drills</Link>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "4px 0 0" }}>
            {phase === "teaching" ? scenario.title : "HOD Breakout Drill"}
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ggl-muted)", marginLeft: 10 }}>
              {DIFFICULTY_LABEL[scenario.difficulty]}
            </span>
          </h1>
        </div>
        {(phase === "running" || phase === "resolving") && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--ggl-muted)" }}>
              Sim time <strong style={{ color: "#fff" }}>{sim ? fmtSimTime(sim.simTimeMs) : "00:00"}</strong>
              {" · "}{paused ? "Paused" : phase === "resolving" ? "Resolving" : "Running"}
            </span>
            <button onClick={() => setPaused((p) => !p)}
              style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#fff", cursor: "pointer", fontSize: 13 }}>
              {paused ? "Resume" : "Pause"}
            </button>
            <button onClick={startDrill}
              style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#fff", cursor: "pointer", fontSize: 13 }}>
              Reset
            </button>
            <label style={{ fontSize: 12, color: "var(--ggl-muted)" }}>Speed</label>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}
              style={{ padding: "4px 8px", borderRadius: 6, background: "#0d1117", color: "#fff", border: "1px solid rgba(255,255,255,0.15)" }}>
              {[1, 2, 4, 8, 16, 32].map((s) => <option key={s} value={s}>{s}x</option>)}
            </select>
            {phase === "resolving" && (
              <button onClick={skipToResult}
                style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#fff", cursor: "pointer", fontSize: 13 }}>
                Skip to Result →
              </button>
            )}
          </div>
        )}
      </div>
      {(phase === "running" || phase === "resolving") && (
        <div style={{ fontSize: 11, color: "var(--ggl-muted)", marginTop: -6, marginBottom: 10 }}>
          Speed: 1x = real time (one simulated minute per 60 seconds). Higher speeds compress wall-clock time only — the market sequence is identical at every speed.
        </div>
      )}

      {phase === "intro" && (
        <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 24, maxWidth: 640 }}>
          <p style={{ fontSize: 15, marginBottom: 12 }}>{scenario.description}</p>
          <p style={{ fontSize: 14, color: "var(--ggl-muted)", marginBottom: 12 }}>
            Watch the market develop. At the key moment you&apos;ll be asked to
            classify the breakout — then see how it actually played out and learn
            from the evidence. Order flow panels are simulated for training.
          </p>
          <p style={{ fontSize: 14, color: "var(--ggl-muted)", marginBottom: 20 }}>
            Controls: Pause/Resume and Reset are in the header while the drill
            runs, and Speed can be changed at any time — it only changes how
            fast the same market replays. Some candles of history are already
            on the chart so you can see the approach into the HOD level
            (the gold line) before live action starts.
          </p>
          <button onClick={startDrill}
            style={{ padding: "12px 32px", borderRadius: 10, border: "none", background: "#42d879", color: "#06110b", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>
            Start Drill
          </button>
        </div>
      )}

      {inRun && sim && engine && (
        <>
          {/* HOD readout: reference level vs live session high are
              different things and are labelled as such. */}
          <div style={{
            display: "flex", gap: 20, alignItems: "center", marginBottom: 10, flexWrap: "wrap",
            padding: "8px 14px", background: "#0d1117",
            border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 13,
          }}>
            <span><span style={{ color: "#f0b429", fontWeight: 700 }}>HOD (breakout level):</span> <strong>${scenario.hod.toFixed(2)}</strong></span>
            <span><span style={{ color: "var(--ggl-muted)" }}>Session high (live):</span> <strong>${liveHod.toFixed(2)}</strong></span>
            <span><span style={{ color: "var(--ggl-muted)" }}>Current:</span> <strong>${livePrice.toFixed(2)}</strong></span>
            <span><span style={{ color: "var(--ggl-muted)" }}>Distance to HOD:</span> <strong style={{ color: livePrice >= scenario.hod ? "#2ebd85" : "#f0b429" }}>
              {livePrice >= scenario.hod ? "+" : "−"}${Math.abs(livePrice - scenario.hod).toFixed(2)} ({distPct >= 0 ? "+" : ""}{distPct.toFixed(2)}%)
            </strong></span>
            <span><span style={{ color: "var(--ggl-muted)" }}>State:</span> <strong>{HOD_STATE_LABEL[hodState]}</strong></span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 12 }} className="drill-grid">
            <div style={{ minHeight: 380 }}>
              <LwcChart
                candles={displayCandles}
                revealedCount={displayCandles.length}
                sessionKey={scenario.id}
                countdown={null}
                lastPrice={livePrice}
                brackets={{ plannedSL: null, plannedTP: null, activeSL: null, activeTP: null }}
                referenceLevels={[{ price: scenario.hod, label: "HOD", color: "#f0b429" }]}
                fitOnLoad={true}
                onPlannedDrag={() => {}}
                onActiveDrag={() => {}}
                drawings={[]}
                onDrawingsChange={() => {}}
                drawingTool="select"
                onDrawingToolChange={() => {}}
              />
            </div>
            <div className="drill-side-panels" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="drill-desktop-panels" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Level2Panel book={sim.book} level={scenario.hod} />
                <TimeSalesPanel prints={sim.prints} />
              </div>
              <div className="drill-mobile-tabs" style={{ display: "none" }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <button onClick={() => setMobileTab("l2")}
                    style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: mobileTab === "l2" ? "rgba(66,216,121,0.15)" : "transparent", color: "#fff", cursor: "pointer" }}>
                    Level 2
                  </button>
                  <button onClick={() => setMobileTab("ts")}
                    style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: mobileTab === "ts" ? "rgba(66,216,121,0.15)" : "transparent", color: "#fff", cursor: "pointer" }}>
                    Time &amp; Sales
                  </button>
                </div>
                {mobileTab === "l2" ? <Level2Panel book={sim.book} level={scenario.hod} /> : <TimeSalesPanel prints={sim.prints} />}
              </div>
            </div>
          </div>

          {/* Checkpoint modal */}
          {phase === "checkpoint" && (
            <div style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
              display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16,
            }}>
              <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, padding: 28, maxWidth: 520, width: "100%" }}>
                <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>What type of breakout is this setting up to be?</h2>
                <p style={{ fontSize: 14, color: "var(--ggl-muted)", marginBottom: 20 }}>
                  Base your read on the candles, volume, Level 2, and Time &amp; Sales so far.
                  The outcome is hidden until you answer.
                </p>
                <div style={{ display: "grid", gap: 10, marginBottom: 20 }}>
                  {ANSWER_OPTIONS.map((o) => (
                    <button key={o.id} onClick={() => submitAnswer(o.id)}
                      style={{ padding: "12px 16px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.03)", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", textAlign: "left" }}>
                      {o.label}
                    </button>
                  ))}
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 13, color: "var(--ggl-muted)", display: "block", marginBottom: 6 }}>
                    Confidence (optional): {confidence ?? "—"}/5
                  </label>
                  <input type="range" min={1} max={5} step={1}
                    value={confidence ?? 3}
                    onChange={(e) => setConfidence(Number(e.target.value))}
                    style={{ width: "100%" }} />
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {phase === "teaching" && answer && grading && (
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {/* Result */}
          <div style={{
            background: "#0d1117", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12, padding: 24, marginBottom: 16,
            borderLeft: `4px solid ${grading.correct ? "#2ebd85" : grading.partial ? "#f0b429" : "#f6465d"}`,
          }}>
            <div style={{ fontSize: 13, color: "var(--ggl-muted)", marginBottom: 4 }}>YOUR ANSWER</div>
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 12 }}>
              {answer === "not_sure" ? "Not Sure" : CLASS_LABEL[answer as BreakoutClassification]}
            </div>
            <div style={{ fontSize: 13, color: "var(--ggl-muted)", marginBottom: 4 }}>ACTUAL CLASSIFICATION</div>
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 12 }}>{CLASS_LABEL[scenario.classification]}</div>
            <div style={{
              display: "inline-block", padding: "4px 14px", borderRadius: 20, fontSize: 13, fontWeight: 700,
              background: grading.correct ? "rgba(46,189,133,0.15)" : grading.partial ? "rgba(240,180,41,0.15)" : "rgba(246,70,93,0.15)",
              color: grading.correct ? "#2ebd85" : grading.partial ? "#f0b429" : "#f6465d",
            }}>
              {grading.correct ? "Correct" : grading.partial ? "Partially Correct" : "Incorrect"}
            </div>
          </div>

          {/* Evidence */}
          <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 24, marginBottom: 16 }}>
            <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 12 }}>What happened</h3>
            <EvidenceRow label="Candles" text={scenario.evidence.candleStructure} />
            <EvidenceRow label="Volume" text={scenario.evidence.volumeBehavior} />
            <EvidenceRow label="Price vs HOD" text={scenario.evidence.priceVsLevel} />
            <EvidenceRow label="Resolution" text={scenario.evidence.resolution} />
          </div>

          {/* What you missed */}
          {scenario.teaching.missedByAnswer[answer] && (
            <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 24, marginBottom: 16 }}>
              <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 12 }}>What to take from this</h3>
              <p style={{ fontSize: 14, lineHeight: 1.6 }}>{scenario.teaching.missedByAnswer[answer]}</p>
            </div>
          )}

          {/* Alternative outcome */}
          <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 24, marginBottom: 16 }}>
            <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 12 }}>Alternative outcome</h3>
            <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ggl-muted)" }}>
              <em>Illustrative comparison, not historical data:</em> {scenario.teaching.alternativeOutcome}
            </p>
          </div>

          {/* Lessons */}
          <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 24, marginBottom: 24 }}>
            <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 12 }}>Key lessons</h3>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {scenario.teaching.lessons.map((l, i) => (
                <li key={i} style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 8 }}>{l}</li>
              ))}
            </ul>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 32 }}>
            <Link href={`/drills/${nextScenario.id}`}
              style={{ padding: "12px 24px", borderRadius: 10, background: "#42d879", color: "#06110b", fontWeight: 800, textDecoration: "none", fontSize: 14 }}>
              Next Drill →
            </Link>
            <button onClick={() => { simRef.current = null; setPhase("intro"); }}
              style={{ padding: "12px 24px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 14 }}>
              Replay This Setup
            </button>
            <Link href="/drills"
              style={{ padding: "12px 24px", borderRadius: 10, background: "transparent", color: "#fff", textDecoration: "none", fontSize: 14 }}>
              All Drills
            </Link>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 900px) {
          .drill-grid { grid-template-columns: 1fr !important; }
          .drill-desktop-panels { display: none !important; }
          .drill-mobile-tabs { display: block !important; }
        }
      `}</style>
    </div>
  );
}

function EvidenceRow({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#f0b429", marginBottom: 2 }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 14, lineHeight: 1.6 }}>{text}</div>
    </div>
  );
}
