"""FastAPI backend for SQL Studio with Monaco Editor."""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import duckdb
import sqlglot
import time as _time
from typing import Optional, List, Dict, Any

app = FastAPI(title="SQL Studio API", version="0.1.0")

# CORS — frontend Next.js (3001) chama a API (9001) cross-origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:3000",
    ],
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


def _parquet_files(prefixo: str, year_from: int, year_to: int, municipality: str):
    """Lista arquivos parquet com pruning por nome (ano/município).

    O dataset real é particionado no nome: {prefixo}_{ano}_{mes}[_{codigo}].parquet
    — filtrar pelo glob evita abrir os 31k arquivos.
    Arquivos corrompidos já detectados são excluídos.
    """
    files = set()
    for ano in range(year_from, year_to + 1):
        if municipality and municipality != "all":
            code = str(municipality).zfill(3)
            files.update(_glob.glob(os.path.join(PARQUET_DIR, f"{prefixo}_{ano}_*_{code}.parquet")))
            files.update(_glob.glob(os.path.join(PARQUET_DIR, f"{prefixo}_{ano}_{code}.parquet")))
        else:
            files.update(_glob.glob(os.path.join(PARQUET_DIR, f"{prefixo}_{ano}_*.parquet")))
            files.update(_glob.glob(os.path.join(PARQUET_DIR, f"{prefixo}_{ano}.parquet")))
    return sorted(f for f in files if f not in _BAD_PARQUET_FILES)


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

    # ---------- Fonte: parquet real (lazy, zero-copy) ou tabela seed ----------
    from_sql = f'"{table}"'
    source = "seed"
    file_list = None
    if PARQUET_DIR and os.path.isdir(PARQUET_DIR):
        if _glob.glob(os.path.join(PARQUET_DIR, f"{table}_*.parquet")):
            file_list = _parquet_files(table, req.year_from, req.year_to, req.municipality)

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

    # 1. Período — cobre os dois encodings: seed (2025) e real TCE (202500 = ano*100)
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

    # 2. Município (municipio_referencia no seed; codigo_municipio no parquet real)
    if req.municipality and req.municipality != "all":
        munis = {
            m.get("codigo_municipio"): m.get("nome_municipio")
            for m in cfg["municipios"].get("elements", [])
        }
        nome = munis.get(req.municipality)
        if "municipio_referencia" in columns:
            if nome:
                where.append("UPPER(COALESCE(municipio_referencia, '')) = UPPER(?)")
                params.append(nome)
            else:
                where.append("1 = 0")  # código inválido → sem resultados
        elif "codigo_municipio" in columns:
            where.append("LPAD(CAST(codigo_municipio AS VARCHAR), 3, '0') = ?")
            params.append(str(req.municipality).zfill(3))
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

    order_sql = (
        "exercicio_orcamento DESC, id ASC"
        if "id" in columns
        else "exercicio_orcamento DESC"
    )

    limit = max(1, min(req.limit or 500, 500))
    while True:
        try:
            total = conn.execute(
                f"SELECT COUNT(*) FROM {from_sql} WHERE {where_sql}", params
            ).fetchone()[0]

            result = conn.execute(
                f"SELECT *, {match_expr} FROM {from_sql} "
                f"WHERE {where_sql} "
                f"ORDER BY {order_sql} "
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
    }


# Health endpoint
@app.get("/health")
def health():
    return {"status": "ok", "message": "SQL Studio API is running"}