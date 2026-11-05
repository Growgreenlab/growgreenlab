import Link from "next/link";

/**
 * Grow Green Lab homepage — 2.0 conversion redesign (redesign-preview),
 * iteration 2: product-first, built for active stock traders.
 *
 * The simulator leads: a tightened hero puts the real product visual
 * immediately under the headline and CTAs. Messaging speaks to US
 * penny stock traders and the HOD breakout workflow the platform was
 * built around. Sections: Hero → Problem → Differentiators → three
 * screenshot feature sections (Replay / Execution / Journal) →
 * How It Works (5 steps) → Why + Psychology Guard → Founder
 * (preserved verbatim) → Member Stories → Pricing → Final CTA.
 *
 * Design identity: Redesign Direction v2 — light platform theme,
 * navy ink, Lavender accent, real product screenshots only.
 * Pricing facts are copied from app/pricing/page.tsx — the
 * entitlement source of truth. No testimonials or statistics are
 * published: TESTIMONIALS is intentionally empty and the section
 * renders an honest placeholder until real member feedback exists.
 */

const SIM_ALT =
  "Grow Green Lab trading simulator — a historical session replaying candle by candle, with the chart, order panel and session controls";
const CHART_ALT =
  "Grow Green Lab trading simulator chart — candlesticks and volume replaying a historical session, with stop-loss and take-profit lines drawn on the chart";
const ORDER_ALT =
  "Grow Green Lab order panel — simulated market order entry with quantity, stop-loss and take-profit brackets, and the fills ledger";
const JOURNAL_ALT =
  "Grow Green Lab Trade Journal — trade history with performance analytics, breakdowns and the AI Edge Analysis Export panel";

const HERO_BENEFITS = [
  "Historical Market Replay",
  "HOD Breakout Practice",
  "Realistic Paper Trading",
];

const DIFFERENTIATORS = [
  "Historical Market Replay",
  "HOD Breakout Practice",
  "Realistic Paper Trading",
  "Market Order and Limit Order Execution",
  "Stop Loss and Take Profit",
  "Level 2 and Time & Sales",
  "Trading Performance Analytics",
  "Trading Journal",
];

const REPLAY_FEATURES: { title: string; detail: string }[] = [
  { title: "Historical Market Replay", detail: "Load a real past session — any ticker, any trading day — and trade it as if it were live." },
  { title: "HOD Breakout Practice", detail: "Replay high-of-day breakout setups candle by candle, including premarket momentum names, and grade the setup — Clean, Weak, Failed or Anticipation." },
  { title: "Candle-by-candle playback", detail: "The session reveals one candle at a time. Pause, step, change speed — no peeking at the finished chart." },
  { title: "Daily Replay", detail: "Lock a starting candle and replay a full day, sealed — future candles are never in your browser before they form." },
];

const EXECUTION_FEATURES: { title: string; detail: string }[] = [
  { title: "Market and limit order execution", detail: "Simulated orders fill at the live tick price as each candle builds — limit orders included, with price improvement." },
  { title: "Stop loss and take profit", detail: "Brackets go on with the order and can be dragged directly on the chart. They trigger tick by tick, exactly as placed." },
  { title: "Level 2 and Time & Sales", detail: "Depth and tape panels where supported, so you can practise reading the book and the prints — not just the chart." },
  { title: "Risk decided before the trade", detail: "The risk calculator sizes your position from your stop before you enter — not during the move." },
];

const JOURNAL_FEATURES: { title: string; detail: string; pro?: boolean }[] = [
  { title: "Trade history", detail: "Every simulated and replayed trade, saved with its screenshots and context." },
  { title: "Performance tracking", detail: "Net P&L, win rate, average R, profit factor and drawdown — computed from your own trades." },
  { title: "Execution analysis", detail: "Decision Timelines show what you did, candle by candle, and when." },
  { title: "Mistakes and patterns", detail: "Breakdowns by setup, mistake, emotion and plan adherence surface what repeats." },
  { title: "Strategy performance", detail: "Results grouped by the strategy you actually traded, not just the ticker.", pro: true },
  { title: "AI Edge Analysis Export", detail: "One organised package of trades, analytics and screenshots for deeper AI-assisted review.", pro: true },
];

const STEPS: { n: string; title: string; detail: string }[] = [
  { n: "1", title: "Choose a historical session", detail: "Pick a ticker and a past trading day — from the built-in library, Daily Replay, or your own market data." },
  { n: "2", title: "Replay the market", detail: "Play the session back candle by candle, at your speed, with the tape and Level 2 where supported." },
  { n: "3", title: "Execute trades", detail: "Enter with market or limit orders, brackets on, sized from your stop." },
  { n: "4", title: "Analyze performance", detail: "Every trade lands in your journal with its decision timeline, metrics and screenshots." },
  { n: "5", title: "Improve execution", detail: "Review what actually happened, fix the recurring mistake, and replay it again." },
];

const WHY_POINTS: { title: string; detail: string }[] = [
  { title: "Practice without risking real capital", detail: "Build skill on historical sessions with simulated money — mistakes cost nothing but teach the same lessons." },
  { title: "Learn through historical market conditions", detail: "Real past sessions, including the messy ones — not cherry-picked examples." },
  { title: "Develop repeatable strategies", detail: "Define a strategy, replay it, and see whether it actually holds up across sessions." },
  { title: "Improve execution through review", detail: "Entries, exits and risk decisions are recorded, so review is about evidence, not memory." },
  { title: "Understand your trading behavior", detail: "Psychology tracking and the Psychology Guard make tilt, FOMO and revenge trading visible — and interruptible." },
];

const GUARD_RULES: { rule: string; detail: string }[] = [
  { rule: "Loss ≥ 5%", detail: "Warning — you are approaching a lockout." },
  { rule: "Loss ≥ 10%", detail: "New entries locked for 30 minutes." },
  { rule: "Loss ≥ 20%", detail: "New entries locked for 60 minutes." },
  { rule: "Loss ≥ 30%", detail: "New entries locked for 3 hours." },
  { rule: "Exits always allowed", detail: "A lockout blocks new entries — never your exit." },
];

const FREE_FEATURES = [
  "Trading Simulator / Replay Lab with sample data",
  "Daily Replay — full sealed replay workflow",
  "3 trades per day · 7 journal entries per month",
  "Trade Journal with full history — always readable",
  "Basic analytics, Psychology Guard, Breakout Drills, Community",
];

const PRO_FEATURES = [
  "Unlimited trades and journal entries",
  "AI Edge Analysis Export",
  "Advanced analytics — Strategy Performance and breakdowns",
  "Everything in Free, with no daily or monthly caps",
];

/** Real member testimonials only. Empty until genuine feedback exists —
 *  add entries here and the section fills in automatically. */
const TESTIMONIALS: { quote: string; name: string; detail: string }[] = [];

function CheckIcon() {
  return (
    <svg
      className="ggl2-check"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="ggl-home ggl2" data-theme="light">
      {/* ============ HERO — product first ============ */}
      <section className="ggl2-hero">
        <div className="ggl2-hero-inner">
          <p className="ggl2-eyebrow">TRADING SIMULATOR FOR ACTIVE STOCK TRADERS</p>
          <h1 className="ggl2-headline">
            Master Your Trading.
            <br />
            Before You Risk Real Money.
          </h1>
          <p className="ggl2-sub">
            Replay real historical sessions — including US penny stock momentum
            and HOD breakouts — execute with simulated orders, brackets and the
            tape, then analyze every trade in your journal.
          </p>
          <div className="ggl2-cta-row">
            <Link href="/replay" className="ggl2-btn ggl2-btn-primary ggl2-btn-lg">
              Start a Free Practice Session
            </Link>
            <a href="#replay" className="ggl2-btn ggl2-btn-outline ggl2-btn-lg">
              Explore the Simulator
            </a>
          </div>
          <p className="ggl2-trust">
            Free to practise as a guest — 5 practice trades a day, no account
            required. Simulated trading only; no real orders are executed.
          </p>
          <figure className="ggl2-hero-visual">
            <img src="/sim-preview.png" alt={SIM_ALT} loading="eager" />
          </figure>
          <ul className="ggl2-benefits ggl2-benefits-below">
            {HERO_BENEFITS.map((b) => (
              <li key={b}>
                <CheckIcon />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ============ THE PROBLEM ============ */}
      <section className="ggl2-section ggl2-problem" aria-labelledby="problem-heading">
        <div className="ggl2-inner ggl2-problem-inner">
          <p className="ggl2-eyebrow">THE PROBLEM</p>
          <h2 id="problem-heading" className="ggl2-h2">
            Most Traders Pay the Live Market to Teach Them.
          </h2>
          <p className="ggl2-problem-copy">
            Entries, exits, position sizing, discipline under pressure — these are
            learned through repetition. Learned live, every repetition costs real
            money, and the fastest, most volatile sessions are the most expensive
            teachers of all.
          </p>
          <p className="ggl2-problem-copy">
            Grow Green Lab moves that tuition to historical sessions. Replay the
            exact kind of day you trade — premarket momentum, HOD breakouts,
            failed follow-through — practise your execution as many times as you
            need, and review the evidence before real capital is ever on the line.
          </p>
          <div className="ggl2-cta-row">
            <Link href="/replay" className="ggl2-btn ggl2-btn-primary">
              Practice Before You Pay For It
            </Link>
          </div>
        </div>
      </section>

      {/* ============ DIFFERENTIATORS ============ */}
      <section className="ggl2-diffband" aria-label="What Grow Green Lab includes">
        <div className="ggl2-inner">
          <ul className="ggl2-diff-grid">
            {DIFFERENTIATORS.map((d) => (
              <li key={d}>
                <CheckIcon />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ============ FEATURE 1 — REPLAY ============ */}
      <section className="ggl2-section" id="replay" aria-labelledby="replay-heading">
        <div className="ggl2-inner">
          <p className="ggl2-eyebrow">HISTORICAL MARKET REPLAY</p>
          <h2 id="replay-heading" className="ggl2-h2">
            Replay the Market. Candle by Candle.
          </h2>
          <p className="ggl2-lede">
            A real historical session, revealed the way it actually unfolded —
            not the way the finished chart makes it look in hindsight.
          </p>
          <div className="ggl2-showcase">
            <figure className="ggl2-showcase-visual ggl2-showcase-visual-flat">
              <img src="/sim-chart.png" alt={CHART_ALT} className="ggl2-showcase-chart" loading="lazy" />
            </figure>
            <ul className="ggl2-feature-list">
              {REPLAY_FEATURES.map((f) => (
                <li key={f.title}>
                  <CheckIcon />
                  <div>
                    <h3>{f.title}</h3>
                    <p>{f.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="ggl2-links">
            <Link href="/replay" className="ggl2-textlink">
              Start a replay session <span aria-hidden="true">→</span>
            </Link>
          </p>
        </div>
      </section>

      {/* ============ FEATURE 2 — EXECUTION ============ */}
      <section className="ggl2-section ggl2-section-alt" aria-labelledby="execution-heading">
        <div className="ggl2-inner">
          <p className="ggl2-eyebrow">REALISTIC PAPER TRADING</p>
          <h2 id="execution-heading" className="ggl2-h2">
            Execute Like It&rsquo;s Live. Because It Trains Like It Is.
          </h2>
          <p className="ggl2-lede">
            Entries, exits and risk management are skills — and they are practised
            here with the same order mechanics you use with real money.
          </p>
          <div className="ggl2-split">
            <ul className="ggl2-feature-list">
              {EXECUTION_FEATURES.map((f) => (
                <li key={f.title}>
                  <CheckIcon />
                  <div>
                    <h3>{f.title}</h3>
                    <p>{f.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            <figure className="ggl2-exec-visual">
              <img src="/shot-replay.png" alt={CHART_ALT} className="ggl2-exec-chart" loading="lazy" />
              <img src="/shot-order.png" alt={ORDER_ALT} className="ggl2-exec-order" loading="lazy" />
            </figure>
          </div>
          <div className="ggl2-cta-row">
            <Link href="/replay" className="ggl2-btn ggl2-btn-primary">
              Try the Order Panel Free
            </Link>
          </div>
        </div>
      </section>

      {/* ============ FEATURE 3 — JOURNAL & ANALYTICS ============ */}
      <section className="ggl2-section" aria-labelledby="journal-heading">
        <div className="ggl2-inner">
          <p className="ggl2-eyebrow">TRADE JOURNAL &amp; ANALYTICS</p>
          <h2 id="journal-heading" className="ggl2-h2">
            Stop Guessing. Start Understanding Your Performance.
          </h2>
          <p className="ggl2-lede">
            Practice only works if you review it. Your journal records every trade
            and turns it into evidence about your execution.
          </p>
          <div className="ggl2-split">
            <ul className="ggl2-feature-list">
              {JOURNAL_FEATURES.map((f) => (
                <li key={f.title}>
                  <CheckIcon />
                  <div>
                    <h3>
                      {f.title}
                      {f.pro && <span className="ggl2-pro-tag">Pro</span>}
                    </h3>
                    <p>{f.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            <figure className="ggl2-split-visual">
              <img src="/shot-journal.png" alt={JOURNAL_ALT} loading="lazy" />
            </figure>
          </div>
          <p className="ggl2-links">
            <Link href="/journal" className="ggl2-textlink">
              Explore the Trade Journal <span aria-hidden="true">→</span>
            </Link>
          </p>
        </div>
      </section>

      {/* ============ HOW IT WORKS — 5 STEPS ============ */}
      <section className="ggl2-section ggl2-section-alt" aria-labelledby="steps-heading">
        <div className="ggl2-inner">
          <p className="ggl2-eyebrow">HOW IT WORKS</p>
          <h2 id="steps-heading" className="ggl2-h2">
            From Historical Session to Better Execution.
          </h2>
          <div className="ggl2-steps ggl2-steps-5">
            {STEPS.map((s) => (
              <article className="ggl2-step" key={s.n}>
                <span className="ggl2-step-n" aria-hidden="true">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.detail}</p>
              </article>
            ))}
          </div>
          <div className="ggl2-cta-row ggl2-cta-center">
            <Link href="/replay" className="ggl2-btn ggl2-btn-primary ggl2-btn-lg">
              Start a Free Practice Session
            </Link>
          </div>
        </div>
      </section>

      {/* ============ WHY GROW GREEN LAB ============ */}
      <section className="ggl2-section" aria-labelledby="why-heading">
        <div className="ggl2-inner">
          <p className="ggl2-eyebrow">WHY GROW GREEN LAB</p>
          <h2 id="why-heading" className="ggl2-h2">
            Built for Traders Who Want to Improve.
          </h2>
          <div className="ggl2-why-grid">
            {WHY_POINTS.map((w) => (
              <article className="ggl2-why-card" key={w.title}>
                <h3>{w.title}</h3>
                <p>{w.detail}</p>
              </article>
            ))}
            <article className="ggl2-why-card ggl2-guard-card">
              <h3>Psychology Guard — fixed rules, set in advance</h3>
              <div className="ggl2-ledger">
                {GUARD_RULES.map((r) => (
                  <div className="ggl2-ledger-row" key={r.rule}>
                    <span className="ggl2-ledger-rule">{r.rule}</span>
                    <span className="ggl2-ledger-detail">{r.detail}</span>
                  </div>
                ))}
              </div>
              <p className="ggl2-guard-note">
                Position loss is tracked live. The Guard warns first, then locks
                new entries — it doesn&rsquo;t negotiate mid-session.
              </p>
            </article>
          </div>
          <p className="ggl2-links">
            <Link href="/community" className="ggl2-textlink">
              You don&rsquo;t have to review alone — visit the Community <span aria-hidden="true">→</span>
            </Link>
          </p>
        </div>
      </section>

      {/* ============ FOUNDER (preserved verbatim) ============ */}
      <section className="ggl-rfounder" aria-labelledby="founder-heading">
        <div className="ggl-rfounder-inner">
          <p className="ggl-eyebrow">THE STORY BEHIND THE PLATFORM</p>
          <h2 id="founder-heading" className="ggl-rfounder-title">
            Built for Traders. <span className="ggl-rfounder-accent">Driven by Purpose.</span>
          </h2>
          <div className="ggl-rfounder-rule" aria-hidden="true" />
          <div className="ggl-rfounder-story">
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
          <p className="ggl-rfounder-closing">&ldquo;Big visions can come from small beginnings.&rdquo;</p>
          <div className="ggl-rfounder-sign">
            <div className="ggl-rfounder-name">Karandeep Singh</div>
            <div className="ggl-rfounder-role">Founder, Grow Green Trade Lab</div>
          </div>
        </div>
      </section>


      {/* ============ MEMBER STORIES ============ */}
      <section className="ggl2-section" aria-labelledby="stories-heading">
        <div className="ggl2-inner">
          <p className="ggl2-eyebrow">MEMBER STORIES</p>
          <h2 id="stories-heading" className="ggl2-h2">
            What Traders Are Saying.
          </h2>
          {TESTIMONIALS.length > 0 ? (
            <div className="ggl2-testimonials">
              {TESTIMONIALS.map((t) => (
                <figure className="ggl2-testimonial" key={t.name}>
                  <blockquote>{t.quote}</blockquote>
                  <figcaption>
                    <strong>{t.name}</strong>
                    <span>{t.detail}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div className="ggl2-testimonial-empty">
              <p>
                Grow Green Lab is built in the open, by a trader, for traders.
                Member stories will be published here as traders share them —
                no invented reviews, ever.
              </p>
              <Link href="/community" className="ggl2-textlink">
                Join the Community and share yours <span aria-hidden="true">→</span>
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* ============ PRICING ============ */}
      <section className="ggl2-section ggl2-section-alt" id="pricing" aria-labelledby="pricing-heading">
        <div className="ggl2-inner">
          <p className="ggl2-eyebrow">PRICING</p>
          <h2 id="pricing-heading" className="ggl2-h2">
            Start Free. Upgrade When You&rsquo;re Ready.
          </h2>
          <p className="ggl2-lede">
            Every plan starts with real practice. Pro removes the caps when your
            routine outgrows them.
          </p>
          <div className="ggl2-pricing">
            <article className="ggl2-price-card">
              <h3>Free</h3>
              <p className="ggl2-price">
                <span className="ggl2-price-amount">$0</span>
                <span className="ggl2-price-per">forever</span>
              </p>
              <ul className="ggl2-price-list">
                {FREE_FEATURES.map((f) => (
                  <li key={f}>
                    <CheckIcon />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link href="/replay" className="ggl2-btn ggl2-btn-outline">
                Start Practicing Free
              </Link>
            </article>
            <article className="ggl2-price-card ggl2-price-card-pro">
              <p className="ggl2-price-badge">PRO</p>
              <h3>Grow Green Lab Pro</h3>
              <p className="ggl2-price">
                <span className="ggl2-price-amount">$9.99</span>
                <span className="ggl2-price-per">CAD / month</span>
              </p>
              <p className="ggl2-price-alt">or $99.99 CAD / year — save about 17%</p>
              <ul className="ggl2-price-list">
                {PRO_FEATURES.map((f) => (
                  <li key={f}>
                    <CheckIcon />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link href="/pricing" className="ggl2-btn ggl2-btn-primary">
                See Pro Plans
              </Link>
            </article>
          </div>
          <p className="ggl2-price-note">
            Prices in Canadian dollars. Subscriptions are managed securely through
            Stripe — upgrade, manage or cancel anytime from your billing page.
            Simulated trading only; no real orders are executed.
          </p>
        </div>
      </section>

      {/* ============ FINAL CTA ============ */}
      <section className="ggl2-final" aria-labelledby="final-heading">
        <div className="ggl2-final-inner">
          <h2 id="final-heading" className="ggl2-final-title">
            Your Next Level Starts With Better Practice.
          </h2>
          <p className="ggl2-final-sub">
            Build your trading skills through repetition, discipline and
            data-driven feedback.
          </p>
          <Link href="/replay" className="ggl2-btn ggl2-btn-light ggl2-btn-lg">
            Start a Free Practice Session
          </Link>
          <p className="ggl2-final-note">
            Free as a guest — no account, no card, no install.
          </p>
        </div>
      </section>
    </div>
  );
}
