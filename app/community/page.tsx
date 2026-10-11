"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabaseClient";
import type { CommunityRoom } from "../../lib/community";

// Simple dot icons per category — professional, no emoji
function MarketDot({ slug }: { slug: string }) {
  const colors: Record<string, string> = {
    "penny-stocks": "#42d879",
    "stock-market": "#60a5fa",
    "options-trading": "#a78bfa",
    "futures-trading": "#f59e0b",
    "forex": "#38bdf8",
    "crypto": "#f472b6",
  };
  return (
    <span style={{
      width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
      background: colors[slug] ?? "#6b7280",
    }} />
  );
}

export default function CommunityLanding() {
  const [rooms, setRooms] = useState<CommunityRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        setSignedIn(!!user);
        const { data, error } = await supabase
          .from("community_rooms")
          .select("*")
          .neq("id", "00000000-0000-0000-0000-000000000000")
          .order("category", { ascending: true })
          .order("name", { ascending: true });
        if (error) throw error;
        setRooms(data ?? []);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((r) =>
      r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
    );
  }, [rooms, query]);

  const markets = filtered.filter((r) => r.category === "markets");
  const community = filtered.filter((r) => r.category === "community");

  const renderRow = (room: CommunityRoom) => (
    <Link
      key={room.id}
      href={`/community/${room.slug}`}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 16px", borderRadius: 10, textDecoration: "none",
        border: "1px solid transparent",
        background: "rgba(255,255,255,0.02)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(66,216,121,0.25)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
    >
      <MarketDot slug={room.slug} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 15, color: "var(--ggl-text)" }}>
          {room.name}
        </div>
        {room.description && (
          <div style={{
            color: "var(--ggl-muted)", fontSize: 13, marginTop: 2,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {room.description}
          </div>
        )}
      </div>
      <span style={{ color: "var(--ggl-muted)", fontSize: 18, flexShrink: 0 }}>›</span>
    </Link>
  );

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px 48px" }}>
      <p className="ggl-eyebrow">GROW GREEN LAB</p>
      <h1 style={{ fontSize: "clamp(24px, 4vw, 32px)", fontWeight: 800, letterSpacing: "-0.5px", margin: "0 0 8px" }}>
        Chat Area
      </h1>
      <p style={{ color: "var(--ggl-muted)", fontSize: 14, lineHeight: 1.6, margin: "0 0 20px" }}>
        Pick your market first — every market has its own independent discussion.
      </p>

      {/* Search */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search markets…"
        aria-label="Search markets"
        style={{
          width: "100%", padding: "10px 16px", borderRadius: 10, marginBottom: 24,
          border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.03)",
          color: "var(--ggl-text)", fontSize: 15, outline: "none", boxSizing: "border-box",
        }}
        onFocus={(e) => (e.target.style.borderColor = "rgba(66,216,121,0.4)")}
        onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
      />

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

      {loading ? (
        <p style={{ color: "var(--ggl-muted)" }}>Loading…</p>
      ) : loadError ? (
        <p style={{ color: "#f87171" }}>Couldn't load. Check your connection and refresh.</p>
      ) : (
        <>
          {markets.length > 0 && (
            <section style={{ marginBottom: 28 }}>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: "var(--ggl-muted)", textTransform: "uppercase", letterSpacing: "0.8px", margin: "0 0 10px" }}>
                Markets
              </h2>
              <div style={{ display: "grid", gap: 8 }}>
                {markets.map(renderRow)}
              </div>
            </section>
          )}
          {community.length > 0 && (
            <section>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: "var(--ggl-muted)", textTransform: "uppercase", letterSpacing: "0.8px", margin: "0 0 10px" }}>
                Learning & Community
              </h2>
              <div style={{ display: "grid", gap: 8 }}>
                {community.map(renderRow)}
              </div>
            </section>
          )}
          {filtered.length === 0 && (
            <p style={{ color: "var(--ggl-muted)" }}>No markets match "{query}".</p>
          )}
        </>
      )}

      <p style={{ color: "var(--ggl-muted)", fontSize: 13, marginTop: 32, lineHeight: 1.6 }}>
        Be kind and constructive. No financial advice, no spam, no pump-and-dump schemes.
      </p>
    </div>
  );
}
