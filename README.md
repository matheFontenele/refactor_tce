# SQL Studio — Plataforma de Auditoria Fiscal TCE-CE (Refatoração)

> Refatoração do painel Streamlit para arquitetura desacoplada: **FastAPI (backend) + Next.js (frontend)**.
> Documento-base: `TRANSICAO_ARQUITETURAL.md` — Spec 001 (SQL Studio com Monaco Editor).

## Portas (importante!)

A máquina já possui outros projetos rodando. Para evitar conflitos:

| Serviço | Porta Host | Porta Container | Observação |
|---|---|---|---|
| **API FastAPI** | **9001** | 8000 | SQL Studio backend |
| **Frontend Next.js** | **3001** | 3000 | SQL Studio UI |
| **Streamlit (transição)** | **8502** | 8501 | Perfil `streamlit` |
| **Ollama (IA)** | **11435** | 11434 | Perfil `ai` |

Portas **ocupadas por outros projetos** (não usar): 3000, 3333, 5433, 8000, 8080, 8081, 8085, 8501, 8503, 9000.

---

## Como rodar

### Opção A — Local (sem Docker) ✅ mais rápido

```bash
# 1. Backend (terminal 1)
cd ~/refatoracao_tce
uvicorn src.api.main:app --port 8000

# 2. Frontend (terminal 2)
cd ~/refatoracao_tce/src/app
npm install
npm run dev -- -p 3001
# Acesse: http://localhost:3001
```

### Opção B — Docker

```bash
# Apenas API (porta 9001)
docker build -t tce-api -f src/api/Dockerfile.api src/api/
docker run -d -p 9001:8000 -v ~/refatoracao_tce/data:/data:ro --name tce-api tce-api

# Ou compose completo (API + Frontend)
docker compose up -d api frontend

# Streamlit (opcional, perfil separado)
docker compose --profile streamlit up -d streamlit
```

---

## Testes rápidos

```bash
# Health check
curl -s http://localhost:9001/health

# SELECT (deve funcionar)
curl -s -X POST http://localhost:9001/api/sql/execute \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM notas_empenho LIMIT 3"}'

# Guardrail — DROP bloqueado
curl -s -X POST http://localhost:9001/api/sql/execute \
  -H "Content-Type: application/json" \
  -d '{"sql": "DROP TABLE notas_empenho"}'
# → {"detail":"Operação não permitida: DROP. Apenas leitura (SELECT/WITH) é permitida."}
```

---

## Endpoints da API

| Método | Rota | Função |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/api/sql/execute` | Executa SELECT/WITH (guardrails) |
| POST | `/api/sql/catalog` | Catálogo p/ autocomplete |
| POST | `/api/sql/stream` | SSE (streaming de resultados) |
| POST | `/api/saved-queries` | Salva query |
| POST | `/api/saved-queries/list` | Lista queries salvas |

---

## Estrutura

```
refatoracao_tce/
├── TRANSICAO_ARQUITETURAL.md   # Documento-base (não alterar)
├── docker-compose.yml           # Portas 9001 / 3001 / 8502 / 11435
├── create_db.py                 # Seed do DuckDB (21 tipos de documento)
├── data/
│   └── tce_analysis.duckdb      # Fonte de dados (não versionar dados reais)
├── src/
│   ├── api/
│   │   ├── main.py              # FastAPI backend (guardrails + SSE)
│   │   ├── Dockerfile.api
│   │   └── requirements.txt
│   └── app/
│       ├── page.tsx             # Página SQL Studio
│       ├── components/
│       │   └── MonacoSQLEditor.tsx
│       ├── hooks/
│       │   ├── useSSE.ts
│       │   └── useSavedQueries.ts
│       ├── Dockerfile.nextjs
│       └── Dockerfile.streamlit
```

---

## Guardrails (Spec 001 — US-4, non-negotiable)

Bloqueados **antes de chegar ao banco** (via `sqlglot`):
`INSERT` · `UPDATE` · `DELETE` · `DROP` · `CREATE` · `ALTER` · `TRUNCATE` · `COPY` · `VACUUM` · transações

Permitidos: `SELECT` e `WITH` (uma statement por execução).

---

## Próximos épicos

- **002** — Assistente IA com streaming SSE (Ollama + sqlglot guardrails)
- **003** — Auth + RBAC (JWT)
- **004** — Ingestão sob demanda (cache hit/miss + validadores)
