import type { Metadata } from "next";
import "./globals.css";
import Header from "../components/Header";

export const metadata: Metadata = {
  title: "Trade Replay Lab",
  description:
    "Replay historical market sessions candle by candle and practice HOD breakout trading with simulated orders.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Header />
        <main className="wrap">{children}</main>
        <footer className="wrap footer">
          Trade Replay Lab — simulated trading only. Not real orders, not financial advice.
        </footer>
      </body>
    </html>
  );
}
