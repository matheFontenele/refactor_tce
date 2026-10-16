"""Fetch sob demanda da API do TCE (Spec 2.1 — híbrido local-first).

Esta camada só é acionada quando o recorte não existe no data lake local.
Port enxuto de `src/modules/extraction.py` do projeto original: paginação
($count/$start_index), backoff/rate-limit global, cache negativo (.empty) e
escrita atômica — sem threading/Streamlit/Airflow.

Diferenças deliberadas do original (uso interativo, não backfill em massa):
- menos tentativas por página (TCE_HTTP_RETRIES, default 2) e orçamento de
  tempo por requisição, para a busca nunca travar esperando a API;
- validação do parquet gravado com DuckDB (o check do original via pyarrow
  aceitava arquivos 0-coluna que o DuckDB rejeita — os 12 corrompidos do
  dataset real nasceram daí).
"""
import datetime as _dt
import os
import threading
import time

import pyarrow as pa
import pyarrow.parquet as pq
import requests

TCE_TIMEOUT = max(10, int(os.getenv("TCE_HTTP_TIMEOUT", "90")))
MAX_TENTATIVAS = max(1, int(os.getenv("TCE_HTTP_RETRIES", "2")))
_PAUSA_PRE_REQ = 0.7  # pausa amigável antes de cada recorte (como o original)
_PAUSA_PAGINA = 0.5
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

_rate_lock = threading.Lock()
_rate_limit_until = 0.0


def _aguardar_rate_limit(deadline: float) -> bool:
    """Espera o resfriamento global (429) se couber no orçamento da requisição."""
    with _rate_lock:
        espera = max(0.0, _rate_limit_until - time.monotonic())
    if espera <= 0:
        return True
    if time.monotonic() + espera > deadline:
        return False
    time.sleep(espera)
    return True


def _definir_rate_limit(segundos: float) -> None:
    global _rate_limit_until
    with _rate_lock:
        _rate_limit_until = max(_rate_limit_until, time.monotonic() + segundos)


def montar_params(parametros_obrigatorios, ano: int, codigo_mun: str, mes=None) -> dict:
    """Port de extraction.montar_params (exercicio_orcamento = ano*100 etc.)."""
    exercicio = int(f"{ano}00")
    params = {"$format": "json", "$count": 1000, "$start_index": 0}
    for param in parametros_obrigatorios:
        if param == "exercicio_orcamento":
            params[param] = exercicio
        elif param == "codigo_municipio":
            params[param] = codigo_mun
        elif param == "data_referencia_doc":
            if mes is not None:
                params[param] = int(f"{ano}{str(mes).zfill(2)}")
        elif param == "data_inicio":
            mes_inicio = int(mes) if mes is not None else 1
            params[param] = f"{int(ano):04d}{mes_inicio:02d}01"
        elif param == "data_fim":
            mes_fim = int(mes) if mes is not None else 12
            seguinte = _dt.date(int(ano), mes_fim, 1) + _dt.timedelta(days=32)
            ultimo = seguinte.replace(day=1) - _dt.timedelta(days=1)
            params[param] = ultimo.strftime("%Y%m%d")
    return params


def _fetch_paginas(url: str, params: dict, deadline: float):
    """Baixa todas as páginas de um recorte. Retorna (linhas, erro_ou_None)."""
    session = requests.Session()
    headers = {"Accept": "application/json", "User-Agent": _UA, "Connection": "keep-alive"}
    todos: list = []
    start = 0
    limite = int(params.get("$count", 1000))

    time.sleep(_PAUSA_PRE_REQ)

    while True:
        params["$start_index"] = start
        response = None
        for tentativa in range(1, MAX_TENTATIVAS + 1):
            if time.monotonic() > deadline:
                return todos, "orçamento de tempo esgotado"
            if not _aguardar_rate_limit(deadline):
                return todos, "rate limit ativo — servindo dados locais"
            try:
                response = session.get(url, headers=headers, params=params, timeout=TCE_TIMEOUT)
            except requests.exceptions.RequestException as e:
                if tentativa >= MAX_TENTATIVAS:
                    return todos, f"erro de conexão: {str(e)[:200]}"
                espera = min(300, 15 * (2 ** (tentativa - 1)))  # como o original
                if time.monotonic() + espera > deadline:
                    return todos, "orçamento esgotado após erro de conexão"
                time.sleep(espera)
                session = requests.Session()  # sessão nova, como o original
                continue

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                try:
                    espera = (
                        min(900.0, max(1.0, float(retry_after)))
                        if retry_after
                        else min(900.0, 30.0 * (2 ** (tentativa - 1)))
                    )
                except (TypeError, ValueError):
                    espera = min(900.0, 30.0 * (2 ** (tentativa - 1)))
                _definir_rate_limit(espera)
                return todos, f"HTTP 429 — pausa global de {espera:.0f}s antes de novas chamadas"
            if response.status_code == 400:
                corpo = (response.text or "").strip().replace("\n", " ")[:300]
                return todos, f"HTTP 400: {corpo or '<resposta vazia>'}"
            if response.status_code != 200:
                return todos, f"HTTP {response.status_code}"
            break  # 200 → sai do loop de tentativas

        if response is None or response.status_code != 200:
            return todos, "sem resposta válida"

        elementos = (response.json() or {}).get("elements", []) or []
        if not elementos:
            break
        todos.extend(elementos)
        if len(elementos) < limite:
            break  # última página
        start += limite
        if time.monotonic() > deadline:
            return todos, "orçamento esgotado (páginas parciais)"
        time.sleep(_PAUSA_PAGINA)

    return todos, None


def baixar_recorte(url: str, parametros_obrigatorios, ano: int, codigo_mun: str,
                   mes, nome_municipio: str, deadline: float):
    """Baixa um recorte (ano[, mês], município). Retorna (linhas, erro_ou_None)."""
    params = montar_params(parametros_obrigatorios, ano, codigo_mun, mes)
    rows, erro = _fetch_paginas(url, params, deadline)
    if rows:
        # Filtro defensivo de ano (a API às vezes devolve lixo de outro exercício)
        if "exercicio_orcamento" in rows[0]:
            ano_str = str(ano)
            rows = [
                r for r in rows
                if str(r.get("exercicio_orcamento") or "").startswith(ano_str)
            ]
        for r in rows:
            r["municipio_referencia"] = nome_municipio  # como o original
    return rows, erro


def _tabela_de_rows(rows) -> pa.Table:
    try:
        return pa.Table.from_pylist(rows)
    except (pa.ArrowInvalid, pa.ArrowTypeError):
        # Colunas com tipos mistos entre linhas → coage valores para texto
        safe = [
            {k: (None if v is None else str(v)) for k, v in r.items()}
            for r in rows
        ]
        return pa.Table.from_pylist(safe)


def _validar_parquet(caminho: str) -> None:
    """Valida lendo com DuckDB — mais estrito que o pyarrow do original."""
    import duckdb

    con = duckdb.connect()
    try:
        con.execute("SELECT * FROM read_parquet(?) LIMIT 0", [caminho]).fetchall()
    finally:
        con.close()


def salvar_recorte(rows, caminho: str, ano: int) -> str:
    """Escrita atômica. Vazio + ano fechado → marcador `.empty` (cache negativo)."""
    if rows:
        table = _tabela_de_rows(rows)
        tmp = caminho + ".tmp"
        pq.write_table(table, tmp, compression="snappy")
        _validar_parquet(tmp)
        os.replace(tmp, caminho)
        return "BAIXADO"
    if ano < _dt.date.today().year:
        with open(caminho + ".empty", "w"):
            pass
        return "VAZIO"
    return "VAZIO_NAO_CACHEADO"  # ano corrente: dado ainda pode aparecer
