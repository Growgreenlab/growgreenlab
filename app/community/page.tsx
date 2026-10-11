"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabaseClient";
import { MARKET_CARDS, COMMUNITY_CARDS } from "../../lib/community-markets";

function Card({
  slug, name, description, color,
}: { slug: string; name: string; description: string; color: string }) {
  return (
    <Link
      href={`/community/${slug}`}
      style={{
        display: "flex", alignItems: "center", gap: 14,
        padding: "16px 18px", borderRadius: 12, textDecoration: "none",
        border: "1px solid rgba(255,255,255,0.07)",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <span style={{
        width: 12, height: 12, borderRadius: "50%", flexShrink: 0,
        background: color,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: "var(--ggl-text)" }}>
          {name}
        </div>
        <div style={{
          color: "var(--ggl-muted)", fontSize: 13, marginTop: 3,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {description}
        </div>
      </div>
      <span style={{ color: "var(--ggl-muted)", fontSize: 20, flexShrink: 0 }}>›</span>
    </Link>
  );
}

export default function CommunityLanding() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        setSignedIn(!!user);
      } catch { /* signed-out view is fine */ }
    })();
  }, []);

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px 48px" }}>
      <p className="ggl-eyebrow">GROW GREEN LAB</p>
      <h1 style={{ fontSize: "clamp(24px, 4vw, 32px)", fontWeight: 800, letterSpacing: "-0.5px", margin: "0 0 8px" }}>
        Chat Area
      </h1>
      <p style={{ color: "var(--ggl-muted)", fontSize: 14, lineHeight: 1.6, margin: "0 0 24px" }}>
        Pick your market — each one has its own independent discussion.
      </p>

      {!signedIn && (
        <div style={{
          background: "rgba(66,216,121,0.06)",
          border: "1px solid rgba(66,216,121,0.2)",
          borderRadius: 12, padding: "14px 16px", marginBottom: 24,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexWrap: "wrap", gap: 12,
        }}>
          <div style={{ fontSize: 14 }}>
            <strong>Sign in to participate</strong>
            <div style={{ color: "var(--ggl-muted)", fontSize: 13, marginTop: 4 }}>
              Browse freely — sign in to send messages and react.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link href="/login?next=/community" className="ggl-btn ggl-btn-outline">Sign In</Link>
            <Link href="/login?mode=signup&next=/community" className="ggl-btn ggl-btn-primary">Create Account</Link>
          </div>
        </div>
      )}

      {/* Six market cards */}
      <section style={{ marginBottom: 28 }}>
        <div style={{ display: "grid", gap: 10 }}>
          {MARKET_CARDS.map((m) => (
            <Card key={m.slug} {...m} />
          ))}
        </div>
      </section>

      {/* Community destinations */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, color: "var(--ggl-muted)", textTransform: "uppercase", letterSpacing: "0.8px", margin: "0 0 10px" }}>
          Community
        </h2>
        <div style={{ display: "grid", gap: 10 }}>
          {COMMUNITY_CARDS.map((m) => (
            <Card key={m.slug} {...m} />
          ))}
        </div>
      </section>

      {/* Announcements — small dedicated section */}
      <section>
        <Link
          href="/community/announcements"
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 16px", borderRadius: 10, textDecoration: "none",
            border: "1px solid rgba(251,191,36,0.2)",
            background: "rgba(251,191,36,0.04)",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "#fbbf24" }}>
            📢 Announcements
          </span>
          <span style={{ color: "var(--ggl-muted)", fontSize: 12, flex: 1 }}>
            Official updates from Grow Green Lab
          </span>
          <span style={{ color: "var(--ggl-muted)", fontSize: 18 }}>›</span>
        </Link>
      </section>

      <p style={{ color: "var(--ggl-muted)", fontSize: 13, marginTop: 32, lineHeight: 1.6 }}>
        Be kind and constructive. No financial advice, no spam, no pump-and-dump schemes.
      </p>
    </div>
  );
}
