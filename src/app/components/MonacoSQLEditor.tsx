"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { useSavedQueries } from "../hooks/useSavedQueries";
import { Button } from "./ui/Button";
import { Card, CardHeader } from "./ui/Card";
import { Field, controlClass } from "./ui/Field";
import { Icon } from "./ui/Icon";
import { PageHeader } from "./ui/PageHeader";
import {
  TableShell,
  tableClass,
  tdClass,
  thClass,
} from "./ui/Table";
import { cx } from "./ui/cx";
import { getApiUrl } from "../lib/api";

/**
 * SQL Studio — Monaco Editor + FastAPI backend
 *
 * Features (Spec 001):
 * - FR-001: SQL syntax highlight (Monaco)
 * - FR-002: autocomplete contextual do catálogo (tabelas/colunas)
 * - FR-003: execução contra DuckDB com grade de resultados
 * - FR-004: Ctrl+Enter (Cmd+Enter no Mac) executa
 * - FR-005/006: guardrails — apenas SELECT/WITH, uma statement por execução
 * - FR-007: duração + contagem de linhas
 * - FR-008: export CSV
 * - FR-009: histórico local das últimas execuções
 * - FR-012/013: timeout 30s, limite 5000 linhas com aviso de truncamento
 *
 * O endpoint, os guardrails e o payload permanecem inalterados.
 */

const PAGE_SIZE = 50;

interface QueryResult {
  success: boolean;
  data: Array<Record<string, unknown>> | null;
  columns: string[] | null;
  row_count: number | null;
  execution_time: number | null;
  truncated: boolean;
  error: string | null;
}

interface Catalog {
  tables: string[];
  views: string[];
  columns: Record<string, string[]>;
}

export default function MonacoSQLEditor() {
  const { queries: savedQueries, addQuery, removeQuery } = useSavedQueries();

  const [value, setValue] = useState(
    "-- SQL Studio — TCE-CE\n-- Ctrl+Enter executa (apenas SELECT/WITH)\nSELECT * FROM notas_empenho LIMIT 10;\n",
  );
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [history, setHistory] = useState<
    Array<{ sql: string; at: string; ok: boolean; duration?: number | null }>
  >([]);
  const [saveName, setSaveName] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [page, setPage] = useState(0);

  const editorRef = useRef<unknown>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  // ---- Catálogo (FR-002) ----
  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/api/sql/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = (await res.json()) as Catalog;
        setCatalog(data);
      }
    } catch {
      // catálogo indisponível — autocomplete fica vazio
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  // ---- Execução (FR-003, FR-004, FR-005, FR-006) ----
  const executeQuery = useCallback(async () => {
    const editor = editorRef.current as
      | { getValue: () => string; getModel: () => unknown }
      | null;
    if (!editor) return;

    const sql = editor.getValue().trim();
    if (!sql) return;

    setLoading(true);
    setErrorMsg(null);
    setResult(null);
    setPage(0);

    const startedAt = new Date();
    try {
      const res = await fetch(`${getApiUrl()}/api/sql/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, max_rows: 5000, timeout: 30 }),
      });

      const data = (await res.json()) as QueryResult | { detail?: string };

      if (!res.ok) {
        const detail =
          (data as { detail?: string }).detail || `Erro HTTP ${res.status}`;
        setErrorMsg(detail);
        setHistory((h) =>
          [
            { sql, at: startedAt.toLocaleTimeString(), ok: false },
            ...h,
          ].slice(0, 50),
        );
        return;
      }

      const qr = data as QueryResult;
      if (!qr.success) {
        setErrorMsg(qr.error || "Erro desconhecido na execução");
        setHistory((h) =>
          [
            { sql, at: startedAt.toLocaleTimeString(), ok: false },
            ...h,
          ].slice(0, 50),
        );
        return;
      }

      setResult(qr);
      setHistory((h) =>
        [
          {
            sql,
            at: startedAt.toLocaleTimeString(),
            ok: true,
            duration: qr.execution_time,
          },
          ...h,
        ].slice(0, 50),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Falha de conexão: ${msg}`);
      setHistory((h) =>
        [
          { sql, at: startedAt.toLocaleTimeString(), ok: false },
          ...h,
        ].slice(0, 50),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Erros precisam ser encontráveis por teclado e leitores de tela.
  useEffect(() => {
    if (errorMsg) errorRef.current?.focus();
  }, [errorMsg]);

  // ---- Ctrl+Enter / Cmd+Enter (FR-004) ----
  const handleEditorMount = useCallback(
    (editor: unknown) => {
      editorRef.current = editor;
      const ed = editor as {
        addCommand: (keybinding: number, handler: () => void) => void;
        getValue: () => string;
      };
      // KeyMod.CtrlCmd | KeyCode.Enter
      ed.addCommand(2048 | 3, () => {
        executeQuery();
      });
    },
    [executeQuery],
  );

  // ---- Autocomplete contextual (FR-002) ----
  const handleBeforeMount = useCallback(
    (monaco: any) => {
      monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: [" ", ".", ","],
        provideCompletionItems: (model: any, position: any) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          const suggestions: any[] = [];

          if (catalog) {
            for (const t of [...catalog.tables, ...catalog.views]) {
              suggestions.push({
                label: t,
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: t,
                detail: catalog.views.includes(t) ? "view" : "tabela",
                range,
              });
            }
            for (const [table, cols] of Object.entries(catalog.columns)) {
              for (const col of cols) {
                suggestions.push({
                  label: `${table}.${col}`,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: `${table}.${col}`,
                  detail: `coluna de ${table}`,
                  range,
                });
              }
            }
          }
          // Keywords básicas se catálogo vazio
          if (!catalog || suggestions.length === 0) {
            for (const kw of [
              "SELECT",
              "FROM",
              "WHERE",
              "GROUP BY",
              "ORDER BY",
              "LIMIT",
              "JOIN",
              "WITH",
            ]) {
              suggestions.push({
                label: kw,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: kw,
                range,
              });
            }
          }
          return { suggestions };
        },
      });
    },
    [catalog],
  );

  // ---- Export CSV (FR-008) ----
  const exportCSV = () => {
    if (!result?.data || !result.columns) return;
    const header = result.columns.join(",");
    const rows = result.data.map((row) =>
      result
        .columns!.map((c) => {
          const v = row[c];
          const s = v === null || v === undefined ? "" : String(v);
          return `"${s.replace(/"/g, '""')}"`;
        })
        .join(","),
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob(["\uFEFF" + csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sql-result-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---- Salvar query (FR-010) ----
  const handleSave = () => {
    if (!saveName.trim()) {
      setErrorMsg("Dê um nome para salvar a query.");
      return;
    }
    addQuery(saveName.trim(), value);
    setSaveName("");
    setErrorMsg(null);
  };

  const rows = result?.data ?? [];
  const columns = result?.columns ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedRows = rows.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Análise"
        title="SQL Studio"
        description="Editor SQL com guardrails de leitura. Ctrl+Enter executa."
        actions={
          <Button
            variant="primary"
            onClick={() => void executeQuery()}
            loading={loading}
          >
            {!loading ? <Icon name="play" className="h-4 w-4" /> : null}
            {loading ? "Executando…" : "Executar"}
          </Button>
        }
      />

      {/* Painéis laterais + editor */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <aside className="order-2 space-y-3 lg:order-1">
          <Card className="p-4">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <Icon name="save" className="h-4 w-4 text-emerald-300" />
                  Queries salvas
                </span>
              }
              subtitle="Armazenadas neste navegador."
            />
            {savedQueries.length === 0 ? (
              <p className="mt-3 text-xs text-slate-400">Nenhuma ainda.</p>
            ) : (
              <ul className="mt-3 space-y-1">
                {savedQueries.map((q) => (
                  <li key={q.name} className="flex items-center gap-1">
                    <button
                      type="button"
                      className="min-h-[36px] min-w-0 flex-1 truncate rounded px-1 text-left text-sm text-emerald-300 transition-colors hover:bg-slate-800 hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      onClick={() => setValue(q.sql)}
                      title={q.sql}
                    >
                      {q.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-slate-400 hover:text-rose-300"
                      onClick={() => removeQuery(q.name)}
                      aria-label={`Excluir query salva ${q.name}`}
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 space-y-2">
              <Field id="nome-query" label="Nome da query">
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="ex.: empenhos 2025"
                  className={controlClass}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSave();
                    }
                  }}
                />
              </Field>
              <Button
                variant="secondary"
                onClick={handleSave}
                className="w-full"
              >
                <Icon name="save" className="h-4 w-4" />
                Salvar query
              </Button>
            </div>
          </Card>

          <Card className="p-4">
            <button
              type="button"
              onClick={() => setShowHistory((s) => !s)}
              aria-expanded={showHistory}
              aria-controls="historico-execucoes"
              className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded text-sm font-semibold text-slate-200 transition-colors hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <span className="inline-flex items-center gap-2">
                <Icon name="history" className="h-4 w-4 text-emerald-300" />
                Histórico ({history.length})
              </span>
              <Icon
                name="chevronDown"
                className={cx(
                  "h-4 w-4 transition-transform",
                  showHistory ? "rotate-180" : "",
                )}
              />
            </button>
            {showHistory ? (
              <ul
                id="historico-execucoes"
                className="mt-2 max-h-60 space-y-1 overflow-auto"
              >
                {history.map((h, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className={cx(
                        "min-h-[36px] w-full truncate rounded px-1 text-left text-xs transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400",
                        h.ok ? "text-slate-300" : "text-rose-300",
                      )}
                      onClick={() => setValue(h.sql)}
                      title={h.sql}
                    >
                      [{h.at}
                      {h.duration != null ? ` · ${h.duration}s` : ""}]{" "}
                      {h.sql.slice(0, 40)}
                      {h.sql.length > 40 ? "…" : ""}
                    </button>
                  </li>
                ))}
                {history.length === 0 ? (
                  <li className="text-xs text-slate-400">Sem execuções.</li>
                ) : null}
              </ul>
            ) : null}
          </Card>
        </aside>

        {/* Editor + Resultados */}
        <div className="order-1 space-y-4 lg:order-2 lg:col-span-3">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5">
              <p className="text-xs font-medium text-slate-300">
                Editor SQL
                <span className="ml-2 text-slate-500">
                  somente leitura · 1 statement
                </span>
              </p>
              <kbd className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                Ctrl + Enter
              </kbd>
            </div>
            <Editor
              height="360px"
              defaultLanguage="sql"
              theme="vs-dark"
              value={value}
              onChange={(v) => setValue(v ?? "")}
              onMount={handleEditorMount}
              beforeMount={handleBeforeMount}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                quickSuggestions: true,
                suggestOnTriggerCharacters: true,
                padding: { top: 8, bottom: 8 },
              }}
            />
          </Card>

          {errorMsg ? (
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
              <span>{errorMsg}</span>
            </div>
          ) : null}

          {result ? (
            <div className="space-y-2" aria-busy={loading}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div
                  role="status"
                  aria-live="polite"
                  className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-300"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="table" className="h-4 w-4 text-slate-400" />
                    {result.row_count ?? 0} linhas
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="history" className="h-4 w-4 text-slate-400" />
                    {result.execution_time ?? 0}s
                  </span>
                  {result.truncated ? (
                    <span className="inline-flex items-center gap-1.5 text-amber-300">
                      <Icon name="alertTriangle" className="h-4 w-4" />
                      Truncado em 5000 linhas
                    </span>
                  ) : null}
                </div>
                <Button variant="secondary" size="sm" onClick={exportCSV}>
                  <Icon name="download" className="h-4 w-4" />
                  Exportar CSV
                </Button>
              </div>

              <TableShell className="max-h-[420px] overflow-y-auto">
                <table className={tableClass}>
                  <caption className="sr-only">
                    Resultado da consulta: {result.row_count ?? 0} linhas,
                    página {currentPage + 1} de {pageCount}
                  </caption>
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th
                          key={c}
                          scope="col"
                          className={cx(thClass, "sticky top-0 z-10")}
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((row, i) => (
                      <tr
                        key={currentPage * PAGE_SIZE + i}
                        className="odd:bg-slate-950/30 hover:bg-emerald-500/5"
                      >
                        {columns.map((c) => {
                          const numeric = typeof row[c] === "number";
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
                              {row[c] === null || row[c] === undefined
                                ? "—"
                                : String(row[c])}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={Math.max(columns.length, 1)}
                          className="px-3 py-4 text-center text-slate-400"
                        >
                          Sem linhas.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </TableShell>

              {rows.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-slate-400">
                    Página {currentPage + 1} de {pageCount} ·{" "}
                    {rows.length.toLocaleString("pt-BR")} linhas
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={currentPage <= 0}
                    >
                      Anterior
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setPage((p) => Math.min(pageCount - 1, p + 1))
                      }
                      disabled={currentPage >= pageCount - 1}
                    >
                      Próxima
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
