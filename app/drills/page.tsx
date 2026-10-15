"use client";

/**
 * /drills — Breakout Recognition drill picker.
 *
 * Two clearly separated modes (see docs/drill-blind-audit-2026-10-14.md):
 *
 *  - Blind Practice (default, this screen): drills carry neutral
 *    labels only ("HOD Drill #047"). No category, description, or
 *    difficulty is shown anywhere — the whole point is to read the
 *    market, not the menu. A random draw is seeded; the seed is shown
 *    only at the post-drill review so a run can be reproduced.
 *  - Focused Learning (/drills/focused): deliberately pick a setup
 *    category for targeted practice.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BLIND_CATALOG, blindSlugForSeed, randomRunSeed } from "../../lib/drills/catalog";

const BLIND_SEED_KEY = "ggl-blind-seed";

export default function DrillsPage() {
  const router = useRouter();

  const startRandomBlind = () => {
    const seed = randomRunSeed();
    try {
      sessionStorage.setItem(BLIND_SEED_KEY, String(seed));
    } catch {
      /* sessionStorage unavailable — the run still works, seed just isn't shown at review */
    }
    router.push(`/drills/${blindSlugForSeed(seed)}`);
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>
        Breakout Recognition
      </h1>
      <p style={{ color: "var(--ggl-muted)", fontSize: 15, marginBottom: 24, maxWidth: 640 }}>
        Train your eye to read breakouts. Watch the market develop across
        chart, volume, Level 2, and Time &amp; Sales — then classify what
        you see and commit to a decision before the outcome is revealed.
        Order flow is simulated for training.
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
        <p style={{ fontSize: 14, color: "var(--ggl-muted)", marginBottom: 16, maxWidth: 620 }}>
          No labels, no hints, no difficulty ratings. You get a neutral
          drill number and the market — your read is the exercise. The
          setup type is revealed only after you lock in your decision.
        </p>
        <button
          onClick={startRandomBlind}
          style={{
            padding: "12px 28px", borderRadius: 10, border: "none",
            background: "#42d879", color: "#06110b", fontSize: 15,
            fontWeight: 800, cursor: "pointer", marginBottom: 20,
          }}
        >
          Start a Random Blind Drill
        </button>

        <div style={{ display: "grid", gap: 10 }}>
          {BLIND_CATALOG.map((d) => (
            <Link
              key={d.slug}
              href={`/drills/${d.slug}`}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "14px 18px", borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(255,255,255,0.02)",
                textDecoration: "none", color: "inherit",
              }}
            >
              <span style={{ fontSize: 16, fontWeight: 700 }}>{d.label}</span>
              <span style={{ fontSize: 12, color: "#6e7681" }}>
                HOD Breakout · {d.candleCount} candles · Start drill →
              </span>
            </Link>
          ))}
        </div>
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
          ambiguous — and drill it deliberately.
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
