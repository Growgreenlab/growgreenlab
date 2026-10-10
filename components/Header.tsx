"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient, isSupabaseConfigured } from "../lib/supabaseClient";

export default function Header() {
  const [email, setEmail] = useState<string | null>(null);
  const configured = isSupabaseConfigured();

  useEffect(() => {
    if (!configured) return;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) =>
      setEmail(session?.user?.email ?? null)
    );
    return () => sub.subscription.unsubscribe();
  }, [configured]);

  const signOut = async () => {
    if (!configured) return;
    await createClient().auth.signOut();
    window.location.href = "/";
  };

  return (
    <header className="topbar">
      <div className="wrap" style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/" className="brand">
          <img src="/growgreenlab-logo.png" alt="Grow Green Lab" className="brand-logo-wide" />
          <span className="brand-text">
            <span className="brand-product">Trade Replay Lab</span>
          </span>
        </Link>
        <nav className="navlinks">
          <span className="badge sim">Simulated — not real orders</span>
          {email ? (
            <>
              <Link href="/replay">Replay</Link>
              <Link href="/sessions">My Sessions</Link>
              <span className="badge user">{email}</span>
              <button className="btn" onClick={signOut} style={{ padding: "6px 10px" }}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link href="/replay">Replay</Link>
              <Link href="/login" className="btn" style={{ padding: "6px 12px" }}>
                Sign in
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
