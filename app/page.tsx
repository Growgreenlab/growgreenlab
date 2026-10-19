import Link from "next/link";
import HomeProcess from "../components/HomeProcess";

const CHART_ALT =
  "Grow Green Lab trading simulator chart — candlesticks and volume replaying a historical session, with stop-loss and take-profit lines drawn on the chart";
const ORDER_ALT =
  "Grow Green Lab order panel — simulated market order entry with quantity, stop-loss and take-profit brackets, and the fills ledger";
const JOURNAL_ALT =
  "Grow Green Lab Trade Journal — Analytics tab with the AI Edge Analysis Export panel and risk metrics";

const MANIFEST_ROWS: { file: string; desc: string }[] = [
  { file: "trades.csv", desc: "One row per trade — entries, exits, P&L, R multiples and your annotations." },
  { file: "analytics.json", desc: "The complete metrics snapshot behind the Analyzer: breakdowns, risk metrics, drawdown." },
  { file: "Trading_Report.pdf", desc: "A printable performance report with charts, generated from the same numbers." },
  { file: "ChatGPT_Prompt.txt", desc: "A ready-made brief that tells the AI how to review the package — and what not to invent." },
  { file: "README.txt", desc: "How every figure is calculated, including rounding and missing-data rules." },
  { file: "screenshots/", desc: "Your trade screenshots, matched to the trades they belong to." },
];

const GUARD_RULES: { rule: string; detail: string }[] = [
  { rule: "Position loss, tracked live", detail: "Realized + unrealized P&L measured against your initial position value." },
  { rule: "Loss ≥ 5%", detail: "Warning — you are approaching a lockout." },
  { rule: "Loss ≥ 10%", detail: "New entries locked for 30 minutes." },
  { rule: "Loss ≥ 20%", detail: "New entries locked for 60 minutes." },
  { rule: "Loss ≥ 30%", detail: "New entries locked for 3 hours." },
  { rule: "Exits always allowed", detail: "A lockout blocks new entries — never your exit." },
  { rule: "Cooldowns persist", detail: "Real-time timers survive a refresh and follow signed-in users across devices." },
];

const ROOMS: { name: string; desc: string; note?: string }[] = [
  { name: "Penny Stocks", desc: "Breakouts, premarket movers, and low-float plays." },
  { name: "Stock Market", desc: "Large and mid-cap stocks, earnings, and trends." },
  { name: "Options Trading", desc: "Calls, puts, strategies, and expiration plays." },
  { name: "Futures Trading", desc: "Index futures, price action, and scalping." },
  { name: "Forex", desc: "Currency pairs and economic events." },
  { name: "Crypto", desc: "Bitcoin, altcoins, and crypto market moves." },
  { name: "Trading Psychology & Education", desc: "Mindset, discipline, and learning resources." },
  { name: "General Discussion", desc: "Anything trading-related that fits nowhere else." },
  { name: "Announcements", desc: "Platform updates and release notes from the Grow Green Lab team.", note: "Admin-posted" },
];

export default function Home() {
  return (
    <div className="ggl-home">
      {/* ============ HERO ============ */}
      <section className="ggl-rhero">
        <div className="ggl-rhero-inner">
          <div className="ggl-rhero-copy">
            <p className="ggl-eyebrow">TRADING PRACTICE PLATFORM</p>
            <h1 className="ggl-rheadline">
              Train Your Strategy.
              <br />
              Prove Your Edge.
            </h1>
            <p className="ggl-rsub">
              Practice historical market sessions, test your trading decisions, analyze
              your performance, and build consistency before putting real capital at risk.
            </p>
            <div className="ggl-cta-row">
              <Link href="/replay" className="ggl-btn ggl-btn-primary ggl-btn-lg">
                Start Practicing <span aria-hidden="true">→</span>
              </Link>
              <a href="#practice" className="ggl-btn ggl-btn-outline ggl-btn-lg">
                Explore the Platform
              </a>
            </div>
            <p className="ggl-rtrust">
              Free to practise as a guest — 5 practice trades a day, no account
              required. Simulated trading only; no real orders are executed.
            </p>
          </div>
          <div className="ggl-rhero-visual" aria-hidden="false">
            <img
              src="/sim-chart.png"
              alt={CHART_ALT}
              className="ggl-rhero-chart"
              loading="eager"
            />
            <img
              src="/sim-order-panel.png"
              alt={ORDER_ALT}
              className="ggl-rhero-order"
              loading="eager"
            />
          </div>
        </div>
      </section>

      {/* ============ PROCESS: RAIL + PANELS ============ */}
      <section className="ggl-rprocess" id="features">
        <div id="how-it-works">
          <HomeProcess>
            {/* ---- 01 PRACTICE ---- */}
            <article className="ggl-rpanel ggl-rpanel-practice" id="practice" aria-labelledby="practice-heading">
              <p className="ggl-eyebrow">01 — PRACTICE</p>
              <h2 id="practice-heading" className="ggl-rpanel-title">
                Replay the market, candle by candle.
              </h2>
              <div className="ggl-rpanel-visual">
                <img src="/sim-chart.png" alt={CHART_ALT} className="ggl-rpanel-chart" loading="lazy" />
                <img src="/sim-order-panel.png" alt={ORDER_ALT} className="ggl-rpanel-order" loading="lazy" />
              </div>
              <div className="ggl-rpanel-cols ggl-rpanel-cols-1">
                <div>
                  <h3>Historical Market Replay</h3>
                  <p>
                    Load a real past session — from the built-in library or your own
                    market data — and play it back candle by candle. Pause, step,
                    change speed, draw your levels, and trade it with simulated orders
                    and stop-loss / take-profit brackets that trigger on every tick.
                  </p>
                </div>
              </div>
              <p className="ggl-rlinks">
                <Link href="/replay" className="ggl-textlink">
                  Open the Replay Lab <span aria-hidden="true">→</span>
                </Link>
              </p>
            </article>

            {/* ---- 02 ANALYZE ---- */}
            <article className="ggl-rpanel ggl-rpanel-analyze" id="analyze" aria-labelledby="analyze-heading">
              <p className="ggl-eyebrow">02 — ANALYZE</p>
              <h2 id="analyze-heading" className="ggl-rpanel-title">
                Know What Your Trades Are Telling You.
              </h2>
              <p className="ggl-rpanel-lede">
                Every trade contains clues about your edge. Analyze your setups,
                uncover recurring mistakes, understand your performance, and use
                AI-assisted reviews to discover what to improve next.
              </p>
              <div className="ggl-analyze-grid">
                <div className="ggl-benefits">
                  <div className="ggl-benefit">
                    <svg
                      className="ggl-benefit-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <line x1="6" y1="20" x2="6" y2="14" />
                      <line x1="12" y1="20" x2="12" y2="4" />
                      <line x1="18" y1="20" x2="18" y2="10" />
                    </svg>
                    <div>
                      <h3>Performance Insights</h3>
                      <p>
                        Break down your results by setup, mistakes, emotions, risk,
                        and plan adherence to identify where your performance is
                        strongest and where it needs work.
                      </p>
                    </div>
                  </div>
                  <div className="ggl-benefit">
                    <svg
                      className="ggl-benefit-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                      <line x1="12" y1="22.08" x2="12" y2="12" />
                    </svg>
                    <div>
                      <h3>AI-Ready Trade Export</h3>
                      <p>
                        Export your trades, analytics, performance report, review
                        instructions, and associated screenshots in one organized
                        package for deeper AI-assisted analysis.
                      </p>
                    </div>
                  </div>
                  <p className="ggl-analyze-cta">
                    <Link href="/journal" className="ggl-btn ggl-btn-primary">
                      Explore Trade Journal <span aria-hidden="true">→</span>
                    </Link>
                  </p>
                </div>
                <figure className="ggl-analyze-figure">
                  <img
                    src="/journal-analytics.png"
                    alt={JOURNAL_ALT}
                    className="ggl-analyze-shot"
                    loading="lazy"
                  />
                </figure>
              </div>
              <details className="ggl-included">
                <summary>What’s Included in Your AI Edge Export</summary>
                <div className="ggl-included-body">
                  <div className="ggl-manifest">
                    {MANIFEST_ROWS.map((r) => (
                      <div className="ggl-manifest-row" key={r.file}>
                        <span className="ggl-manifest-file">{r.file}</span>
                        <span className="ggl-manifest-desc">{r.desc}</span>
                      </div>
                    ))}
                  </div>
                  <h3 className="ggl-manifest-title">How the analysis works</h3>
                  <dl className="ggl-defs ggl-defs-included">
                    <div className="ggl-def-row">
                      <dt>Performance breakdowns</dt>
                      <dd>
                        Net P&amp;L, win rate, average R and expectancy — grouped by setup,
                        HOD class, symbol, mistake, emotion, session and time of day.
                      </dd>
                    </div>
                    <div className="ggl-def-row">
                      <dt>Edge Finder</dt>
                      <dd>
                        Surfaces the dimensions where your results concentrate, with
                        minimum sample sizes — a handful of trades is never dressed up
                        as an edge.
                      </dd>
                    </div>
                    <div className="ggl-def-row">
                      <dt>Risk metrics</dt>
                      <dd>
                        Average R, maximum drawdown, profit factor and streaks, computed
                        trade by trade from your own journal.
                      </dd>
                    </div>
                  </dl>
                </div>
              </details>
            </article>

            {/* ---- 03 IMPROVE ---- */}
            <article className="ggl-rpanel ggl-rpanel-improve" id="improve" aria-labelledby="improve-heading">
              <p className="ggl-eyebrow">03 — IMPROVE</p>
              <h2 id="improve-heading" className="ggl-rpanel-title">
                Risk decided before the trade, not during it.
              </h2>
              <div className="ggl-rpanel-split">
                <div>
                  <p>
                    The risk calculator sizes your position from your stop before you
                    enter. Brackets go on with the order — drag the stop-loss and
                    take-profit lines directly on the chart, and they trigger live
                    as price moves.
                  </p>
                  <p>
                    While you trade, the Psychology Guard watches the position. When
                    losses cross fixed thresholds it warns you first — then locks new
                    entries for a cooldown. It exists to stop the revenge trade and
                    the overtrade, not to trap you: exits are always allowed.
                  </p>
                  <p className="ggl-rlinks">
                    <Link href="/replay" className="ggl-textlink">
                      See it in the Replay Lab <span aria-hidden="true">→</span>
                    </Link>
                  </p>
                </div>
                <div>
                  <h3 className="ggl-ledger-title">Psychology Guard — fixed rules</h3>
                  <div className="ggl-ledger">
                    {GUARD_RULES.map((r) => (
                      <div className="ggl-ledger-row" key={r.rule}>
                        <span className="ggl-ledger-rule">{r.rule}</span>
                        <span className="ggl-ledger-detail">{r.detail}</span>
                      </div>
                    ))}
                  </div>
                  <p className="ggl-ledger-note">
                    Thresholds are set in advance — the Guard doesn&rsquo;t negotiate
                    mid-session.
                  </p>
                </div>
              </div>
            </article>

            {/* ---- 04 CONNECT ---- */}
            <article className="ggl-rpanel ggl-rpanel-connect" id="connect" aria-labelledby="connect-heading">
              <p className="ggl-eyebrow">04 — CONNECT</p>
              <h2 id="connect-heading" className="ggl-rpanel-title">
                You don&rsquo;t have to review alone.
              </h2>
              <p className="ggl-rpanel-lede">
                The Community is where Grow Green Lab traders compare notes —
                premarket movers, post-session reviews, and the discipline of
                sticking to a plan. Rooms are organised by market.
              </p>
              <div className="ggl-directory">
                {ROOMS.map((r) => (
                  <div className="ggl-directory-row" key={r.name}>
                    <span className="ggl-directory-name">
                      {r.name}
                      {r.note && <span className="ggl-directory-note">{r.note}</span>}
                    </span>
                    <span className="ggl-directory-desc">{r.desc}</span>
                  </div>
                ))}
              </div>
              <p className="ggl-rlinks">
                <Link href="/community" className="ggl-textlink">
                  Visit the Community <span aria-hidden="true">→</span>
                </Link>
              </p>
            </article>
          </HomeProcess>
        </div>
      </section>

      {/* ============ FOUNDER ============ */}
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

      {/* ============ ACCESS BAND ============ */}
      <section className="ggl-rband ggl-raccess" id="pricing" aria-labelledby="access-heading">
        <div className="ggl-rband-inner ggl-raccess-grid">
          <div>
            <p className="ggl-eyebrow">ACCESS</p>
            <h2 id="access-heading" className="ggl-rband-title">
              Start practising for free.
            </h2>
            <p className="ggl-raccess-copy">
              No card, no install. Open the simulator as a guest and start replaying
              real sessions in seconds. When you&rsquo;re ready to keep your work,
              a free account saves your sessions and journal.
            </p>
            <Link href="/replay" className="ggl-btn ggl-btn-primary ggl-btn-lg">
              Start Practicing <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div>
            <div className="ggl-ledger">
              <div className="ggl-ledger-row">
                <span className="ggl-ledger-rule">Guest access</span>
                <span className="ggl-ledger-detail">5 free practice trades per day — no account required.</span>
              </div>
              <div className="ggl-ledger-row">
                <span className="ggl-ledger-rule">Full simulator</span>
                <span className="ggl-ledger-detail">Replay, brackets, risk calculator and the Psychology Guard.</span>
              </div>
              <div className="ggl-ledger-row">
                <span className="ggl-ledger-rule">Free account</span>
                <span className="ggl-ledger-detail">Save sessions and keep your Trade Journal. Grow Green Lab Pro adds unlimited trades and entries, the AI Edge Analysis Export, and advanced analytics.</span>
              </div>
            </div>
            <p className="ggl-ledger-note">
              Simulated trading only. No real orders are executed.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
