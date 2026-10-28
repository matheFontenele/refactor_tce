"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./ui/Icon";

/**
 * Assistente de Dados — chat Text-to-SQL sobre os Parquets reais do TCE-CE.
 *
 * Fluxo (SSE via POST + fetch/ReadableStream — EventSource não faz POST):
 *   status → status → sql → metadata → row* → final   (ou: error)
 *
 * Princípios de UX:
 * - Nada é inventado: só mostramos o que o backend devolveu.
 * - O SQL é sempre visível (revelável) — auditoria exige rastreabilidade.
 * - O modelo roda localmente: pode levar 1–2 min. Mostramos estágio + tempo
 *   decorrido para que a espera não pareça travamento.
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:9001";

const MAX_ROWS = 200;

const SUGGESTIONS = [
  "Quantas notas de empenho foram emitidas em 2025?",
  "Quais os 5 municípios com maior valor empenhado em 2025?",
  "Compare o valor liquidado em 2024 e 2025.",
];

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type Stage = "interpretando_pergunta" | "gerando_sql" | "executando_consulta";

const STAGE_LABEL: Record<Stage, string> = {
  interpretando_pergunta: "Interpretando a pergunta",
  gerando_sql: "Gerando SQL",
  executando_consulta: "Executando consulta",
};

interface Turn {
  id: string;
  question: string;
  stage: Stage | null;
  sql: string | null;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  executionTime: number | null;
  attempts: number | null;
  answer: string | null;
  error: string | null;
  done: boolean;
  startedAt: number;
}

interface AiStatus {
  model: string;
  ollama_url: string;
  views: Record<string, number>;
  max_rows: number;
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

const nfInt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const nfDec = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const nfBrl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});

/** Colunas cujo nome sugere dinheiro — formatadas como BRL. */
const MONEY_HINT =
  /(valor|preco|preço|montante|despesa|receita|vlr|dotac|liquid|empenh|pago|bruto|custo|gasto)/i;

/**
 * Converte string numérica em número, aceitando "1.234,56" (pt-BR),
 * "1,50" e "1.50". Devolve null para "057" — códigos de município mantêm
 * os zeros à esquerda.
 */
function parseNumericString(text: string): number | null {
  const t = text.trim();
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) {
    return Number(t.replace(/\./g, "").replace(",", "."));
  }
  if (/^-?\d+,\d+$/.test(t)) {
    return Number(t.replace(",", "."));
  }
  if (/^-?\d+\.\d+$/.test(t)) {
    return Number(t);
  }
  return null;
}

function formatCell(
  value: unknown,
  column: string,
): { text: string; numeric: boolean } {
  if (value === null || value === undefined)
    return { text: "—", numeric: false };
  if (typeof value === "boolean")
    return { text: value ? "sim" : "não", numeric: false };

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { text: String(value), numeric: false };
    if (MONEY_HINT.test(column))
      return { text: nfBrl.format(value), numeric: true };
    if (Number.isInteger(value))
      return { text: nfInt.format(value), numeric: true };
    return { text: nfDec.format(value), numeric: true };
  }

  if (typeof value === "string") {
    const asNumber = parseNumericString(value);
    if (asNumber !== null && Number.isFinite(asNumber)) {
      if (MONEY_HINT.test(column))
        return { text: nfBrl.format(asNumber), numeric: true };
      return { text: nfDec.format(asNumber), numeric: true };
    }
    return { text: value, numeric: false };
  }

  return { text: JSON.stringify(value), numeric: false };
}

/** "total_empenhado" → "Total empenhado" (o nome cru segue no title). */
function prettyColumn(name: string): string {
  const base = name
    .replace(/\(\)$/, "")
    .replace(/_+/g, " ")
    .trim();
  if (!base) return name;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function fmtSeconds(seconds: number): string {
  return `${nfDec.format(seconds)} s`;
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Parser SSE
// ---------------------------------------------------------------------------

interface SseBlock {
  event: string;
  data: string;
}

/** Interpreta um bloco SSE (linhas `event:` / `data:`). */
function parseSseBlock(block: string): SseBlock | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue; // comentário / keep-alive

    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    let value = sep === -1 ? "" : line.slice(sep + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

function mapStage(raw: string): Stage {
  if (raw === "interpretando_pergunta") return "interpretando_pergunta";
  if (raw === "gerando_sql") return "gerando_sql";
  return "executando_consulta";
}

// ---------------------------------------------------------------------------
// Sub-componentes
// ---------------------------------------------------------------------------

function Chevron({ className = "" }: { className?: string }) {
  return (
    <Icon
      name="chevronRight"
      className={`h-3.5 w-3.5 transition-transform duration-300 ${className}`}
    />
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (!ok) return;
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  }, [text]);

  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
        copied
          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
          : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-600 hover:text-slate-200"
      }`}
      aria-label={copied ? "SQL copiado" : "Copiar SQL"}
    >
      <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" />
      {copied ? "Copiado" : "Copiar"}
    </button>
  );
}

function SqlPanel({ sql, id }: { sql: string; id: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/70">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={`${id}-sql`}
          className="inline-flex items-center gap-1.5 rounded text-xs font-semibold uppercase tracking-[0.12em] text-slate-400 transition-colors hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
        >
          <Chevron className={open ? "rotate-90" : ""} />
          Ver SQL
        </button>
        <CopyButton text={sql} />
      </div>
      <div
        id={`${id}-sql`}
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          {open && (
            <pre className="font-panelmono overflow-x-auto whitespace-pre px-3 py-3 text-[12.5px] leading-relaxed text-emerald-200/90">
              {sql}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultTable({
  columns,
  rows,
  truncated,
  rowCount,
  executionTime,
}: {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  rowCount: number;
  executionTime: number | null;
}) {
  if (!columns.length) return null;

  const shown = rows.length;
  const label = shown === 1 ? "1 linha" : `${nfInt.format(shown)} linhas`;

  return (
    <div className="mt-3">
      {truncated && (
        <p className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          <Icon
            name="alertTriangle"
            className="mt-px h-4 w-4 shrink-0"
          />
          <span>
            Mostrando as primeiras {nfInt.format(shown)} linhas — o resultado foi
            truncado no limite do assistente.
          </span>
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800">
        <div className="max-h-96 overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-left text-[12.5px]">
            <caption className="sr-only">Resultado da consulta: {label}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    title={c}
                    className="sticky top-0 z-10 whitespace-nowrap border-b border-slate-800 bg-slate-900/95 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-400 backdrop-blur"
                  >
                    {prettyColumn(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-3 py-4 text-center text-slate-400"
                  >
                    A consulta não retornou nenhuma linha.
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => (
                  <tr
                    key={i}
                    className="transition-colors odd:bg-slate-950/40 hover:bg-emerald-500/5"
                  >
                    {columns.map((c) => {
                      const { text, numeric } = formatCell(row[c], c);
                      return (
                        <td
                          key={c}
                          className={`whitespace-nowrap border-b border-slate-800/50 px-3 py-1.5 last:border-b-0 ${
                            numeric
                              ? "font-panelmono text-right tabular-nums text-slate-100"
                              : "text-slate-300"
                          }`}
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-1.5 text-right text-xs text-slate-400">
        {label}
        {executionTime !== null && <> • {fmtSeconds(executionTime)}</>}
        {rowCount > shown && <> • {nfInt.format(rowCount)} no total</>}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: AiStatus | null }) {
  if (!status) return null;
  const bases = Object.keys(status.views);

  return (
    <span
      title={`Modelo: ${status.model} · Bases: ${bases.join(", ") || "—"}`}
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-slate-700/80 bg-slate-950/70 px-3 py-1 text-xs text-slate-400"
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]"
      />
      <span className="font-panelmono text-slate-300">{status.model}</span>
      <span className="text-slate-700">·</span>
      <span>
        {bases.length} {bases.length === 1 ? "base" : "bases"}
      </span>
      <span className="text-slate-700">·</span>
      <span>máx. {nfInt.format(status.max_rows)} linhas</span>
    </span>
  );
}

function ThinkingDots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-dot-bounce rounded-full bg-emerald-400"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export default function AssistantChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const endRef = useRef<HTMLDivElement | null>(null);
  const lastScroll = useRef(0);
  const counter = useRef(0);

  // --- Badge de status (falha é silenciosa) --------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/ai/status`);
        if (!res.ok) return;
        const data = (await res.json()) as AiStatus;
        if (alive) setStatus(data);
      } catch {
        /* silencioso: o painel funciona sem o badge */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // --- Relógio de tempo decorrido ----------------------------------------
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // --- Rolagem automática (com throttle) ----------------------------------
  useEffect(() => {
    const stamp = Date.now();
    if (stamp - lastScroll.current < 300) return;
    lastScroll.current = stamp;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  const lastTurn = turns[turns.length - 1];
  const lastDone = lastTurn?.done ?? false;
  useEffect(() => {
    if (!lastDone) return;
    lastScroll.current = Date.now();
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lastDone]);

  // --- Atualização de um turno --------------------------------------------
  const patchTurn = useCallback((id: string, patch: Partial<Turn>) => {
    setTurns((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }, []);

  // --- Tratamento de cada evento SSE --------------------------------------
  // Retorna true quando o turno chegou a um estado terminal.
  const handleEvent = useCallback(
    (id: string, { event, data }: SseBlock): boolean => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return false;
      }

      switch (event) {
        case "status": {
          const stage = typeof payload.stage === "string" ? payload.stage : "";
          patchTurn(id, { stage: mapStage(stage) });
          return false;
        }

        case "sql": {
          const sql = typeof payload.sql === "string" ? payload.sql : null;
          patchTurn(id, { sql, stage: "executando_consulta" });
          return false;
        }

        case "metadata": {
          const columns = Array.isArray(payload.columns)
            ? (payload.columns as unknown[]).filter(
                (c): c is string => typeof c === "string",
              )
            : [];
          patchTurn(id, {
            columns,
            rowCount:
              typeof payload.row_count === "number" ? payload.row_count : 0,
            truncated: payload.truncated === true,
            executionTime:
              typeof payload.execution_time === "number"
                ? payload.execution_time
                : null,
            attempts:
              typeof payload.attempts === "number" ? payload.attempts : null,
          });
          return false;
        }

        case "row": {
          const rowData = payload.data;
          if (
            rowData &&
            typeof rowData === "object" &&
            !Array.isArray(rowData)
          ) {
            const record = rowData as Record<string, unknown>;
            setTurns((prev) =>
              prev.map((t) =>
                t.id === id ? { ...t, rows: [...t.rows, record] } : t,
              ),
            );
          }
          return false;
        }

        case "final": {
          const patch: Partial<Turn> = { stage: null, done: true };
          if (typeof payload.text === "string") patch.answer = payload.text;
          if (typeof payload.sql === "string") patch.sql = payload.sql;
          if (typeof payload.row_count === "number")
            patch.rowCount = payload.row_count;
          if (typeof payload.truncated === "boolean")
            patch.truncated = payload.truncated;
          if (typeof payload.execution_time === "number")
            patch.executionTime = payload.execution_time;
          patchTurn(id, patch);
          return true;
        }

        case "error": {
          const patch: Partial<Turn> = {
            error:
              typeof payload.detail === "string"
                ? payload.detail
                : "Não foi possível responder.",
            stage: null,
            done: true,
          };
          if (typeof payload.sql === "string") patch.sql = payload.sql;
          if (typeof payload.attempts === "number")
            patch.attempts = payload.attempts;
          patchTurn(id, patch);
          return true;
        }

        default:
          return false;
      }
    },
    [patchTurn],
  );

  // --- Envio da pergunta --------------------------------------------------
  const send = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question || busy) return;

      counter.current += 1;
      const id = `t${Date.now()}-${counter.current}`;

      setTurns((prev) => [
        ...prev,
        {
          id,
          question,
          stage: "interpretando_pergunta",
          sql: null,
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          executionTime: null,
          attempts: null,
          answer: null,
          error: null,
          done: false,
          startedAt: Date.now(),
        },
      ]);
      setInput("");
      setBusy(true);
      setNow(Date.now());

      try {
        const res = await fetch(`${API_URL}/api/ai/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({ question, max_rows: MAX_ROWS }),
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            detail?: string;
          } | null;
          throw new Error(
            body?.detail || `Falha na requisição (HTTP ${res.status}).`,
          );
        }
        if (!res.body) throw new Error("Resposta sem corpo.");

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let finished = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");

          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const parsed = parseSseBlock(block);
            if (parsed && handleEvent(id, parsed)) finished = true;
            sep = buffer.indexOf("\n\n");
          }
        }

        buffer += decoder.decode();
        const tail = parseSseBlock(buffer);
        if (tail && handleEvent(id, tail)) finished = true;

        // A conexão caiu antes de `final`/`error`.
        if (!finished) {
          patchTurn(id, {
            error:
              "A conexão com o assistente foi encerrada antes da resposta.",
            stage: null,
            done: true,
          });
        }
      } catch (err) {
        patchTurn(id, {
          error: err instanceof Error ? err.message : String(err),
          stage: null,
          done: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, handleEvent, patchTurn],
  );

  // --- Teclado: Enter envia, Shift+Enter quebra linha --------------------
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!busy) void send(input);
    }
  };

  const empty = turns.length === 0;
  const running = lastTurn && !lastTurn.done ? lastTurn : null;

  return (
    <div className="font-panel flex min-h-[calc(100vh-4.5rem)] flex-col gap-4">
      {/* ---------------- Cabeçalho ---------------- */}
      <header className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_130%_at_12%_-10%,rgba(16,185,129,0.18),transparent_62%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/60 to-transparent"
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Icon
                name="sparkles"
                className="h-5 w-5 text-emerald-300"
              />
              <h1 className="font-display text-2xl leading-tight tracking-tight text-slate-50 sm:text-[28px]">
                Assistente de Dados
              </h1>
            </div>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-slate-400">
              Pergunte em português. A resposta é calculada nos dados reais do
              TCE-CE e o SQL fica visível.
            </p>
          </div>
          <StatusBadge status={status} />
        </div>
      </header>

      {/* ---------------- Thread ---------------- */}
      <div className="flex-1">
        {empty ? (
          <div className="animate-fade-up rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 p-6 sm:p-8">
            <p className="text-sm font-semibold text-slate-200">
              Comece por uma pergunta
            </p>
            <p className="mt-1 text-sm text-slate-400">
              O assistente escreve uma consulta SQL, executa sobre as bases do
              TCE-CE e mostra o resultado com a consulta aberta.
            </p>

            <ul className="mt-5 grid gap-2.5 sm:grid-cols-3">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => void send(s)}
                    className="group flex h-full w-full items-start justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3.5 text-left text-[13px] leading-snug text-slate-300 transition-all hover:-translate-y-0.5 hover:border-emerald-500/40 hover:bg-slate-900 hover:text-slate-100 hover:shadow-lg hover:shadow-emerald-950/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                  >
                    <span>{s}</span>
                    <Icon
                      name="arrowRight"
                      className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-all group-hover:translate-x-0.5 group-hover:text-emerald-300"
                    />
                  </button>
                </li>
              ))}
            </ul>

            <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-slate-400">
              <Icon
                name="info"
                className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
              />
              <span>
                O modelo roda localmente na máquina do TCE. A primeira resposta
                pode levar de 1 a 2 minutos enquanto o modelo é carregado — o
                estágio e o tempo decorrido aparecem durante a espera.
              </span>
            </p>
          </div>
        ) : (
          <div
            role="log"
            aria-live="polite"
            aria-label="Conversa com o assistente"
            className="space-y-5"
          >
            {turns.map((turn) => (
              <TurnView key={turn.id} turn={turn} onRetry={send} />
            ))}
          </div>
        )}
        <div
          ref={endRef}
          className="h-1"
          style={{ scrollMarginBottom: "8rem" }}
        />
      </div>

      {/* ---------------- Composer ---------------- */}
      <div className="sticky bottom-0 z-10 -mx-1 px-1 pb-1">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-2 shadow-2xl shadow-slate-950/60 backdrop-blur-md sm:p-3">
          {running && (
            <div
              role="status"
              aria-live="polite"
              className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] px-3 py-2"
            >
              <span className="flex items-center gap-2 text-[12.5px] text-emerald-200">
                <ThinkingDots />
                {running.stage
                  ? `${STAGE_LABEL[running.stage]}…`
                  : "Processando…"}
              </span>
              <span className="font-panelmono text-xs tabular-nums text-slate-400">
                {fmtClock(now - running.startedAt)}
              </span>
            </div>
          )}

          <div className="flex items-end gap-2">
            <label htmlFor="assistant-question" className="sr-only">
              Sua pergunta sobre os dados do TCE-CE
            </label>
            <textarea
              id="assistant-question"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
              rows={2}
              placeholder="Ex.: Quantas notas de empenho foram emitidas em 2025?"
              className="min-h-[52px] flex-1 resize-y rounded-xl border border-slate-700 bg-slate-950/80 px-3.5 py-2.5 text-sm leading-relaxed text-slate-100 placeholder:text-slate-400 transition-colors hover:border-slate-600 focus:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void send(input)}
              disabled={busy || !input.trim()}
              className="shrink-0 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-950/40 transition-all hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-400 disabled:shadow-none"
            >
              {busy ? "Consultando…" : "Perguntar"}
            </button>
          </div>

          <p className="mt-1.5 px-1 text-xs text-slate-400">
            <kbd className="rounded border border-slate-700 bg-slate-800/70 px-1 py-0.5 font-panelmono text-xs text-slate-400">
              Enter
            </kbd>{" "}
            envia ·{" "}
            <kbd className="rounded border border-slate-700 bg-slate-800/70 px-1 py-0.5 font-panelmono text-xs text-slate-400">
              Shift
            </kbd>{" "}
            +{" "}
            <kbd className="rounded border border-slate-700 bg-slate-800/70 px-1 py-0.5 font-panelmono text-xs text-slate-400">
              Enter
            </kbd>{" "}
            quebra a linha. As consultas são executadas apenas em modo leitura.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Turno (pergunta + resposta)
// ---------------------------------------------------------------------------

function TurnView({
  turn,
  onRetry,
}: {
  turn: Turn;
  onRetry: (question: string) => void;
}) {
  const elapsed = Date.now() - turn.startedAt;

  return (
    <div className="animate-fade-up space-y-3">
      {/* Pergunta do usuário — à direita */}
      <div className="flex justify-end">
        <p className="max-w-[88%] rounded-2xl rounded-br-md border border-emerald-500/25 bg-emerald-500/10 px-4 py-2.5 text-sm leading-relaxed text-emerald-50 shadow-sm">
          {turn.question}
        </p>
      </div>

      {/* Resposta do assistente — à esquerda */}
      <div className="relative overflow-hidden rounded-2xl rounded-tl-md border border-slate-800 bg-slate-900/60 p-4 sm:p-5">
        <span
          aria-hidden
          className="absolute inset-y-3 left-0 w-[3px] rounded-full bg-gradient-to-b from-emerald-400 via-emerald-500/60 to-transparent"
        />

        {/* Estado de carregamento */}
        {!turn.done && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[13px] text-emerald-200">
              <ThinkingDots />
              {turn.stage ? `${STAGE_LABEL[turn.stage]}…` : "Consultando…"}
            </div>
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-slate-800">
              <div className="absolute inset-y-0 w-1/3 animate-shimmer rounded-full bg-gradient-to-r from-transparent via-emerald-400/70 to-transparent" />
            </div>
            <p className="font-panelmono text-xs tabular-nums text-slate-400">
              {fmtClock(elapsed)} decorridos
            </p>
            {turn.sql && (
              <p className="font-panelmono truncate text-xs text-slate-400">
                {turn.sql}
              </p>
            )}
          </div>
        )}

        {/* Erro */}
        {turn.done && turn.error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-500/40 bg-rose-950/50 p-4"
          >
            <p className="text-sm font-semibold text-rose-200">
              Não foi possível responder
            </p>
            <p className="mt-1 text-sm leading-relaxed text-rose-300/90">
              {turn.error}
            </p>
            {turn.attempts !== null && turn.attempts > 1 && (
              <p className="mt-1.5 text-[12px] text-rose-400/80">
                Foram {turn.attempts} tentativas antes de desistir.
              </p>
            )}
            <div className="mt-3">
              <button
                type="button"
                onClick={() => onRetry(turn.question)}
                className="rounded-lg border border-rose-500/40 bg-rose-900/60 px-3.5 py-1.5 text-[13px] font-medium text-rose-100 transition-colors hover:bg-rose-800/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/70"
              >
                Tentar novamente
              </button>
            </div>
          </div>
        )}

        {/* Resposta concluída */}
        {turn.done && !turn.error && (
          <>
            {turn.answer && (
              <div className="space-y-2 text-[14px] leading-relaxed text-slate-200">
                {turn.answer.split(/\n{2,}/).map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            )}

            {turn.columns.length > 0 && (
              <ResultTable
                columns={turn.columns}
                rows={turn.rows}
                truncated={turn.truncated}
                rowCount={turn.rowCount}
                executionTime={turn.executionTime}
              />
            )}

            {turn.sql && <SqlPanel sql={turn.sql} id={turn.id} />}
          </>
        )}

        {turn.done && turn.error && turn.sql && (
          <SqlPanel sql={turn.sql} id={`${turn.id}-err`} />
        )}
      </div>
    </div>
  );
}
