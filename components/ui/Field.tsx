/**
 * Input / Select — redesign v2 UI kit (Phase 0).
 * Label above, 44px min height, error text wired with
 * aria-describedby per Direction v2 §2.6 (audit input spec).
 */
import type { InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from "react";

type InputProps = {
  label: string;
  error?: string;
  id: string;
} & InputHTMLAttributes<HTMLInputElement>;

export function Input({ label, error, id, ...rest }: InputProps) {
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div>
      <label className="ui-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="ui-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        {...rest}
      />
      {error && (
        <p className="ui-field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

type SelectProps = {
  label: string;
  error?: string;
  id: string;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ label, error, id, children, ...rest }: SelectProps) {
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div>
      <label className="ui-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="ui-select"
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        {...rest}
      >
        {children}
      </select>
      {error && (
        <p className="ui-field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
