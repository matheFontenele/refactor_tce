"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
} from "recharts";

/**
 * Dashboard — KPI cards + gráficos
 *
 * Consome GET /api/dashboard/stats:
 * - totals: {records, value, tables, municipalities}
 * - by_year: [{year, records, value}]
 * - by_municipality: [{municipality, records, value}]
 * - by_document_type: [{type, records, value}]
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:9001";

interface Stats {
  totals: {
    records: number;
    value: number;
    tables: number;
    municipalities: number;
  };
  by_year: Array<{ year: number; records: number; value: number }>;
  by_municipality: Array<{
    municipality: string;
    records: number;
    value: number;
  }>;
  by_document_type: Array<{ type: string; records: number; value: number }>;
}

const brl = (n: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(n);

const int = (n: number) => new Intl.NumberFormat("pt-BR").format(n);

// Paleta consistente com o tema slate/emerald
const BAR_COLORS = [
  "#10b981", // emerald-500
  "#38bdf8", // sky-400
  "#f59e0b", // amber-500
  "#a78bfa", // violet-400
  "#fb7185", // rose-400
  "#2dd4bf", // teal-400
  "#facc15", // yellow-400
  "#60a5fa", // blue-400
  "#f472b6", // pink-400
  "#4ade80", // green-400
];

const tooltipStyle = {
  backgroundColor: "#0f172a",
  border: "1px solid #334155",
  borderRadius: "8px",
  color: "#f1f5f9",
  fontSize: 13,
};

function CardSkeleton() {
  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 p-5 animate-pulse">
      <div className="h-3 w-24 bg-slate-800 rounded mb-3" />
      <div className="h-7 w-32 bg-slate-800 rounded" />
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 p-5">
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      {subtitle && (
        <p className="text-xs text-slate-500 mt-0.5 mb-4">{subtitle}</p>
      )}
      {!subtitle && <div className="mb-4" />}
      {children}
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/dashboard/stats`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || `Erro HTTP ${res.status}`);
      }
      const data = (await res.json()) as Stats;
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[...Array(2)].map((_, i) => (
            <div
              key={i}
              className="rounded-xl bg-slate-900 border border-slate-800 p-5 h-72 animate-pulse"
            >
              <div className="h-3 w-40 bg-slate-800 rounded mb-4" />
              <div className="h-full bg-slate-800/50 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl bg-rose-950 border border-rose-800 p-6 text-center">
        <p className="text-rose-200 font-medium">
          Falha ao carregar o dashboard
        </p>
        <p className="text-rose-400 text-sm mt-1">{error}</p>
        <button
          onClick={load}
          className="mt-4 px-4 py-2 rounded-lg bg-rose-800 hover:bg-rose-700 text-sm font-medium"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (!stats) return null;

  const { totals, by_year, by_municipality, by_document_type } = stats;
  const topMunicipios = by_municipality.slice(0, 10);
  const tipos = by_document_type.slice(0, 10);

  const kpis = [
    {
      label: "Total de Registros",
      value: int(totals.records),
      accent: "text-emerald-400",
      ring: "ring-emerald-500/30",
    },
    {
      label: "Valor Total",
      value: brl(totals.value),
      accent: "text-sky-400",
      ring: "ring-sky-500/30",
    },
    {
      label: "Municípios",
      value: int(totals.municipalities),
      accent: "text-amber-400",
      ring: "ring-amber-500/30",
    },
    {
      label: "Tabelas",
      value: int(totals.tables),
      accent: "text-violet-400",
      ring: "ring-violet-500/30",
    },
  ];

  return (
    <div className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map((k) => (
          <div
            key={k.label}
            className={`rounded-xl bg-slate-900 border border-slate-800 p-5 ring-1 ${k.ring}`}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {k.label}
            </p>
            <p className={`mt-2 text-2xl font-bold tabular-nums ${k.accent}`}>
              {k.value}
            </p>
          </div>
        ))}
      </div>

      {/* Gráficos principais */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title="Top Municípios por Valor"
          subtitle="Soma de valores por município (R$)"
        >
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topMunicipios} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="municipality"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  interval={0}
                  angle={-24}
                  textAnchor="end"
                  height={56}
                />
                <YAxis
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) =>
                    v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)
                  }
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value) => [brl(Number(value ?? 0)), "Valor"]}
                  cursor={{ fill: "#1e293b66" }}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {topMunicipios.map((_, i) => (
                    <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard
          title="Registros por Exercício"
          subtitle="Quantidade de documentos e valor por ano"
        >
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={by_year} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="year"
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value, name) =>
                    name === "records"
                      ? [int(Number(value ?? 0)), "Registros"]
                      : [brl(Number(value ?? 0)), "Valor"]
                  }
                  cursor={{ fill: "#1e293b66" }}
                />
                <Bar
                  dataKey="records"
                  fill="#10b981"
                  radius={[4, 4, 0, 0]}
                  name="records"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      {/* Tipos de documento */}
      <ChartCard
        title="Por Tipo de Documento"
        subtitle="Registros por tipo (top 10)"
      >
        {tipos.length === 0 ? (
          <p className="text-sm text-slate-500 py-6 text-center">
            Sem dados disponíveis.
          </p>
        ) : (
          <div className="space-y-2">
            {tipos.map((t, i) => {
              const max = tipos[0].records || 1;
              const pct = Math.round((t.records / max) * 100);
              return (
                <div key={t.type} className="flex items-center gap-3">
                  <span
                    className="text-xs text-slate-400 w-56 truncate"
                    title={t.type}
                  >
                    {t.type}
                  </span>
                  <div className="flex-1 h-5 bg-slate-800/60 rounded overflow-hidden">
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                      }}
                    />
                  </div>
                  <span className="text-xs tabular-nums text-slate-300 w-24 text-right">
                    {int(t.records)} reg.
                  </span>
                  <span className="text-xs tabular-nums text-slate-500 w-28 text-right hidden sm:block">
                    {brl(t.value)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </ChartCard>

      <p className="text-xs text-slate-600 text-right">
        Fonte: DuckDB · {int(totals.records)} registros em {totals.tables}{" "}
        tabelas
      </p>
    </div>
  );
}
