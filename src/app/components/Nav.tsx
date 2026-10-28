"use client";

import React, { useEffect, useRef } from "react";
import { Icon, IconName } from "./ui/Icon";
import { cx } from "./ui/cx";

export type Tab = "dashboard" | "search" | "sql" | "assistant";

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "search", label: "Pesquisa", icon: "search" },
  { id: "sql", label: "SQL Studio", icon: "code" },
  { id: "assistant", label: "Assistente", icon: "sparkles" },
];

/**
 * Nav — navegação entre Dashboard, Pesquisa, SQL Studio e Assistente.
 * Abas como botões (estado da SPA), com ícones vetoriais e alvo de toque 44px.
 */
export default function Nav({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (tab: Tab) => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Em telas estreitas a barra rola na horizontal — garante que a aba ativa
  // fique sempre visível, respeitando a preferência por menos movimento.
  useEffect(() => {
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    activeRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reduce ? "auto" : "smooth",
    });
  }, [active]);

  return (
    <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-300">
            <Icon name="landmark" className="h-5 w-5" />
          </span>
          <div className="hidden min-w-0 leading-tight sm:block">
            <p className="truncate text-sm font-semibold text-slate-100">
              Auditoria Fiscal TCE-CE
            </p>
            <p className="truncate text-xs text-slate-400">
              Plataforma de análise
            </p>
          </div>
        </div>

        <nav
          aria-label="Seções da plataforma"
          className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 p-1"
        >
          {TABS.map((t) => {
            const isActive = active === t.id;
            return (
              <button
                key={t.id}
                ref={isActive ? activeRef : undefined}
                type="button"
                onClick={() => onChange(t.id)}
                aria-label={t.label}
                aria-current={isActive ? "page" : undefined}
                className={cx(
                  "inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors sm:px-4",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950",
                  isActive
                    ? "bg-emerald-500 text-slate-950 shadow-sm"
                    : "text-slate-300 hover:bg-slate-800 hover:text-slate-50",
                )}
              >
                <Icon name={t.icon} className="h-4 w-4" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
