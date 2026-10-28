"""FastAPI backend for SQL Studio with Monaco Editor."""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import duckdb
import sqlglot
import time as _time
import os as _os
from typing import Optional, List, Dict, Any

try:  # pyarrow/requests existem na imagem Docker; dev local cai no modo parquet/seed
    import tce_client as _tce
except Exception:  # pragma: no cover
    _tce = None

app = FastAPI(title="SQL Studio API", version="0.1.0")

# CORS — configurável por CORS_ORIGINS, separado por vírgula.
_cors_origins = [
    origin.strip()
    for origin in _os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3001,http://127.0.0.1:3001,http://localhost:3000,http://172.16.0.200:3001",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------- Models -----------

class ExecuteRequest(BaseModel):
    sql: str = Field(..., description="SQL query to execute (SELECT or WITH only)")
    max_rows: Optional[int] = Field(default=5000, description="Max rows to return")
    timeout: Optional[float] = Field(default=30.0, description="Timeout in seconds")

class ExecuteResponse(BaseModel):
    success: bool
    data: Optional[List[Dict[str, Any]]] = None
    columns: Optional[List[str]] = None
    row_count: Optional[int] = None
    execution_time: Optional[float] = None
    truncated: Optional[bool] = False
    error: Optional[str] = None

class CatalogRequest(BaseModel):
    pass

class SavedQueryRequest(BaseModel):
    name: str
    description: Optional[str] = None
    sql: str

class SearchRequest(BaseModel):
    category: str = Field(..., description="Categoria (chave no endpoints.json)")
    year_from: int = Field(..., description="Ano inicial")
    year_to: int = Field(..., description="Ano final")
    municipality: str = Field(default="all", description="codigo_municipio ou 'all'")
    filters: Dict[str, Any] = Field(default_factory=dict, description="Filtros dinâmicos (campos_ui)")
    general_search: str = Field(default="", description="Busca geral (texto)")
    supplier_search: str = Field(default="", description="Fornecedor/CNPJ")
    limit: int = Field(default=500, le=500, description="Máximo de linhas")

class AiRequest(BaseModel):
    question: str = Field(..., min_length=1, description="Pergunta em linguagem natural")
    max_rows: Optional[int] = Field(default=200, ge=1, le=1000, description="Máximo de linhas retornadas")

# ----------- Constants -----------

import os

# Works both locally and inside Docker (env DUCKDB_PATH overrides)
_here = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get(
    "DUCKDB_PATH",
    os.path.join(os.path.dirname(os.path.dirname(_here)), "data", "tce_analysis.duckdb"),
)
QUERIES_FILE = os.environ.get(
    "SAVED_QUERIES_FILE",
    os.path.join(os.path.dirname(DB_PATH), "saved_queries.json"),
)
# Fallback to /tmp if the data dir is read-only (e.g. Docker :ro mount)
if not os.access(os.path.dirname(QUERIES_FILE), os.W_OK):
    QUERIES_FILE = "/tmp/saved_queries.json"

# Pesquisa interativa: configs vindas da raiz do projeto (mount no Docker)
_ROOT = os.path.dirname(os.path.dirname(_here))
ENDPOINTS_FILE = os.environ.get("ENDPOINTS_FILE", os.path.join(_ROOT, "endpoints.json"))
MUNICIPIOS_FILE = os.environ.get("MUNICIPIOS_FILE", os.path.join(_ROOT, "municipios.json"))

# Parquets reais do TCE (opcional; montado read-only em /parquet no Docker).
# Quando presente, a Pesquisa lê parquet lazy (zero-copy) em vez do seed.
PARQUET_DIR = os.environ.get("PARQUET_DIR", "")

# Data lake local gravável: recortes baixados sob demanda da API TCE (Spec 2.1).
CACHE_PARQUET_DIR = os.environ.get("CACHE_PARQUET_DIR", os.path.join(_ROOT, "data", "cache"))

# Híbrido local-first: a API do TCE só é chamada para recortes ausentes no cache.
TCE_FETCH_ENABLED = os.environ.get("TCE_FETCH_ENABLED", "1") != "0"
TCE_FETCH_BUDGET_SECONDS = float(os.environ.get("TCE_FETCH_BUDGET_SECONDS", "60"))
TCE_FETCH_MAX_RECORTES = int(os.environ.get("TCE_FETCH_MAX_RECORTES", "12"))

# Arquivos parquet corrompidos detectados em tempo de execução (blocklist em memória)
_BAD_PARQUET_FILES: set = set()

# ----------- Helpers -----------

def get_db():
    """Get a DuckDB connection (read-only).
    
    Cache the connection in the app state to avoid repeated connection
    overhead and ensure consistency across requests.
    """
    if not hasattr(app.state, "db_conn") or app.state.db_conn is None:
        conn = duckdb.connect(DB_PATH, read_only=True)
        app.state.db_conn = conn
    return app.state.db_conn

def validate_sql(sql: str) -> None:
    """Validate SQL with sqlglot, allow only SELECT/WITH."""
    parsed = sqlglot.parse_one(sql, dialect="duckdb")
    if parsed is None:
        raise HTTPException(status_code=400, detail="Não conseguiu parsear a SQL")
    
    # Check top-level statement type - allow only SELECT and WITH
    top_statement = str(parsed).strip().upper()
    
    # Block disallowed keywords at the start
    disallowed = ("INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", 
                  "TRUNCATE", "COPY", "VACUUM", "BEGIN", "COMMIT", "ROLLBACK")
    
    first_word = top_statement.split()[0] if top_statement.split() else ""
    if first_word in disallowed:
        raise HTTPException(
            status_code=400, 
            detail=f"Operação não permitida: {first_word}. Apenas leitura (SELECT/WITH) é permitida."
        )
    
    # Also check for disallowed patterns in the full statement
    sql_upper = sql.upper()
    for keyword in disallowed:
        # Check if keyword appears as a standalone statement (at start after semicolons)
        # Simple heuristic: check if keyword is at the very start or after ;
        if f"; {keyword}" in sql_upper or sql_upper.startswith(keyword):
            raise HTTPException(
                status_code=400, 
                detail=f"Operação não permitida: {keyword}. Apenas leitura (SELECT/WITH) é permitida."
            )

# ----------- Endpoints -----------

@app.on_event("startup")
def startup():
    """Initialize DuckDB connection on startup."""
    # Initialize the cached connection
    conn = get_db()
    # Quick validation that the DB is accessible
    try:
        conn.execute("SELECT 1").fetchall()
    except Exception as e:
        raise RuntimeError(f"Could not connect to DuckDB database: {e}")

@app.post("/api/sql/execute", response_model=ExecuteResponse)
def execute_sql(req: ExecuteRequest):
    """Execute a SQL query against the DuckDB analytics database."""
    try:
        validate_sql(req.sql)
        
        conn = get_db()
        start_time = _time.time()
        
        try:
            # Execute query
            result = conn.execute(req.sql).fetchall()
            elapsed = _time.time() - start_time
            
            data = []
            columns = [col[0] for col in conn.description] if conn.description else []
            row_count = len(result)
            
            if result:
                data = [dict(zip(columns, row)) for row in result]
            
            truncated = row_count > (req.max_rows or 5000)
            if truncated and req.max_rows:
                # Re-execute with limit
                limited_result = conn.execute(f"{req.sql} LIMIT {req.max_rows}").fetchall()
                columns = [col[0] for col in conn.description] if conn.description else []
                data = [dict(zip(columns, row)) for row in limited_result]
                row_count = len(limited_result)
            
            return ExecuteResponse(
                success=True,
                data=data,
                columns=columns,
                row_count=row_count,
                execution_time=round(elapsed, 2),
                truncated=truncated,
            )
        finally:
            # Don't close the connection - it's cached
            pass
            
    except HTTPException:
        raise
    except Exception as e:
        return ExecuteResponse(
            success=False,
            error=str(e),
        )

@app.post("/api/sql/catalog")
def get_catalog():
    """Get catalog of tables/views/columns for autocomplete."""
    try:
        conn = get_db()
        catalog = {"tables": [], "views": [], "columns": {}}

        # DuckDB: duckdb_tables() / duckdb_views() work better than information_schema
        try:
            rows = conn.execute(
                "SELECT table_name FROM duckdb_tables() WHERE schema_name='main' OR schema_name='public'"
            ).fetchall()
        except Exception:
            rows = conn.execute("SHOW TABLES").fetchall()

        names = [r[0] for r in rows]

        # Só tabelas reais (sem internas sqlite_*/duckdb_*)
        names = [
            n for n in names
            if not any(n.startswith(p) for p in ("duckdb_", "sqlite_", "pragma_"))
        ]

        try:
            view_rows = conn.execute(
                "SELECT view_name FROM duckdb_views() WHERE schema_name='main' OR schema_name='public'"
            ).fetchall()
            # Excluir views internas (duckdb_*, sqlite_*, pragma_*) do autocomplete
            view_names = [
                r[0] for r in view_rows
                if not any(r[0].startswith(p) for p in ("duckdb_", "sqlite_", "pragma_"))
            ]
        except Exception:
            view_names = []

        for name in names + view_names:
            if name in view_names:
                catalog["views"].append(name)
            else:
                catalog["tables"].append(name)

            try:
                cols = conn.execute(f'DESCRIBE "{name}"').fetchall()
                catalog["columns"][name] = [c[0] for c in cols]
            except Exception:
                pass

        return catalog

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro ao carregar catálogo: {str(e)}")

@app.post("/api/saved-queries")
def save_query(req: SavedQueryRequest):
    """Save a query locally (MVP - storage in file)."""
    import json
    queries_file = QUERIES_FILE
    
    queries = {}
    if os.path.exists(queries_file):
        with open(queries_file, "r") as f:
            queries = json.load(f)
    
    queries[req.name] = {"sql": req.sql, "description": req.description or ""}
    
    with open(queries_file, "w") as f:
        json.dump(queries, f, ensure_ascii=False, indent=2)
    
    return {"status": "saved", "name": req.name}

@app.post("/api/saved-queries/list")
def list_queries():
    """List saved queries."""
    import os, json
    queries_file = QUERIES_FILE
    
    if os.path.exists(queries_file):
        with open(queries_file, "r") as f:
            return json.load(f)
    return {}

@app.post("/api/sql/stream")
def sql_stream(req: ExecuteRequest):
    """Stream query results via SSE (Server-Sent Events)."""
    import json as _json
    from fastapi.responses import StreamingResponse

    # Validate before streaming (FR-005/006 guardrails)
    validate_sql(req.sql)

    conn = duckdb.connect(DB_PATH, read_only=True)
    try:
        results = conn.execute(req.sql).fetchall()
        columns = [col[0] for col in conn.description] if conn.description else []
        row_count = len(results)
        max_rows = req.max_rows or 5000
        display_results = results[:max_rows]
        truncated = row_count > max_rows
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Erro na query: {e}")

    def event_generator():
        try:
            yield "event: metadata\n"
            yield "data: " + _json.dumps(
                {
                    "columns": columns,
                    "row_count": row_count,
                    "truncated": truncated,
                },
                ensure_ascii=False,
            ) + "\n\n"

            for i, row in enumerate(display_results):
                yield "event: row\n"
                yield "data: " + _json.dumps(
                    {"row_num": i + 1, "data": dict(zip(columns, row))},
                    ensure_ascii=False,
                    default=str,
                ) + "\n\n"

            yield "event: complete\n"
            yield "data: " + _json.dumps(
                {"row_count": row_count, "truncated": truncated},
                ensure_ascii=False,
            ) + "\n\n"
        finally:
            conn.close()

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# ----------- Assistente IA -----------

@app.post("/api/ai/ask")
def ai_ask(req: AiRequest):
    """Responde uma pergunta em linguagem natural via Text-to-SQL."""
    from ai import get_assistant

    try:
        return get_assistant().ask(req.question, max_rows=req.max_rows)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.post("/api/ai/stream")
def ai_stream(req: AiRequest):
    """Chat Text-to-SQL com eventos SSE.

    Eventos: status · sql · metadata · row · final · error
    """
    import json as _json

    from fastapi.responses import StreamingResponse

    from ai import get_assistant

    def evento(nome: str, dados: dict) -> str:
        return (
            f"event: {nome}\n"
            f"data: {_json.dumps(dados, ensure_ascii=False, default=str)}\n\n"
        )

    def gerar():
        yield evento("status", {"stage": "interpretando_pergunta"})
        try:
            assistente = get_assistant()
            yield evento("status", {"stage": "gerando_sql"})
            resultado = assistente.ask(req.question, max_rows=req.max_rows)

            if resultado.get("sql"):
                yield evento("sql", {"sql": resultado["sql"]})
            if not resultado.get("success"):
                yield evento("error", {
                    "detail": resultado.get("error") or "Não foi possível responder.",
                    "sql": resultado.get("sql"),
                    "attempts": resultado.get("attempts"),
                })
                return

            yield evento("metadata", {
                "columns": resultado["columns"],
                "row_count": resultado["row_count"],
                "truncated": resultado["truncated"],
                "execution_time": resultado["execution_time"],
                "attempts": resultado["attempts"],
            })
            colunas = resultado["columns"]
            for i, linha in enumerate(resultado["rows"]):
                yield evento("row", {"row_num": i + 1, "data": dict(zip(colunas, linha))})
            yield evento("final", {
                "text": resultado["text"],
                "sql": resultado["sql"],
                "row_count": resultado["row_count"],
                "truncated": resultado["truncated"],
                "execution_time": resultado["execution_time"],
            })
        except Exception as exc:
            yield evento("error", {"detail": str(exc)})

    return StreamingResponse(
        gerar(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/ai/status")
def ai_status():
    """Estado do assistente: modelo, views disponíveis e nº de arquivos."""
    from ai import get_assistant

    assistente = get_assistant()
    return {
        "model": assistente.llm.model,
        "ollama_url": assistente.llm.base_url,
        "views": assistente.db.views,
        "max_rows": assistente.max_rows,
    }


# ----------- Dashboard -----------

@app.get("/api/dashboard/stats")
def dashboard_stats():
    """Agregações para o Dashboard (KPI cards + gráficos).

    Contrato:
    totals: {records, value, tables, municipalities}
    by_year: [{year, records, value}]
    by_municipality: [{municipality, records, value}]
    by_document_type: [{type, records, value}]
    """
    try:
        conn = get_db()

        # Lista as tabelas reais (schema main, sem internas)
        rows = conn.execute(
            "SELECT table_name FROM duckdb_tables() WHERE schema_name IN ('main', 'public')"
        ).fetchall()
        tables = [
            r[0] for r in rows
            if not any(r[0].startswith(p) for p in ("duckdb_", "sqlite_", "pragma_"))
        ]
        tables.sort()

        if not tables:
            return {
                "totals": {"records": 0, "value": 0.0, "tables": 0, "municipalities": 0},
                "by_year": [],
                "by_municipality": [],
                "by_document_type": [],
            }

        # Totals — uma única query com UNION ALL
        count_parts = " UNION ALL ".join(
            f"SELECT COUNT(*) AS cnt, COALESCE(SUM(valor), 0) AS val FROM \"{t}\""
            for t in tables
        )
        recs, val = conn.execute(
            f"SELECT COALESCE(SUM(cnt), 0), COALESCE(SUM(val), 0) FROM ({count_parts})"
        ).fetchone()

        # Municípios distintos
        muni_parts = " UNION ALL ".join(
            f"SELECT DISTINCT municipio_referencia AS m FROM \"{t}\"" for t in tables
        )
        muni_count = conn.execute(
            f"SELECT COUNT(DISTINCT m) FROM ({muni_parts}) WHERE m IS NOT NULL"
        ).fetchone()[0]

        # by_year
        year_parts = " UNION ALL ".join(
            f"SELECT exercicio_orcamento AS y, 1 AS c, COALESCE(valor, 0) AS v FROM \"{t}\""
            for t in tables
        )
        by_year = [
            {"year": int(r[0]), "records": int(r[1]), "value": float(r[2])}
            for r in conn.execute(
                f"SELECT y, COUNT(*), SUM(v) FROM ({year_parts}) "
                f"WHERE y IS NOT NULL GROUP BY y ORDER BY y"
            ).fetchall()
        ]

        # by_municipality
        muni_parts2 = " UNION ALL ".join(
            f"SELECT municipio_referencia AS m, 1 AS c, COALESCE(valor, 0) AS v FROM \"{t}\""
            for t in tables
        )
        by_municipality = [
            {"municipality": str(r[0]), "records": int(r[1]), "value": float(r[2])}
            for r in conn.execute(
                f"SELECT m, COUNT(*), SUM(v) FROM ({muni_parts2}) "
                f"WHERE m IS NOT NULL GROUP BY m ORDER BY SUM(v) DESC"
            ).fetchall()
        ]

        # by_document_type (uma contagem por tabela)
        dt_parts = " UNION ALL ".join(
            f"SELECT '{t}' AS tp, COUNT(*) AS c, COALESCE(SUM(valor), 0) AS v FROM \"{t}\""
            for t in tables
        )
        by_document_type = [
            {"type": str(r[0]), "records": int(r[1]), "value": float(r[2])}
            for r in conn.execute(
                f"SELECT tp, c, v FROM ({dt_parts}) ORDER BY c DESC"
            ).fetchall()
        ]

        return {
            "totals": {
                "records": int(recs),
                "value": float(val),
                "tables": len(tables),
                "municipalities": int(muni_count),
            },
            "by_year": by_year,
            "by_municipality": by_municipality,
            "by_document_type": by_document_type,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro no dashboard: {str(e)}")


# ----------- Pesquisa Interativa -----------

import json as _json
import datetime as _dt
import glob as _glob
import re as _re
from decimal import Decimal as _Decimal

_search_config_cache: Optional[Dict[str, Any]] = None

# Colunas de fornecedor candidatas a busca por CNPJ/razão social
_SUPPLIER_COLS = [
    "nome_negociante", "numero_documento_negociante", "nome_fornecedor",
    "cpf_cnpj_emitente", "nome_emitente", "razao_social",
    "nome_responsavel_pagamento", "nome_razao_prestador", "nome_locador",
    "nome_credor_despesa_extra", "orgao", "nome_servidor_responsavel",
    "nome_responsavel_liquidacao",
]


def _load_search_config() -> Dict[str, Any]:
    """Carrega endpoints.json + municipios.json (cache em memória)."""
    global _search_config_cache
    if _search_config_cache is None:
        try:
            with open(ENDPOINTS_FILE, encoding="utf-8") as f:
                endpoints = _json.load(f)
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"endpoints.json não encontrado em {ENDPOINTS_FILE}: {e}",
            )
        try:
            with open(MUNICIPIOS_FILE, encoding="utf-8") as f:
                municipios = _json.load(f)
        except Exception:
            municipios = {"elements": []}
        _search_config_cache = {"endpoints": endpoints, "municipios": municipios}
    return _search_config_cache


@app.get("/api/search/config")
def search_config():
    """Config para a Pesquisa Interativa: categorias, municípios e anos."""
    cfg = _load_search_config()

    categories = []
    for name, c in cfg["endpoints"].items():
        categories.append({
            "name": name,
            "prefixo": c.get("prefixo"),
            "campos_ui": c.get("campos_ui", []),
            "colunas_texto": c.get("colunas_texto", {}),
            "layout_card": c.get("layout_card") or {},
        })

    municipalities = [
        {"code": m.get("codigo_municipio"), "name": m.get("nome_municipio")}
        for m in cfg["municipios"].get("elements", [])
    ]
    current = _dt.date.today().year
    return {
        "categories": categories,
        "municipalities": municipalities,
        "years": list(range(2008, current + 2)),
    }


def _serialize_row(row):
    out = []
    for v in row:
        if isinstance(v, _Decimal):
            out.append(float(v))
        elif isinstance(v, (_dt.date, _dt.datetime)):
            out.append(v.isoformat())
        else:
            out.append(v)
    return out


def _parquet_dirs():
    """Data lake local: dataset real (ro) + cache gravável de recortes sob demanda."""
    return [d for d in (PARQUET_DIR, CACHE_PARQUET_DIR) if d and os.path.isdir(d)]


def _parquet_files(prefixo: str, year_from: int, year_to: int, municipality: str):
    """Lista arquivos parquet com pruning por nome (ano/município).

    O dataset real é particionado no nome: {prefixo}_{ano}_{mes}[_{codigo}].parquet
    — filtrar pelo glob evita abrir os 31k arquivos.
    Arquivos corrompidos já detectados são excluídos.
    """
    files = set()
    for base in _parquet_dirs():
        for ano in range(year_from, year_to + 1):
            if municipality and municipality != "all":
                code = str(municipality).zfill(3)
                files.update(_glob.glob(os.path.join(base, f"{prefixo}_{ano}_*_{code}.parquet")))
                files.update(_glob.glob(os.path.join(base, f"{prefixo}_{ano}_{code}.parquet")))
            else:
                files.update(_glob.glob(os.path.join(base, f"{prefixo}_{ano}_*.parquet")))
                files.update(_glob.glob(os.path.join(base, f"{prefixo}_{ano}.parquet")))
    return sorted(f for f in files if f not in _BAD_PARQUET_FILES)


def _prefix_has_files(prefixo: str) -> bool:
    """Existe qualquer arquivo do prefixo no data lake local (o seed é último recurso)?"""
    return any(
        _glob.glob(os.path.join(base, f"{prefixo}_*.parquet"))
        for base in _parquet_dirs()
    )


def _recorte_filename(prefixo: str, ano: int, mes, code: str) -> str:
    if mes is None:
        return f"{prefixo}_{ano}_{code}.parquet"
    return f"{prefixo}_{ano}_{mes:02d}_{code}.parquet"


def _recorte_presente(prefixo: str, ano: int, mes, code: str) -> bool:
    """Arquivo baixado ou marcador de cache negativo (.empty) já existem?"""
    nome = _recorte_filename(prefixo, ano, mes, code)
    for base in _parquet_dirs():
        if os.path.exists(os.path.join(base, nome)) or os.path.exists(
            os.path.join(base, nome + ".empty")
        ):
            return True
    return False


def _recortes_do_intervalo(prefixo: str, freq: str, anos, code: str):
    """Recortes (ano, mes) do intervalo pedido. Anual não tem mês; ano corrente: até o mês atual."""
    hoje = _dt.date.today()
    for ano in anos:
        if freq == "anual":
            yield ano, None
        else:
            mes_max = 12 if ano < hoje.year else hoje.month
            for mes in range(1, mes_max + 1):
                yield ano, mes


def _resolve_source(cat: dict, prefixo: str, req: "SearchRequest", cfg: dict):
    """Resolve a fonte local e baixa da API TCE apenas os recortes ausentes.

    Spec 2.1 (local-first): cache hit serve na hora; miss baixa só o recorte
    faltante. TCE fora do ar → serve o que existe local; nunca falha por rede.
    Retorna (file_list | None, fetched, fetch_error, fetch_pending).
    """
    file_list = (
        _parquet_files(prefixo, req.year_from, req.year_to, req.municipality)
        if _prefix_has_files(prefixo)
        else None
    )

    fetched, fetch_error, pending = [], None, 0
    munis = {
        m.get("codigo_municipio"): m.get("nome_municipio")
        for m in cfg["municipios"].get("elements", [])
    }
    pode_baixar = (
        TCE_FETCH_ENABLED
        and _tce is not None
        and req.municipality
        and req.municipality != "all"
        and req.municipality in munis  # código válido (evita fetch de código inexistente)
        and cat.get("endpoint")
        and (cat.get("parametros_obrigatorios") or [])
    )
    if not pode_baixar:
        return file_list, fetched, fetch_error, pending

    freq = str(cat.get("frequencia") or "mensal").lower()
    code = str(req.municipality).zfill(3)
    anos = list(range(req.year_from, req.year_to + 1))
    faltantes = [
        (a, m)
        for a, m in _recortes_do_intervalo(prefixo, freq, anos, code)
        if not _recorte_presente(prefixo, a, m, code)
    ]

    if faltantes:
        try:
            os.makedirs(CACHE_PARQUET_DIR, exist_ok=True)
            gravavel = os.access(CACHE_PARQUET_DIR, os.W_OK)
        except OSError:
            gravavel = False
        if not gravavel:
            fetch_error = f"cache local não gravável: {CACHE_PARQUET_DIR}"
        else:
            nome_mun = munis.get(req.municipality) or f"COD {code}"
            deadline = _time.monotonic() + TCE_FETCH_BUDGET_SECONDS
            for i, (ano, mes) in enumerate(faltantes):
                if i >= TCE_FETCH_MAX_RECORTES or _time.monotonic() > deadline:
                    pending = len(faltantes) - i
                    break
                nome_arquivo = _recorte_filename(prefixo, ano, mes, code)
                caminho = os.path.join(CACHE_PARQUET_DIR, nome_arquivo)
                try:
                    rows, erro = _tce.baixar_recorte(
                        cat["endpoint"],
                        cat["parametros_obrigatorios"],
                        ano,
                        code,
                        mes,
                        nome_mun,
                        deadline,
                    )
                except Exception as e:  # nunca derruba a busca por erro de rede
                    rows, erro = [], f"{type(e).__name__}: {e}"
                if erro and not rows:
                    fetch_error = erro
                    pending = len(faltantes) - i
                    break
                try:
                    if _tce.salvar_recorte(rows, caminho, ano) == "BAIXADO":
                        fetched.append(nome_arquivo)
                except Exception as e:
                    fetch_error = f"falha ao gravar {nome_arquivo}: {e}"
                    break

    # Re-resolve a fonte com o que acabou de ser baixado/marcado
    file_list = (
        _parquet_files(prefixo, req.year_from, req.year_to, req.municipality)
        if _prefix_has_files(prefixo)
        else None
    )
    if file_list is None and any(
        _recorte_presente(prefixo, a, m, code)
        for a, m in _recortes_do_intervalo(prefixo, freq, anos, code)
    ):
        file_list = []  # só marcadores de vazio → resposta vazia legítima (não cai no seed)
    return file_list, fetched, fetch_error, pending


def _read_parquet_sql(files) -> str:
    quoted = ", ".join("'" + p.replace("'", "''") + "'" for p in files)
    return f"read_parquet([{quoted}], union_by_name=True)"


def _bad_file_from_error(err) -> str:
    """Extrai o path do arquivo corrompido da mensagem do DuckDB."""
    m = _re.search(r"Failed to read Parquet file '([^']+)'", str(err))
    return m.group(1) if m else ""


@app.post("/api/search")
def search(req: SearchRequest):
    """Pesquisa interativa: filtros dinâmicos + busca geral + fornecedor.

    Somente SELECT parametrizado contra a tabela da categoria (whitelist).
    """
    cfg = _load_search_config()
    endpoints = cfg["endpoints"]
    if req.category not in endpoints:
        raise HTTPException(status_code=404, detail=f"Categoria desconhecida: {req.category}")

    cat = endpoints[req.category]
    table = cat.get("prefixo")
    if not table:
        raise HTTPException(status_code=500, detail=f"Categoria sem prefixo: {req.category}")

    if req.year_from > req.year_to:
        raise HTTPException(status_code=400, detail="Ano inicial não pode ser maior que o final.")

    conn = get_db()

    # ---------- Fonte: data lake local + fetch sob demanda da API (Spec 2.1) ----------
    # Local-first: só chama o TCE para recortes ausentes no data lake local.
    from_sql = f'"{table}"'
    source = "seed"
    file_list, fetched_now, fetch_error, fetch_pending = _resolve_source(
        cat, table, req, cfg
    )

    if file_list is not None:
        source = "parquet"
        # Descobre o schema; arquivos corrompidos entram na blocklist e são excluídos
        while True:
            if not file_list:
                # Nenhum arquivo real para o recorte → resposta vazia de verdade
                return {
                    "category": req.category,
                    "table": table,
                    "count": 0,
                    "returned": 0,
                    "columns": [],
                    "rows": [],
                    "source": source,
                    "fetched": fetched_now,
                    "fetch_error": fetch_error,
                    "fetch_pending": fetch_pending,
                }
            from_sql = _read_parquet_sql(file_list)
            try:
                desc = conn.execute(f"DESCRIBE SELECT * FROM {from_sql}").fetchall()
                break
            except Exception as e:
                bad = _bad_file_from_error(e)
                if bad and bad in file_list:
                    _BAD_PARQUET_FILES.add(bad)
                    file_list = [f for f in file_list if f != bad]
                    continue
                raise HTTPException(status_code=400, detail=f"Erro ao ler parquet: {e}")
    else:
        # Whitelist: a tabela seed precisa existir no banco
        existing = {
            r[0]
            for r in conn.execute(
                "SELECT table_name FROM duckdb_tables() WHERE schema_name IN ('main', 'public')"
            ).fetchall()
        }
        if table not in existing:
            raise HTTPException(
                status_code=404,
                detail=f"Tabela '{table}' não existe no banco. Execute: python3 create_db.py",
            )
        desc = conn.execute(f"DESCRIBE SELECT * FROM {from_sql}").fetchall()

    columns = [d[0] for d in desc]
    col_types = {d[0]: str(d[1]).upper() for d in desc}
    text_cols = [
        c for c in columns
        if any(t in col_types[c] for t in ("VARCHAR", "TEXT", "STRING"))
    ]

    where, params = [], []

    # 1. Período — a coluna de ano varia por dataset (notas_empenho tem
    # exercicio_orcamento; veiculos só data_referencia_doc) e com dois encodings:
    # seed (2025), real TCE (202500 = ano*100) e YYYYMM (202501)
    if "exercicio_orcamento" in columns:
        where.append(
            "(exercicio_orcamento BETWEEN ? AND ?"
            " OR exercicio_orcamento BETWEEN ? AND ?)"
        )
        params += [
            req.year_from,
            req.year_to,
            req.year_from * 100,
            req.year_to * 100 + 99,
        ]
    elif "data_referencia_doc" in columns:
        where.append("TRY_CAST(data_referencia_doc AS BIGINT) BETWEEN ? AND ?")
        params += [req.year_from * 100, req.year_to * 100 + 99]
    # sem coluna de ano → o pruning por nome de arquivo (ano no filename) já limita

    # 2. Município (codigo_municipio no dado real/cache; municipio_referencia no seed)
    if req.municipality and req.municipality != "all":
        if "codigo_municipio" in columns:
            where.append("LPAD(CAST(codigo_municipio AS VARCHAR), 3, '0') = ?")
            params.append(str(req.municipality).zfill(3))
        elif "municipio_referencia" in columns:
            munis = {
                m.get("codigo_municipio"): m.get("nome_municipio")
                for m in cfg["municipios"].get("elements", [])
            }
            nome = munis.get(req.municipality)
            if nome:
                where.append("UPPER(COALESCE(municipio_referencia, '')) = UPPER(?)")
                params.append(nome)
            else:
                where.append("1 = 0")  # código inválido → sem resultados
        # sem coluna de município → o pruning por nome de arquivo já limita (como no original)

    # 3. Filtros dinâmicos (apenas colunas existentes na tabela)
    campos_ui = {c.get("id"): c for c in cat.get("campos_ui", [])}
    for col, val in (req.filters or {}).items():
        if col not in columns or val in (None, "", "TODOS", "TODOS "):
            continue
        tipo = (campos_ui.get(col) or {}).get("tipo", "text")
        if tipo == "number":
            try:
                num = float(val)
            except (TypeError, ValueError):
                continue
            if num > 0:
                where.append(f'"{col}" >= ?')
                params.append(num)
        elif tipo == "select":
            where.append(f'UPPER("{col}") = UPPER(?)')
            params.append(str(val))
        else:
            where.append(f'"{col}" ILIKE ?')
            params.append(f"%{val}%")

    # 4. Busca geral (OR sobre colunas de texto)
    general = req.general_search.strip()
    if general:
        term = f"%{general}%"
        ors = [f'"{c}" ILIKE ?' for c in text_cols]
        if ors:
            where.append("(" + " OR ".join(ors) + ")")
            params.extend([term] * len(text_cols))

    # 5. Fornecedor (termos separados por vírgula = E entre termos, OU entre colunas)
    supplier = req.supplier_search.strip()
    if supplier:
        sup_cols = [c for c in _SUPPLIER_COLS if c in columns] or text_cols
        term_groups = []
        for t in (x.strip() for x in supplier.split(",") if x.strip()):
            term_groups.append("(" + " OR ".join(f'"{c}" ILIKE ?' for c in sup_cols) + ")")
            params.extend([f"%{t}%"] * len(sup_cols))
        if term_groups:
            where.append("(" + " OR ".join(term_groups) + ")")

    where_sql = " AND ".join(where)

    # match_reason: qual coluna de texto casou com a busca geral (como o original)
    match_params: list = []
    case_parts = []
    if general:
        for col, label in cat.get("colunas_texto", {}).items():
            if col in text_cols:
                case_parts.append(f'WHEN "{col}" ILIKE ? THEN ?')
                match_params.extend([f"%{general}%", str(label)])
    match_expr = (
        "CASE " + " ".join(case_parts) + " ELSE '' END AS match_reason"
        if case_parts
        else "'' AS match_reason"
    )

    # Ordenação: pela coluna de ano existente (schema varia por dataset)
    if "exercicio_orcamento" in columns:
        order_col = "exercicio_orcamento"
    elif "data_referencia_doc" in columns:
        order_col = "TRY_CAST(data_referencia_doc AS BIGINT)"
    else:
        order_col = None
    if order_col:
        order_sql = f"{order_col} DESC"
        if "id" in columns:
            order_sql += ", id ASC"
    else:
        order_sql = "id ASC" if "id" in columns else None

    limit = max(1, min(req.limit or 500, 500))
    while True:
        try:
            total = conn.execute(
                f"SELECT COUNT(*) FROM {from_sql} WHERE {where_sql}", params
            ).fetchone()[0]

            order_clause = f"ORDER BY {order_sql} " if order_sql else ""
            result = conn.execute(
                f"SELECT *, {match_expr} FROM {from_sql} "
                f"WHERE {where_sql} "
                f"{order_clause}"
                f"LIMIT ?",
                match_params + params + [limit],
            ).fetchall()
            break
        except Exception as e:
            bad = _bad_file_from_error(e) if source == "parquet" else ""
            if bad and bad in (file_list or []):
                _BAD_PARQUET_FILES.add(bad)
                file_list = [f for f in file_list if f != bad]
                if not file_list:
                    return {
                        "category": req.category,
                        "table": table,
                        "count": 0,
                        "returned": 0,
                        "columns": [],
                        "rows": [],
                        "source": source,
                        "fetched": fetched_now,
                        "fetch_error": fetch_error,
                        "fetch_pending": fetch_pending,
                    }
                from_sql = _read_parquet_sql(file_list)
                continue
            raise HTTPException(status_code=400, detail=f"Erro na pesquisa: {e}")

    rows = [dict(zip(columns + ["match_reason"], _serialize_row(r))) for r in result]

    return {
        "category": req.category,
        "table": table,
        "count": int(total),
        "returned": len(rows),
        "columns": columns + ["match_reason"],
        "rows": rows,
        "source": source,
        "fetched": fetched_now,
        "fetch_error": fetch_error,
        "fetch_pending": fetch_pending,
    }


# Health endpoint
@app.get("/health")
def health():
    return {"status": "ok", "message": "SQL Studio API is running"}
