"use client";

import { usePathname } from "next/navigation";
import Header from "./Header";

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
      <footer className="wrap footer">
        <strong style={{ color: "var(--emerald-bright)" }}>Grow Green Lab</strong>
        {" · "}Trade Replay Lab — simulated trading only. Not real orders, not financial advice.
      </footer>
    </>
  );
}
