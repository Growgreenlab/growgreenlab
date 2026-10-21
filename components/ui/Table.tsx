/**
 * Table primitives — redesign v2 UI kit (Phase 0).
 * Row hairlines, tabular numerals, P&L cells in the semantic
 * ink tokens (Direction v2 §2.6) — green/red appear in the
 * numbers, where they mean something.
 */
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ children, className, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLTableElement>) {
  return (
    <table className={"ui-table" + (className ? ` ${className}` : "")} {...rest}>
      {children}
    </table>
  );
}

export function Th({ children, ...rest }: { children: ReactNode } & ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...rest}>{children}</th>;
}

export function Td({ children, ...rest }: { children: ReactNode } & TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest}>{children}</td>;
}

/** A numeric cell colored by sign: positive → --up-ink, negative → --down-ink. */
export function PnlCell({ value, format }: { value: number; format?: (n: number) => string }) {
  const text = format ? format(value) : value.toFixed(2);
  return <td className={value > 0 ? "ui-num-pos" : value < 0 ? "ui-num-neg" : undefined}>{text}</td>;
}
