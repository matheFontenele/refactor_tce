"""Assistente Text-to-SQL do TCE-CE (backend).

Fluxo: pergunta -> contexto (schema real + dicionário do endpoints.json) ->
LLM local (Ollama) devolve {explicacao, sql} -> validação estrita -> execução
read-only na camada dedicada (`ai_db`) -> resultado + SQL para auditoria.

A IA interpreta e explica; o DuckDB calcula; a validação controla o que executa.
Nenhum número é aceito da prosa do modelo: totais/rankings vêm das linhas reais.

Variáveis de ambiente:
  OLLAMA_BASE_URL   default http://tce-ollama-local:11434
  OLLAMA_MODEL      default qwen3:4b
  AI_LLM_TIMEOUT    timeout do LLM em segundos (default 600)
  AI_MAX_ROWS       linhas devolvidas por resposta (default 200)
  AI_CATEGORIES     prefixos habilitados (default do ai_db)
  ENDPOINTS_FILE    catálogo com descrições/relacionamentos
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Optional

import requests
import sqlglot
from sqlglot import exp

from ai_db import AiDatabase, DEFAULT_CATEGORIES, get_ai_db

DEFAULT_OLLAMA_URL = "http://tce-ollama-local:11434"
DEFAULT_MODEL = "qwen3:4b"

FORMAT_SQL = {
    "type": "object",
    "properties": {
        "explicacao": {"type": "string"},
        "sql": {"type": "string"},
    },
    "required": ["explicacao", "sql"],
    "additionalProperties": False,
}

BANNED_FUNCS = {
    "read_parquet", "parquet_scan", "read_csv", "read_csv_auto", "csv_scan",
    "read_json", "read_json_auto", "read_ndjson", "read_text", "read_blob",
    "glob", "sniff_csv", "delta_scan", "iceberg_scan", "postgres_scan",
    "sqlite_scan", "mysql_scan", "http_get", "http_post",
}

HINTS = {
    "exercicio_orcamento": "exercício no formato ANO*100 (2025 → 202500)",
    "valor_empenhado": "valor empenhado em R$",
    "valor_liquidado": "valor liquidado em R$",
    "valor_bruto": "valor bruto da nota fiscal em R$",
    "valor_liquido": "valor líquido da nota fiscal em R$",
    "codigo_municipio": "código do município (3 dígitos; ex.: '049' = Crato)",
    "municipio_referencia": "nome canônico do município (maiúsculas); use para agregações e rankings",
    "municipio_negociante": "nome do município como veio no empenho (variações de caixa; NÃO usar para agrupar)",
    "nome_negociante": "nome do fornecedor/credor",
    "numero_empenho": "número do empenho (chave de join)",
    "codigo_orgao": "código do órgão (chave de join)",
    "descricao_historico_empenho": "histórico/descrição do empenho",
    "numero_documento_negociante": "CPF/CNPJ do credor",
}

REGRAS = """Regras obrigatórias:
1. Gere UMA única instrução SELECT (CTE WITH permitido). Nunca INSERT/UPDATE/DELETE/DDL, nunca múltiplas instruções.
2. Use somente as tabelas listadas e SOMENTE as colunas listadas. Nunca use read_parquet, read_csv, glob, read_text ou funções de arquivo/rede. Nunca invente colunas.
3. Ano: exercicio_orcamento = ANO*100 (2025 → 202500).
4. "valor empenhado" = SUM(valor_empenhado); "valor liquidado" = SUM(valor_liquidado); nota fiscal = valor_bruto ou valor_liquido.
5. Contagens: cada linha é um documento — use COUNT(*). Não use COUNT(DISTINCT numero_empenho): numero_empenho não é único globalmente (repete por município/órgão).
6. Comparações entre anos: retorne UMA LINHA POR ANO com GROUP BY exercicio_orcamento — nunca some anos diferentes no mesmo total.
7. Joins: a chave entre as três tabelas é SEMPRE (codigo_municipio, codigo_orgao, numero_empenho, exercicio_orcamento) — as três colunas de chave MAIS o exercício. Sem o exercício, números de empenho de anos diferentes colidem e duplicam valores. liquidacoes e notas_fiscais NÃO têm nome_negociante: para fornecedor, junte com notas_empenho.
8. Município: para agregações/rankings por município use SEMPRE municipio_referencia (nome canônico, em maiúsculas); municipio_negociante é o nome bruto do empenho e pode ter variações de caixa (FORTALEZA/Fortaleza) — nunca agrupe por ele. Para filtros, use codigo_municipio (string de 3 dígitos, ex.: '049' = Crato) ou municipio_referencia. Nunca compare código de município com nome de município.
9. Busca de texto: quando a pergunta mencionar nomes (fornecedor, credor, município, histórico, etc.), use SEMPRE ILIKE '%termo%' (contém) em vez de igualdade exata. Exemplo: fornecedor 'ALUCOM' → e.nome_negociante ILIKE '%ALUCOM%'. Nunca use ILIKE sem curinga '%', pois não encontra nomes compostos (ex.: 'ALUCOM LTDA - EPP').
10. Consultas que retornam linhas devem ter LIMIT <= 1000; agregações podem omitir.
11. Responda SOMENTE JSON: {"explicacao": "...", "sql": "..."}.
12. "explicacao": 1-2 frases curtas em português, sem raciocínio interno e sem inventar números.
13. Se a pergunta não puder ser respondida com as tabelas/colunas acima, retorne "sql" vazio e explique em "explicacao".

Exemplos:
Pergunta: Quantas notas de empenho em 2025?
Resposta: {"explicacao": "Conta as notas de empenho do exercício de 2025.", "sql": "SELECT COUNT(*) FROM notas_empenho WHERE exercicio_orcamento = 202500"}

Pergunta: Compare o valor liquidado em 2024 e 2025.
Resposta: {"explicacao": "Compara o total liquidado em cada exercício.", "sql": "SELECT exercicio_orcamento, SUM(valor_liquidado) AS total FROM liquidacoes WHERE exercicio_orcamento IN (202400, 202500) GROUP BY 1 ORDER BY 1"}

Pergunta: Quais os 5 fornecedores com maior valor liquidado em 2025?
Resposta: {"explicacao": "Soma as liquidações por fornecedor do empenho.", "sql": "SELECT e.nome_negociante, SUM(l.valor_liquidado) AS total FROM liquidacoes l JOIN notas_empenho e ON e.codigo_municipio = l.codigo_municipio AND e.codigo_orgao = l.codigo_orgao AND e.numero_empenho = l.numero_empenho AND e.exercicio_orcamento = l.exercicio_orcamento WHERE l.exercicio_orcamento = 202500 GROUP BY 1 ORDER BY total DESC NULLS LAST LIMIT 5"}

Pergunta: Quais os 5 municípios com maior valor empenhado em 2025?
Resposta: {"explicacao": "Soma o valor empenhado por município do exercício de 2025.", "sql": "SELECT municipio_referencia, SUM(valor_empenhado) AS total FROM notas_empenho WHERE exercicio_orcamento = 202500 GROUP BY 1 ORDER BY total DESC NULLS LAST LIMIT 5"}"""


# ---------------- validação ----------------

def validar_sql_ia(sql: str, tabelas_permitidas: set[str]) -> tuple[Optional[str], Optional[str]]:
    """Valida SQL gerado pela IA. Retorna (sql_normalizado, erro)."""
    if not sql or not sql.strip():
        return None, "sql vazio"
    try:
        statements = [s for s in sqlglot.parse(sql, read="duckdb") if s is not None]
    except Exception as exc:
        return None, f"parse falhou: {exc}"
    if len(statements) != 1:
        return None, f"esperava 1 instrução, vieram {len(statements)}"
    st = statements[0]
    if not isinstance(st, (exp.Select, exp.Union, exp.Intersect, exp.Except)):
        return None, f"tipo não permitido: {type(st).__name__}"

    ctes = {c.alias_or_name for c in st.find_all(exp.CTE)}
    tabelas = {t.name for t in st.find_all(exp.Table)}
    proibidas = tabelas - set(tabelas_permitidas) - ctes
    if proibidas:
        return None, f"tabelas não permitidas: {sorted(proibidas)}"

    for fn in st.find_all(exp.Anonymous):
        if fn.name.lower() in BANNED_FUNCS:
            return None, f"função não permitida: {fn.name}"

    limite_atual = st.args.get("limit")
    if limite_atual is None:
        st = st.limit(1000)
    else:
        try:
            valor = int(limite_atual.expression.this)
        except Exception:
            valor = 0
        if valor > 1000:
            st = st.limit(1000)
    return st.sql(dialect="duckdb"), None


def _tem_join(sql: str) -> bool:
    return bool(re.search(r"\bjoin\b", sql, re.IGNORECASE))


def extrair_json(content: str) -> dict:
    """Extrai o objeto JSON da resposta do modelo (tolerante a cercas/texto)."""
    texto = (content or "").strip()
    cerca = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", texto, re.S)
    if cerca:
        texto = cerca.group(1)
    try:
        dados = json.loads(texto)
    except Exception:
        bloco = re.search(r"\{.*\}", texto, re.S)
        if not bloco:
            raise ValueError("resposta do modelo não contém JSON")
        dados = json.loads(bloco.group(0))
    if not isinstance(dados, dict):
        raise ValueError("resposta do modelo não é um objeto JSON")
    return dados


# ---------------- LLM ----------------

class OllamaClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("OLLAMA_BASE_URL", DEFAULT_OLLAMA_URL)).rstrip("/")
        self.model = model or os.environ.get("OLLAMA_MODEL", DEFAULT_MODEL)
        self.timeout = float(timeout or os.environ.get("AI_LLM_TIMEOUT", "600"))

    def chat(self, messages: list[dict]) -> str:
        resposta = requests.post(
            f"{self.base_url}/api/chat",
            json={
                "model": self.model,
                "stream": False,
                "think": False,
                "format": FORMAT_SQL,
                "options": {"temperature": 0, "num_predict": 400},
                "messages": messages,
            },
            timeout=(10, self.timeout),
        )
        resposta.raise_for_status()
        return resposta.json()["message"]["content"]


# ---------------- assistente ----------------

class Assistant:
    def __init__(
        self,
        db: Optional[AiDatabase] = None,
        llm: Optional[OllamaClient] = None,
        endpoints_path: Optional[str] = None,
        categories: Optional[list[str]] = None,
        max_rows: Optional[int] = None,
    ) -> None:
        self._db = db
        self.llm = llm or OllamaClient()
        raiz = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        self.endpoints_path = endpoints_path or os.environ.get(
            "ENDPOINTS_FILE", os.path.join(raiz, "endpoints.json")
        )
        self.max_rows = int(max_rows or os.environ.get("AI_MAX_ROWS", "200"))
        self.categories = categories or [
            p.strip() for p in os.environ.get(
                "AI_CATEGORIES", ",".join(DEFAULT_CATEGORIES)
            ).split(",") if p.strip()
        ]
        self._prompt: Optional[str] = None

    @property
    def db(self) -> AiDatabase:
        if self._db is None:
            self._db = get_ai_db()
        return self._db

    # ---------- prompt ----------

    def _dicionario(self) -> dict:
        try:
            with open(self.endpoints_path, encoding="utf-8") as f:
                endpoints = json.load(f)
        except Exception:
            return {}
        por_prefixo = {}
        for categoria in endpoints.values():
            prefixo = categoria.get("prefixo")
            if prefixo:
                por_prefixo[prefixo] = categoria
        return por_prefixo

    def system_prompt(self) -> str:
        if self._prompt:
            return self._prompt
        schemas = self.db.schemas()
        disponiveis = [p for p in self.categories if schemas.get(p)]
        if not disponiveis:
            raise RuntimeError(
                "Nenhuma categoria do assistente possui parquets disponíveis. "
                "Verifique PARQUET_DIR/CACHE_PARQUET_DIR."
            )
        dicionario = self._dicionario()
        blocos = []
        joins = []
        for prefixo in disponiveis:
            cat = dicionario.get(prefixo, {})
            descricoes = cat.get("colunas_texto", {}) or {}
            linhas = []
            for nome, tipo in schemas[prefixo]:
                extras = [x for x in (descricoes.get(nome), HINTS.get(nome)) if x]
                extra = "; ".join(dict.fromkeys(extras))
                linhas.append(f"- {nome} {tipo}" + (f" — {extra}" if extra else ""))
            blocos.append(f"### {prefixo}\n" + "\n".join(linhas))
            for rel in cat.get("relacionamentos", []) or []:
                alvo = rel.get("tabela_alvo_prefixo")
                if alvo in disponiveis:
                    chaves = ", ".join(rel.get("chaves_join", []))
                    item = f"{prefixo} ↔ {alvo} por ({chaves}) + exercicio_orcamento"
                    if item not in joins:
                        joins.append(item)

        self._prompt = (
            "Você é o Assistente de Dados do TCE-CE. Gera SQL DuckDB somente leitura "
            "para responder perguntas em português.\n\n"
            "Tabelas disponíveis (views sobre os Parquets reais do TCE-CE):\n\n"
            + "\n\n".join(blocos)
            + ("\n\nJoins conhecidos (inclua sempre exercicio_orcamento):\n- "
               + "\n- ".join(joins) if joins else "")
            + "\n\n" + REGRAS
        )
        return self._prompt

    # ---------- execução ----------

    def ask(self, pergunta: str, max_rows: Optional[int] = None) -> dict:
        pergunta = (pergunta or "").strip()
        if not pergunta:
            raise ValueError("pergunta vazia")
        limite = int(max_rows or self.max_rows)
        tabelas = set(self.db.views)
        tentativas = 0
        ultimo_sql: Optional[str] = None
        ultimo_erro: Optional[str] = None

        messages = [
            {"role": "system", "content": self.system_prompt()},
            {"role": "user", "content": pergunta},
        ]

        for tentativa in (1, 2):
            tentativas = tentativa
            try:
                conteudo = self.llm.chat(messages)
            except requests.RequestException as exc:
                return self._falha(
                    f"Não consegui falar com o modelo local (Ollama). "
                    f"Verifique OLLAMA_BASE_URL ({self.llm.base_url}). Detalhe: {exc}",
                    sql=ultimo_sql, tentativas=tentativas,
                )
            except Exception as exc:
                return self._falha(f"Erro ao consultar o modelo: {exc}", sql=ultimo_sql, tentativas=tentativas)

            try:
                dados = extrair_json(conteudo)
            except Exception as exc:
                ultimo_erro = f"resposta inválida do modelo: {exc}"
                if tentativa == 1:
                    messages += [
                        {"role": "assistant", "content": conteudo},
                        {"role": "user", "content": "Responda somente JSON válido com as chaves explicacao e sql."},
                    ]
                    continue
                break

            explicacao = str(dados.get("explicacao") or "").strip()
            sql = str(dados.get("sql") or "").strip()

            if not sql:
                return {
                    "success": True,
                    "text": explicacao or "Não é possível responder com os dados disponíveis.",
                    "sql": None,
                    "columns": [],
                    "rows": [],
                    "row_count": 0,
                    "truncated": False,
                    "execution_time": 0.0,
                    "attempts": tentativas,
                    "error": None,
                }

            sql_norm, erro = validar_sql_ia(sql, tabelas)
            if erro:
                ultimo_sql, ultimo_erro = sql, erro
                if tentativa == 1:
                    messages += [
                        {"role": "assistant", "content": conteudo},
                        {"role": "user", "content": (
                            f"O SQL anterior não passou na validação: {erro}. "
                            "Corrija e devolva o JSON (explicacao, sql)."
                        )},
                    ]
                    continue
                break

            inicio = time.time()
            try:
                colunas, linhas = self.db.execute(sql_norm)
                duracao = time.time() - inicio
            except Exception as exc:
                ultimo_sql, ultimo_erro = sql_norm, f"execução: {exc}"
                if tentativa == 1:
                    messages += [
                        {"role": "assistant", "content": conteudo},
                        {"role": "user", "content": (
                            f"A consulta falhou ao executar: {str(exc)[:400]}. "
                            "Corrija o SQL e devolva o JSON (explicacao, sql)."
                        )},
                    ]
                    continue
                break

            if not linhas and tentativa == 1 and _tem_join(sql_norm):
                ultimo_sql, ultimo_erro = sql_norm, "a consulta retornou 0 linhas"
                messages += [
                    {"role": "assistant", "content": conteudo},
                    {"role": "user", "content": (
                        "A consulta executou, mas retornou 0 linhas. Se a pergunta não for sobre "
                        "ausência de dados, revise os joins (use codigo_municipio, codigo_orgao, "
                        "numero_empenho) e os filtros; devolva o JSON (explicacao, sql)."
                    )},
                ]
                continue

            truncado = len(linhas) > limite
            texto = explicacao or "Consulta executada com sucesso."
            if not linhas:
                texto = f"{texto} A consulta não retornou linhas."
            return {
                "success": True,
                "text": texto,
                "sql": sql_norm,
                "columns": colunas,
                "rows": linhas[:limite],
                "row_count": len(linhas),
                "truncated": truncado,
                "execution_time": round(duracao, 2),
                "attempts": tentativas,
                "error": None,
            }

        return self._falha(
            "Não foi possível gerar uma consulta válida para a pergunta. "
            f"Detalhe: {ultimo_erro}",
            sql=ultimo_sql, tentativas=tentativas,
        )

    @staticmethod
    def _falha(mensagem: str, *, sql: Optional[str], tentativas: int) -> dict:
        return {
            "success": False,
            "text": None,
            "sql": sql,
            "columns": [],
            "rows": [],
            "row_count": 0,
            "truncated": False,
            "execution_time": 0.0,
            "attempts": tentativas,
            "error": mensagem,
        }


# ---------------- singleton ----------------

_assistant: Optional[Assistant] = None
_assistant_lock = threading.Lock()


def get_assistant() -> Assistant:
    global _assistant
    if _assistant is None:
        with _assistant_lock:
            if _assistant is None:
                _assistant = Assistant()
    return _assistant
