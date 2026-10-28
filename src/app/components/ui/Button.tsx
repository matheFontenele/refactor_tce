"use client";

import React, { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";
import { Icon } from "./Icon";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  /* Texto escuro sobre esmeralda claro: contraste alto e estável no hover. */
  primary:
    "bg-emerald-500 text-slate-950 hover:bg-emerald-400 border border-transparent",
  secondary:
    "bg-slate-800 text-slate-100 border border-slate-700 hover:bg-slate-700",
  ghost:
    "bg-transparent text-slate-300 border border-transparent hover:bg-slate-800 hover:text-slate-100",
  danger:
    "bg-rose-900 text-rose-50 border border-rose-700 hover:bg-rose-800",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3 text-xs gap-1.5",
  md: "h-11 px-4 text-sm gap-2",
  icon: "h-11 w-11 p-0",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-lg font-semibold transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Icon name="loader" className="h-4 w-4 animate-spin" />
      ) : null}
      {children}
    </button>
  );
}
