"""Descoberta e validação de partições do lakehouse TCE-CE.

Contrato do consumidor (documentado em README.md):

- ler somente ``bronze/**``; ignorar ``_staging/``, ``*.tmp`` e caminhos que
  começam com ``_`` ou ``.``;
- o ``*.parquet.manifest.json`` é o commit: o Parquet só é aberto se o
  manifesto existir e for válido;
- validar ``content_sha256``, ``row_count`` e ``columns`` contra o manifesto;
- se a validação falhar, pular o arquivo e tentar de novo numa próxima
  execução (pode ser substituição em andamento);
- abrir sempre somente leitura; nunca escrever, mover ou apagar na árvore;
- atualidade = ``content_sha256`` + ``created_at`` do manifesto, nunca mtime.

Este módulo é a única porta de entrada para os dados do lakehouse. Pesquisa
(``main.py``) e Assistente (``ai_db.py``) não devem fazer glob direto em
``bronze`` — usam :func:`get_lakehouse` e :meth:`Lakehouse.files`.

Variáveis de ambiente:

  LAKEHOUSE_SOURCE   raiz do lakehouse dentro do container (default ``/lakehouse``)
  LAKEHOUSE_SCAN_TTL_SECONDS         cache da varredura de manifestos (default 30)
  LAKEHOUSE_VALIDATION_RETRY_SECONDS retry de manifesto inválido (default 30)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

DEFAULT_ROOT = "/lakehouse"
DEFAULT_SCAN_TTL = 30.0
DEFAULT_VALIDATION_RETRY = 30.0
_HASH_CHUNK = 1024 * 1024
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
# <endpoint>_<ano>[_<mes>]_<municipio>.parquet  (mês e município com 2/3 dígitos)
_FILENAME = re.compile(
    r"^(?P<endpoint>.+?)_(?P<year>\d{4})(?:_(?P<month>\d{2}))?_(?P<muni>\d{3})\.parquet$"
)
_SKIP_PREFIXES = ("_", ".")


@dataclass(frozen=True)
class Partition:
    """Uma partição bronze já validada contra o seu manifesto."""

    path: str
    endpoint: str
    year: int
    month: Optional[int]
    municipality: str
    content_sha256: str
    row_count: int
    columns: tuple[str, ...]
    size_bytes: Optional[int]
    created_at: Optional[str]
    manifest_path: str


@dataclass(frozen=True)
class Manifest:
    """Manifesto lido do disco, ainda não validado contra o Parquet."""

    path: str
    manifest_path: str
    endpoint: str
    year: int
    month: Optional[int]
    municipality: str
    content_sha256: str
    row_count: int
    columns: tuple[str, ...]
    size_bytes: Optional[int]
    created_at: Optional[str]


def _is_skipped(name: str) -> bool:
    return name.startswith(_SKIP_PREFIXES) or name.endswith(".tmp")


def _clean_int(value) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_manifest(manifest_path: Path, bronze: Path) -> Optional[Manifest]:
    """Lê e valida a *forma* do manifesto. Conteúdo do Parquet vem depois."""
    if _is_skipped(manifest_path.name):
        return None
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None

    sha = str(data.get("content_sha256") or "").strip().lower()
    if not _HEX64.match(sha):
        return None

    row_count = _clean_int(data.get("row_count"))
    columns = data.get("columns")
    if row_count is None or row_count < 0 or not isinstance(columns, list):
        return None
    columns = tuple(str(c) for c in columns)
    if not columns:
        # Parquet sem colunas não serve para nenhuma consulta.
        return None

    size_bytes = _clean_int(data.get("size_bytes"))
    if size_bytes is not None and size_bytes < 0:
        size_bytes = None

    # Nome do Parquet: campo `file` do manifesto ou o próprio nome do manifesto.
    file_name = os.path.basename(str(data.get("file") or "").strip())
    if not file_name or _is_skipped(file_name):
        file_name = manifest_path.name[: -len(".manifest.json")]
    parquet_path = manifest_path.parent / file_name
    try:
        parquet_path = parquet_path.resolve()
        parquet_path.relative_to(bronze)
    except (OSError, ValueError):
        return None

    parts = data.get("partition") if isinstance(data.get("partition"), dict) else {}
    endpoint = str(parts.get("endpoint_prefix") or "").strip()
    year = _clean_int(parts.get("year"))
    month = _clean_int(parts.get("month"))
    municipality = str(parts.get("municipality_code") or "").strip()

    # O caminho bronze/<endpoint>/<ano>/ é a fonte mais confiável.
    try:
        rel_parts = parquet_path.relative_to(bronze).parts
    except ValueError:
        return None
    if len(rel_parts) >= 3:
        # O diretório é a verdade do layout; o manifesto fornece só os metadados.
        endpoint = rel_parts[0]
        year = _clean_int(rel_parts[1])
        if len(rel_parts) >= 4:  # bronze/<endpoint>/<ano>/<mes>/...
            month = month if month is not None else _clean_int(rel_parts[2])

    match = _FILENAME.match(parquet_path.name)
    if match:
        endpoint = endpoint or match.group("endpoint")
        if year is None:
            year = _clean_int(match.group("year"))
        if month is None and match.group("month"):
            month = _clean_int(match.group("month"))
        if not municipality:
            municipality = match.group("muni")

    if not endpoint or year is None or not municipality:
        return None

    return Manifest(
        path=str(parquet_path),
        manifest_path=str(manifest_path),
        endpoint=endpoint,
        year=year,
        month=month,
        municipality=municipality.zfill(3),
        content_sha256=sha,
        row_count=row_count,
        columns=columns,
        size_bytes=size_bytes,
        created_at=(str(data.get("created_at")) if data.get("created_at") else None),
    )


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:  # somente leitura
        for chunk in iter(lambda: handle.read(_HASH_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _parquet_metadata(path: str) -> tuple[int, list[str]]:
    """(row_count, colunas) lidos só do footer; nunca carrega os dados."""
    try:
        import pyarrow.parquet as pq  # import local: dev sem pyarrow não quebra o módulo

        pf = pq.ParquetFile(path)  # read-only por padrão
        return pf.metadata.num_rows, list(pf.schema_arrow.names)
    except ImportError:
        pass

    # Fallback do ambiente de desenvolvimento (imagem Docker sempre tem pyarrow).
    import duckdb

    con = duckdb.connect(":memory:")
    try:
        row = con.execute(
            "SELECT num_rows FROM parquet_file_metadata(?)", [path]
        ).fetchone()
        cols = con.execute("DESCRIBE SELECT * FROM read_parquet(?)", [path]).fetchall()
    finally:
        con.close()
    if not row:
        raise ValueError("metadata de parquet indisponível")
    return int(row[0]), [c[0] for c in cols]


class Lakehouse:
    """Varredura, cache e validação das partições do lakehouse."""

    def __init__(
        self,
        root: str | os.PathLike[str] = DEFAULT_ROOT,
        *,
        scan_ttl: float = DEFAULT_SCAN_TTL,
        validation_retry: float = DEFAULT_VALIDATION_RETRY,
    ) -> None:
        self.root = Path(root).resolve()
        self.bronze = (self.root / "bronze").resolve()
        self.scan_ttl = max(0.0, float(scan_ttl))
        self.validation_retry = max(0.0, float(validation_retry))
        self._lock = threading.Lock()
        self._scan_at = 0.0
        self._manifests: Optional[list[Manifest]] = None
        self._valid: set[tuple[str, str, int]] = set()
        self._failed_at: dict[tuple[str, str, int], float] = {}

    # ---------------- descoberta ----------------

    @property
    def enabled(self) -> bool:
        return self.bronze.is_dir()

    def discover(self, *, force: bool = False) -> list[Manifest]:
        """Varre ``bronze/**/*.manifest.json``; cache curto para não repetir por request."""
        with self._lock:
            fresh = (
                self._manifests is not None
                and not force
                and (time.monotonic() - self._scan_at) < self.scan_ttl
            )
            if fresh:
                return list(self._manifests)

        manifests: list[Manifest] = []
        if self.bronze.is_dir():
            for dirpath, dirnames, filenames in os.walk(self.bronze, followlinks=False):
                dirnames[:] = sorted(
                    d for d in dirnames if not _is_skipped(d)
                )
                for name in sorted(filenames):
                    if not name.endswith(".manifest.json"):
                        continue
                    parsed = _parse_manifest(Path(dirpath) / name, self.bronze)
                    if parsed is not None:
                        manifests.append(parsed)

        manifests.sort(key=lambda m: (m.endpoint, m.year, m.month or 0, m.municipality, m.path))
        with self._lock:
            self._manifests = manifests
            self._scan_at = time.monotonic()
        return list(manifests)

    def refresh(self) -> None:
        """Invalida a varredura e os retries negativos (nova execução/refresh explícito)."""
        with self._lock:
            self._manifests = None
            self._scan_at = 0.0
            self._failed_at.clear()

    # ---------------- validação ----------------

    def _key(self, manifest: Manifest) -> tuple[str, str, int]:
        return (manifest.path, manifest.content_sha256, manifest.size_bytes or 0)

    def _validate(self, manifest: Manifest) -> bool:
        """Valida sha256, row_count e columns. Só sucessos ficam em cache."""
        key = self._key(manifest)
        now = time.monotonic()
        with self._lock:
            if key in self._valid:
                return True
            failed_at = self._failed_at.get(key)
            if failed_at is not None and (now - failed_at) < self.validation_retry:
                return False

        def _fail() -> bool:
            with self._lock:
                self._failed_at[key] = time.monotonic()
            return False

        try:
            stat = os.stat(manifest.path)
        except OSError:
            return _fail()
        if manifest.size_bytes is not None and stat.st_size != manifest.size_bytes:
            return _fail()

        try:
            if _sha256_file(manifest.path) != manifest.content_sha256:
                return _fail()
            row_count, columns = _parquet_metadata(manifest.path)
        except Exception:  # arquivo em substituição, corrompido ou pyarrow ausente
            return _fail()

        if row_count != manifest.row_count or columns != list(manifest.columns):
            return _fail()

        with self._lock:
            self._valid.add(key)
            self._failed_at.pop(key, None)
        return True

    # ---------------- API de consumo ----------------

    def has_prefix(self, prefix: str) -> bool:
        """Existe manifesto commitado para o endpoint? (decide a precedência da fonte)"""
        return any(m.endpoint == prefix for m in self.discover())

    def files(
        self,
        prefix: str,
        year_from: int,
        year_to: int,
        municipality: str = "all",
    ) -> list[str]:
        """Parquets validados do recorte, ordenados e sem duplicatas."""
        code = None
        if municipality and str(municipality) != "all":
            code = str(municipality).zfill(3)

        out: set[str] = set()
        for manifest in self.discover():
            if manifest.endpoint != prefix:
                continue
            if not (year_from <= manifest.year <= year_to):
                continue
            if code is not None and manifest.municipality != code:
                continue
            if self._validate(manifest):
                out.add(manifest.path)
        return sorted(out)

    def partitions(self, prefix: Optional[str] = None) -> list[Partition]:
        """Partições válidas (diagnóstico/status). Valida tudo do prefixo pedido."""
        out: list[Partition] = []
        for manifest in self.discover():
            if prefix and manifest.endpoint != prefix:
                continue
            if not self._validate(manifest):
                continue
            out.append(
                Partition(
                    path=manifest.path,
                    endpoint=manifest.endpoint,
                    year=manifest.year,
                    month=manifest.month,
                    municipality=manifest.municipality,
                    content_sha256=manifest.content_sha256,
                    row_count=manifest.row_count,
                    columns=manifest.columns,
                    size_bytes=manifest.size_bytes,
                    created_at=manifest.created_at,
                    manifest_path=manifest.manifest_path,
                )
            )
        return out

    def summary(self) -> dict:
        """Resumo barato (sem validar conteúdo) para health/diagnóstico."""
        manifests = self.discover()
        endpoints: dict[str, int] = {}
        years: set[int] = set()
        for manifest in manifests:
            endpoints[manifest.endpoint] = endpoints.get(manifest.endpoint, 0) + 1
            years.add(manifest.year)
        return {
            "root": str(self.root),
            "enabled": self.enabled,
            "partitions": len(manifests),
            "endpoints": dict(sorted(endpoints.items())),
            "years": sorted(years),
        }


_instance: Optional[Lakehouse] = None
_instance_root: Optional[Path] = None
_instance_lock = threading.Lock()


def _configured_root() -> str:
    return (
        os.environ.get("LAKEHOUSE_SOURCE")
        or os.environ.get("LAKEHOUSE_DIR")
        or DEFAULT_ROOT
    ).strip()


def get_lakehouse() -> Optional[Lakehouse]:
    """Instância única do lakehouse, ou ``None`` quando a raiz não está montada."""
    global _instance, _instance_root
    raw = _configured_root()
    if not raw:
        return None
    root = Path(raw).resolve()
    with _instance_lock:
        if _instance is None or _instance_root != root:
            _instance = Lakehouse(root) if (root / "bronze").is_dir() else None
            _instance_root = root
        return _instance


def reset_cache() -> None:
    """Limpa a instância (testes/hot reload)."""
    global _instance, _instance_root
    with _instance_lock:
        _instance = None
        _instance_root = None
