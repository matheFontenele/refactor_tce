import React from "react";
import { cx } from "./cx";

/** Container padrão: rolagem horizontal + borda consistente. */
export function TableShell({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        "overflow-x-auto rounded-xl border border-slate-800",
        className,
      )}
    >
      {children}
    </div>
  );
}

export const tableClass = "w-full border-collapse text-left text-sm";

export const thClass =
  "whitespace-nowrap border-b border-slate-800 bg-slate-900 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400";

export const tdClass =
  "whitespace-nowrap border-b border-slate-800/60 px-3 py-2.5 text-slate-300";
