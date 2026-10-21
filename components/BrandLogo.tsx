/**
 * BrandLogo — Grow Green Lab lockup, Direction v2 decision D4(a):
 * navy wordmark + heritage-green glyph. An inline-SVG adaptation of
 * the existing logo mark (G-swoosh arc, ascending bars, leaf) so the
 * colors come from the v2 tokens instead of the dark-era PNG:
 * arc + wordmark in --ink-900, bars + leaf in --up-ink ("lab green",
 * which appears only inside the logo — Direction v2 §6.1).
 * Renders inside [data-theme="light"] subtrees (header/footer).
 */
export default function BrandLogo() {
  return (
    <span className="ggl-brand-lockup">
      <svg
        className="ggl-brand-glyph"
        viewBox="0 0 48 48"
        aria-hidden="true"
        focusable="false"
      >
        {/* G-swoosh arc (gap at upper right) */}
        <circle
          cx="24"
          cy="24"
          r="15.5"
          fill="none"
          style={{ stroke: "var(--ink-900)" }}
          strokeWidth="4.2"
          strokeLinecap="round"
          strokeDasharray="80 17.4"
          transform="rotate(-13 24 24)"
        />
        {/* Ascending bars */}
        <g style={{ fill: "var(--up-ink)" }}>
          <rect x="15.8" y="29" width="4.6" height="8" rx="2.3" />
          <rect x="21.7" y="23.5" width="4.6" height="13.5" rx="2.3" />
          <rect x="27.6" y="18" width="4.6" height="19" rx="2.3" />
        </g>
        {/* Leaf, overlapping bottom-left as in the original mark */}
        <path
          d="M4 26 C4 38 10 45 22 45 C21 33 15 26 4 26 Z"
          style={{ fill: "var(--up-ink)" }}
        />
        <path
          d="M7.5 41.5 C11 35 15 31 19.5 28"
          fill="none"
          style={{ stroke: "var(--surface)" }}
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
      <span className="ggl-brand-word">GrowGreenLab</span>
    </span>
  );
}
