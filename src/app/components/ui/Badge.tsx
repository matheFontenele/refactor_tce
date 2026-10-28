import React from "react";
import { cx } from "./cx";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const TONES: Record<Tone, string> = {
  neutral: "border-slate-700 bg-slate-800/70 text-slate-300",
  accent: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  danger: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-300",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
