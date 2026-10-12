"use client";

/**
 * /drills/[id] — Breakout Recognition drill runner.
 *
 * State machine: intro → running → checkpoint (paused) → resolving → teaching.
 *
 * Synchronization: a single tick loop drives the ReplayEngine; on every tick
 * the chart (via engine.displayCandles), Level 2, and Time & Sales all update
 * from the same tick state. The engine's `revealed` boundary guarantees no
 * future data leaks before the checkpoint.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getScenario, HOD_SCENARIOS } from "../../../lib/drills/scenarios";
import { gradeAnswer, type DrillAnswer, type BreakoutClassification } from "../../../lib/drills/types";
import {
  generateBook, generatePrints, phaseForCandle, flowTimestamp,
  FLOW_UPDATES_PER_CANDLE, TICKS_PER_FLOW_UPDATE,
  type OrderBookSnapshot, type TradePrint, type FlowBehavior,
} from "../../../lib/drills/orderflow";
import { ReplayEngine, TICKS_PER_CANDLE } from "../../../lib/engine";
import LwcChart from "../../../components/LwcChart";
import Level2Panel from "../../../components/Level2Panel";
import TimeSalesPanel from "../../../components/TimeSalesPanel";

type DrillPhase = "intro" | "running" | "checkpoint" | "resolving" | "teaching";

const BEHAVIOR_FOR: Record<string, FlowBehavior> = {
  "hod-clean-001": "clean",
  "hod-weak-001": "weak",
  "hod-failed-001": "failed",
  "hod-ambiguous-001": "ambiguous",
};

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

export default function DrillRunner() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const scenario = getScenario(id);

  const [phase, setPhase] = useState<DrillPhase>("intro");
  const [speed, setSpeed] = useState(8);
  const [tickVersion, setTickVersion] = useState(0); // re-render trigger
  const [answer, setAnswer] = useState<DrillAnswer | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [prints, setPrints] = useState<TradePrint[]>([]);
  const [mobileTab, setMobileTab] = useState<"l2" | "ts">("l2");

  const engineRef = useRef<ReplayEngine | null>(null);
  const tickCountRef = useRef(0);
  const ticksThisCandleRef = useRef(0);
  const lastCandleIndexRef = useRef(-1);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const answeredRef = useRef(false);
  const prevPriceRef = useRef<number>(0);

  // Init engine when starting — reveal historical context so the user
  // sees the approach/consolidation structure before live formation.
  const startDrill = useCallback(() => {
    if (!scenario) return;
    const historyCount = Math.max(2, Math.floor(scenario.checkpointIndex * 0.4));
    engineRef.current = new ReplayEngine(scenario.candles, 100_000, historyCount);
    tickCountRef.current = 0;
    ticksThisCandleRef.current = 0;
    lastCandleIndexRef.current = historyCount - 1;
    answeredRef.current = false;
    prevPriceRef.current = scenario.candles[historyCount].o;
    setAnswer(null);
    setConfidence(null);
    // Seed the order-flow panels with the last history candle's state
    // so Level 2 / Time & Sales aren't empty at drill start.
    const fp0 = { seed: scenario.seed, level: scenario.hod, behavior: BEHAVIOR_FOR[scenario.id] };
    const histCandle = scenario.candles[historyCount - 1];
    const histPhase = phaseForCandle(historyCount - 1, scenario.checkpointIndex);
    setBook(generateBook(fp0, 0, histCandle.c, histPhase, flowTimestamp(histCandle.t, FLOW_UPDATES_PER_CANDLE - 1)));
    setPrints(generatePrints(fp0, 0, histCandle.c, Math.max(1, Math.round(histCandle.v / FLOW_UPDATES_PER_CANDLE)), histPhase, flowTimestamp(histCandle.t, FLOW_UPDATES_PER_CANDLE - 1), 0).reverse());
    setPhase("running");
  }, [scenario]);

  // Tick loop
  useEffect(() => {
    if (phase !== "running" && phase !== "resolving") return;
    const engine = engineRef.current;
    if (!engine || !scenario) return;

    const tickMs = 1000 / ((TICKS_PER_CANDLE / 60) * speed);
    timerRef.current = setInterval(() => {
      const eng = engineRef.current;
      if (!eng) return;
      const prevPrice = prevPriceRef.current;
      const r = eng.tick();
      const price = eng.displayPrice;
      const dir: 1 | -1 | 0 = price > prevPrice ? 1 : price < prevPrice ? -1 : 0;
      prevPriceRef.current = price;
      tickCountRef.current += 1;

      // Reset per-candle tick counter when a new candle starts forming
      const formingIdx = eng.index + 1;
      if (formingIdx !== lastCandleIndexRef.current) {
        lastCandleIndexRef.current = formingIdx;
        ticksThisCandleRef.current = 0;
      }
      ticksThisCandleRef.current += 1;
      const ticksThisCandle = ticksThisCandleRef.current;

      // Order flow updates at a controlled, deterministic cadence:
      // 8 updates per candle, tied to tick position — readable at any speed.
      if (ticksThisCandle % TICKS_PER_FLOW_UPDATE === 0) {
        const updateIndex = Math.min(
          FLOW_UPDATES_PER_CANDLE - 1,
          Math.floor(ticksThisCandle / TICKS_PER_FLOW_UPDATE)
        );
        const flowPhase = phaseForCandle(eng.index, scenario.checkpointIndex);
        const fp = { seed: scenario.seed, level: scenario.hod, behavior: BEHAVIOR_FOR[scenario.id] };
        const candle = scenario.candles[Math.min(formingIdx, scenario.candles.length - 1)];
        const ts = flowTimestamp(candle.t, updateIndex);
        const flowTick = formingIdx * 1000 + updateIndex; // deterministic per update
        const newBook = generateBook(fp, flowTick, price, flowPhase, ts);
        const tickVol = Math.max(1, Math.round(candle.v / FLOW_UPDATES_PER_CANDLE));
        const newPrints = generatePrints(fp, flowTick, price, tickVol, flowPhase, ts, dir);
        setBook(newBook);
        setPrints((prev) => [...newPrints.reverse(), ...prev].slice(0, 60));
      }
      setTickVersion((v) => v + 1);

      // Checkpoint: pause when the checkpoint candle is finalized
      if (!answeredRef.current && eng.index >= scenario.checkpointIndex) {
        if (timerRef.current) clearInterval(timerRef.current);
        setPhase("checkpoint");
        return;
      }
      // End of scenario
      if (r.atEnd || eng.atEnd) {
        if (timerRef.current) clearInterval(timerRef.current);
        setPhase("teaching");
      }
    }, Math.max(16, tickMs));

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase, speed, scenario]);

  const submitAnswer = (a: DrillAnswer) => {
    if (answeredRef.current || !scenario) return;
    answeredRef.current = true;
    setAnswer(a);
    setPhase("resolving");
  };

  const skipToResult = () => {
    const eng = engineRef.current;
    if (!eng) return;
    if (timerRef.current) clearInterval(timerRef.current);
    while (!eng.atEnd) eng.step();
    setTickVersion((v) => v + 1);
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

  const engine = engineRef.current;
  const grading = answer ? gradeAnswer(scenario, answer) : null;
  const nextScenario = HOD_SCENARIOS[(HOD_SCENARIOS.findIndex((s) => s.id === scenario.id) + 1) % HOD_SCENARIOS.length];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <Link href="/drills" style={{ fontSize: 13, color: "var(--ggl-muted)" }}>← All drills</Link>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "4px 0 0" }}>{scenario.title}</h1>
        </div>
        {(phase === "running" || phase === "resolving") && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ fontSize: 12, color: "var(--ggl-muted)" }}>Speed</label>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}
              style={{ padding: "4px 8px", borderRadius: 6, background: "#0d1117", color: "#fff", border: "1px solid rgba(255,255,255,0.15)" }}>
              {[1, 2, 4, 8, 16].map((s) => <option key={s} value={s}>{s}x</option>)}
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

      {phase === "intro" && (
        <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 24, maxWidth: 640 }}>
          <p style={{ fontSize: 15, marginBottom: 12 }}>{scenario.description}</p>
          <p style={{ fontSize: 14, color: "var(--ggl-muted)", marginBottom: 20 }}>
            Watch the market develop. At the key moment you&apos;ll be asked to
            classify the breakout — then see how it actually played out and learn
            from the evidence. Order flow panels are simulated for training.
          </p>
          <button onClick={startDrill}
            style={{ padding: "12px 32px", borderRadius: 10, border: "none", background: "#42d879", color: "#06110b", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>
            Start Drill
          </button>
        </div>
      )}

      {(phase === "running" || phase === "resolving" || phase === "checkpoint") && engine && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 12 }} className="drill-grid">
            <div style={{ minHeight: 380 }}>
              <LwcChart
                candles={scenario.candles}
                revealedCount={engine.index + 1}
                sessionKey={scenario.id}
                countdown={null}
                lastPrice={engine.displayPrice}
                brackets={{ plannedSL: null, plannedTP: null, activeSL: null, activeTP: null }}
                referenceLevels={[{ price: scenario.hod, label: "HOD", color: "#f0b429" }]}
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
                <Level2Panel book={book} level={scenario.hod} />
                <TimeSalesPanel prints={prints} />
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
                {mobileTab === "l2" ? <Level2Panel book={book} level={scenario.hod} /> : <TimeSalesPanel prints={prints} />}
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
            <button onClick={() => { setPhase("intro"); }}
              style={{ padding: "12px 24px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 14 }}>
              Replay This Setup
            </button>
            <Link href="/drills"
              style={{ padding: "12px 24px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#fff", textDecoration: "none", fontSize: 14 }}>
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
