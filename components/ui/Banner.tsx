/**
 * Banner — redesign v2 UI kit (Phase 0).
 * The four tint pairs of Direction v2 §2.4 replace the ad-hoc
 * notice cards (billing's five variants migrate in Phase 3).
 */
import type { HTMLAttributes, ReactNode } from "react";

export type BannerTone = "neutral" | "info" | "success" | "danger" | "warning";

const TONE_CLASS: Record<BannerTone, string> = {
  neutral: "ui-banner",
  info: "ui-banner ui-banner-info",
  success: "ui-banner ui-banner-success",
  danger: "ui-banner ui-banner-danger",
  warning: "ui-banner ui-banner-warning",
};

type BannerProps = { tone?: BannerTone; children: ReactNode } & HTMLAttributes<HTMLDivElement>;

export default function Banner({ tone = "neutral", children, className, ...rest }: BannerProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={TONE_CLASS[tone] + (className ? ` ${className}` : "")}
      {...rest}
    >
      {children}
    </div>
  );
}
