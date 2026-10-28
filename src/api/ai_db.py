"""Camada de dados dedicada do Assistente IA.

DuckDB **in-memory** com views somente-leitura sobre os Parquets reais do TCE-CE.
Não compartilha conexão com o SQL Studio (`get_db`/seed) nem com a Pesquisa:
cada categoria habilitada vira uma view nomeada pelo `prefixo` do endpoints.json.

Por construção, a única coisa exposta é `read_parquet(...)` — não há tabela base
gravável. Ainda assim, o executor da IA deve rodar apenas SQL pré-validado
(allowlist de tabelas + bloqueio de funções de arquivo/rede), como segunda camada.

Variáveis de ambiente (com defaults seguros):
  AI_CATEGORIES       prefixos separados por vírgula
                      (default: notas_empenho,notas_fiscais,liquidacoes)
  PARQUET_DIR         dataset real (default /parquet)
  CACHE_PARQUET_DIR   cache sob demanda (default <repo>/data/cache)
  AI_MEMORY_LIMIT     limite do DuckDB em MB (default 1536)
  AI_TEMP_DIR         diretório de spill (default /tmp/duckdb_ai)
  AI_QUERY_TIMEOUT    timeout por consulta em segundos (default 30)
  AI_MIN_FILE_BYTES   parquets menores que isso são ignorados (default 3072;
                      os 12 arquivos 0-coluna conhecidos têm ~1012 B)
"""

from __future__ import annotations

import glob
import os
import re
import threading
import time
from typing import Iterable, Optional

import duckdb

DEFAULT_CATEGORIES = ("notas_empenho", "notas_fiscais", "liquidacoes")

_BAD_FILE_PATTERNS = (
    re.compile(r"Failed to read Parquet file '([^']+)'"),
    re.compile(r"Footer length error in file '([^']+)'"),
    re.compile(r'No magic bytes found at tail of file "([^"]+)"'),
    re.compile(r"File '([^']+\.parquet)' is not a valid Parquet file"),
)


def _quote_path(path: str) -> str:
    return "'" + path.replace("'", "''") + "'"


def _bad_file_from_error(error: BaseException) -> str:
    texto = str(error)
    for pattern in _BAD_FILE_PATTERNS:
        match = pattern.search(texto)
        if match:
            return match.group(1)
    return ""


class AiDatabase:
    """Conexão DuckDB dedicada do assistente, com views por categoria."""

    def __init__(
        self,
        prefixes: Iterable[str] = DEFAULT_CATEGORIES,
        parquet_dirs: Iterable[str] = ("/parquet",),
        *,
        memory_limit_mb: int = 1536,
        temp_dir: Optional[str] = "/tmp/duckdb_ai",
        query_timeout: float = 30.0,
        min_file_bytes: int = 3072,
    ) -> None:
        self.prefixes = sorted({p.strip() for p in prefixes if p and p.strip()})
        self.parquet_dirs = [d for d in parquet_dirs if d and os.path.isdir(d)]
        self.query_timeout = float(query_timeout)
        self.min_file_bytes = int(min_file_bytes)

        self._conn = duckdb.connect(":memory:")
        self._conn.execute(f"SET memory_limit='{int(memory_limit_mb)}MB'")
        if temp_dir:
            os.makedirs(temp_dir, exist_ok=True)
            self._conn.execute(f"SET temp_directory={_quote_path(temp_dir)}")

        self._lock = threading.Lock()
        self._blocked: set[str] = set()
        self._files: dict[str, list[str]] = {}
        self._views: dict[str, list[str]] = {}
        self._schema_cache: dict[str, list[tuple[str, str]]] = {}
        self._refresh_views()

    # ---------------- inventário ----------------

    def _list_files(self, prefix: str) -> list[str]:
        """Parquets do prefixo, deduplicados por nome (primeiro diretório vence)."""
        vistos: set[str] = set()
        arquivos: list[str] = []
        for base in self.parquet_dirs:
            for path in sorted(glob.glob(os.path.join(base, f"{prefix}_*.parquet"))):
                nome = os.path.basename(path)
                if nome in vistos:
                    continue
                vistos.add(nome)
                if path in self._blocked:
                    continue
                try:
                    if os.path.getsize(path) < self.min_file_bytes:
                        continue
                except OSError:
                    continue
                arquivos.append(path)
        return arquivos

    def _refresh_views(self, max_saneamento: int = 50) -> None:
        """(Re)cria as views, excluindo parquets corrompidos detectados no bind.

        O `CREATE VIEW` já lê os footers; um arquivo inválido falha aqui. Nesse
        caso, ele entra na blocklist e a construção recomeça.
        """
        for _ in range(max_saneamento):
            try:
                self._build_views()
                return
            except Exception as exc:
                bad = _bad_file_from_error(exc)
                if not bad or bad in self._blocked:
                    raise
                self._blocked.add(bad)
        raise RuntimeError("limite de saneamento de parquets corrompidos excedido")

    def _build_views(self) -> None:
        self._files.clear()
        self._views.clear()
        self._schema_cache.clear()
        for prefix in self.prefixes:
            arquivos = self._list_files(prefix)
            self._files[prefix] = arquivos
            if not arquivos:
                continue
            lista = "[" + ",".join(_quote_path(p) for p in arquivos) + "]"
            self._conn.execute(
                f'CREATE OR REPLACE VIEW "{prefix}" AS '
                f"SELECT * FROM read_parquet({lista}, union_by_name=true)"
            )
            self._views[prefix] = arquivos

    def refresh(self) -> None:
        """Relê o data lake (novos parquets) e recria as views."""
        with self._lock:
            self._refresh_views()

    # ---------------- metadados ----------------

    @property
    def views(self) -> dict[str, int]:
        """Views disponíveis e quantidade de arquivos de cada uma."""
        return {p: len(f) for p, f in self._views.items()}

    def list_files(self, prefix: str) -> list[str]:
        return list(self._files.get(prefix, []))

    def schema(self, prefix: str) -> list[tuple[str, str]]:
        """Colunas (nome, tipo) da view — calculado sob demanda e cacheado."""
        if prefix not in self._views:
            return []
        if prefix in self._schema_cache:
            return self._schema_cache[prefix]
        with self._lock:
            if prefix in self._schema_cache:
                return self._schema_cache[prefix]
            rows = self._conn.execute(f'DESCRIBE SELECT * FROM "{prefix}"').fetchall()
            self._schema_cache[prefix] = [(r[0], str(r[1])) for r in rows]
            return self._schema_cache[prefix]

    def schemas(self) -> dict[str, list[tuple[str, str]]]:
        return {prefix: self.schema(prefix) for prefix in self._views}

    # ---------------- execução ----------------

    def execute(
        self,
        sql: str,
        *,
        timeout: Optional[float] = None,
        _retry_bad_file: bool = True,
    ) -> tuple[list[str], list[tuple]]:
        """Executa SQL já validado e devolve (colunas, linhas).

        Serializa o uso da conexão e aplica timeout via `interrupt()`.
        Em erro de parquet corrompido, exclui o arquivo e tenta uma vez de novo.
        """
        try:
            return self._execute_once(sql, timeout)
        except Exception as exc:
            if _retry_bad_file:
                bad = _bad_file_from_error(exc)
                if bad and self._excluir_arquivo(bad):
                    return self._execute_once(sql, timeout)
            raise

    def _execute_once(self, sql: str, timeout: Optional[float]) -> tuple[list[str], list[tuple]]:
        limite = self.query_timeout if timeout is None else float(timeout)
        with self._lock:
            if not _file_funcs_bloqueadas(sql):
                raise PermissionError(
                    "Uso de funções de arquivo/rede não é permitido na camada de dados da IA."
                )
            resultado: dict = {}

            def _run() -> None:
                try:
                    cur = self._conn.execute(sql)
                    resultado["cols"] = [d[0] for d in cur.description] if cur.description else []
                    resultado["rows"] = cur.fetchall()
                except BaseException as exc:  # repassa para a thread principal
                    resultado["error"] = exc

            thread = threading.Thread(target=_run, daemon=True)
            thread.start()
            thread.join(limite)
            if thread.is_alive():
                self._conn.interrupt()
                thread.join(5.0)
                raise TimeoutError(f"consulta excedeu o limite de {limite:g}s")
            if "error" in resultado:
                raise resultado["error"]
            return resultado["cols"], resultado["rows"]

    def _excluir_arquivo(self, path: str) -> bool:
        with self._lock:
            for prefix, arquivos in self._files.items():
                if path in arquivos:
                    self._blocked.add(path)
                    self._refresh_views()
                    return True
            return False


# `execute` recebe SQL já validado; este check é uma terceira barreira barata
# contra chamadas de arquivo/rede dentro de expressões.
_FUNCS_BLOQUEADAS = (
    "read_parquet(", "parquet_scan(", "read_csv(", "read_csv_auto(", "csv_scan(",
    "read_json(", "read_json_auto(", "read_ndjson(", "read_text(", "read_blob(",
    "glob(", "sniff_csv(", "delta_scan(", "iceberg_scan(", "postgres_scan(",
    "sqlite_scan(", "mysql_scan(", "http_get(", "http_post(",
)


def _file_funcs_bloqueadas(sql: str) -> bool:
    lowered = sql.lower()
    return not any(fn in lowered for fn in _FUNCS_BLOQUEADAS)


# ---------------- singleton de aplicação ----------------

_ai_db: Optional[AiDatabase] = None
_ai_db_lock = threading.Lock()


def _env_dirs() -> list[str]:
    raiz = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return [
        os.environ.get("PARQUET_DIR", "/parquet"),
        os.environ.get("CACHE_PARQUET_DIR", os.path.join(raiz, "data", "cache")),
    ]


def get_ai_db() -> AiDatabase:
    """Instância única (lazy) usada pelo backend da IA."""
    global _ai_db
    if _ai_db is None:
        with _ai_db_lock:
            if _ai_db is None:
                categorias = os.environ.get(
                    "AI_CATEGORIES", ",".join(DEFAULT_CATEGORIES)
                ).split(",")
                _ai_db = AiDatabase(
                    prefixes=categorias,
                    parquet_dirs=_env_dirs(),
                    memory_limit_mb=int(os.environ.get("AI_MEMORY_LIMIT", "1536")),
                    temp_dir=os.environ.get("AI_TEMP_DIR", "/tmp/duckdb_ai"),
                    query_timeout=float(os.environ.get("AI_QUERY_TIMEOUT", "30")),
                    min_file_bytes=int(os.environ.get("AI_MIN_FILE_BYTES", "3072")),
                )
    return _ai_db
