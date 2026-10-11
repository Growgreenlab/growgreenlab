"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient, isSupabaseConfigured } from "../lib/supabaseClient";

const NAV_LINKS = [
  { label: "Replay Lab", href: "/replay" },
  { label: "Features", href: "/#features" },
  { label: "How It Works", href: "/#how-it-works" },
  { label: "Pricing", href: "/#pricing" },
  { label: "About", href: "/#about" },
];

export default function Header() {
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const configured = isSupabaseConfigured();

  useEffect(() => {
    if (!configured) return;
    const supabase = createClient();
    const updateUser = (user: { email?: string; user_metadata?: { display_name?: string } } | null) => {
      setEmail(user?.email ?? null);
      setDisplayName(user?.user_metadata?.display_name ?? null);
    };
    supabase.auth.getUser().then(({ data }) => updateUser(data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) =>
      updateUser(session?.user ?? null)
    );
    return () => sub.subscription.unsubscribe();
  }, [configured]);

  const signOut = async () => {
    if (!configured) return;
    await createClient().auth.signOut();
    window.location.href = "/";
  };

  return (
    <header className="ggl-nav">
      <div className="ggl-nav-inner">
        <Link href="/" className="ggl-brand" aria-label="Grow Green Lab home">
          <img src="/growgreenlab-logo.png" alt="Grow Green Lab" className="ggl-brand-logo" />
        </Link>

        <nav className="ggl-nav-links" aria-label="Primary">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
          {email && (
            <>
              <Link href="/sessions">
                My Sessions
              </Link>
              <Link href="/journal">
                Trade Journal
              </Link>
            </>
          )}
        </nav>

        <div className="ggl-nav-actions">
          {email ? (
            <>
              <span className="ggl-user-badge" title={email}>{displayName || email}</span>
              <button className="ggl-btn ggl-btn-ghost" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <Link href="/login" className="ggl-btn ggl-btn-ghost">
              Sign In
            </Link>
          )}
          <Link href="/replay" className="ggl-btn ggl-btn-primary ggl-launch-btn">
            <span className="ggl-launch-full">Launch Simulator</span>
            <span className="ggl-launch-short">Launch</span>
            <span aria-hidden="true">→</span>
          </Link>
          <button
            className="ggl-menu-btn"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav className="ggl-mobile-menu" aria-label="Mobile">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setMenuOpen(false)}>
              {l.label}
            </Link>
          ))}
          {email ? (
            <>
              <span className="ggl-user-badge" title={email}>{displayName || email}</span>
              <button className="ggl-btn ggl-btn-ghost" onClick={() => { setMenuOpen(false); signOut(); }}>
                Sign out
              </button>
            </>
          ) : (
            <Link href="/login" className="ggl-btn ggl-btn-ghost" onClick={() => setMenuOpen(false)}>
              Sign In
            </Link>
          )}
          <Link href="/replay" className="ggl-btn ggl-btn-primary ggl-launch-btn" onClick={() => setMenuOpen(false)}>
            <span className="ggl-launch-full">Launch Simulator</span>
            <span className="ggl-launch-short">Launch</span>
            <span aria-hidden="true">→</span>
          </Link>
        </nav>
      )}
    </header>
  );
}
