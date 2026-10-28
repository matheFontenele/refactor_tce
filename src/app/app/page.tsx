"use client";

import { useEffect, useState } from "react";
import Nav, { Tab } from "@/components/Nav";
import Dashboard from "@/components/Dashboard";
import Search from "@/components/Search";
import MonacoSQLEditor from "@/components/MonacoSQLEditor";
import AssistantChat from "@/components/AssistantChat";

const TAB_TITLES: Record<Tab, string> = {
  dashboard: "Dashboard",
  search: "Pesquisa",
  sql: "SQL Studio",
  assistant: "Assistente",
};

export default function HomePage() {
  const [tab, setTab] = useState<Tab>("dashboard");
  // Mantém abas já visitadas montadas: filtros, resultados, query e conversa
  // não são descartados ao navegar. A primeira visita é lazy.
  const [visited, setVisited] = useState<Tab[]>(["dashboard"]);

  const changeTab = (next: Tab) => {
    setTab(next);
    setVisited((prev) => (prev.includes(next) ? prev : [...prev, next]));
  };

  useEffect(() => {
    document.title = `${TAB_TITLES[tab]} — SQL Studio TCE-CE`;
  }, [tab]);

  return (
    <div id="app-shell" className="min-h-screen bg-slate-950 text-slate-100">
      <a
        href="#conteudo"
        className="sr-only rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
      >
        Pular para o conteúdo
      </a>

      <Nav active={tab} onChange={changeTab} />

      <main
        id="conteudo"
        tabIndex={-1}
        className="mx-auto max-w-7xl px-4 py-5 focus:outline-none sm:px-6 sm:py-6"
      >
        <section hidden={tab !== "dashboard"} aria-label="Dashboard">
          {visited.includes("dashboard") ? <Dashboard /> : null}
        </section>

        <section hidden={tab !== "search"} aria-label="Pesquisa">
          {visited.includes("search") ? <Search /> : null}
        </section>

        <section hidden={tab !== "sql"} aria-label="SQL Studio">
          {visited.includes("sql") ? <MonacoSQLEditor /> : null}
        </section>

        <section hidden={tab !== "assistant"} aria-label="Assistente">
          {visited.includes("assistant") ? <AssistantChat /> : null}
        </section>
      </main>
    </div>
  );
}
