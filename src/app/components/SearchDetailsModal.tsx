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
 * O endpoint e o payload permanecem inalterados.
 */

import React, { useEffect, useId, useState } from "react";
import { Icon, IconName } from "./ui/Icon";
import { Modal } from "./ui/Modal";
import {
  TableShell,
  tableClass,
  tdClass,
  thClass,
} from "./ui/Table";
import { cx } from "./ui/cx";

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

const META_ICONS: Record<string, IconName> = {
  local: "mapPin",
  data: "calendar",
  valor: "coins",
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
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {sec.titulo}
      </h4>

      {!sec.sucesso ? (
        <p className="mt-2 flex items-start gap-2 text-xs text-slate-300">
          <Icon
            name="alertTriangle"
            className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300"
          />
          {sec.msg}
        </p>
      ) : (
        <>
          <TableShell className="mt-2">
            <table className={tableClass}>
              <caption className="sr-only">
                {sec.titulo}: {rows.length} registro
                {rows.length === 1 ? "" : "s"} exibido
                {rows.length === 1 ? "" : "s"}
              </caption>
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c.campo} scope="col" className={thClass}>
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
                          className={cx(
                            tdClass,
                            tipo === "moeda"
                              ? "text-right font-mono tabular-nums"
                              : "",
                          )}
                        >
                          {display || "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>

          {(sec.total_rows || 0) > rows.length ? (
            <p className="mt-1 text-xs text-slate-400">
              +{(sec.total_rows || 0) - rows.length} registros (mostrando os
              primeiros {rows.length})
            </p>
          ) : null}

          {(sec.soma_total || 0) > 0 ? (
            <p className="mt-2 text-xs text-slate-300">
              Soma total:{" "}
              <strong className="font-semibold text-emerald-300">
                {brl(sec.soma_total || 0)}
              </strong>
            </p>
          ) : null}
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
  const titleId = useId();

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
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      className="max-w-5xl"
    >
      {/* Cabeçalho */}
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-800 bg-slate-900/95 px-5 py-4 backdrop-blur">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <Icon name="fileText" className="h-3.5 w-3.5" />
            Detalhes do documento
          </p>
          <h2
            id={titleId}
            className="mt-1 break-words text-lg font-bold text-slate-50"
          >
            {titulo
              ? `${category.name.toUpperCase()} — ${titulo}`
              : category.name.toUpperCase()}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-300">
            <span className="inline-flex items-center gap-1">
              <Icon name="mapPin" className="h-3.5 w-3.5" />
              {municipioNome}
            </span>
            <span className="text-slate-500" aria-hidden>
              ·
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="calendar" className="h-3.5 w-3.5" />
              Exercício: {exercicio}
            </span>
            {tituloGrande ? (
              <>
                <span className="text-slate-500" aria-hidden>
                  ·
                </span>
                <span>{tituloGrande}</span>
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar detalhes"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-300 transition-colors hover:bg-slate-700 hover:text-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <Icon name="x" className="h-5 w-5" />
        </button>
      </div>

      <div className="space-y-5 p-5">
        {/* Informações Principais */}
        {metadados.length > 0 ? (
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <Icon name="fileText" className="h-3.5 w-3.5" />
              Informações principais
            </h3>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {metadados.map((m) => {
                const tipo = (m.tipo || "texto").toLowerCase();
                const display = formatMeta(row[m.coluna], tipo);
                return (
                  <div
                    key={m.coluna}
                    className="rounded-lg border border-slate-800 bg-slate-800/50 p-3"
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      <Icon
                        name={META_ICONS[tipo] || "fileText"}
                        className="h-3.5 w-3.5"
                      />
                      {m.label}
                    </div>
                    <div
                      className={cx(
                        "mt-1 text-sm",
                        display ? "text-slate-200" : "text-slate-400",
                      )}
                    >
                      {display || "Não informado"}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* Informações de Orçamento */}
        {codOrgao && codMun ? (
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <Icon name="landmark" className="h-3.5 w-3.5" />
              Informações de orçamento
            </h3>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-slate-800/50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Unidade gestora
                </div>
                <div className="mt-1 text-sm text-slate-200">
                  {municipioNome} - U.O. {unidade || "—"}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-800/50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Órgão
                </div>
                <div className="mt-1 text-sm text-slate-200">
                  <span className="font-mono text-slate-300">{codOrgao}</span>
                  {" — "}
                  {loading ? "…" : data?.nome_orgao || "Não identificado"}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {/* Descrição dinâmica */}
        {descPartes.length > 0 ? (
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <Icon name="fileText" className="h-3.5 w-3.5" />
              {descLabel}
            </h3>
            <div className="mt-2 rounded-lg border-l-2 border-emerald-500/60 bg-slate-800/50 p-3 text-sm leading-relaxed text-slate-300">
              {descPartes.map((p, i) => (
                <span key={i}>
                  {i > 0 ? " — " : null}
                  {p.label ? (
                    <strong className="font-medium text-slate-200">
                      {p.label}:{" "}
                    </strong>
                  ) : null}
                  {p.value}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {/* Relacionamentos de Vínculos */}
        {mostrarRelacionamentos ? (
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <Icon name="barChart" className="h-3.5 w-3.5" />
              Relacionamentos de vínculos
            </h3>
            <div className="mt-2 space-y-3">
              {loading ? (
                <p
                  role="status"
                  className="flex items-center gap-2 text-sm text-slate-300"
                >
                  <Icon
                    name="loader"
                    className="h-4 w-4 animate-spin text-emerald-300"
                  />
                  Carregando vínculos…
                </p>
              ) : null}
              {error ? (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-rose-800 bg-rose-950/60 p-3 text-sm text-rose-200"
                >
                  <Icon
                    name="alertTriangle"
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                  Não foi possível carregar os vínculos: {error}
                </div>
              ) : null}
              {data?.sections.map((sec) => (
                <RelatedSectionView key={sec.titulo} sec={sec} />
              ))}
            </div>
          </section>
        ) : null}

        {/* Todos os dados detalhados */}
        {rawEntries.length > 0 ? (
          <details className="rounded-xl border border-slate-800 bg-slate-950/40">
            <summary className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 transition-colors hover:text-slate-200">
              <Icon name="database" className="h-3.5 w-3.5" />
              Ver todos os dados detalhados
            </summary>
            <div className="border-t border-slate-800 p-3">
              <TableShell>
                <table className={tableClass}>
                  <caption className="sr-only">
                    Todos os campos disponíveis para este documento
                  </caption>
                  <tbody>
                    {rawEntries.map(([k, vv]) => {
                      const friendly = dict[k] || k.replace(/_/g, " ");
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
                          <th
                            scope="row"
                            className="w-1/3 px-3 py-2 text-left text-sm font-medium text-slate-400"
                          >
                            {friendly}
                          </th>
                          <td className={tdClass}>{display}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableShell>
            </div>
          </details>
        ) : null}
      </div>
    </Modal>
  );
}
