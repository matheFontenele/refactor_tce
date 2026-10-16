"""Seed do DuckDB com os 21 tipos de documento do TCE-CE (endpoints.json).

- Schema por categoria derivado de endpoints.json (fonte única de verdade):
  colunas base unificadas + colunas extras (colunas_texto, campos_ui, layout_card).
- Semeia TODAS as 21 categorias para que a Pesquisa Interativa retorne dados.

O banco real é alimentado pelo pipeline de extração (Airflow + ingestão sob demanda).
"""

import datetime as dt
import json
import os

import duckdb

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get(
    "DUCKDB_PATH",
    os.path.join(PROJECT_ROOT, "data", "tce_analysis.duckdb"),
)
ENDPOINTS_FILE = os.environ.get(
    "ENDPOINTS_FILE",
    os.path.join(PROJECT_ROOT, "endpoints.json"),
)
MUNICIPIOS_FILE = os.path.join(PROJECT_ROOT, "municipios.json")

# Colunas unificadas presentes em TODAS as tabelas (dashboard depende delas)
BASE_COLUMNS = [
    ("id", "INTEGER"),
    ("exercicio_orcamento", "INTEGER"),
    ("municipio_referencia", "VARCHAR"),
    ("nome_negociante", "VARCHAR"),
    ("numero_documento", "VARCHAR"),
    ("data_registro", "DATE"),
    ("valor", "DECIMAL(18,2)"),
]
BASE_NAMES = {c for c, _ in BASE_COLUMNS}

# (id, exercicio, municipio, fornecedor, numero_documento, data, valor)
SAMPLE_ROWS = {
    "notas_empenho": [
        (1, 2025, "Crato", "CONSTRUTORA NORDESTE LTDA", "NE-2025-0001", "2025-01-15", 15000.00),
        (2, 2025, "Crato", "CONSTRUTORA NORDESTE LTDA", "NE-2025-0002", "2025-02-10", 42500.00),
        (3, 2025, "Fortaleza", "SERVICOS GERAIS CEARA ME", "NE-2025-0003", "2025-03-05", 8750.50),
        (4, 2024, "Juazeiro do Norte", "DISTRIBUIDORA SERTAO SA", "NE-2024-0117", "2024-11-22", 120000.00),
        (5, 2025, "Sobral", "MEDICAMENTOS VIDA LTDA", "NE-2025-0004", "2025-04-18", 33200.75),
    ],
    "notas_fiscais": [
        (1, 2025, "Fortaleza", "SERVICOS GERAIS CEARA ME", "NF-2025-5521", "2025-02-20", 25000.00),
        (2, 2025, "Crato", "CONSTRUTORA NORDESTE LTDA", "NF-2025-5522", "2025-03-11", 18750.00),
        (3, 2025, "Sobral", "MEDICAMENTOS VIDA LTDA", "NF-2025-5523", "2025-04-02", 9800.90),
    ],
    "liquidacoes": [
        (1, 2025, "Crato", "CONSTRUTORA NORDESTE LTDA", "LIQ-2025-0101", "2025-01-30", 15000.00),
        (2, 2025, "Fortaleza", "SERVICOS GERAIS CEARA ME", "LIQ-2025-0102", "2025-03-20", 8750.50),
        (3, 2024, "Juazeiro do Norte", "DISTRIBUIDORA SERTAO SA", "LIQ-2024-0998", "2024-12-05", 120000.00),
    ],
    "veiculos_municipais": [
        (1, 2025, "Crato", "RENAULT MASTER PLACA PMU-2E45", "VEI-0001", "2025-01-01", 50000.00),
        (2, 2025, "Fortaleza", "FIAT CRONOS PLACA PQL-8A11", "VEI-0002", "2025-01-01", 72000.00),
        (3, 2025, "Sobral", "AMBULANCIA FIAT DUCATO PLACA RMU-7B22", "VEI-0003", "2025-02-15", 145000.00),
    ],
    "controle_abastecimento_veiculos": [
        (1, 2025, "Crato", "POSTO CENTRAL LTDA", "ABS-2025-001", "2025-01-20", 850.00),
        (2, 2025, "Fortaleza", "POSTO ROTA 020", "ABS-2025-002", "2025-01-25", 1200.00),
    ],
    "controle_manutencao_veiculos": [
        (1, 2025, "Crato", "OFICINA MECANICA SERTAO", "MAN-2025-001", "2025-02-01", 2350.00),
        (2, 2025, "Sobral", "OFICINA MECANICA SERTAO", "MAN-2025-002", "2025-03-14", 4800.00),
    ],
}


def load_config():
    with open(ENDPOINTS_FILE, encoding="utf-8") as f:
        return json.load(f)


def load_municipio_codes():
    """dict nome_upper -> codigo_municipio (para seed do codigo_municipio)."""
    try:
        with open(MUNICIPIOS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return {
            m["nome_municipio"].upper(): m["codigo_municipio"]
            for m in data.get("elements", [])
        }
    except Exception:
        return {}


def extra_columns(cat_cfg: dict) -> list:
    """Colunas extras da categoria derivadas do endpoints.json."""
    cols: dict = {}

    def add(name, type_hint=None):
        if not isinstance(name, str) or not name or name in BASE_NAMES or name in cols:
            return
        if type_hint:
            cols[name] = type_hint
        elif name.startswith("data_"):
            cols[name] = "DATE"
        elif name.startswith(("valor_", "quantidade_", "qtd_")):
            cols[name] = "DOUBLE"
        else:
            cols[name] = "VARCHAR"

    for col in cat_cfg.get("colunas_texto", {}):
        add(col)
    for campo in cat_cfg.get("campos_ui", []):
        add(campo.get("id"))
    layout = cat_cfg.get("layout_card") or {}
    corpo = layout.get("corpo_texto")
    if isinstance(corpo, list):
        for c in corpo:
            add(c)
    else:
        add(corpo)
    add(layout.get("topo_esq"))
    add(layout.get("titulo_grande"))
    for meta in layout.get("metadados", []) or []:
        add(meta.get("coluna"))
    for item in layout.get("grid_financeiro", []) or []:
        add(item.get("coluna"))
    return [(c, cols[c]) for c in cols]


def seed_extra_value(col, typ, row, municipio_codes):
    """Valor de exemplo plausível para coluna extra."""
    _id, _ano, municipio, fornecedor, numero_doc, data_reg, valor = row
    nome_mun = municipio.upper()

    if col == "municipio_referencia":
        return municipio
    if col in ("nome_negociante", "numero_documento"):
        return fornecedor if col == "nome_negociante" else numero_doc
    if col == "codigo_municipio":
        return municipio_codes.get(nome_mun, "999")
    if col.startswith("codigo_"):
        return "001"
    if col.startswith("numero_") or col in ("renavam_traduzido", "codigo_renavam"):
        return numero_doc
    if col.startswith("nome_") or col.startswith("orgao"):
        return fornecedor
    if col.startswith("cpf_cnpj"):
        return "12.345.678/0001-90"
    if col.startswith("data_"):
        return data_reg
    if col.startswith("valor_"):
        return float(valor)
    if col.startswith("quantidade_"):
        return 10.0
    if col == "status_pagamento":
        return ["PAGO", "PARCIAL", "PENDENTE"][_id % 3]
    if col == "tipo_vinculo":
        return "PRÓPRIO"
    if col.startswith(("descricao_", "historico", "especificacao")):
        return f"Histórico de {numero_doc} referente a {municipio}"
    if col.startswith(("tipo_", "estado_", "classe")):
        return "CLASSIFICACAO GERAL"
    if "traduzid" in col or col.startswith(("placa", "chassi")):
        return f"TRAD-{numero_doc}"
    if col == "ano_modelo":
        return "2022"
    if col == "vida_util":
        return "5"
    if col == "veiculo_completo":
        return f"VEICULO {numero_doc} - {municipio}"
    if typ == "DATE":
        return data_reg
    if typ == "DOUBLE":
        return float(valor)
    # fallback: string pesquisável contendo o número do documento
    return f"{col.replace('_', ' ')} {numero_doc}"


def generic_sample_rows(table: str, n: int = 2):
    """Linhas de exemplo para categorias sem seed específico."""
    ano = 2025
    munis = ["Crato", "Fortaleza", "Sobral"]
    fornecedores = [
        "CONSTRUTORA NORDESTE LTDA",
        "SERVICOS GERAIS CEARA ME",
        "MEDICAMENTOS VIDA LTDA",
    ]
    rows = []
    for i in range(1, n + 1):
        doc = f"DOC-2025-{abs(hash((table, i))) % 9000 + 1000}"
        rows.append(
            (
                i,
                ano if i % 2 else ano - 1,
                munis[i % len(munis)],
                fornecedores[i % len(fornecedores)],
                doc,
                f"{ano}-0{(i % 9) + 1}-1{i}",
                round(1500.0 + 700.0 * i, 2),
            )
        )
    return rows


def main():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    config = load_config()
    municipio_codes = load_municipio_codes()

    conn = duckdb.connect(DB_PATH, read_only=False)

    # Recria tudo (schema pode ter evoluído)
    for cat_cfg in config.values():
        table = cat_cfg["prefixo"]
        conn.execute(f'DROP TABLE IF EXISTS "{table}"')

    total_rows = 0
    for cat, cat_cfg in config.items():
        table = cat_cfg["prefixo"]
        cols = BASE_COLUMNS + extra_columns(cat_cfg)
        col_defs = ", ".join(f'"{c}" {t}' for c, t in cols)
        conn.execute(f'CREATE TABLE "{table}" ({col_defs})')

        rows = SAMPLE_ROWS.get(table) or generic_sample_rows(table)
        extra = [c for c, _ in cols if c not in BASE_NAMES]
        col_names = [c for c, _ in cols]

        for row in rows:
            values = list(row)
            if isinstance(values[5], str):
                values[5] = dt.date.fromisoformat(values[5])
            for col in extra:
                typ = dict(cols)[col]
                v = seed_extra_value(col, typ, row, municipio_codes)
                if typ == "DATE" and isinstance(v, str):
                    v = dt.date.fromisoformat(v)
                values.append(v)
            placeholders = ", ".join("?" * len(values))
            quoted_cols = ", ".join('"' + c + '"' for c in col_names)
            conn.execute(
                f'INSERT INTO "{table}" ({quoted_cols}) VALUES ({placeholders})',
                values,
            )
        total_rows += len(rows)

    tables = conn.execute("SHOW TABLES").fetchall()
    print(f"Banco criado: {len(tables)} tabelas ({len(config)} tipos de documento)")
    print(f"Total de linhas de exemplo: {total_rows}")
    for t in tables:
        cnt = conn.execute(f'SELECT COUNT(*) FROM "{t[0]}"').fetchone()[0]
        print(f"  {t[0]}: {cnt}")
    conn.close()


if __name__ == "__main__":
    main()
