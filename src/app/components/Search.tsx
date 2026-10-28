"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import SearchDetailsModal from "./SearchDetailsModal";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card, CardHeader } from "./ui/Card";
import { Field, controlClass } from "./ui/Field";
import { Icon, IconName } from "./ui/Icon";
import { PageHeader } from "./ui/PageHeader";
import { EmptyState, ErrorState } from "./ui/State";
import {
  TableShell,
  tableClass,
  tdClass,
  thClass,
} from "./ui/Table";
import { cx } from "./ui/cx";

/**
 * Pesquisa Interativa — espelho da "Consulta Detalhada" do painel original.
 *
 * - Filtros: categoria (endpoints.json), período, município, campos dinâmicos
 * - Busca geral (com match_reason) e fornecedor (CNPJ/razão social)
 * - Cards dinâmicos (layout_card) + export CSV
 *
 * O payload enviado a POST /api/search permanece idêntico ao original.
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:9001";

interface CampoUI {
  id: string;
  label: string;
  tipo: "select" | "number" | "text";
  opcoes?: string[];
  default?: number;
  step?: number;
  placeholder?: string;
}

interface LayoutCard {
  topo_esq?: string;
  titulo_grande?: string;
  corpo_texto?: string | string[];
  metadados?: Array<{ tipo?: string; label: string; coluna: string }>;
  grid_financeiro?: Array<{ coluna: string; label_caixa: string }>;
}

interface Category {
  name: string;
  prefixo: string;
  campos_ui: CampoUI[];
  colunas_texto: Record<string, string>;
  layout_card: LayoutCard;
}

interface Municipality {
  code: string;
  name: string;
}

interface SearchConfig {
  categories: Category[];
  municipalities: Municipality[];
  years: number[];
}

interface SearchRow {
  [col: string]: unknown;
  match_reason?: string;
}

interface SearchResults {
  category: string;
  count: number;
  returned: number;
  columns: string[];
  rows: SearchRow[];
  /** "parquet" = dataset real do TCE; "seed" = amostra local */
  source?: string;
  /** Recortes baixados da API do TCE nesta consulta (Spec 2.1) */
  fetched?: string[];
  fetch_error?: string | null;
  fetch_pending?: number;
}

type ViewMode = "cards" | "table";
type SortDirection = "asc" | "desc";

const CARD_STEP = 20;
const PAGE_SIZE = 25;

const brl = (n: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(n);

function fmtDate(v: unknown): string {
  if (!v) return "—";
  const s = String(v).split("T")[0];
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
}

function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlight({ text, term }: { text: string; term: string }) {
  if (!term || !text) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeReg(term)})`, "ig"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === term.toLowerCase() ? (
          <mark
            key={i}
            className="rounded-sm bg-yellow-300 px-0.5 text-slate-950"
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

const STATUS_STYLES: Record<string, string> = {
  PAGO: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
  PARCIAL: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  PENDENTE: "bg-rose-500/15 text-rose-300 border border-rose-500/30",
};

const META_ICONS: Record<string, IconName> = {
  local: "mapPin",
  data: "calendar",
  valor: "coins",
};

const MONEY_COLUMN = /valor|pago|liquidado|empenhado|montante|total|vlr/i;
const NUMERIC_COLUMN =
  /valor|pago|liquidado|empenhado|montante|total|quantidade|qtd|vlr|ano|exercicio/i;

function formatTableValue(column: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const lower = column.toLowerCase();
  if (lower.includes("data")) return fmtDate(value);
  if (typeof value === "number") {
    return MONEY_COLUMN.test(column) ? brl(value) : value.toLocaleString("pt-BR");
  }
  if (MONEY_COLUMN.test(column)) {
    const num = Number(value);
    if (Number.isFinite(num)) return brl(num);
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Card dinâmico (fiel ao dynamic_card.py original, no tema escuro)
// ---------------------------------------------------------------------------
function SearchCard({
  row,
  category,
  generalTerm,
  onOpen,
}: {
  row: SearchRow;
  category: Category;
  generalTerm: string;
  onOpen: () => void;
}) {
  const layout = category.layout_card || {};
  const dict = category.colunas_texto || {};

  const val = (col?: string | string[]): string => {
    if (!col || Array.isArray(col)) return "";
    const v = row[col];
    return v === null || v === undefined ? "" : String(v).trim();
  };
  const labelOf = (col: string) =>
    (dict[col] || col.replace(/_/g, " ")).replace(/_/g, " ");

  const valTopo = val(layout.topo_esq);
  const valTitulo = val(layout.titulo_grande) || val("numero_documento") || "—";
  const labelTopo = layout.topo_esq ? labelOf(layout.topo_esq) : "Documento";
  const labelTitulo = layout.titulo_grande ? labelOf(layout.titulo_grande) : "Credor";

  // Corpo (string ou lista de colunas)
  let corpoLabel = "Descrição";
  let corpoVal = "";
  if (Array.isArray(layout.corpo_texto)) {
    const partes: string[] = [];
    for (const c of layout.corpo_texto) {
      const v = val(c);
      if (v) partes.push(`${labelOf(c)}: ${v}`);
    }
    corpoVal = partes.join(" • ");
    corpoLabel = "Especificações";
  } else if (layout.corpo_texto) {
    corpoVal = val(layout.corpo_texto);
    corpoLabel = labelOf(layout.corpo_texto);
  } else {
    corpoVal = val("descricao_historico_empenho") || val("historico");
  }
  if (corpoVal.length > 220) corpoVal = corpoVal.slice(0, 220) + "…";

  // Metadados
  const metadados = (layout.metadados || []).filter((m) => val(m.coluna));
  const temMetaPadrao = metadados.length === 0;
  if (temMetaPadrao) {
    if (val("municipio_referencia"))
      metadados.push({
        tipo: "local",
        label: "Município",
        coluna: "municipio_referencia",
      });
    if (val("data_registro"))
      metadados.push({
        tipo: "data",
        label: "Emissão",
        coluna: "data_registro",
      });
  }

  const status = val("status_pagamento").toUpperCase();

  return (
    <div
      className="group flex h-full cursor-pointer flex-col rounded-xl border border-slate-800 border-l-4 border-l-emerald-500 bg-slate-900 p-5 transition-colors hover:border-emerald-600/50 hover:bg-slate-900/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={`Ver detalhes: ${category.name} — ${valTitulo}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {labelTopo}
          </span>
          <span className="rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-xs font-semibold text-slate-200">
            {valTopo || "N/A"}
          </span>
          {status && STATUS_STYLES[status] ? (
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${STATUS_STYLES[status]}`}
            >
              {status}
            </span>
          ) : null}
        </div>
        {row.match_reason ? (
          <Badge tone="warning" className="shrink-0">
            <Icon name="search" className="h-3.5 w-3.5" />
            {row.match_reason}
          </Badge>
        ) : null}
      </div>

      {/* título */}
      <div className="mt-3">
        <span className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
          {labelTitulo}
        </span>
        <p
          className="mt-0.5 line-clamp-2 text-base font-bold leading-snug text-slate-50"
          title={valTitulo}
        >
          <Highlight text={valTitulo} term={generalTerm} />
        </p>
      </div>

      {/* metadados */}
      <div className="mt-3 flex flex-wrap gap-2">
        {metadados.map((m) => {
          const raw = row[m.coluna];
          const tipo = (m.tipo || "texto").toLowerCase();
          const display =
            tipo === "data"
              ? fmtDate(raw)
              : tipo === "valor"
                ? brl(Number(raw))
                : String(raw ?? "").trim();
          if (!display) return null;
          return (
            <span
              key={m.coluna}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/70 px-2.5 py-1 text-xs text-slate-300"
            >
              <Icon
                name={META_ICONS[tipo] || "fileText"}
                className="h-3.5 w-3.5 shrink-0 text-slate-400"
              />
              <strong className="font-medium text-slate-200">{m.label}:</strong>{" "}
              <Highlight text={display} term={generalTerm} />
            </span>
          );
        })}
      </div>

      {/* corpo */}
      {corpoVal ? (
        <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-slate-300">
          <strong className="font-medium text-slate-200">{corpoLabel}:</strong>{" "}
          <Highlight text={corpoVal} term={generalTerm} />
        </p>
      ) : null}

      {/* rodapé (ancorado embaixo: cards da mesma linha alinham os valores) */}
      <div className="mt-auto pt-4">
        {layout.grid_financeiro && layout.grid_financeiro.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {layout.grid_financeiro.map((g) => {
              const raw = row[g.coluna];
              if (raw === null || raw === undefined || raw === "") return null;
              const num = Number(raw);
              if (Number.isNaN(num)) return null;
              const isQtd = /quantidade|qtd/i.test(g.coluna);
              const color = /pago|pagamento/i.test(g.coluna)
                ? "text-emerald-300"
                : /liquidado/i.test(g.coluna)
                  ? "text-sky-300"
                  : "text-slate-100";
              return (
                <div
                  key={g.coluna}
                  className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
                >
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {g.label_caixa}
                  </div>
                  <div
                    className={`mt-0.5 font-mono text-base font-bold tabular-nums ${color}`}
                  >
                    {isQtd ? num.toLocaleString("pt-BR") : brl(num)}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div
          className={cx(
            "flex items-center justify-end",
            layout.grid_financeiro && layout.grid_financeiro.length > 0
              ? "mt-3"
              : "",
          )}
        >
          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 transition-colors group-hover:text-emerald-300">
            Ver detalhes
            <Icon name="arrowRight" className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function Search() {
  const [config, setConfig] = useState<SearchConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);

  const [category, setCategory] = useState("");
  const [yearFrom, setYearFrom] = useState(2024);
  const [yearTo, setYearTo] = useState(2026);
  const [municipality, setMunicipality] = useState("all");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<{
    row: SearchRow;
    category: Category;
  } | null>(null);
  const [general, setGeneral] = useState("");
  const [supplier, setSupplier] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searched, setSearched] = useState(false);

  const [view, setView] = useState<ViewMode>("cards");
  const [visibleCount, setVisibleCount] = useState(CARD_STEP);
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");

  const errorRef = useRef<HTMLDivElement | null>(null);

  // Config (categorias, municípios, anos)
  const loadConfig = useCallback(async () => {
    setCfgError(null);
    try {
      const res = await fetch(`${API_URL}/api/search/config`);
      if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);
      const data = (await res.json()) as SearchConfig;
      setConfig(data);
      if (data.categories.length) setCategory(data.categories[0].name);
      const cur = new Date().getFullYear();
      setYearFrom(Math.max(2008, cur - 2));
      setYearTo(cur);
    } catch (e) {
      setCfgError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const cat: Category | undefined = useMemo(
    () => config?.categories.find((c) => c.name === category),
    [config, category],
  );

  // Motor híbrido de filtros (igual ao projeto original): campos_ui (selects)
  // + colunas_texto — cada coluna de texto vira um filtro "Digite X..."
  const camposEspecificos: CampoUI[] = useMemo(() => {
    if (!cat) return [];
    const textos: CampoUI[] = Object.entries(cat.colunas_texto || {}).map(
      ([id, label]) => ({
        id,
        label,
        tipo: "text" as const,
        placeholder: `Digite ${label.toLowerCase()}...`,
      }),
    );
    return [...(cat.campos_ui || []), ...textos];
  }, [cat]);

  const onCategoryChange = (name: string) => {
    setCategory(name);
    setFilters({});
    setResults(null);
    setSearched(false);
    setError(null);
    setShowAdvanced(false);
    setPage(1);
    setSortKey(null);
  };

  const execute = useCallback(async () => {
    if (!cat) return;
    if (yearFrom > yearTo) {
      setError("O ano inicial não pode ser maior que o ano final.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: cat.name,
          year_from: yearFrom,
          year_to: yearTo,
          municipality,
          filters,
          general_search: general,
          supplier_search: supplier,
          limit: 500,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || `Erro HTTP ${res.status}`);
      setResults(data as SearchResults);
      setSearched(true);
      setVisibleCount(CARD_STEP);
      setPage(1);
      setSortKey(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cat, yearFrom, yearTo, municipality, filters, general, supplier]);

  // Erros precisam ser encontráveis por teclado e leitores de tela.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const exportCSV = () => {
    if (!results) return;
    const cols = results.columns.filter((c) => c !== "match_reason");
    const esc = (v: unknown) =>
      `"${(v === null || v === undefined ? "" : String(v)).replace(/"/g, '""')}"`;
    const csv = [
      cols.join(";"),
      ...results.rows.map((r) => cols.map((c) => esc(r[c])).join(";")),
    ].join("\n");
    const blob = new Blob(["\uFEFF" + csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `TCE_${results.category.replace(/\s+/g, "_")}_${yearFrom}_${yearTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns = useMemo(
    () => (results?.columns || []).filter((c) => c !== "match_reason"),
    [results],
  );

  const sortedRows = useMemo(() => {
    if (!results) return [];
    if (!sortKey) return results.rows;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...results.rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const aEmpty = av === null || av === undefined || av === "";
      const bEmpty = bv === null || bv === undefined || bv === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      const an = Number(av);
      const bn = Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
      return (
        String(av).localeCompare(String(bv), "pt-BR", { numeric: true }) * dir
      );
    });
  }, [results, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedRows = sortedRows.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const activeFilterCount = Object.values(filters).filter(
    (v) => v && v !== "TODOS",
  ).length;
  const hasAnyFilter =
    activeFilterCount > 0 ||
    general.trim() !== "" ||
    supplier.trim() !== "" ||
    municipality !== "all";

  const clearFilters = () => {
    setFilters({});
    setGeneral("");
    setSupplier("");
    setMunicipality("all");
    setError(null);
  };

  const removeFilter = (id: string) => {
    setFilters((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const onSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(1);
  };

  // ---------- Estados de carga/erro da config ----------
  if (cfgError) {
    return (
      <div className="space-y-5">
        <PageHeader
          eyebrow="Consulta detalhada"
          title="Pesquisa"
          description="Filtre os documentos fiscais por categoria, período, município e campos específicos."
        />
        <ErrorState
          title="Falha ao carregar a configuração"
          message={cfgError}
          onRetry={() => void loadConfig()}
        />
      </div>
    );
  }

  if (!config || !cat) {
    return (
      <div className="space-y-5">
        <PageHeader
          eyebrow="Consulta detalhada"
          title="Pesquisa"
          description="Filtre os documentos fiscais por categoria, período, município e campos específicos."
        />
        <Card className="p-6">
          <div className="h-4 w-48 animate-pulse rounded bg-slate-800" />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <div
                key={i}
                className="h-11 animate-pulse rounded-lg bg-slate-800/70"
              />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  const municipalityName =
    config.municipalities.find((m) => m.code === municipality)?.name ||
    municipality;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Consulta detalhada"
        title="Pesquisa"
        description="Filtre os documentos fiscais por categoria, período, município e campos específicos. Os fluxos de bens, veículos e alocação seguem as mesmas categorias do TCE."
      />

      {/* ---------- Painel de filtros ---------- */}
      <Card className="p-5">
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Icon name="sliders" className="h-4 w-4 text-emerald-300" />
              Opções de filtro
            </span>
          }
          subtitle={`${camposEspecificos.length} filtros específicos disponíveis para ${cat.name}.`}
          actions={
            hasAnyFilter ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <Icon name="x" className="h-4 w-4" />
                Limpar filtros
              </Button>
            ) : null
          }
        />

        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void execute();
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field id="filtro-categoria" label="Tipo de documento">
              <select
                className={controlClass}
                value={category}
                onChange={(e) => onCategoryChange(e.target.value)}
              >
                {config.categories.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field id="filtro-ano-inicial" label="Ano inicial">
              <select
                className={controlClass}
                value={yearFrom}
                onChange={(e) => setYearFrom(Number(e.target.value))}
              >
                {config.years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </Field>

            <Field id="filtro-ano-final" label="Ano final">
              <select
                className={controlClass}
                value={yearTo}
                onChange={(e) => setYearTo(Number(e.target.value))}
              >
                {config.years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </Field>

            <Field id="filtro-municipio" label="Município">
              <select
                className={controlClass}
                value={municipality}
                onChange={(e) => setMunicipality(e.target.value)}
              >
                <option value="all">Todos</option>
                {config.municipalities.map((m) => (
                  <option key={`${m.code}-${m.name}`} value={m.code}>
                    {m.name} ({m.code})
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Campos dinâmicos da categoria (mantidos montados ao recolher) */}
          {camposEspecificos.length > 0 ? (
            <section className="mt-5 border-t border-slate-800 pt-4">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
                aria-controls="filtros-especificos"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg text-xs font-semibold uppercase tracking-wide text-slate-300 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <Icon
                  name="chevronDown"
                  className={cx(
                    "h-4 w-4 transition-transform",
                    showAdvanced ? "rotate-180" : "",
                  )}
                />
                Filtros específicos
                <Badge tone={activeFilterCount > 0 ? "accent" : "neutral"}>
                  {activeFilterCount > 0
                    ? `${activeFilterCount} ativo${activeFilterCount > 1 ? "s" : ""}`
                    : camposEspecificos.length}
                </Badge>
                <span className="normal-case tracking-normal text-slate-400">
                  — {cat.name}
                </span>
              </button>

              <div
                id="filtros-especificos"
                hidden={!showAdvanced}
                className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
              >
                {camposEspecificos.map((campo, index) => {
                  const fieldId = `filtro-${campo.id}-${index}`;
                  return (
                    <Field key={`${campo.id}-${index}`} id={fieldId} label={campo.label}>
                      {campo.tipo === "select" ? (
                        <select
                          className={controlClass}
                          value={filters[campo.id] ?? "TODOS"}
                          onChange={(e) => {
                            const value = e.target.value;
                            setFilters((f) => {
                              const next = { ...f };
                              if (value === "TODOS") delete next[campo.id];
                              else next[campo.id] = value;
                              return next;
                            });
                          }}
                        >
                          {(campo.opcoes || ["TODOS"]).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : campo.tipo === "number" ? (
                        <input
                          type="number"
                          className={controlClass}
                          value={filters[campo.id] ?? ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setFilters((f) => {
                              const next = { ...f };
                              if (value === "") delete next[campo.id];
                              else next[campo.id] = value;
                              return next;
                            });
                          }}
                        />
                      ) : (
                        <input
                          type="text"
                          placeholder={campo.placeholder || ""}
                          className={controlClass}
                          value={filters[campo.id] ?? ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setFilters((f) => {
                              const next = { ...f };
                              if (value === "") delete next[campo.id];
                              else next[campo.id] = value;
                              return next;
                            });
                          }}
                        />
                      )}
                    </Field>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* Busca geral + fornecedor */}
          <div className="mt-5 grid grid-cols-1 gap-4 border-t border-slate-800 pt-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
            <Field
              id="busca-geral"
              label="Busca geral"
              hint="Nº do empenho, histórico, contrato ou patrimônio."
            >
              <input
                type="text"
                placeholder="Nº empenho, histórico, contrato, patrimônio..."
                className={controlClass}
                value={general}
                onChange={(e) => setGeneral(e.target.value)}
              />
            </Field>

            <Field
              id="busca-fornecedor"
              label="Fornecedor / responsável"
              hint="CNPJ ou razão social; separe termos por vírgula."
            >
              <input
                type="text"
                placeholder="CNPJ, razão social..."
                className={controlClass}
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
              />
            </Field>

            <Button
              type="submit"
              variant="primary"
              loading={loading}
              className="w-full md:w-auto"
            >
              {!loading ? <Icon name="search" className="h-4 w-4" /> : null}
              {loading ? "Consultando…" : "Consultar"}
            </Button>
          </div>

          {/* Chips de filtros ativos */}
          {hasAnyFilter ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Ativos:
              </span>
              {general.trim() ? (
                <FilterChip
                  label={`Busca: ${general.trim()}`}
                  onRemove={() => setGeneral("")}
                />
              ) : null}
              {supplier.trim() ? (
                <FilterChip
                  label={`Fornecedor: ${supplier.trim()}`}
                  onRemove={() => setSupplier("")}
                />
              ) : null}
              {municipality !== "all" ? (
                <FilterChip
                  label={`Município: ${municipalityName}`}
                  onRemove={() => setMunicipality("all")}
                />
              ) : null}
              {Object.entries(filters).map(([id, value]) => {
                if (!value || value === "TODOS") return null;
                const campo = camposEspecificos.find((c) => c.id === id);
                return (
                  <FilterChip
                    key={id}
                    label={`${campo?.label || id}: ${value}`}
                    onRemove={() => removeFilter(id)}
                  />
                );
              })}
            </div>
          ) : null}
        </form>
      </Card>

      {/* ---------- Erro ---------- */}
      {error ? (
        <div
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="flex items-start gap-2 rounded-lg border border-rose-800 bg-rose-950/60 p-3 text-sm text-rose-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          <Icon
            name="alertTriangle"
            className="mt-0.5 h-4 w-4 shrink-0 text-rose-300"
          />
          <span>{error}</span>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className="sr-only">
        {loading
          ? "Consultando registros."
          : results
            ? `${results.count.toLocaleString("pt-BR")} registros encontrados.`
            : ""}
      </p>

      {/* ---------- Resultados ---------- */}
      {searched && results ? (
        <section className="space-y-4" aria-busy={loading}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-50">
                {results.category} — {yearFrom} a {yearTo}
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="accent">
                  <Icon name="fileText" className="h-3.5 w-3.5" />
                  {results.count.toLocaleString("pt-BR")}{" "}
                  {results.count === 1 ? "registro" : "registros"}
                </Badge>
                {municipality !== "all" ? (
                  <Badge tone="neutral">
                    <Icon name="mapPin" className="h-3.5 w-3.5" />
                    {municipalityName}
                  </Badge>
                ) : null}
                {results.source ? (
                  <Badge
                    tone={results.source === "parquet" ? "success" : "neutral"}
                  >
                    <Icon name="database" className="h-3.5 w-3.5" />
                    {results.source === "parquet"
                      ? "dados reais (parquet)"
                      : "amostra local"}
                  </Badge>
                ) : null}
                {results.fetched && results.fetched.length > 0 ? (
                  <Badge tone="info">
                    <Icon name="download" className="h-3.5 w-3.5" />
                    {results.fetched.length} recorte
                    {results.fetched.length > 1 ? "s" : ""} baixado
                    {results.fetched.length > 1 ? "s" : ""} da API do TCE
                  </Badge>
                ) : null}
                {results.fetch_error ? (
                  <Badge tone="warning">
                    <Icon name="alertTriangle" className="h-3.5 w-3.5" />
                    API do TCE indisponível — servindo dados locais
                  </Badge>
                ) : null}
                {!results.fetch_error && (results.fetch_pending || 0) > 0 ? (
                  <Badge tone="neutral">
                    <Icon name="refresh" className="h-3.5 w-3.5" />
                    {results.fetch_pending} recorte
                    {(results.fetch_pending || 0) > 1 ? "s" : ""} pendente
                    {(results.fetch_pending || 0) > 1 ? "s" : ""} — repita a
                    busca
                  </Badge>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Modo de visualização dos resultados"
                className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              >
                <button
                  type="button"
                  onClick={() => setView("cards")}
                  aria-pressed={view === "cards"}
                  className={cx(
                    "inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400",
                    view === "cards"
                      ? "bg-slate-800 text-slate-50"
                      : "text-slate-400 hover:text-slate-200",
                  )}
                >
                  <Icon name="layoutGrid" className="h-4 w-4" />
                  Cards
                </button>
                <button
                  type="button"
                  onClick={() => setView("table")}
                  aria-pressed={view === "table"}
                  className={cx(
                    "inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400",
                    view === "table"
                      ? "bg-slate-800 text-slate-50"
                      : "text-slate-400 hover:text-slate-200",
                  )}
                >
                  <Icon name="table" className="h-4 w-4" />
                  Tabela
                </button>
              </div>

              <Button
                variant="secondary"
                onClick={exportCSV}
                aria-label={`Exportar CSV com ${results.rows.length} linhas`}
              >
                <Icon name="download" className="h-4 w-4" />
                Exportar CSV
              </Button>
            </div>
          </div>

          {results.rows.length === 0 ? (
            <EmptyState
              icon="search"
              title="Nenhum registro encontrado"
              description="Ajuste os filtros ou amplie o período para ver outros documentos."
            />
          ) : view === "cards" ? (
            <>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {results.rows.slice(0, visibleCount).map((row, i) => (
                  <SearchCard
                    key={i}
                    row={row}
                    category={cat}
                    generalTerm={general.trim()}
                    onOpen={() => setDetail({ row, category: cat })}
                  />
                ))}
              </div>

              <div className="flex flex-col items-center gap-3">
                {visibleCount < results.rows.length ? (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setVisibleCount((n) =>
                        Math.min(n + CARD_STEP, results.rows.length),
                      )
                    }
                  >
                    Mostrar mais{" "}
                    {Math.min(CARD_STEP, results.rows.length - visibleCount)}{" "}
                    registros
                  </Button>
                ) : null}
                <p className="text-center text-xs text-slate-400">
                  Exibindo{" "}
                  {Math.min(visibleCount, results.rows.length).toLocaleString(
                    "pt-BR",
                  )}{" "}
                  de {results.rows.length.toLocaleString("pt-BR")} linhas
                  retornadas.
                  {results.count > results.rows.length
                    ? ` A consulta encontrou ${results.count.toLocaleString("pt-BR")} registros; refine os filtros para ver os demais.`
                    : ""}
                </p>
              </div>
            </>
          ) : (
            <>
              <TableShell className="max-h-[70vh] overflow-y-auto">
                <table className={tableClass}>
                  <caption className="sr-only">
                    Resultados de {results.category}, página {currentPage} de{" "}
                    {pageCount}
                  </caption>
                  <thead>
                    <tr>
                      {columns.map((c) => {
                        const isSorted = sortKey === c;
                        return (
                          <th
                            key={c}
                            scope="col"
                            aria-sort={
                              isSorted
                                ? sortDir === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                            }
                            className={cx(thClass, "sticky top-0 z-10")}
                          >
                            <button
                              type="button"
                              onClick={() => onSort(c)}
                              className="inline-flex items-center gap-1 rounded text-inherit transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                            >
                              {c.replace(/_/g, " ")}
                              <Icon
                                name="chevronDown"
                                className={cx(
                                  "h-3 w-3 transition-transform",
                                  isSorted && sortDir === "desc"
                                    ? "rotate-180"
                                    : "",
                                  !isSorted ? "opacity-40" : "",
                                )}
                              />
                            </button>
                          </th>
                        );
                      })}
                      <th scope="col" className={cx(thClass, "text-right")}>
                        Ação
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((row, i) => (
                      <tr
                        key={`${currentPage}-${i}`}
                        className="odd:bg-slate-950/30 hover:bg-emerald-500/5"
                      >
                        {columns.map((c) => {
                          const numeric =
                            NUMERIC_COLUMN.test(c) ||
                            typeof row[c] === "number";
                          return (
                            <td
                              key={c}
                              className={cx(
                                tdClass,
                                numeric
                                  ? "text-right font-mono tabular-nums"
                                  : "",
                              )}
                            >
                              {formatTableValue(c, row[c])}
                            </td>
                          );
                        })}
                        <td className={cx(tdClass, "text-right")}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setDetail({ row, category: cat })
                            }
                            aria-label={`Ver detalhes de ${
                              row[cat.layout_card?.titulo_grande || ""] ||
                              results.category
                            }`}
                          >
                            Detalhes
                            <Icon
                              name="arrowRight"
                              className="h-3.5 w-3.5"
                            />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-400" aria-live="polite">
                  Página {currentPage} de {pageCount} ·{" "}
                  {sortedRows.length.toLocaleString("pt-BR")} linhas
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage <= 1}
                  >
                    Anterior
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setPage((p) => Math.min(pageCount, p + 1))
                    }
                    disabled={currentPage >= pageCount}
                  >
                    Próxima
                  </Button>
                </div>
              </div>
            </>
          )}
        </section>
      ) : null}

      {/* ---------- Estado inicial ---------- */}
      {!searched && !error ? (
        <EmptyState
          icon="info"
          title="Defina os filtros e consulte"
          description="A pesquisa cobre os 21 tipos de documento do TCE. Ao consultar, você pode alternar entre cards e tabela e exportar o resultado em CSV."
        />
      ) : null}

      {/* ---------- Modal de detalhes ---------- */}
      {detail ? (
        <SearchDetailsModal
          row={detail.row}
          category={detail.category}
          yearFrom={yearFrom}
          municipality={municipality}
          onClose={() => setDetail(null)}
        />
      ) : null}
    </div>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex min-h-[36px] max-w-full items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 py-1 pl-3 pr-1 text-xs text-emerald-200">
      <span className="max-w-[16rem] truncate" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remover filtro ${label}`}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-emerald-200 transition-colors hover:bg-emerald-500/20 hover:text-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      >
        <Icon name="x" className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}
