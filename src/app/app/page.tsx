"use client";

import { useState } from "react";
import Nav, { Tab } from "@/components/Nav";
import Dashboard from "@/components/Dashboard";
import Search from "@/components/Search";
import MonacoSQLEditor from "@/components/MonacoSQLEditor";

export default function HomePage() {
  const [tab, setTab] = useState<Tab>("dashboard");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Nav active={tab} onChange={setTab} />
      <main className="max-w-7xl mx-auto p-4">
        {tab === "dashboard" && <Dashboard />}
        {tab === "search" && <Search />}
        {tab === "sql" && <MonacoSQLEditor />}
      </main>
    </div>
  );
}
