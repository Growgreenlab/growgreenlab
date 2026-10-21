/**
 * Card — redesign v2 UI kit (Phase 0).
 * Surface card per Direction v2 §2.6 with the eyebrow + title
 * section-header pattern (§6.2 "recorded line" motif).
 */
import type { HTMLAttributes, ReactNode } from "react";

type CardProps = {
  eyebrow?: string;
  title?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>;

export default function Card({ eyebrow, title, children, className, ...rest }: CardProps) {
  return (
    <div className={"ui-card" + (className ? ` ${className}` : "")} {...rest}>
      {(eyebrow || title) && (
        <div className="ui-card-h">
          {eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}
          {title && <h3 className="ui-card-title">{title}</h3>}
        </div>
      )}
      {children}
    </div>
  );
}
