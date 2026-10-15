"""Streamlit frontend for TCE audit platform (temporarily maintained during migration)."""

import streamlit as st
import duckdb
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from pathlib import Path

st.set_page_config(
    page_title="TCE Audit Platform",
    page_icon="🏛",
    layout="wide",
)

st.title("🏛 Plataforma de Auditoria Fiscal TCE-CE")
st.caption("Versão de transição — Estrutura consolidada")

# ===== Sidebar =====
st.sidebar.header("Navegação")
aba = st.sidebar.radio("Aba", ["Extração", "Consulta", "Comparação", "Validação", "SQL Studio", "IA Assistant"])

# ===== Connection =====
DB_PATH = "/data/tce_analysis.duckdb"

try:
    conn = duckdb.connect(DB_PATH, read_only=True)
    conn.execute("SET memory_limit='1536 MB'")
    st.sidebar.success("Conexão DuckDB estabelecida")
except Exception as e:
    st.sidebar.error(f"Erro ao conectar DuckDB: {e}")
    conn = None

# ===== Aba: Extração =====
if aba == "Extração":
    st.header("Extração de Dados Abertos TCE-CE")
    
    with st.form("extracao_form"):
        ano = st.number_input("Ano", min_value=2000, max_value=2030, value=2025)
        municipio = st.text_input("Município", value="")
        submitted = st.form_submit_button("Executar Extração")
    
    if submitted and conn:
        with st.spinner("Extraindo..."):
            try:
                # Query the API data openly
                query = f"""
                SELECT * FROM notas_empenho 
                WHERE exercicio = {ano}
                """
                if municipio:
                    query += f" AND municipio = '{municipio}'"
                
                result = conn.execute(query).fetch_pandas_all()
                st.success(f"Extraídas {len(result)} linhas")
                
                # Display summary
                if not result.empty:
                    st.dataframe(result.head(10))
                    
                    # Basic stats
                    st.metric("Valor Total", result['valor'].sum() if 'valor' in result.columns else "N/A")
            except Exception as e:
                st.error(f"Erro na extração: {str(e)}")

# ===== Aba: Consulta =====
elif aba == "Consulta":
    st.header("Consulta de Dados")
    
    with st.form("consulta_form"):
        query = st.text_area("SQL Query (apenas leitura)", 
                           "SELECT COUNT(*) as total FROM notas_empenho",
                           height=100)
        submitted = st.form_submit_button("Executar")
    
    if submitted and conn:
        try:
            result = conn.execute(query).fetch_pandas_all()
            st.success(f"Resultado: {len(result)} linhas")
            st.dataframe(result)
        except Exception as e:
            st.error(f"Erro na query: {str(e)}")

# ===== Aba: Comparação =====
elif aba == "Comparação":
    st.header("Comparação entre Períodos")
    
    with st.form("comparison_form"):
        ano1 = st.number_input("Ano Inicial", min_value=2000, max_value=2030, value=2024)
        ano2 = st.number_input("Ano Final", min_value=2000, max_value=2030, value=2025)
        submitted = st.form_submit_button("Comparar")
    
    if submitted and conn:
        try:
            q1 = f"SELECT * FROM notas_empenho WHERE exercicio = {ano1}"
            q2 = f"SELECT * FROM notas_empenho WHERE exercicio = {ano2}"
            
            r1 = conn.execute(q1).fetch_pandas_all()
            r2 = conn.execute(q2).fetch_pandas_all()
            
            st.metric("Registros", f"{len(r1)} (ano {ano1}) vs {len(r2)} (ano {ano2})")
            
            if 'valor' in r1.columns and 'valor' in r2.columns:
                st.metric("Valor Total", f"R$ {r1['valor'].sum():.2f} vs R$ {r2['valor'].sum():.2f}")
                fig = go.Figure(data=[
                    go.Bar(
                        x=["Ano " + str(ano1), "Ano " + str(ano2)],
                        y=[r1['valor'].sum(), r2['valor'].sum()]
                    )
                ])
                st.plotly_chart(fig)
        except Exception as e:
            st.error(f"Erro: {str(e)}")

# ===== Aba: Validação =====
elif aba == "Validação":
    st.header("Validação de Dados")
    
    st.info("""
    **Duas camadas de validação** (NON-NEGOTIABLE):
    - Camada 1: Validação linha a linha (schemas declarativos Polars)
    - Camada 2: Great Expectations (suites derivadas do schema)
    """)
    
    with st.form("validacao_form"):
        uploaded = st.file_uploader("Arquivo Parquet para validar")
        submitted = st.form_submit_button("Validar")
    
    if submitted and uploaded and conn:
        try:
            # Save uploaded file temporarily
            import tempfile
            with tempfile.NamedTemporaryFile(suffix='.parquet', delete=False) as tmp:
                tmp.write(uploaded.read())
                tmp_path = tmp.name
            
            # Read with DuckDB
            parquet_data = conn.execute(f"READ_PARQUET('{tmp_path}')").fetch_pandas_all()
            
            st.success(f"Parquet válido: {len(parquet_data)} linhas")
            st.dataframe(parquet_data.head(10))
        except Exception as e:
            st.error(f"Erro na validação: {str(e)}")

# ===== Aba: SQL Studio =====
elif aba == "SQL Studio":
    st.header("SQL Studio — Monaco Editor")
    st.markdown("""
    **Endpoint:** `http://api:8000` (FastAPI)
    **Funcionalidades:** 
    - Editor SQL com destaque de sintaxe
    - Autocomplete contextual
    - Execução `Ctrl+Enter`
    - Guardrails (apenas leitura SELECT/WITH)
    - SSE streaming de resultados
    """)
    
    st.code("""
    // Conecte no frontend Next.js em http://localhost:3000
    // Ou teste a API diretamente:
    curl -X POST http://localhost:8000/api/sql/execute \\
         -H "Content-Type: application/json" \\
         -d '{"sql": "SELECT * FROM notas_empenho LIMIT 5"}'
    """, language="bash")

# ===== Aba: IA Assistant =====
elif aba == "IA Assistant":
    st.header("Assistente IA — Text-to-SQL")
    
    st.markdown("""
    **Status:** Conectando Ollama...
    
    with st.form("ia_form"):
        pergunta = st.text_area("Pergunta", 
                               "Quantas notas de empenho o fornecedor X tem no exercício 2025?")
        submitted = st.form_submit_button("Enviar")
    
    if submitted and pergunta:
        st.info("Enviando para Ollama local...")
        st.code(f"Pergunta: {pergunta}")

# ===== Rodapé =====
st.sidebar.markdown("""
---\n**Governança:** Spec-Driven Development v1.2.0\n**Principios:** Schema como Fonte Única da Verdade · Validação em Duas Camadas · Publicação Somente-Leitura\n**Handoff:** `docs/contexto-dos-agentes.md`\n---\n""")

# Initialize DuckDB on startup
try:
    conn = duckdb.connect(DB_PATH, read_only=True)
    conn.execute("SET memory_limit='1536 MB'")
    conn.close()
except:
    pass