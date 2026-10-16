"""Seed do DuckDB com os 21 tipos de documento do TCE-CE (endpoints.json).

Este script cria o banco analítico de demonstração/refatoração.
O banco real é alimentado pelo pipeline de extração (Airflow + extração sob demanda).
"""

import duckdb
import os

DB_PATH = os.environ.get(
    "DUCKDB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tce_analysis.duckdb"),
)

# 21 tipos de documento do endpoints.json (nomes normalizados p/ SQL)
DOCUMENT_TYPES = [
    "notas_empenho",
    "notas_fiscais",
    "notas_pagamento",
    "cheques_notas_pagamento",
    "notas_pagamento_folha",
    "despesas_extra_orcamentarias",
    "pagamentos_liquidacoes",
    "liquidacoes",
    "bens_incorporados",
    "controle_alocacao_bens",
    "ajuste_reavaliacao_obras",
    "controle_bens_notas_empenho",
    "contas_redutoras_bens",
    "itens_notas_fiscais",
    "veiculos_municipais",
    "veiculos_locados",
    "veiculos_cedidos",
    "destinacao_veiculos",
    "baixa_destinacao_veiculos",
    "controle_abastecimento",
    "controle_manutencao_veiculos",
]

# Schema mínimo comum derivado dos schemas declarativos (src/schemas/)
COMMON_COLUMNS = """
    id INTEGER,
    exercicio_orcamento INTEGER,
    municipio_referencia VARCHAR,
    nome_negociante VARCHAR,
    numero_documento VARCHAR,
    data_registro DATE,
    valor DECIMAL(18,2)
"""

# Dados de exemplo por tipo (municípios reais do municípios.json)
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
    "controle_abastecimento": [
        (1, 2025, "Crato", "POSTO CENTRAL LTDA", "ABS-2025-001", "2025-01-20", 850.00),
        (2, 2025, "Fortaleza", "POSTO ROTA 020", "ABS-2025-002", "2025-01-25", 1200.00),
    ],
    "controle_manutencao_veiculos": [
        (1, 2025, "Crato", "OFICINA MECANICA SERTAO", "MAN-2025-001", "2025-02-01", 2350.00),
        (2, 2025, "Sobral", "OFICINA MECANICA SERTAO", "MAN-2025-002", "2025-03-14", 4800.00),
    ],
}


def main():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = duckdb.connect(DB_PATH, read_only=False)

    created = 0
    for table in DOCUMENT_TYPES:
        conn.execute(f'CREATE TABLE IF NOT EXISTS "{table}" ({COMMON_COLUMNS})')
        created += 1

        rows = SAMPLE_ROWS.get(table, [])
        for row in rows:
            conn.execute(
                f'INSERT INTO "{table}" (id, exercicio_orcamento, municipio_referencia, '
                f"nome_negociante, numero_documento, data_registro, valor) VALUES (?,?,?,?,?,?,?)",
                list(row),
            )

    tables = conn.execute("SHOW TABLES").fetchall()
    print(f"Banco criado: {len(tables)} tabelas ({len(DOCUMENT_TYPES)} tipos de documento)")
    total = 0
    for t in tables:
        cnt = conn.execute(f'SELECT COUNT(*) FROM "{t[0]}"').fetchone()[0]
        total += cnt
    print(f"Total de linhas de exemplo: {total}")
    conn.close()


if __name__ == "__main__":
    main()