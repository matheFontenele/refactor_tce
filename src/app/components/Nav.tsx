"use client";

import React from "react";

export type Tab = "dashboard" | "search" | "sql";

/**
 * Nav — navegação entre Dashboard e SQL Studio.
 * Tema escuro consistente com o resto da aplicação.
 */
export default function Nav({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (tab: Tab) => void;
}) {
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "dashboard", label: "Dashboard" },
    { id: "search", label: "🔍 Pesquisa" },
    { id: "sql", label: "SQL Studio" },
  ];

  return (
    <header className="border-b border-slate-800 bg-slate-950/95 sticky top-0 z-20 backdrop-blur">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-lg" aria-hidden>
            🏛
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-slate-100">
              Auditoria Fiscal TCE-CE
            </p>
            <p className="text-[11px] text-slate-500">
              Plataforma de Refatoração
            </p>
          </div>
        </div>

        <nav className="flex gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onChange(t.id)}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                active === t.id
                  ? "bg-emerald-600 text-white shadow"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}
