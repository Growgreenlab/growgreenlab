/**
 * Button — redesign v2 UI kit (Phase 0).
 * Variants per Direction v2 §2.6: navy `primary` is the platform's
 * default command; `accent` is reserved for commercial moments
 * (upgrade / subscribe, D8); `buy`/`sell` are trading-context only.
 * Renders <a> when href is given, otherwise <button>.
 * Consumes v2 tokens only (app/tokens.css, [data-theme="light"]).
 */
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant =
  | "primary"
  | "accent"
  | "secondary"
  | "ghost"
  | "danger"
  | "buy"
  | "sell";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "ui-btn ui-btn-primary",
  accent: "ui-btn ui-btn-accent",
  secondary: "ui-btn ui-btn-secondary",
  ghost: "ui-btn ui-btn-ghost",
  danger: "ui-btn ui-btn-danger",
  buy: "ui-btn ui-btn-buy",
  sell: "ui-btn ui-btn-sell",
};

type ButtonProps = {
  variant?: ButtonVariant;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement> &
  AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string };

export default function Button({ variant = "primary", children, href, className, ...rest }: ButtonProps) {
  const cls = VARIANT_CLASS[variant] + (className ? ` ${className}` : "");
  if (href) {
    return (
      <a href={href} className={cls} {...rest}>
        {children}
      </a>
    );
  }
  const { href: _href, ...btnRest } = rest as ButtonHTMLAttributes<HTMLButtonElement> & { href?: string };
  return (
    <button className={cls} {...btnRest}>
      {children}
    </button>
  );
}
