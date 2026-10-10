import Link from "next/link";

export default function Home() {
  return (
    <div>
      <section className="hero">
        <span className="kicker">Grow Green Lab · Trading tools</span>
        <h1>
          Trade Replay <span className="grad">Lab</span>
        </h1>
        <p>
          Replay historical market sessions candle by candle and practice the
          HOD breakout strategy on US penny stocks — with simulated orders,
          stop-losses, take-profits, and a virtual $100,000 account. Future
          candles stay hidden, so every decision is made like it&apos;s live.
        </p>
        <div className="row keep-row" style={{ maxWidth: 440, margin: "0 auto" }}>
          <Link href="/replay" className="btn primary big" style={{ textAlign: "center" }}>
            Open Replay Lab
          </Link>
          <Link href="/sessions" className="btn big" style={{ textAlign: "center" }}>
            My Sessions
          </Link>
        </div>
        <p className="hint" style={{ marginTop: 18 }}>
          <span className="badge sim">Simulated — not real orders</span>
        </p>
      </section>

      <section className="feats">
        <div className="feat"><span className="ic">📼</span><b>Candle-by-candle replay</b><small>Play, pause, step, speed control and reset. The future never leaks.</small></div>
        <div className="feat"><span className="ic">📊</span><b>Real market data</b><small>Bring your own free Twelve Data key for real 1-minute candles, upload CSVs, or practice on labelled sample tapes.</small></div>
        <div className="feat"><span className="ic">🎯</span><b>HOD breakout focus</b><small>Live high-of-day tracking with an on-chart HOD line — built for the breakout trader.</small></div>
        <div className="feat"><span className="ic">💼</span><b>Simulated trading</b><small>Market buy/sell, share sizing, stop-loss and take-profit brackets that trigger as candles print.</small></div>
        <div className="feat"><span className="ic">💾</span><b>Saved sessions</b><small>Every replay and its trades are stored per account — review, reload, or delete them anytime.</small></div>
        <div className="feat"><span className="ic">🌱</span><b>By Grow Green Lab</b><small>Professional-grade practice tools for the self-made trader. Free to use, no account needed to start.</small></div>
      </section>
    </div>
  );
}
