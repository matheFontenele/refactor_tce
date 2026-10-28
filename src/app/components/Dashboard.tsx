"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardHeader } from "./ui/Card";
import { PageHeader } from "./ui/PageHeader";
import { ErrorState } from "./ui/State";
import { Icon, IconName } from "./ui/Icon";
import { TableShell, tableClass, tdClass, thClass } from "./ui/Table";
import { cx } from "./ui/cx";
import { getApiUrl } from "../lib/api";

/**
 * Dashboard — KPI cards + gráficos.
 *
 * Consome GET /api/dashboard/stats (contrato inalterado):
 * - totals: {records, value, tables, municipalities}
 * - by_year: [{year, records, value}]
 * - by_municipality: [{municipality, records, value}]
 * - by_document_type: [{type, records, value}]
 */

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

type Metric = "records" | "value";

const brl = (n: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(n);

const int = (n: number) => new Intl.NumberFormat("pt-BR").format(n);

const compact = (n: number) =>
  new Intl.NumberFormat("pt-BR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);

// Paleta categórica — cores distintas, usadas apenas como reforço do rótulo.
const BAR_COLORS = [
  "#34d399",
  "#38bdf8",
  "#fbbf24",
  "#a78bfa",
  "#fb7185",
  "#2dd4bf",
  "#facc15",
  "#60a5fa",
];

const tooltipStyle: React.CSSProperties = {
  backgroundColor: "#0f172a",
  border: "1px solid #334155",
  borderRadius: "8px",
  color: "#f1f5f9",
  fontSize: 12,
};

function CardSkeleton() {
  return (
    <Card className="p-5">
      <div className="mb-3 h-3 w-24 animate-pulse rounded bg-slate-800" />
      <div className="h-7 w-32 animate-pulse rounded bg-slate-800" />
    </Card>
  );
}

function ChartCard({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="min-w-0 p-5">
      <CardHeader title={title} subtitle={subtitle} actions={actions} />
      <div className="mt-4">{children}</div>
    </Card>
  );
}

/** Alternativa textual aos gráficos: leitores de tela e conferência de valores. */
function ChartDataTable({
  caption,
  label,
  rows,
}: {
  caption: string;
  label: string;
  rows: Array<{ key: string; records: number; value: number }>;
}) {
  return (
    <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40">
      <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200">
        Ver dados em tabela
      </summary>
      <TableShell className="rounded-t-none border-0 border-t border-slate-800">
        <table className={tableClass}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className={thClass}>
                {label}
              </th>
              <th scope="col" className={cx(thClass, "text-right")}>
                Registros
              </th>
              <th scope="col" className={cx(thClass, "text-right")}>
                Valor
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th
                  scope="row"
                  className="whitespace-nowrap border-b border-slate-800/60 px-3 py-2 text-left text-sm font-normal text-slate-300"
                >
                  {row.key}
                </th>
                <td className={cx(tdClass, "text-right font-mono tabular-nums")}>
                  {int(row.records)}
                </td>
                <td className={cx(tdClass, "text-right font-mono tabular-nums")}>
                  {brl(row.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableShell>
    </details>
  );
}

function KpiCard({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: IconName;
  tone: "emerald" | "sky" | "amber" | "violet";
}) {
  const tones = {
    emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    sky: "border-sky-500/20 bg-sky-500/10 text-sky-300",
    amber: "border-amber-500/20 bg-amber-500/10 text-amber-300",
    violet: "border-violet-500/20 bg-violet-500/10 text-violet-300",
  } as const;

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {label}
          </p>
          <p className="mt-2 break-words text-2xl font-bold tabular-nums text-slate-50">
            {value}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{hint}</p>
        </div>
        <span
          className={cx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border",
            tones[tone],
          )}
        >
          <Icon name={icon} className="h-5 w-5" />
        </span>
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("records");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiUrl()}/api/dashboard/stats`);
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
      <div className="space-y-5">
        <PageHeader
          eyebrow="Visão geral"
          title="Dashboard"
          description="Panorama consolidado dos documentos fiscais disponíveis na base local."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[...Array(2)].map((_, i) => (
            <Card key={i} className="h-80 p-5">
              <div className="mb-4 h-3 w-40 animate-pulse rounded bg-slate-800" />
              <div className="h-full animate-pulse rounded bg-slate-800/50" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        <PageHeader
          eyebrow="Visão geral"
          title="Dashboard"
          description="Panorama consolidado dos documentos fiscais disponíveis na base local."
        />
        <ErrorState
          title="Falha ao carregar o dashboard"
          message={error}
          onRetry={load}
        />
      </div>
    );
  }

  if (!stats) return null;

  const { totals, by_year, by_municipality, by_document_type } = stats;
  const topMunicipios = by_municipality.slice(0, 8);
  const tipos = by_document_type.slice(0, 10);

  const kpis: Array<{
    label: string;
    value: string;
    hint: string;
    icon: IconName;
    tone: "emerald" | "sky" | "amber" | "violet";
  }> = [
    {
      label: "Registros",
      value: int(totals.records),
      hint: "Documentos somados em todas as bases",
      icon: "fileText",
      tone: "emerald",
    },
    {
      label: "Valor total",
      value: brl(totals.value),
      hint: "Soma dos valores registrados",
      icon: "coins",
      tone: "sky",
    },
    {
      label: "Municípios",
      value: int(totals.municipalities),
      hint: "Municípios com registros na base",
      icon: "mapPin",
      tone: "amber",
    },
    {
      label: "Tipos de documento",
      value: int(totals.tables),
      hint: "Bases disponíveis para consulta",
      icon: "database",
      tone: "violet",
    },
  ];

  const metricLabel = metric === "records" ? "Registros" : "Valor";
  const metricFormatter = (v: number) =>
    metric === "records" ? int(v) : brl(v);
  const axisFormatter = (v: number) =>
    metric === "records" ? compact(v) : `R$ ${compact(v)}`;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Visão geral"
        title="Dashboard"
        description="Panorama consolidado dos documentos fiscais disponíveis na base local."
      />

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      {/* Gráficos principais */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Top municípios por valor"
          subtitle="Oito municípios com maior valor registrado (R$)"
        >
          {topMunicipios.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              Sem dados disponíveis.
            </p>
          ) : (
            <>
              <div
                className="h-80"
                role="img"
                aria-label="Gráfico de barras dos oito municípios com maior valor registrado."
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={topMunicipios}
                    layout="vertical"
                    margin={{ top: 4, right: 12, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="#1e293b"
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={{ stroke: "#334155" }}
                      tickLine={false}
                      tickFormatter={(v: number) => compact(v)}
                    />
                    <YAxis
                      type="category"
                      dataKey="municipality"
                      width={104}
                      tick={{ fill: "#cbd5e1", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: string) =>
                        v.length > 15 ? `${v.slice(0, 14)}…` : v
                      }
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value) => [brl(Number(value ?? 0)), "Valor"]}
                      cursor={{ fill: "#1e293b66" }}
                    />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {topMunicipios.map((_, i) => (
                        <Cell
                          key={i}
                          fill={BAR_COLORS[i % BAR_COLORS.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <ChartDataTable
                caption="Valores por município"
                label="Município"
                rows={topMunicipios.map((m) => ({
                  key: m.municipality,
                  records: m.records,
                  value: m.value,
                }))}
              />
            </>
          )}
        </ChartCard>

        <ChartCard
          title="Evolução por exercício"
          subtitle={
            metric === "records"
              ? "Quantidade de documentos por ano"
              : "Valor total dos documentos por ano"
          }
          actions={
            <div
              className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Métrica do gráfico"
            >
              {(
                [
                  ["records", "Registros"],
                  ["value", "Valor"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMetric(id)}
                  aria-pressed={metric === id}
                  className={cx(
                    "min-h-[36px] rounded-md px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400",
                    metric === id
                      ? "bg-slate-800 text-slate-50"
                      : "text-slate-400 hover:text-slate-200",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        >
          {by_year.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              Sem dados disponíveis.
            </p>
          ) : (
            <>
              <div
                className="h-80"
                role="img"
                aria-label={`Gráfico de barras de ${metricLabel.toLowerCase()} por exercício.`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={by_year}
                    margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="#1e293b"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="year"
                      tick={{ fill: "#cbd5e1", fontSize: 12 }}
                      axisLine={{ stroke: "#334155" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={56}
                      tickFormatter={axisFormatter}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value) => [
                        metricFormatter(Number(value ?? 0)),
                        metricLabel,
                      ]}
                      cursor={{ fill: "#1e293b66" }}
                    />
                    <Bar
                      dataKey={metric}
                      fill="#34d399"
                      radius={[4, 4, 0, 0]}
                      name={metricLabel}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <ChartDataTable
                caption="Registros e valores por exercício"
                label="Exercício"
                rows={by_year.map((y) => ({
                  key: String(y.year),
                  records: y.records,
                  value: y.value,
                }))}
              />
            </>
          )}
        </ChartCard>
      </div>

      {/* Tipos de documento */}
      <ChartCard
        title="Por tipo de documento"
        subtitle="Dez bases com mais registros"
      >
        {tipos.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">
            Sem dados disponíveis.
          </p>
        ) : (
          <div className="space-y-3">
            {tipos.map((t, i) => {
              const max = tipos[0].records || 1;
              const pct = Math.max(2, Math.round((t.records / max) * 100));
              return (
                <div key={t.type} className="flex items-center gap-3">
                  <span
                    className="w-40 shrink-0 truncate text-xs text-slate-300 sm:w-56"
                    title={t.type}
                  >
                    {t.type}
                  </span>
                  <div
                    className="h-5 flex-1 overflow-hidden rounded bg-slate-800/70"
                    role="img"
                    aria-label={`${t.type}: ${int(t.records)} registros, ${brl(t.value)}`}
                  >
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                      }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-300">
                    {int(t.records)} reg.
                  </span>
                  <span className="hidden w-32 shrink-0 text-right text-xs tabular-nums text-slate-400 sm:block">
                    {brl(t.value)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </ChartCard>

      <p className="text-right text-xs text-slate-400">
        Fonte: DuckDB · {int(totals.records)} registros em {totals.tables}{" "}
        bases
      </p>
    </div>
  );
}
