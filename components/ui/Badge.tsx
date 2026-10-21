/**
 * Badge — redesign v2 UI kit (Phase 0).
 * PRO = accent-soft/accent-ink; LIVE/positive = success tint;
 * default (SIMULATED / SAMPLE etc.) = neutral surface-2 (Direction
 * v2 §2.6; sim/sample dedupe happens at migration time, Phase 3+).
 */
import type { HTMLAttributes, ReactNode } from "react";

export type BadgeTone = "neutral" | "pro" | "live";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "ui-badge",
  pro: "ui-badge ui-badge-pro",
  live: "ui-badge ui-badge-live",
};

type BadgeProps = { tone?: BadgeTone; children: ReactNode } & HTMLAttributes<HTMLSpanElement>;

export default function Badge({ tone = "neutral", children, className, ...rest }: BadgeProps) {
  return (
    <span className={TONE_CLASS[tone] + (className ? ` ${className}` : "")} {...rest}>
      {children}
    </span>
  );
}
