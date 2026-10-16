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

# ----------- Constants -----------

import os

# Works both locally and inside Docker (env DUCKDB_PATH overrides)
_here = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get(
    "DUCKDB_PATH",
    os.path.join(os.path.dirname(_here), "data", "tce_analysis.duckdb"),
)
QUERIES_FILE = os.environ.get(
    "SAVED_QUERIES_FILE",
    os.path.join(os.path.dirname(DB_PATH), "saved_queries.json"),
)
# Fallback to /tmp if the data dir is read-only (e.g. Docker :ro mount)
if not os.access(os.path.dirname(QUERIES_FILE), os.W_OK):
    QUERIES_FILE = "/tmp/saved_queries.json"

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

# Health endpoint
@app.get("/health")
def health():
    return {"status": "ok", "message": "SQL Studio API is running"}