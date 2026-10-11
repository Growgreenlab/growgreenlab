"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabaseClient";
import type { CommunityRoom } from "../../lib/community";

export default function CommunityLanding() {
  const [rooms, setRooms] = useState<CommunityRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        setSignedIn(!!user);
        const { data, error } = await supabase
          .from("community_rooms")
          .select("*")
          .neq("slug", "global")
          .order("created_at", { ascending: true });
        if (error) throw error;
        setRooms(data ?? []);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="ggl-community" style={{ maxWidth: 800, margin: "0 auto", padding: "48px 24px" }}>
      <p className="ggl-eyebrow">GROW GREEN LAB COMMUNITY</p>
      <h1 style={{ fontSize: "clamp(28px, 4vw, 44px)", fontWeight: 800, letterSpacing: "-0.8px", margin: "0 0 12px" }}>
        Trade Together. <span className="ggl-green">Grow Together.</span>
      </h1>
      <p style={{ color: "var(--ggl-muted)", fontSize: 16, lineHeight: 1.6, margin: "0 0 32px", maxWidth: 600 }}>
        Join live discussions with traders practicing on Grow Green Lab.
        Share watchlists, discuss setups, and learn from the community.
      </p>

      {!signedIn && (
        <div style={{
          background: "rgba(66,216,121,0.06)",
          border: "1px solid rgba(66,216,121,0.2)",
          borderRadius: 12, padding: "16px 20px", marginBottom: 32,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexWrap: "wrap", gap: 12,
        }}>
          <div style={{ fontSize: 14 }}>
            <strong>Sign in to participate</strong>
            <div style={{ color: "var(--ggl-muted)", fontSize: 13, marginTop: 4 }}>
              Browse rooms freely — sign in to send messages and react.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link href="/login?next=/community" className="ggl-btn ggl-btn-outline">Sign In</Link>
            <Link href="/login?mode=signup&next=/community" className="ggl-btn ggl-btn-primary">Create Account</Link>
          </div>
        </div>
      )}

      <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px" }}>Rooms</h2>
      {loading ? (
        <p style={{ color: "var(--ggl-muted)" }}>Loading rooms…</p>
      ) : loadError ? (
        <p style={{ color: "#f87171" }}>
          Couldn't load rooms. Please check your connection and refresh.
        </p>
      ) : rooms.length === 0 ? (
        <p style={{ color: "var(--ggl-muted)" }}>No rooms yet. Check back soon.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {rooms.map((room) => (
            <Link
              key={room.id}
              href={`/community/${room.slug}`}
              style={{
                display: "block", padding: "18px 20px", borderRadius: 12,
                border: "1px solid var(--ggl-border)", textDecoration: "none",
                background: "rgba(255,255,255,0.02)", transition: "border-color 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 16, color: "var(--ggl-text)" }}>
                  {room.ticker ? `$${room.ticker}` : `#`} {room.name}
                </span>
                {!room.is_public && (
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "rgba(251,191,36,0.15)", color: "#fbbf24" }}>
                    Members only
                  </span>
                )}
              </div>
              {room.description && (
                <div style={{ color: "var(--ggl-muted)", fontSize: 14 }}>{room.description}</div>
              )}
            </Link>
          ))}
        </div>
      )}

      <p style={{ color: "var(--ggl-muted)", fontSize: 13, marginTop: 32, lineHeight: 1.6 }}>
        Be kind and constructive. No financial advice, no spam, no pump-and-dump schemes.
        Moderators may remove messages that violate community guidelines.
      </p>
    </div>
  );
}
