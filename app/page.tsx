import Link from "next/link";

export default function Home() {
  return (
    <div className="ggl-home">
      {/* ============ HERO ============ */}
      <section className="ggl-hero">
        <div className="ggl-hero-inner">
          <div className="ggl-hero-copy">
            <p className="ggl-eyebrow">SIMULATED TRADING • REAL MARKET DATA • BUILD DISCIPLINE</p>
            <h1 className="ggl-headline">
              Master Your
              <br />
              Trading.
              <br />
              <span className="ggl-headline-muted">Before You Risk Real Money.</span>
            </h1>
            <p className="ggl-sub">
              Replay historical market sessions, refine your entries, practise risk
              management, and build consistent trading habits — all with simulated trading.
            </p>
            <div className="ggl-cta-row">
              <Link href="/replay" className="ggl-btn ggl-btn-primary ggl-btn-lg">
                Launch Simulator <span aria-hidden="true">→</span>
              </Link>
              <Link href="/#features" className="ggl-btn ggl-btn-outline ggl-btn-lg">
                Explore Features
              </Link>
            </div>
            <ul className="ggl-ticks">
              <li>✓ Try it free</li>
              <li>✓ 5 practice trades per day</li>
              <li>✓ No account required</li>
            </ul>
            <p className="ggl-disclaimer">Simulated trading only. No real orders are executed.</p>
          </div>
          <div className="ggl-hero-visual">
            <div className="ggl-sim-frame">
              <img
                src="/sim-preview.png"
                alt="Grow Green Lab trading simulator — candlestick chart with replay controls, order panel and risk calculator"
                className="ggl-sim-img"
                loading="eager"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ============ FEATURE CARDS ============ */}
      <section className="ggl-section" id="features">
        <div className="ggl-cards">
          <article className="ggl-card">
            <div className="ggl-card-icon" aria-hidden="true">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                <rect x="6" y="18" width="6" height="14" rx="1.5" fill="#F0525F" />
                <rect x="17" y="10" width="6" height="22" rx="1.5" fill="#7F8993" />
                <rect x="28" y="6" width="6" height="26" rx="1.5" fill="#26C77A" />
              </svg>
            </div>
            <h3>Replay the Market</h3>
            <p>Practise historical sessions candle by candle. Pause, step, control the speed, and reset.</p>
            <Link href="/replay" className="ggl-card-link" aria-label="Replay the Market — open simulator">
              <span aria-hidden="true">→</span>
            </Link>
          </article>
          <article className="ggl-card">
            <div className="ggl-card-icon" aria-hidden="true">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                <circle cx="20" cy="20" r="14" stroke="#B5BDC5" strokeWidth="2.5" />
                <circle cx="20" cy="20" r="8" stroke="#B5BDC5" strokeWidth="2.5" />
                <circle cx="20" cy="20" r="3" fill="#42D879" />
              </svg>
            </div>
            <h3>Master Risk Management</h3>
            <p>Practise position sizing, stop-losses, and take-profits before committing to a trade.</p>
            <Link href="/replay" className="ggl-card-link" aria-label="Master Risk Management — open simulator">
              <span aria-hidden="true">→</span>
            </Link>
          </article>
          <article className="ggl-card">
            <div className="ggl-card-icon" aria-hidden="true">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                <rect x="6" y="22" width="5" height="10" rx="1" fill="#7F8993" />
                <rect x="14" y="16" width="5" height="16" rx="1" fill="#7F8993" />
                <rect x="22" y="10" width="5" height="22" rx="1" fill="#B5BDC5" />
                <rect x="30" y="5" width="5" height="27" rx="1" fill="#42D879" />
              </svg>
            </div>
            <h3>Analyze Your Strategy</h3>
            <p>Review your trades, track your performance, and discover recurring patterns.</p>
            <Link href="/sessions" className="ggl-card-link" aria-label="Analyze Your Strategy — view sessions">
              <span aria-hidden="true">→</span>
            </Link>
          </article>
        </div>
      </section>

      {/* ============ GUARD + GUEST PANELS ============ */}
      <section className="ggl-section" id="how-it-works">
        <div className="ggl-panels">
          <article className="ggl-panel">
            <div className="ggl-panel-icon" aria-hidden="true">
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                <path d="M18 3L31 8V17C31 25 24 30.5 18 33C12 30.5 5 25 5 17V8L18 3Z" stroke="#42D879" strokeWidth="2.5" fill="none" />
                <rect x="15" y="16" width="6" height="7" rx="1" fill="#B5BDC5" />
                <circle cx="18" cy="13" r="3.5" stroke="#B5BDC5" strokeWidth="2" fill="none" />
              </svg>
            </div>
            <h3>Grow Green Guard</h3>
            <p className="ggl-panel-sub">Build Discipline. Protect Your Process.</p>
            <p>Set your trading rules, use the Guard system to stay accountable, and avoid emotional overtrading.</p>
            <Link href="/replay" className="ggl-btn ggl-btn-outline">
              Learn About Guard <span aria-hidden="true">→</span>
            </Link>
          </article>
          <article className="ggl-panel" id="pricing">
            <div className="ggl-panel-icon" aria-hidden="true">
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                <circle cx="18" cy="12" r="6" stroke="#B5BDC5" strokeWidth="2.5" fill="none" />
                <path d="M6 30C6 24 11 21 18 21C25 21 30 24 30 30" stroke="#B5BDC5" strokeWidth="2.5" fill="none" />
              </svg>
            </div>
            <h3>
              Start Practising for <span className="ggl-green">Free</span>
            </h3>
            <ul className="ggl-check-list">
              <li>5 free practice trades per day</li>
              <li>No account required</li>
              <li>Full access to the simulator</li>
            </ul>
            <Link href="/replay" className="ggl-btn ggl-btn-primary">
              Try the Simulator <span aria-hidden="true">→</span>
            </Link>
          </article>
        </div>
      </section>

      {/* ============ ABOUT STRIP ============ */}
      <section className="ggl-section" id="about">
        <div className="ggl-about">
          <h2>Built by traders, for traders.</h2>
          <p>
            Grow Green Lab started as a personal practice tool for mastering penny-stock
            breakouts without risking real capital. Every feature — the replay engine,
            the risk calculator, the Guard system — exists because it solved a real
            problem at the screen.
          </p>
        </div>
      </section>

      {/* ============ FINAL CTA ============ */}
      <section className="ggl-final">
        <h2>
          Your Next Level Starts With <span className="ggl-green">Better Practice.</span>
        </h2>
        <p>Build your process, manage your risk, and learn from every simulated trade.</p>
        <Link href="/replay" className="ggl-btn ggl-btn-primary ggl-btn-lg">
          Start Practising <span aria-hidden="true">→</span>
        </Link>
      </section>

      {/* ============ FOUNDER ============ */}
      <section className="ggl-founder" aria-labelledby="founder-heading">
        <div className="ggl-founder-inner">
          <p className="ggl-eyebrow">THE STORY BEHIND THE PLATFORM</p>
          <h2 id="founder-heading">
            Built for Traders. <span className="ggl-green">Driven by Purpose.</span>
          </h2>
          <div className="ggl-founder-rule" aria-hidden="true" />
          <div className="ggl-founder-story">
            <p>
              I&rsquo;m <strong>Karandeep Singh</strong>, from Ladhra, a small village near
              Jalandhar, Punjab, India.
            </p>
            <p>
              Like many traders, I understand that trading is a continuous journey of
              learning, discipline, and improvement. I started building Grow Green Trade Lab
              with a simple vision: to make that journey easier through practical tools that
              help traders review their trades, analyze their performance, learn from
              mistakes, and develop better habits.
            </p>
            <p>
              I&rsquo;m building this platform not because I have everything figured out, but
              because I believe there&rsquo;s always room to learn, improve, and build better
              tools along the way.
            </p>
            <p>
              My goal is to create something meaningful for the trading community &mdash; a
              platform built around the challenges traders face and the tools that can help
              them grow.
            </p>
          </div>
          <p className="ggl-founder-closing">&ldquo;Big visions can come from small beginnings.&rdquo;</p>
          <div className="ggl-founder-sign">
            <div className="ggl-founder-name">Karandeep Singh</div>
            <div className="ggl-founder-role">Founder, Grow Green Trade Lab</div>
          </div>
        </div>
      </section>
    </div>
  );
}
