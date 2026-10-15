/**
 * /drills/focused — Focused Learning category picker.
 *
 * This screen names the setup categories ON PURPOSE: the user is
 * deliberately choosing what to study. It is flow-separated from Blind
 * Practice (/drills), which never reveals categories in advance.
 */
import Link from "next/link";
import { FOCUSED_CATALOG } from "../../../lib/drills/catalog";

export default function FocusedPage() {
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px" }}>
      <Link href="/drills" style={{ fontSize: 13, color: "var(--ggl-muted)" }}>
        ← Back to drills
      </Link>
      <h1 style={{ fontSize: 28, fontWeight: 800, margin: "8px 0" }}>
        Focused Learning
      </h1>
      <p style={{ color: "var(--ggl-muted)", fontSize: 15, marginBottom: 24, maxWidth: 640 }}>
        Pick the setup you want to study. You&apos;ll know the category up
        front — use the drill to study its tells in the candles, volume,
        Level 2, and Time &amp; Sales. For unlabelled practice, use{" "}
        <Link href="/drills" style={{ color: "#42d879" }}>Blind Practice</Link>.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        {FOCUSED_CATALOG.map((f) => (
          <Link
            key={f.slug}
            href={`/drills/${f.slug}`}
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
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{f.label}</div>
            <div style={{ fontSize: 14, color: "var(--ggl-muted)" }}>{f.blurb}</div>
            <div style={{ fontSize: 12, color: "#6e7681", marginTop: 8 }}>
              Focused drill · Start →
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
