"use client";

import React, { cloneElement, isValidElement } from "react";
import { cx } from "./cx";
import { Icon } from "./Icon";

export const controlClass =
  "w-full min-h-[44px] rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 transition-colors hover:border-slate-600 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/30 disabled:cursor-not-allowed disabled:opacity-60";

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  className?: string;
  /** Um único elemento de formulário; recebe id e atributos ARIA automaticamente. */
  children: React.ReactElement;
}

export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: FieldProps) {
  const describedBy =
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })
    : children;

  return (
    <div className={cx("min-w-0", className)}>
      <label
        htmlFor={id}
        className="mb-1.5 block text-xs font-semibold text-slate-300"
      >
        {label}
      </label>
      {control}
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1 flex items-start gap-1 text-xs text-rose-300"
        >
          <Icon name="alertTriangle" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
