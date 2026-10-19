"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";

/**
 * Pesquisa Interativa — espelho da "Consulta Detalhada" do painel original.
 *
 * - Filtros: categoria (endpoints.json), período, município, campos dinâmicos
 * - Busca geral (com match_reason) e fornecedor (CNPJ/razão social)
 * - Cards dinâmicos (layout_card) + export CSV
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
          <mark key={i} className="bg-yellow-300 text-slate-950 rounded-sm px-0.5">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

const STATUS_STYLES: Record<string, string> = {
  PAGO: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
  PARCIAL: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  PENDENTE: "bg-rose-500/15 text-rose-400 border border-rose-500/30",
};

const META_ICONS: Record<string, string> = {
  local: "📍",
  data: "📅",
  valor: "💰",
};

// ---------------------------------------------------------------------------
// Card dinâmico (fiel ao dynamic_card.py original, no tema escuro)
// ---------------------------------------------------------------------------
function SearchCard({
  row,
  category,
  generalTerm,
}: {
  row: SearchRow;
  category: Category;
  generalTerm: string;
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
      metadados.push({ tipo: "local", label: "Município", coluna: "municipio_referencia" });
    if (val("data_registro"))
      metadados.push({ tipo: "data", label: "Emissão", coluna: "data_registro" });
  }

  const status = val("status_pagamento").toUpperCase();

  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 border-l-4 border-l-emerald-500 p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-900/60">
      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
          {labelTopo.toUpperCase()}: {valTopo || "N/A"}{" "}
          {status && STATUS_STYLES[status] && (
            <span
              className={`ml-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_STYLES[status]}`}
            >
              {status}
            </span>
          )}
        </div>
        {row.match_reason && (
          <span className="shrink-0 rounded-full bg-yellow-300/90 px-2 py-0.5 text-[10px] font-bold uppercase text-yellow-950">
            🔍 {row.match_reason}
          </span>
        )}
      </div>

      {/* título */}
      <div className="mt-1.5">
        <span className="block text-[11px] font-semibold uppercase text-slate-500">
          {labelTitulo}
        </span>
        <p className="text-lg font-extrabold text-slate-100">
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
              className="inline-flex items-center gap-1 rounded-lg bg-slate-800/70 border border-slate-700/60 px-2.5 py-1 text-xs text-slate-300"
            >
              {META_ICONS[tipo] || "✏️"} <strong className="text-slate-200">{m.label}:</strong>{" "}
              <Highlight text={display} term={generalTerm} />
            </span>
          );
        })}
      </div>

      {/* corpo */}
      {corpoVal && (
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          <strong className="text-slate-300">{corpoLabel}:</strong>{" "}
          <Highlight text={corpoVal} term={generalTerm} />
        </p>
      )}

      {/* grid financeiro */}
      {layout.grid_financeiro && layout.grid_financeiro.length > 0 && (
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {layout.grid_financeiro.map((g) => {
            const raw = row[g.coluna];
            if (raw === null || raw === undefined || raw === "") return null;
            const num = Number(raw);
            if (Number.isNaN(num)) return null;
            const isQtd = /quantidade|qtd/i.test(g.coluna);
            const color = /pago|pagamento/i.test(g.coluna)
              ? "text-emerald-400"
              : /liquidado/i.test(g.coluna)
                ? "text-sky-400"
                : "text-slate-100";
            return (
              <div
                key={g.coluna}
                className="rounded-lg bg-slate-950/70 border border-slate-800 p-3 text-center"
              >
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                  {g.label_caixa}
                </div>
                <div className={`mt-1 font-mono text-base font-extrabold tabular-nums ${color}`}>
                  {isQtd ? num.toLocaleString("pt-BR") : brl(num)}
                </div>
              </div>
            );
          })}
        </div>
      )}
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
  const [general, setGeneral] = useState("");
  const [supplier, setSupplier] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searched, setSearched] = useState(false);

  // Config (categorias, municípios, anos)
  useEffect(() => {
    (async () => {
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
    })();
  }, []);

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
        label: `🏷️ ${label}`,
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cat, yearFrom, yearTo, municipality, filters, general, supplier]);

  const exportCSV = () => {
    if (!results) return;
    const cols = results.columns.filter((c) => c !== "match_reason");
    const esc = (v: unknown) => `"${(v === null || v === undefined ? "" : String(v)).replace(/"/g, '""')}"`;
    const csv = [
      cols.join(";"),
      ...results.rows.map((r) => cols.map((c) => esc(r[c])).join(";")),
    ].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `TCE_${results.category.replace(/\s+/g, "_")}_${yearFrom}_${yearTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---------- Estados de carga/erro da config ----------
  if (cfgError) {
    return (
      <div className="rounded-xl bg-rose-950 border border-rose-800 p-6 text-center">
        <p className="text-rose-200 font-medium">Falha ao carregar a configuração</p>
        <p className="text-rose-400 text-sm mt-1">{cfgError}</p>
      </div>
    );
  }
  if (!config || !cat) {
    return (
      <div className="rounded-xl bg-slate-900 border border-slate-800 p-6 animate-pulse">
        <div className="h-4 w-48 bg-slate-800 rounded" />
      </div>
    );
  }

  const selectCls =
    "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-600/50";
  const labelCls = "block text-xs font-medium text-slate-400 mb-1";

  return (
    <div className="space-y-4">
      {/* ---------- Painel de filtros ---------- */}
      <section className="rounded-xl bg-slate-900 border border-slate-800 p-5">
        <h2 className="text-sm font-semibold text-slate-200 mb-4">
          🔍 Opções de Filtro
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <div>
            <label className={labelCls}>Tipo de Documento</label>
            <select
              className={selectCls}
              value={category}
              onChange={(e) => onCategoryChange(e.target.value)}
            >
              {config.categories.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Ano Inicial</label>
            <select
              className={selectCls}
              value={yearFrom}
              onChange={(e) => setYearFrom(Number(e.target.value))}
            >
              {config.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Ano Final</label>
            <select
              className={selectCls}
              value={yearTo}
              onChange={(e) => setYearTo(Number(e.target.value))}
            >
              {config.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Município</label>
            <select
              className={selectCls}
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
          </div>
        </div>

        {/* Campos dinâmicos da categoria (campos_ui + colunas_texto, como o original) */}
        {camposEspecificos.length > 0 && (
          <>
            <p className="text-xs text-slate-500 mt-4 mb-2">
              🎯 Filtros específicos para: <strong className="text-slate-400">{cat.name}</strong>
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {camposEspecificos.map((campo) => (
                <div key={campo.id}>
                  <label className={labelCls}>{campo.label}</label>
                  {campo.tipo === "select" ? (
                    <select
                      className={selectCls}
                      value={filters[campo.id] ?? "TODOS"}
                      onChange={(e) =>
                        setFilters((f) => ({ ...f, [campo.id]: e.target.value }))
                      }
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
                      className={selectCls}
                      value={filters[campo.id] ?? ""}
                      onChange={(e) =>
                        setFilters((f) => ({ ...f, [campo.id]: e.target.value }))
                      }
                    />
                  ) : (
                    <input
                      type="text"
                      placeholder={campo.placeholder || ""}
                      className={selectCls}
                      value={filters[campo.id] ?? ""}
                      onChange={(e) =>
                        setFilters((f) => ({ ...f, [campo.id]: e.target.value }))
                      }
                    />
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Busca geral + fornecedor + botão */}
        <div className="grid grid-cols-1 md:grid-cols-[2fr_2fr_auto] gap-4 mt-4 items-end">
          <div>
            <label className={labelCls}>Busca Geral</label>
            <input
              type="text"
              placeholder="Nº empenho, histórico, contrato, patrimônio..."
              className={selectCls}
              value={general}
              onChange={(e) => setGeneral(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && execute()}
            />
          </div>
          <div>
            <label className={labelCls}>Fornecedor / Responsável</label>
            <input
              type="text"
              placeholder="CNPJ, Razão Social (separe termos por vírgula)..."
              className={selectCls}
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && execute()}
            />
          </div>
          <button
            onClick={execute}
            disabled={loading}
            className="px-6 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold transition-colors"
          >
            {loading ? "Consultando…" : "🔍 Consultar"}
          </button>
        </div>
      </section>

      {/* ---------- Erro ---------- */}
      {error && (
        <div className="rounded-lg bg-rose-950 border border-rose-800 text-rose-200 p-3 text-sm">
          ✖ {error}
        </div>
      )}

      {/* ---------- Resultados ---------- */}
      {searched && results && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-100 uppercase">
                Lista de {results.category} — {yearFrom} a {yearTo}
              </h2>
              <p className="text-sm text-slate-400 mt-0.5">
                Foram encontrados{" "}
                <strong className="text-emerald-400">
                  {results.count.toLocaleString("pt-BR")}
                </strong>{" "}
                registros.
                {municipality !== "all" &&
                  ` • Município: ${config.municipalities.find((m) => m.code === municipality)?.name || ""}`}
                {results.source && (
                  <>
                    {" • "}
                    <span
                      className={
                        results.source === "parquet"
                          ? "text-emerald-500/80"
                          : "text-slate-500"
                      }
                    >
                      {results.source === "parquet"
                        ? "dados reais (parquet)"
                        : "amostra local"}
                    </span>
                  </>
                )}
                {results.fetched && results.fetched.length > 0 && (
                  <>
                    {" • "}
                    <span className="text-sky-400/80">
                      {results.fetched.length} recorte
                      {results.fetched.length > 1 ? "s" : ""} baixado
                      {results.fetched.length > 1 ? "s" : ""} da API do TCE
                    </span>
                  </>
                )}
                {results.fetch_error && (
                  <>
                    {" • "}
                    <span className="text-amber-500/80">
                      API do TCE indisponível — servindo dados locais
                    </span>
                  </>
                )}
                {!results.fetch_error &&
                  (results.fetch_pending || 0) > 0 && (
                    <>
                      {" • "}
                      <span className="text-slate-500">
                        {results.fetch_pending} recorte
                        {(results.fetch_pending || 0) > 1 ? "s" : ""} pendente
                        {(results.fetch_pending || 0) > 1 ? "s" : ""} — repita a
                        busca para continuar
                      </span>
                    </>
                  )}
              </p>
            </div>
            <button
              onClick={exportCSV}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm font-medium"
            >
              📥 Exportar CSV ({results.rows.length.toLocaleString("pt-BR")} linhas)
            </button>
          </div>

          {results.rows.length === 0 ? (
            <div className="rounded-xl bg-slate-900 border border-slate-800 p-8 text-center text-slate-500 text-sm">
              Nenhum registro encontrado para os filtros aplicados.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {results.rows.slice(0, 20).map((row, i) => (
                  <SearchCard
                    key={i}
                    row={row}
                    category={cat}
                    generalTerm={general.trim()}
                  />
                ))}
              </div>
              {results.count > results.rows.length && (
                <p className="text-xs text-slate-500 text-center">
                  Exibindo {results.rows.length} de {results.count} registros (limite da
                  consulta). Refine os filtros para ver os demais.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {/* ---------- Estado inicial ---------- */}
      {!searched && !error && (
        <p className="text-xs text-slate-600 text-center py-6">
          Selecione os filtros e clique em <strong>Consultar</strong> para pesquisar nos 21
          tipos de documento.
        </p>
      )}
    </div>
  );
}
