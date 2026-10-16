"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import Editor from "@monaco-editor/react";
import { useSavedQueries } from "../hooks/useSavedQueries";

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
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:9001";

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
  const { queries: savedQueries, addQuery } = useSavedQueries();

  const [value, setValue] = useState(
    "-- SQL Studio — TCE-CE\n-- Ctrl+Enter executa (apenas SELECT/WITH)\nSELECT * FROM notas_empenho LIMIT 10;\n"
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

  const editorRef = useRef<unknown>(null);

  // ---- Catálogo (FR-002) ----
  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/sql/catalog`, {
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
      | { getValue: () => string; getSelection: () => unknown; getModel: () => unknown }
      | null;
    if (!editor) return;

    let sql = editor.getValue().trim();
    // Se houver seleção, executar apenas a seleção
    const selection = editor.getSelection() as
      | { isEmpty?: () => boolean }
      | null;
    // (mantemos simples: executar tudo se não houver seleção tratada)

    if (!sql) return;

    // Remove comentário de linha inicial apenas para validação simples no backend
    setLoading(true);
    setErrorMsg(null);
    setResult(null);

    const startedAt = new Date();
    try {
      const res = await fetch(`${API_URL}/api/sql/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, max_rows: 5000, timeout: 30 }),
      });

      const data = (await res.json()) as QueryResult | { detail?: string };

      if (!res.ok) {
        const detail =
          (data as { detail?: string }).detail || `Erro HTTP ${res.status}`;
        setErrorMsg(detail);
        setHistory((h) => [
          { sql, at: startedAt.toLocaleTimeString(), ok: false },
          ...h,
        ].slice(0, 50));
        return;
      }

      const qr = data as QueryResult;
      if (!qr.success) {
        setErrorMsg(qr.error || "Erro desconhecido na execução");
        setHistory((h) => [
          { sql, at: startedAt.toLocaleTimeString(), ok: false },
          ...h,
        ].slice(0, 50));
        return;
      }

      setResult(qr);
      setHistory((h) => [
        {
          sql,
          at: startedAt.toLocaleTimeString(),
          ok: true,
          duration: qr.execution_time,
        },
        ...h,
      ].slice(0, 50));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Falha de conexão: ${msg}`);
      setHistory((h) => [
        { sql, at: startedAt.toLocaleTimeString(), ok: false },
        ...h,
      ].slice(0, 50));
    } finally {
      setLoading(false);
    }
  }, []);

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
    [executeQuery]
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
            for (const kw of ["SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "LIMIT", "JOIN", "WITH"]) {
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
    [catalog]
  );

  // ---- Export CSV (FR-008) ----
  const exportCSV = () => {
    if (!result?.data || !result.columns) return;
    const header = result.columns.join(",");
    const rows = result.data.map((row) =>
      result.columns!
        .map((c) => {
          const v = row[c];
          const s = v === null || v === undefined ? "" : String(v);
          return `"${s.replace(/"/g, '""')}"`;
        })
        .join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
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
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">SQL Studio — TCE-CE</h1>
            <p className="text-slate-400 text-sm">
              Editor SQL com guardrails (somente leitura). API: {API_URL}
            </p>
          </div>
          <button
            onClick={executeQuery}
            disabled={loading}
            className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-semibold"
          >
            {loading ? "Executando…" : "▶ Executar (Ctrl+Enter)"}
          </button>
        </header>

        {/* Painéis laterais */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <aside className="space-y-3">
            <div className="rounded-lg bg-slate-900 border border-slate-800 p-3">
              <h3 className="text-sm font-semibold text-slate-300 mb-2">
                Queries salvas
              </h3>
              {savedQueries.length === 0 ? (
                <p className="text-xs text-slate-500">Nenhuma ainda.</p>
              ) : (
                <ul className="space-y-1">
                  {savedQueries.map((q) => (
                    <li key={q.name}>
                      <button
                        className="text-left text-sm text-emerald-400 hover:underline w-full truncate"
                        onClick={() => setValue(q.sql)}
                      >
                        {q.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="nome da query"
                  className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
                />
                <button
                  onClick={handleSave}
                  className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm"
                >
                  Salvar
                </button>
              </div>
            </div>

            <div className="rounded-lg bg-slate-900 border border-slate-800 p-3">
              <button
                onClick={() => setShowHistory((s) => !s)}
                className="text-sm font-semibold text-slate-300"
              >
                Histórico ({history.length}) {showHistory ? "▾" : "▸"}
              </button>
              {showHistory && (
                <ul className="mt-2 space-y-1 max-h-60 overflow-auto">
                  {history.map((h, i) => (
                    <li key={i} className="text-xs">
                      <button
                        className={`text-left w-full truncate hover:underline ${
                          h.ok ? "text-slate-300" : "text-rose-400"
                        }`}
                        onClick={() => setValue(h.sql)}
                        title={h.sql}
                      >
                        [{h.at}{h.duration != null ? ` · ${h.duration}s` : ""}]{" "}
                        {h.sql.slice(0, 40)}
                        {h.sql.length > 40 ? "…" : ""}
                      </button>
                    </li>
                  ))}
                  {history.length === 0 && (
                    <li className="text-xs text-slate-500">Sem execuções.</li>
                  )}
                </ul>
              )}
            </div>
          </aside>

          {/* Editor + Resultados */}
          <main className="lg:col-span-3 space-y-4">
            <div className="rounded-lg overflow-hidden border border-slate-800">
              <Editor
                height="320px"
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
                }}
              />
            </div>

            {errorMsg && (
              <div className="rounded-lg bg-rose-950 border border-rose-800 text-rose-200 p-3 text-sm">
                ✖ {errorMsg}
              </div>
            )}

            {result && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex gap-4 text-slate-400">
                    <span>{result.row_count ?? 0} linhas</span>
                    <span>{result.execution_time ?? 0}s</span>
                    {result.truncated && (
                      <span className="text-amber-400">
                        ⚠ truncado em 5000 linhas
                      </span>
                    )}
                  </div>
                  <button
                    onClick={exportCSV}
                    className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm"
                  >
                    ⬇ Exportar CSV
                  </button>
                </div>

                <div className="rounded-lg border border-slate-800 overflow-auto max-h-[420px]">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-900 sticky top-0">
                      <tr>
                        {(result.columns ?? []).map((c) => (
                          <th
                            key={c}
                            className="text-left px-3 py-2 font-medium text-slate-300 border-b border-slate-800 whitespace-nowrap"
                          >
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(result.data ?? []).map((row, i) => (
                        <tr
                          key={i}
                          className="odd:bg-slate-950 even:bg-slate-900/60"
                        >
                          {(result.columns ?? []).map((c) => (
                            <td
                              key={c}
                              className="px-3 py-1.5 text-slate-200 whitespace-nowrap"
                            >
                              {row[c] === null || row[c] === undefined
                                ? "—"
                                : String(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {(result.data ?? []).length === 0 && (
                        <tr>
                          <td
                            colSpan={(result.columns ?? [""]).length}
                            className="px-3 py-4 text-center text-slate-500"
                          >
                            Sem linhas.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}