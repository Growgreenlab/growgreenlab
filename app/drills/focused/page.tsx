/**
 * /drills/focused — Focused Learning category picker.
 *
 * This screen names the setup categories ON PURPOSE: the user is
 * deliberately choosing what to study. Under each category, that
 * category's drills are listed by neutral number for the user to pick
 * (the drills themselves still carry no title/description/difficulty).
 * It is flow-separated from Blind Practice (/drills), which never
 * reveals categories in advance, and focused drills never touch the
 * blind cycle queue.
 */
import Link from "next/link";
import { FOCUSED_CATALOG, scenariosForCategory } from "../../../lib/drills/catalog";

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
        Pick the setup you want to study, then pick one of its drills by
        number. You&apos;ll know the category up front — use the drill to
        study its tells in the candles, volume, Level 2, and Time &amp;
        Sales. For unlabelled practice, use{" "}
        <Link href="/drills" style={{ color: "#42d879" }}>Blind Practice</Link>.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        {FOCUSED_CATALOG.map((f) => {
          const drills = scenariosForCategory(f.category);
          return (
            <div
              key={f.slug}
              style={{
                padding: "16px 20px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "#0d1117",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{f.label}</div>
              <div style={{ fontSize: 14, color: "var(--ggl-muted)", marginBottom: 12 }}>{f.blurb}</div>
              <div style={{ display: "grid", gap: 8 }}>
                {drills.map((d) => {
                  // The focused slug mirrors the neutral number: d-047 → f-047.
                  const href = `/drills/f-${d.slug.slice(2)}`;
                  return (
                    <Link
                      key={d.slug}
                      href={href}
                      style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "10px 14px", borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.08)",
                        background: "rgba(255,255,255,0.02)",
                        textDecoration: "none", color: "inherit",
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{d.label}</span>
                      <span style={{ fontSize: 12, color: "#6e7681" }}>
                        {d.candleCount} candles · Start drill →
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
