import duckdb

conn = duckdb.connect("/home/matheus/refatoracao_tce/data/tce_analysis.duckdb", read_only=False)

# Create sample tables based on the 21 document types from the original project
tables = [
    "notas_empenho", "notas_fiscais", "controle_bens", "contas_redutoras",
    "items_notas_fiscais", "cheques", "veiculos_municipais", "veiculos_locados",
    "despesas_extra_orcamentarias", "veiculos_cedidos", "liquidacoes",
    "baixa_destinacao", "bens_incorporados", "controle_alocacao", "controle_manutencao",
    "pagamento_folha", "destinacao_veiculos", "ajuste_reavaliacao_obras"
]

for t in tables:
    conn.execute(f'''CREATE TABLE IF NOT EXISTS "{t}" (
        id INTEGER,
        descricao VARCHAR,
        exercicio INTEGER,
        municipio VARCHAR,
        valor DECIMAL,
        data_registro DATE
    )''').fetchall()

# Insert some sample data
conn.execute(
    "INSERT INTO notas_empenho VALUES (1, 'Nota de Empenho - Crato', 2025, 'Crato', 15000.00, DATE '2025-01-15')"
).fetchall()

conn.execute(
    "INSERT INTO notas_fiscais VALUES (2, 'Nota Fiscal - Fortaleza', 2025, 'Fortaleza', 25000.00, DATE '2025-02-20')"
).fetchall()

conn.execute(
    "INSERT INTO veiculos_municipais VALUES (3, 'Caminhão - Crato', 2025, 'Crato', 50000.00, DATE '2025-03-10')"
).fetchall()

# Set memory limit after creating tables - correct format
conn.execute("SET memory_limit='1536 MB'").fetchall()

print("Database created successfully!")

# Verify tables
tables_created = conn.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public'").fetchall()
print("Tables created:", [t[0] for t in tables_created])

# Test a simple query
result = conn.execute("SELECT * FROM notas_empenho").fetchall()
print("Sample query result:", result)

# Test guardrailed query
result4 = conn.execute("SELECT * FROM (SELECT 1 as id) LIMIT 5").fetchall()
print("Guardrail test:", result4)

conn.close()