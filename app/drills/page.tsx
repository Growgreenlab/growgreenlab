/**
 * /drills — Breakout Recognition drill picker.
 * Lists available scenarios. New route, isolated from /replay.
 */
import Link from "next/link";
import { HOD_SCENARIOS } from "../../lib/drills/scenarios";
import type { DrillDifficulty } from "../../lib/drills/types";

const DIFFICULTY_LABEL: Record<DrillDifficulty, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

const DIFFICULTY_COLOR: Record<DrillDifficulty, string> = {
  beginner: "#2ebd85",
  intermediate: "#f0b429",
  advanced: "#f6465d",
};

export default function DrillsPage() {
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>
        Breakout Recognition
      </h1>
      <p style={{ color: "var(--ggl-muted)", fontSize: 15, marginBottom: 24, maxWidth: 640 }}>
        Train your eye to read breakouts. Watch the market develop across
        chart, volume, Level 2, and Time &amp; Sales — then classify what
        you see before the outcome is revealed. Order flow is simulated
        for training.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        {HOD_SCENARIOS.map((s) => (
          <Link
            key={s.id}
            href={`/drills/${s.id}`}
            style={{
              display: "block",
              padding: "16px 20px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "#0d1117",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{s.title}</span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: DIFFICULTY_COLOR[s.difficulty],
                  border: `1px solid ${DIFFICULTY_COLOR[s.difficulty]}55`,
                  padding: "2px 8px",
                  borderRadius: 20,
                }}
              >
                {DIFFICULTY_LABEL[s.difficulty]}
              </span>
            </div>
            <div style={{ fontSize: 14, color: "var(--ggl-muted)" }}>{s.description}</div>
            <div style={{ fontSize: 12, color: "#6e7681", marginTop: 8 }}>
              HOD Breakout · {s.candles.length} candles · Start drill →
            </div>
          </Link>
        ))}
      </div>

      <p style={{ fontSize: 12, color: "#6e7681", marginTop: 24 }}>
        More setup categories (Premarket High, Opening Range, Consolidation)
        coming soon. Your attempts are scored but never shared.
      </p>
    </div>
  );
}
