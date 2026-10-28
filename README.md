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

### Dataset real (parquet) — leitura lazy

A Pesquisa Interativa lê o dataset real do TCE direto dos parquets (zero-copy, lazy),
com **pruning por nome de arquivo** (ano/município). Configure a fonte no `.env`:

```bash
PARQUET_SOURCE=/home/matheus/automacao_api_tse/data   # montado read-only em /parquet
```

Sem `PARQUET_SOURCE` (ou sem arquivos), a Pesquisa cai automaticamente no seed
(`data/tce_analysis.duckdb`). A resposta da API traz `source: "parquet" | "seed"`.

Detalhes do dataset real:
- `exercicio_orcamento` vem como `ano*100` (ex.: `202500`) — o filtro cobre os dois formatos
- arquivos corrompidos (ex.: `notas_empenho_2025_*_001.parquet`, 12 deles) entram numa
  blocklist em memória e são pulados automaticamente
- ordem de grandeza: ~1M notas de empenho em 2025 em 2,2k arquivos → ~3s de varredura
  (small-file problem — material de estudo)

### Híbrido local-first — fetch sob demanda da API TCE (Spec 2.1)

Se o recorte pedido (categoria × ano × município) não existe no data lake local, a
Pesquisa baixa **só esse recorte** da API do TCE, valida e grava em `data/cache/`
(gravável; o dataset real continua read-only). Não precisa rodar backfill manual —
a primeira consulta a um município/ano novo preenche o cache.

- **Cache hit** → leitura local pura (sem rede)
- **Cache miss** → baixa os recortes faltantes (paginação + rate-limit + retry,
  port do `extraction.py` original), grava atômico e serve
- **TCE fora do ar** → serve o que existe local; a resposta traz `fetch_error`
- **Mês sem dado em ano fechado** → marcador `.empty` (cache negativo; não re-consulta)
- **Validação pós-escrita com DuckDB** (o check antigo via pyarrow aceitava parquet
  0-coluna — origem dos arquivos corrompidos do dataset real)

Variáveis: `CACHE_PARQUET_DIR`, `TCE_FETCH_ENABLED`, `TCE_FETCH_BUDGET_SECONDS`
(orçamento por consulta), `TCE_FETCH_MAX_RECORTES`, `TCE_HTTP_TIMEOUT`, `TCE_HTTP_RETRIES`.

Resposta da busca: `source` (`parquet`/`seed`), `fetched` (recortes baixados agora),
`fetch_error` (TCE indisponível) e `fetch_pending` (recortes restantes). O fetch só
roda com município específico — nunca em "Todos".

### Assistente IA em perfil de estudo (Ollama local limitado)

Por padrão, o Ollama **não** inicia no servidor. Para testar a IA usando o Ollama
em um container isolado, o perfil `ai-study` limita o serviço a **2 GiB de RAM**,
**2 CPUs**, sem swap do container, uma geração/modelo por vez e contexto de 2048
tokens. O limite é rígido: se o modelo exceder a memória, o container pode
encerrar a inferência, em vez de consumir RAM sem limite no host.

No `.env` do projeto, use um modelo menor para este servidor e a URL interna do
serviço (os containers compartilham a rede Docker padrão):

```dotenv
OLLAMA_BASE_URL=http://ollama-study:11434
OLLAMA_MODEL=qwen3:1.7b
AI_MEMORY_LIMIT=768
```

Inicie apenas quando for estudar. O primeiro comando pode baixar a imagem Ollama;
o `pull` do modelo também usa disco e rede:

```bash
docker compose --profile ai-study up -d ollama-study
docker compose --profile ai-study exec ollama-study ollama pull qwen3:1.7b
docker compose up -d --force-recreate api
```

Confira o consumo durante o teste:

```bash
docker stats --no-stream refactor_tce-api-1 tce-ollama-study
free -h
curl -s http://localhost:9001/api/ai/status
```

Para encerrar a inferência e liberar a memória do modelo:

```bash
docker compose --profile ai-study stop ollama-study
```

O modelo permanece no volume `ollama_study_models`, portanto não precisa ser
baixado novamente. Não publicamos a porta 11434 no host: a API acessa o Ollama
pela rede interna do Compose. Para voltar ao Ollama externo, remova/ajuste as
variáveis `OLLAMA_BASE_URL`, `OLLAMA_MODEL` e `AI_MEMORY_LIMIT` no `.env` e
recrie a API.

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
| GET | `/api/dashboard/stats` | KPIs e agregados do painel |
| GET | `/api/search/config` | Config da Pesquisa Interativa |
| POST | `/api/search` | Pesquisa Interativa (parquet real ou seed) |

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
