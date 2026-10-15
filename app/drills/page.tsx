"use client";

/**
 * /drills — Breakout Recognition drill picker.
 *
 * Two clearly separated modes (see docs/drill-blind-audit-2026-10-14.md
 * and docs/drill-pool-2026-10-14.md):
 *
 *  - Blind Practice (default, this screen): a non-repeating CYCLE over
 *    the whole drill pool. The queue order, what's been started, and
 *    what's been submitted live in a local cycle record
 *    (lib/drills/cycle.ts) — drills carry neutral labels only, a drill
 *    counts only when a decision is locked in, and no drill repeats
 *    until the cycle is complete. The setup type is revealed only
 *    after you lock in your decision.
 *  - Focused Learning (/drills/focused): deliberately pick a setup
 *    category for targeted practice (outside the cycle).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { randomRunSeed } from "../../lib/drills/catalog";
import {
  browserStorage, ensurePool, updatePool, serveNextSlug, startNewCycle,
  cycleResults, labelForSlug, type PoolState,
} from "../../lib/drills/cycle";
import type { BreakoutClassification } from "../../lib/drills/types";

const CLASS_LABEL: Record<BreakoutClassification, string> = {
  clean: "Clean Breakout",
  weak: "Weak Breakout",
  failed: "Failed Breakout / Trap",
  continuation: "Strong Continuation",
  ambiguous: "Ambiguous / No Trade",
};

const READ_LABEL = { correct: "Correct", partial: "Partially Correct", incorrect: "Incorrect" } as const;
const ACTION_NAME = { enter: "Enter", wait: "Wait", skip: "Skip" } as const;
const ACTION_LABEL = { appropriate: "Appropriate", acceptable: "Acceptable", inappropriate: "Inappropriate" } as const;

export default function DrillsPage() {
  const [pool, setPool] = useState<PoolState | null>(null);

  useEffect(() => {
    const storage = browserStorage();
    if (storage) setPool(ensurePool(storage, randomRunSeed(), Date.now()));
  }, []);

  const onStartNewCycle = () => {
    const storage = browserStorage();
    if (!storage) return;
    const seed = randomRunSeed();
    const now = Date.now();
    setPool(updatePool(storage, seed, now, (s) => startNewCycle(s, seed, now)));
  };

  const active = pool?.active ?? null;
  const results = active ? cycleResults(active) : null;
  const nextSlug = pool ? serveNextSlug(pool) : null;
  const nextStarted = !!(active && nextSlug && active.started[nextSlug] !== undefined);
  const cycleNumber = (pool?.archives.length ?? 0) + 1;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px calc(32px + env(safe-area-inset-bottom, 0px))" }}>
      <h1 style={{ fontSize: "clamp(24px, 6.5vw, 28px)", fontWeight: 800, marginBottom: 8 }}>
        Breakout Recognition
      </h1>
      <p style={{ color: "var(--ggl-muted)", fontSize: 15, marginBottom: 24, maxWidth: 640 }}>
        Train your eye to recognize breakouts using charts, volume,
        Level 2 and Time &amp; Sales. Make your decision before the
        outcome is revealed. Order flow is simulated for training.
      </p>

      {/* Blind Practice — the default mode */}
      <div
        style={{
          background: "#0d1117",
          border: "1px solid rgba(66,216,121,0.35)",
          borderRadius: 12,
          padding: "20px 20px 16px",
          marginBottom: 28,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.5, color: "#42d879", marginBottom: 6 }}>
          BLIND PRACTICE
        </div>
        <p style={{ fontSize: 14, color: "var(--ggl-muted)", marginBottom: 10, maxWidth: 620 }}>
          No labels, no hints, no difficulty ratings — just the chart,
          the book, and your decision.
        </p>
        <details style={{ marginBottom: 16 }}>
          <summary
            style={{
              fontSize: 13, fontWeight: 700, color: "var(--ggl-muted)",
              cursor: "pointer", padding: "8px 0", width: "fit-content",
            }}
          >
            How it works
          </summary>
          <p style={{ fontSize: 14, color: "var(--ggl-muted)", marginTop: 8, maxWidth: 620 }}>
            Blind Practice runs in cycles over the full drill pool: every
            drill appears exactly once per cycle, in a shuffled order
            known only to the queue. A drill counts when you lock in a
            decision — opening one and leaving doesn&apos;t use it up,
            and an interrupted drill is served again first. Your
            progress is saved on this device.
          </p>
        </details>

        {pool === null || active === null || results === null ? (
          <p style={{ fontSize: 14, color: "var(--ggl-muted)" }}>Loading your cycle…</p>
        ) : results.complete ? (
          <>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>
              🎉 Cycle {cycleNumber} complete — all {results.total} drills submitted
            </div>
            <p style={{ fontSize: 14, color: "var(--ggl-muted)", marginBottom: 16 }}>
              Average score <strong style={{ color: "#fff" }}>{results.avgOverall}/100</strong>
              {" · "}Reads <strong style={{ color: "#fff" }}>{results.readPct}%</strong>
              {" · "}Decisions <strong style={{ color: "#fff" }}>{results.actionPct}%</strong>
            </p>
            <div style={{ display: "grid", gap: 8, marginBottom: 20 }}>
              {results.rows.map((r) => (
                <div
                  key={r.slug}
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    gap: 12, flexWrap: "wrap",
                    padding: "12px 16px", borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.02)",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>
                      {labelForSlug(r.slug)} — {CLASS_LABEL[r.actualClassification]}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ggl-muted)" }}>
                      Your read: {CLASS_LABEL[r.classification]} · Action: {ACTION_NAME[r.action]} · Confidence {r.confidence}/5 · Locked at {r.lockLabel}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, textAlign: "right" }}>
                    <div>Read: <strong>{READ_LABEL[r.readVerdict]}</strong> · Decision: <strong>{ACTION_LABEL[r.actionVerdict]}</strong></div>
                    <div style={{ fontWeight: 800, fontSize: 13 }}>Score {r.overall}/100</div>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={onStartNewCycle}
              style={{
                padding: "12px 28px", borderRadius: 10, border: "none",
                background: "#42d879", color: "#06110b", fontSize: 15,
                fontWeight: 800, cursor: "pointer",
              }}
            >
              Start New Cycle
            </button>
            <p style={{ fontSize: 12, color: "#6e7681", marginTop: 12 }}>
              This cycle&apos;s results stay saved below — starting a new cycle never erases them.
            </p>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "var(--ggl-muted)", marginBottom: 8 }}>
              Cycle {cycleNumber} · {results.submitted} of {results.total} drills submitted
            </div>
            <div style={{
              height: 8, borderRadius: 4, background: "rgba(255,255,255,0.08)",
              overflow: "hidden", marginBottom: 16,
            }}>
              <div style={{
                height: "100%", background: "#42d879",
                width: `${results.total === 0 ? 0 : (results.submitted / results.total) * 100}%`,
              }} />
            </div>
            {nextSlug && (
              <>
                <Link
                  href={`/drills/${nextSlug}`}
                  className="ggl-drill-cta"
                  style={{
                    display: "inline-block", padding: "12px 28px", borderRadius: 10,
                    background: "#42d879", color: "#06110b", fontSize: 15,
                    fontWeight: 800, textDecoration: "none", marginBottom: 10,
                  }}
                >
                  {nextStarted ? `Resume ${labelForSlug(nextSlug)} →` : "Start Next Drill →"}
                </Link>
                <div style={{ fontSize: 12, color: "#6e7681" }}>
                  {nextStarted
                    ? "You started this drill but haven't locked in a decision — it comes first."
                    : `Up next: ${labelForSlug(nextSlug)} — its setup type stays hidden until you decide.`}
                </div>
              </>
            )}
          </>
        )}

        {pool && pool.archives.length > 0 && (
          <div style={{ marginTop: 24, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.5, color: "var(--ggl-muted)", marginBottom: 10 }}>
              PREVIOUS CYCLES
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {pool.archives.map((cycle, i) => {
                const r = cycleResults(cycle);
                return (
                  <div key={cycle.cycleId} style={{ fontSize: 13, color: "var(--ggl-muted)" }}>
                    Cycle {i + 1} — {r.submitted} of {r.total} drills submitted
                    {r.avgOverall !== null ? ` · avg score ${r.avgOverall}/100` : ""}
                    {r.readPct !== null ? ` · reads ${r.readPct}%` : ""}
                    {r.actionPct !== null ? ` · decisions ${r.actionPct}%` : ""}
                    {cycle.completedAt
                      ? ` · completed ${new Date(cycle.completedAt).toLocaleDateString()}`
                      : ""}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Focused Learning — deliberately separated */}
      <div
        style={{
          background: "#0d1117",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          padding: "20px",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.5, color: "var(--ggl-muted)", marginBottom: 6 }}>
          FOCUSED LEARNING
        </div>
        <p style={{ fontSize: 14, color: "var(--ggl-muted)", marginBottom: 16, maxWidth: 620 }}>
          Want to study one setup type on purpose? In Focused Learning you
          choose the category up front — clean, weak, failed/trap, or
          ambiguous — and drill it deliberately. Focused drills don&apos;t
          touch your blind cycle.
        </p>
        <Link
          href="/drills/focused"
          style={{
            display: "inline-block", padding: "10px 22px", borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.2)", background: "transparent",
            color: "#fff", fontWeight: 700, textDecoration: "none", fontSize: 14,
          }}
        >
          Choose a Setup Category →
        </Link>
      </div>

      <p style={{ fontSize: 12, color: "#6e7681", marginTop: 24 }}>
        More setup categories (Premarket High, Opening Range, Consolidation)
        coming soon. Your attempts are scored but never shared.
      </p>
    </div>
  );
}
