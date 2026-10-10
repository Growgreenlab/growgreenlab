import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Header from "../components/Header";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Trade Replay Lab — Grow Green Lab",
  description:
    "Replay historical market sessions candle by candle and practice HOD breakout trading with simulated orders.",
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.className}>
      <body>
        <Header />
        <main className="wrap">{children}</main>
        <footer className="wrap footer">
          <strong style={{ color: "var(--emerald-bright)" }}>Grow Green Lab</strong>
          {" · "}Trade Replay Lab — simulated trading only. Not real orders, not financial advice.
        </footer>
      </body>
    </html>
  );
}
