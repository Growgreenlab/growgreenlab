"use client";

/**
 * Level 2 order-book panel for Breakout Recognition drills.
 *
 * Displays a SIMULATED order book derived from the scenario's deterministic
 * event timeline. This is synthetic training data, not historical exchange
 * data — the "SIMULATED" badge is mandatory and must not be removed.
 */
import type { OrderBookSnapshot } from "../lib/drills/orderflow";

interface Props {
  book: OrderBookSnapshot | null;
  /** Price level of interest (HOD) — highlighted when near. */
  level?: number;
}

function barWidth(size: number, max: number): string {
  return `${Math.min(100, (size / Math.max(1, max)) * 100)}%`;
}

export default function Level2Panel({ book, level }: Props) {
  if (!book) {
    return (
      <div className="drill-panel">
        <div className="drill-panel-header">
          <span>Level 2</span>
          <span className="sim-badge">SIMULATED</span>
        </div>
        <div className="drill-panel-empty">Waiting for market data…</div>
      </div>
    );
  }

  const maxSize = Math.max(
    ...book.bids.map((b) => b.size),
    ...book.asks.map((a) => a.size),
    1
  );
  const spread = book.asks[0].price - book.bids[0].price;

  const nearLevel = (price: number) =>
    level != null && Math.abs(price - level) < 0.015;

  return (
    <div className="drill-panel">
      <div className="drill-panel-header">
        <span>Level 2</span>
        <span className="sim-badge">SIMULATED</span>
      </div>
      <div className="l2-spread">
        Spread <strong>{spread.toFixed(2)}</strong>
      </div>
      <div className="l2-rows">
        {/* Asks: best ask at bottom (closest to spread) */}
        {[...book.asks].reverse().map((a, i) => (
          <div
            key={`a${i}`}
            className={`l2-row ask ${nearLevel(a.price) ? "at-level" : ""}`}
          >
            <span className="l2-size">{a.size.toLocaleString()}</span>
            <span className="l2-price">{a.price.toFixed(2)}</span>
            <div className="l2-bar ask-bar" style={{ width: barWidth(a.size, maxSize) }} />
          </div>
        ))}
        <div className="l2-divider" />
        {/* Bids: best bid at top */}
        {book.bids.map((b, i) => (
          <div
            key={`b${i}`}
            className={`l2-row bid ${nearLevel(b.price) ? "at-level" : ""}`}
          >
            <span className="l2-price">{b.price.toFixed(2)}</span>
            <span className="l2-size">{b.size.toLocaleString()}</span>
            <div className="l2-bar bid-bar" style={{ width: barWidth(b.size, maxSize) }} />
          </div>
        ))}
      </div>
    </div>
  );
}
