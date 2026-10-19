"use client";

/**
 * SearchDetailsModal — modal de detalhes de um documento da Pesquisa.
 *
 * Port do details_modal.py (Streamlit) do projeto original, no tema escuro:
 *  - Informações principais (layout_card.metadados)
 *  - Informações de orçamento (órgão via API de detalhes)
 *  - Descrição dinâmica (layout_card.corpo_texto)
 *  - Relacionamentos de vínculos (POST /api/search/details -> motor relacional)
 *  - Todos os dados detalhados da linha
 *
 * O botão de dossiê em PDF (só em Notas de Empenho) ainda não foi portado.
 */

import React, { useEffect, useRef, useState } from "react";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:9001";

interface LayoutCard {
  topo_esq?: string;
  titulo_grande?: string;
  corpo_texto?: string | string[];
  metadados?: Array<{ tipo?: string; label: string; coluna: string }>;
  grid_financeiro?: Array<{ coluna: string; label_caixa: string }>;
}

interface ModalCategory {
  name: string;
  colunas_texto: Record<string, string>;
  layout_card: LayoutCard;
}

interface RelatedColumn {
  label: string;
  campo: string;
  tipo: string;
}

interface RelatedSection {
  titulo: string;
  sucesso: boolean;
  msg?: string;
  colunas_exibicao?: RelatedColumn[];
  rows?: Array<Record<string, unknown>>;
  total_rows?: number;
  truncated?: boolean;
  soma_total?: number;
}

interface DetailsResponse {
  category: string;
  nome_orgao: string;
  sections: RelatedSection[];
}

interface Props {
  row: Record<string, unknown>;
  category: ModalCategory;
  yearFrom: number;
  municipality: string;
  onClose: () => void;
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

const META_ICONS: Record<string, string> = {
  local: "📍",
  data: "📅",
  valor: "💰",
};

const val = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).trim();

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || String(v).trim() === "";

function formatMeta(v: unknown, tipo: string): string {
  if (isBlank(v)) return "";
  if (tipo === "data") return fmtDate(v);
  if (tipo === "valor") {
    const num = Number(v);
    return Number.isNaN(num) ? String(v) : brl(num);
  }
  return val(v);
}

function RelatedSectionView({ sec }: { sec: RelatedSection }) {
  const cols = sec.colunas_exibicao || [];
  const rows = sec.rows || [];

  return (
    <div className="rounded-xl bg-slate-950/40 border border-slate-800 p-4">
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">
        {sec.titulo}
      </h4>

      {!sec.sucesso ? (
        <p className="mt-2 text-xs text-slate-500">⚠️ {sec.msg}</p>
      ) : (
        <>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  {cols.map((c) => (
                    <th
                      key={c.campo}
                      className="px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500"
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={i}
                    className="border-b border-slate-800/60 last:border-0"
                  >
                    {cols.map((c) => {
                      const tipo = (c.tipo || "texto").toLowerCase();
                      const raw = r[c.campo];
                      const display =
                        tipo === "data"
                          ? fmtDate(raw)
                          : tipo === "moeda"
                            ? brl(Number(raw) || 0)
                            : val(raw);
                      return (
                        <td
                          key={c.campo}
                          className={`px-2 py-1.5 text-slate-300 ${
                            tipo === "moeda"
                              ? "text-right font-mono tabular-nums"
                              : ""
                          }`}
                        >
                          {display || "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(sec.total_rows || 0) > rows.length && (
            <p className="mt-1 text-[11px] text-slate-500">
              +{(sec.total_rows || 0) - rows.length} registros (mostrando os
              primeiros {rows.length})
            </p>
          )}

          {(sec.soma_total || 0) > 0 && (
            <p className="mt-2 text-xs text-slate-400">
              Soma Total:{" "}
              <strong className="text-emerald-400">
                {brl(sec.soma_total || 0)}
              </strong>
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function SearchDetailsModal({
  row,
  category,
  yearFrom,
  municipality,
  onClose,
}: Props) {
  const [data, setData] = useState<DetailsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc fecha + trava scroll do body
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Vínculos (relacionamentos do endpoints.json) — motor relacional no backend
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_URL}/api/search/details`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category: category.name,
            row,
            year_from: yearFrom,
            municipality,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.detail || `Erro HTTP ${res.status}`);
        if (alive) setData(json as DetailsResponse);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [category.name, row, yearFrom, municipality]);

  const layout = category.layout_card || {};
  const dict = category.colunas_texto || {};
  const labelOf = (col: string) =>
    (dict[col] || col.replace(/_/g, " ")).replace(/_/g, " ");

  const topoTituloCol = layout.topo_esq;
  const titulo = topoTituloCol ? val(row[topoTituloCol]) : "";
  const tituloGrandeCol = layout.titulo_grande;
  const tituloGrande = tituloGrandeCol ? val(row[tituloGrandeCol]) : "";
  const municipioNome = val(row["municipio_referencia"]) || "Não informado";
  const exercicio =
    String(row["exercicio_orcamento"] ?? "").slice(0, 4) || "—";
  const codOrgao = val(row["codigo_orgao"]);
  const codMun = val(row["codigo_municipio"]);
  const unidade = val(row["codigo_unidade_orcamentaria"]);

  const metadados = layout.metadados || [];

  // Descrição dinâmica (string ou lista de colunas)
  const corpoTexto = layout.corpo_texto;
  let descLabel = "Especificações / Detalhes";
  let descPartes: Array<{ label: string; value: string }> = [];
  if (Array.isArray(corpoTexto)) {
    descPartes = corpoTexto
      .filter((c) => !isBlank(row[c]))
      .map((c) => ({ label: labelOf(c), value: val(row[c]) }));
  } else if (corpoTexto && !isBlank(row[corpoTexto])) {
    descLabel = labelOf(corpoTexto);
    descPartes = [{ label: "", value: val(row[corpoTexto]) }];
  }

  // Todos os dados detalhados (sem chaves internas/vazias)
  const rawEntries = Object.entries(row).filter(([k, vv]) => {
    if (k === "match_reason" || k.startsWith("_")) return false;
    return !isBlank(vv);
  });

  const mostrarRelacionamentos =
    loading || !!error || (data?.sections.length ?? 0) > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Detalhes do documento"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl shadow-slate-950/80 focus:outline-none"
      >
        {/* Cabeçalho */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-800 bg-slate-900/95 px-5 py-4 backdrop-blur">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
              📋 Detalhes do Documento
            </p>
            <h2 className="mt-1 text-lg font-extrabold text-slate-100">
              {titulo ? `${category.name.toUpperCase()} — ${titulo}` : category.name.toUpperCase()}
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              📍 {municipioNome} — Exercício: {exercicio}
              {tituloGrande ? ` | ${tituloGrande}` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar detalhes"
            className="shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-sm text-slate-300 transition-colors hover:bg-slate-700 hover:text-slate-100"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* 2. Informações Principais */}
          {metadados.length > 0 && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
                📄 Informações Principais
              </h3>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {metadados.map((m) => {
                  const tipo = (m.tipo || "texto").toLowerCase();
                  const display = formatMeta(row[m.coluna], tipo);
                  return (
                    <div
                      key={m.coluna}
                      className="rounded-lg border border-slate-800 bg-slate-800/50 p-3"
                    >
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                        {META_ICONS[tipo] || "✏️"} {m.label}
                      </div>
                      <div
                        className={`mt-1 text-sm ${
                          display ? "text-slate-200" : "text-slate-500"
                        }`}
                      >
                        {display || "Não informado"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 3. Informações de Orçamento */}
          {codOrgao && codMun && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
                🏛️ Informações de Orçamento
              </h3>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-lg border border-slate-800 bg-slate-800/50 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                    Unidade Gestora
                  </div>
                  <div className="mt-1 text-sm text-slate-200">
                    {municipioNome} - U.O. {unidade || "—"}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-800/50 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                    Órgão
                  </div>
                  <div className="mt-1 text-sm text-slate-200">
                    <span className="font-mono text-slate-400">{codOrgao}</span>
                    {" — "}
                    {loading
                      ? "…"
                      : data?.nome_orgao || "Não identificado"}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* 4. Descrição dinâmica */}
          {descPartes.length > 0 && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
                📜 {descLabel}
              </h3>
              <div className="mt-2 rounded-lg border-l-2 border-emerald-500/60 bg-slate-800/50 p-3 text-sm leading-relaxed text-slate-300">
                {descPartes.map((p, i) => (
                  <span key={i}>
                    {i > 0 && " — "}
                    {p.label && (
                      <strong className="text-slate-200">{p.label}: </strong>
                    )}
                    {p.value}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* 5. Relacionamentos de Vínculos */}
          {mostrarRelacionamentos && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
                📊 Relacionamentos de Vínculos
              </h3>
              <div className="mt-2 space-y-3">
                {loading && (
                  <p className="animate-pulse text-sm text-slate-500">
                    Carregando vínculos…
                  </p>
                )}
                {error && (
                  <div className="rounded-lg border border-rose-800 bg-rose-950/60 p-3 text-sm text-rose-200">
                    Não foi possível carregar os vínculos: {error}
                  </div>
                )}
                {data?.sections.map((sec) => (
                  <RelatedSectionView key={sec.titulo} sec={sec} />
                ))}
              </div>
            </section>
          )}

          {/* 6. Todos os dados detalhados */}
          {rawEntries.length > 0 && (
            <details className="rounded-xl border border-slate-800 bg-slate-950/40">
              <summary className="cursor-pointer select-none px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 transition-colors hover:text-slate-300">
                🛠️ Ver Todos os Dados Detalhados
              </summary>
              <div className="border-t border-slate-800 p-3">
                <table className="w-full text-sm">
                  <tbody>
                    {rawEntries.map(([k, vv]) => {
                      const friendly =
                        dict[k] || k.replace(/_/g, " ");
                      const lower = k.toLowerCase();
                      const display =
                        lower.includes("valor") && typeof vv === "number"
                          ? brl(vv)
                          : lower.includes("data")
                            ? fmtDate(vv)
                            : String(vv);
                      return (
                        <tr
                          key={k}
                          className="border-b border-slate-800/60 last:border-0"
                        >
                          <td className="w-1/3 px-2 py-1.5 font-semibold text-slate-500">
                            {friendly}
                          </td>
                          <td className="px-2 py-1.5 text-slate-300">
                            {display}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
