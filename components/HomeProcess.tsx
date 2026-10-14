"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export const PROCESS_STAGES = [
  { id: "practice", num: "01", label: "Practice" },
  { id: "analyze", num: "02", label: "Analyze" },
  { id: "improve", num: "03", label: "Improve" },
  { id: "connect", num: "04", label: "Connect" },
] as const;

/**
 * The Process Rail: a sticky stage index (desktop) / stage bar (mobile)
 * beside the four workflow panels. Active stage tracks scroll position
 * via IntersectionObserver; clicking a stage smooth-scrolls to its panel.
 */
export default function HomeProcess({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<string>("practice");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const els = PROCESS_STAGES.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el != null
    );
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      // A panel counts as "current" when it crosses the middle band of the viewport.
      { rootMargin: "-38% 0px -55% 0px", threshold: 0 }
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const goTo = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="ggl-process" ref={rootRef}>
      {/* Mobile / tablet: slim sticky stage indicator */}
      <div className="ggl-stagebar" role="navigation" aria-label="Platform workflow">
        {PROCESS_STAGES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`ggl-stagebar-item${active === s.id ? " is-active" : ""}`}
            onClick={() => goTo(s.id)}
            aria-current={active === s.id ? "true" : undefined}
          >
            <span className="ggl-stagebar-num">{s.num}</span> {s.label}
          </button>
        ))}
      </div>

      <div className="ggl-process-grid">
        {/* Desktop: sticky rail on a hairline spine */}
        <nav className="ggl-rail" aria-label="Platform workflow">
          <div className="ggl-rail-inner">
            {PROCESS_STAGES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`ggl-rail-item${active === s.id ? " is-active" : ""}`}
                onClick={() => goTo(s.id)}
                aria-current={active === s.id ? "true" : undefined}
              >
                <span className="ggl-rail-dot" aria-hidden="true" />
                <span className="ggl-rail-num">{s.num}</span>
                <span className="ggl-rail-label">{s.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="ggl-panels-col">{children}</div>
      </div>
    </div>
  );
}
