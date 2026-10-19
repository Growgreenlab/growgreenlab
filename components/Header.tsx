"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient, isSupabaseConfigured } from "../lib/supabaseClient";

const NAV_LINKS: { label: string; href: string; external?: boolean }[] = [
  { label: "Simulator", href: "/replay" },
  { label: "Trade Journal", href: "/journal" },
  { label: "Breakout Drills", href: "/drills" },
  { label: "Edge Analyzer", href: "/journal?tab=analytics" },
  { label: "Community", href: "/community" },
  { label: "Pricing", href: "/pricing" },
];

function NavLink({
  link,
  onClick,
}: {
  link: (typeof NAV_LINKS)[number];
  onClick?: () => void;
}) {
  if (link.external) {
    return (
      <a href={link.href} onClick={onClick}>
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} onClick={onClick}>
      {link.label}
    </Link>
  );
}

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
            <NavLink key={l.href} link={l} />
          ))}
          {email && (
            <Link href="/sessions">
              My Sessions
            </Link>
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
            <span className="ggl-launch-full">Start Practicing</span>
            <span className="ggl-launch-short">Start</span>
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
            <NavLink key={l.href} link={l} onClick={() => setMenuOpen(false)} />
          ))}
          {email && (
            <Link href="/sessions" onClick={() => setMenuOpen(false)}>
              My Sessions
            </Link>
          )}
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
            <span className="ggl-launch-full">Start Practicing</span>
            <span className="ggl-launch-short">Start</span>
            <span aria-hidden="true">→</span>
          </Link>
        </nav>
      )}
    </header>
  );
}
