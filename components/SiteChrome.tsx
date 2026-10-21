"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Header from "./Header";
import BrandLogo from "./BrandLogo";

const PRODUCT_LINKS: { label: string; href: string; external?: boolean }[] = [
  { label: "Simulator", href: "/replay" },
  { label: "Trade Journal", href: "/journal" },
  { label: "Edge Analyzer", href: "/journal?tab=analytics" },
  { label: "Community", href: "/community" },
];

const PLATFORM_LINKS = [
  { label: "Features", href: "/#features" },
  { label: "How It Works", href: "/#how-it-works" },
  { label: "Pricing", href: "/#pricing" },
];

/**
 * Conditionally renders site chrome (header/footer).
 * Community chat pages (/community/*) use a dedicated full-screen
 * messaging layout — the site header and footer are hidden there
 * so they don't interfere with the chat experience or keyboard.
 */
export default function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isChat = pathname?.startsWith("/community/");

  if (isChat) {
    // Full-screen chat: no site header, no footer
    return <>{children}</>;
  }

  return (
    <>
      <Header />
      <main className="wrap">{children}</main>
      <footer className="wrap footer ggl-footer" data-theme="light">
        <div className="ggl-footer-grid">
          <div className="ggl-footer-brand">
            <BrandLogo />
            <p>
              Trade Replay Lab — a trading practice platform. Replay real market
              sessions, journal every trade, and build consistency before real
              capital is at risk.
            </p>
          </div>
          <nav className="ggl-footer-col" aria-label="Product">
            <h4>Product</h4>
            {PRODUCT_LINKS.map((l) =>
              l.external ? (
                <a key={l.href} href={l.href}>
                  {l.label}
                </a>
              ) : (
                <Link key={l.href} href={l.href}>
                  {l.label}
                </Link>
              )
            )}
          </nav>
          <nav className="ggl-footer-col" aria-label="Platform">
            <h4>Platform</h4>
            {PLATFORM_LINKS.map((l) => (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ))}
          </nav>
          <nav className="ggl-footer-col" aria-label="Get started">
            <h4>Get Started</h4>
            <Link href="/replay">Start Practicing</Link>
            <Link href="/login">Sign In</Link>
            <Link href="/sessions">My Sessions</Link>
          </nav>
        </div>
        <div className="ggl-footer-base">
          <span>© 2026 Grow Green Lab</span>
          <span>
            Simulated trading only. Not real orders, not financial advice.
          </span>
        </div>
      </footer>
    </>
  );
}
