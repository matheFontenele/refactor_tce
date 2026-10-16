# Documento de Transição Arquitetural — Plataforma de Auditoria Fiscal TCE-CE

> **Status:** Alinhamento (sem implementação). **Não altera o projeto atual.**
> **Criado:** 2026-10-15
> **Objetivo:** Consolidar (a) o retrato fiel do que o projeto atual realiza e (b) todas as diretrizes e alinhamentos discutidos para a refatoração (Ingestão Sob Demanda + Frontend React/Next.js + Backend FastAPI), servindo como ponto de partida para uma **cópia/demo** separada.
> **Como usar:** copie o repositório para um diretório novo, leve este arquivo junto e execute a refatoração lá. O projeto original permanece intacto.

---

## 1. Retrato fiel do projeto atual (origem)

### 1.1 O que o sistema faz, ponta a ponta

1. **Extrai** endpoints da API de dados abertos do TCE-CE, por ano, mês e município (`src/modules/extraction.py`) — com retry, backoff e retomada.
2. **Valida linha a linha** contra schema declarado — posicional (largura fixa) ou delimitado (`src/validators/`).
3. **Qualifica o dataset** com Great Expectations: nulos aceitáveis, contagem mínima de registros etc. (`src/quality/`).
4. **Persiste** cada lote em Parquet sob `data/` — a fonte de verdade (não versionada).
5. **Publica** tabelas somente-leitura num Postgres com `pg_duckdb`, acessíveis por DBeaver/DataGrip na rede interna (`scripts/refresh_parquet_db.py`).

O ciclo mensal é orquestrado pelo Airflow; o painel Streamlit serve para extração manual, visualização e geração de relatórios.

### 1.2 Os 21 tipos de documento (`endpoints.json`)

| # | Tipo | # | Tipo |
|---|---|---|---|
| 1 | Notas de Empenho | 12 | Controle de bens e notas de empenho |
| 2 | Notas Fiscais | 13 | Contas Redutoras e Bens Incorporados |
| 3 | Notas de Pagamento | 14 | Itens de Notas Fiscais |
| 4 | Cheques de Notas de Pagamento | 15 | Veículos Municipais |
| 5 | Notas de Pagamento da Folha | 16 | Veículos Locados |
| 6 | Despesas Extra Orçamentárias | 17 | Veículos Cedidos a Terceiros |
| 7 | Pagamento e Liquidações | 18 | Destinação de Veículos |
| 8 | Liquidações | 19 | Baixa de Destinação de Veículos |
| 9 | Bens Incorporados ao Patrimônio | 20 | Controle de Abastecimento de Veículos |
| 10 | Controle de Alocação (Bens em Órgãos) | 21 | Controle de Manutenção de Veículos |
| 11 | Ajuste, Reavaliação e Obras em Bens | | |

### 1.3 Arquitetura do pipeline atual

```text
API TCE-CE (dados abertos)
        │
        ▼
EXTRAÇÃO (src/modules/extraction.py — requests + retry, por ano/mês/município)
        │
        ▼
VALIDAÇÃO camada 1 (src/validators/ — linha a linha, regras declarativas Polars)
        │
        ▼
QUALIDADE camada 2 (src/quality/ — Great Expectations, suites derivadas do schema)
        │
        ▼
PARQUET (data/ — fonte de verdade, gravação atômica)
        │
        ▼
PUBLICAÇÃO (scripts/refresh_parquet_db.py — Postgres + pg_duckdb, staging → troca em transação curta)
```

### 1.4 Stack técnica atual

| Camada | Tecnologia |
|---|---|
| Linguagem | Python 3.12 |
| Extração HTTP | `requests` (retry + backoff) |
| Dataframes | `pandas`, `polars` |
| Persistência | Parquet via `pyarrow` |
| Qualidade | Great Expectations |
| Interface | Streamlit (`src/app.py`) |
| Orquestração | Apache Airflow (LocalExecutor) |
| Consulta SQL | Postgres 16 + extensão `pg_duckdb` |
| Relatórios | `reportlab` (PDF), `openpyxl` (Excel) |
| Testes | `pytest` (`tests/`) |
| Empacotamento | Docker + Docker Compose |
| CI/CD | GitHub Actions (testes + deploy self-hosted) |

### 1.5 Painel Streamlit atual (abas)

Estado após o último commit (`feat(AI)`): a aba **Extração foi removida**; a padrão é **Consulta**.

| Aba | Módulo | Função |
|---|---|---|
| Consulta | `src/modules/consultation.py` | Navegação por Notas de Empenho, Notas Fiscais etc. |
| Comparação | `src/modules/compare.py` | Comparação entre períodos |
| Validação | `src/modules/validacao.py` | Orquestração da validação |
| SQL | `src/modules/sql_explorer.py` | SQL Explorer (somente-leitura, via Postgres + pg_duckdb) |
| Assistente IA | `src/modules/tce_ai_assistant.py` | Chat Text-to-SQL inicial: conta notas de empenho por fornecedor e exercício (Ollama local, modelo `qwen3:4b`) |

Detalhe do Assistente IA atual: interpreta a pergunta via Ollama (`TCE_OLLAMA_BASE_URL`, `TCE_OLLAMA_MODEL`), extrai `{supplier, year}`, monta **uma única consulta fixa** (`SELECT COUNT(*) FROM notas_empenho WHERE exercicio_orcamento = ... AND nome_negociante ILIKE ...`) e executa via `src/modules/execucao_sql.py`. Qualquer outro tipo de pergunta é rejeitado com mensagem de escopo.

### 1.6 Serviços do `docker-compose.yml` atual

| Serviço | Descrição | Porta |
|---|---|---|
| `app` | Painel Streamlit | `8501` |
| `extrator` | Extração manual / backfill | — |
| `cli` | Wizard interativo (profile `tools`) | — |
| `airflow-webserver` | UI do Airflow | `8085` → 8080 |
| `airflow-scheduler` | Scheduler das DAGs | — |
| `parquet-db` | Postgres + `pg_duckdb` (somente leitura) | `5433` |
| `parquet-db-init` | Build/refresh das tabelas (profile `parquet-init`) | — |

### 1.7 Qualidade e testes

- **Validação em duas camadas (não negociável):** linha a linha + Great Expectations, ambas derivadas do mesmo schema em `src/schemas/`. Carga que falha em qualquer camada **não** substitui a tabela publicada.
- Suíte: `pytest tests/ -v` (validadores, motor Polars, validador de Parquet, refresh do `parquet-db`).
- Via Docker: `docker compose run --rm -T -e PYTHONPATH=/app:/app/src app pytest tests/ -v` (o `PYTHONPATH` é necessário; sem ele a coleta falha com `ModuleNotFoundError: src`).
- Teste órfão conhecido: `tests/test_fortes_notas.py` importa função inexistente; no `origin/main` ele foi neutralizado com `pytest.skip` e nota explicativa (pareamento substituído pelo funil DuckDB em `processar_cruzamento_fortes`).

### 1.8 Orquestração (Airflow)

- DAG `tce_extracao_mensal`: backfill incremental diário + `refresh_parquet_db.py` ao final.
- Retry com backoff, alerta Slack (`SLACK_WEBHOOK_URL`), timezone `America/Fortaleza`.
- **Guarda de armazenamento:** task `verificar_armazenamento` aborta a extração se o disco de `data/` estiver abaixo de `AIRFLOW_MIN_FREE_SPACE_GB` (padrão 20 GB; `0` desativa).
- Refresh não-bloqueante: staging → troca em transação curta; troca abortada após 5 s se leitor segurar a tabela.

### 1.9 Governança e convenções vigentes

- Spec-Driven Development (`specify → plan → tasks → implement`), constituição v1.2.0 (`.specify/memory/constitution.md`), 6 princípios:
  I. Schema como Fonte Única da Verdade · II. Validação em Duas Camadas (NON-NEGOTIABLE) · III. Publicação Somente-Leitura · IV. Reprodutibilidade por Contêiner · V. Testes Obrigatórios e CI Verde · VI. Registro de Decisões nos Artefatos (o quê, por quê, alternativas, descartes — no mesmo PR).
- Commits no formato `<tipo>(<módulo>): <descrição>` (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`…). CI verde obrigatório antes do merge na `main`; deploy produz a partir da `main` (self-hosted, `docker compose up -d --build`).
- Consultas: local via DataGrip/DuckDB (`scripts/criar_views.py` gera views sobre `data/`, ignorando Parquets vazios); remoto via Postgres + `pg_duckdb` (usuário `SELECT`-only criado com `scripts/criar_usuario_leitura.sh`).

### 1.10 Regras críticas (não quebrar na cópia)

- **Parquets com 0 colunas em `data/` são cache negativo intencional.** Não apagar em limpeza/deploy/migração; builds devem ignorá-los sem erro. Apagar força reconsulta à API.
- **Parquets são a fonte de verdade.** Consumidores leem via tabelas publicadas, nunca os arquivos diretos.
- **`duckdb.memory_limit` limitado** (padrão 1536 MB via `PARQUET_DB_MEMORY_LIMIT`); processar Parquets em lotes.
- **Builds via Docker Compose**; segredos só em `.env` (não versionado); variáveis obrigatórias falham cedo (`:?`).
- Handoff entre sessões de agente: ler `docs/contexto-dos-agentes.md` antes de retomar (contém estado histórico — confirmar no código atual).

---

## 2. Diretrizes estratégicas da evolução (documento-base da refatoração)

### 2.1 Otimização de recursos: ingestão sob demanda (Lazy Loading & Cache)

Modelo híbrido baseado em **cache sob demanda** em vez de Data Lake estático gigante com histórico completo de todos os municípios.

**Por que não consultar a API em tempo real a cada clique:**

- *Incompatibilidade analítica:* APIs governamentais entregam JSONs paginados e isolados, sem motor de JOINs relacionais com o ERP legado sem sobrecarregar a aplicação.
- *Rate limiting e instabilidade:* centenas de requisições encadeadas por clique causam lentidão e throttling/bloqueio de IP.

**Solução — cache inteligente de Parquets (verificação prévia + gravação sob demanda):**

1. Usuário solicita auditoria (ex.: Crato / 2025).
2. Backend checa `data/parquet/crato_2025.parquet` local.
3. **Cache Hit:** DuckDB consulta o Parquet local em frações de segundo, sem tocar na API.
4. **Cache Miss:** requisição direcionada só àquele município/ano → valida contrato via Pandera → grava o Parquet → serve o resultado.

**Vantagem:** reduz drasticamente armazenamento e garante performance analítica em hardware enxuto.

> Nota de compatibilidade: o projeto atual usa **Pandera? Não** — validação hoje é via schemas próprios + Great Expectations. Adotar Pandera na ingestão sob demanda é **decisão nova** a validar (vs. reaproveitar `src/validators/` + `src/quality/`).

### 2.2 Evolução do frontend: Streamlit → arquitetura desacoplada

Motivação: com Editor SQL interativo, Assistente IA/RAG e RBAC, o Streamlit atinge limites de renderização global e concorrência. Alvo padrão de mercado: **desacoplamento total**.

**Arquitetura alvo:**

- **Backend (FastAPI / Python):** rotas REST assíncronas para consultas no DuckDB, processamento de LLMs, interface com Airflow.
- **Frontend (React / Next.js + Tailwind):** SPA modular, rápida e responsiva.

### 2.3 Componentes-chave da nova stack

**A. SQL Studio com Monaco Editor** — `@monaco-editor/react` (motor do VS Code): syntax highlight SQL, atalhos, autocomplete dinâmico baseado nos metadados das VIEWs do DuckDB. *(Especificado na Seção 4.)*

**B. Assistente de IA com streaming (SSE)** — backend transmite tokens via Server-Sent Events/WebSockets (estilo ChatGPT). **SQL Guardrails:** `sqlglot` analisa a sintaxe e permite só leitura (`SELECT`), bloqueando `DROP`/`UPDATE` etc.

**C. Segurança e RBAC** — JWT emitido pelo FastAPI, restrições granulares de UI por cargo (Admin, Gestor, Operador…), mapeadas nas rotas do backend.

---

## 3. Alinhamentos técnicos discutidos (2026-10-15)

### 3.1 Estratégia de migração

| Abordagem | Trade-off |
|---|---|
| Big Bang (troca completa) | Risco alto; evita duas stacks paralelas |
| **Strangler Fig / incremental (recomendado)** | Menor risco; valida UX cedo; convive com Streamlit temporariamente |

Sugestão: migrar primeiro **SQL Studio** (maior ganho de UX) e **Assistente IA** (streaming SSE); manter Consulta/Comparação/Validação no Streamlit até estabilizar.
**Em aberto:** tolerância a risco e prazo do time.

### 3.2 Camada de dados

- **DuckDB continua como motor analítico** — muda de *in-process* (Streamlit) para *serviço* (FastAPI).
- **Conexão em aberto:** pool DuckDB read-only no FastAPI **vs.** reaproveitar `pg_duckdb` no Postgres existente exposto via FastAPI. Decidir no `plan.md`.
- **Cache Miss em aberto:** extração sob demanda roda como *background task* do FastAPI **ou** delega ao Airflow? Se síncrono na request, timeout HTTP vira problema em municípios grandes.

### 3.3 Autenticação / RBAC (novo — hoje não há auth)

- **IdP em aberto:** próprio (FastAPI + hash + tokens) **vs.** externo (Keycloak, Auth0, OIDC gov.br).
- **Escopo inicial em aberto:** proteger só escrita/execução? SQL Studio executa só SELECT, mas IA pode ser restrita por perfil.
- **Base de usuários em aberto:** há base existente ou começa do zero?

### 3.4 SQL Guardrails (`sqlglot`)

- `sqlglot` valida a AST e bloqueia escrita. **Atenção:** `WITH RECURSIVE`, `UNNEST`, extensões DuckDB (`read_parquet()`) — o dialect `duckdb` cobre a maioria, mas exige **testes de regressão com queries reais** do painel.

### 3.5 Streaming SSE para IA

- FastAPI + `sse-starlette` (ou `EventSourceResponse`) funciona bem.
- **Infra:** serviço `app` (Streamlit) vira `frontend` (Next.js) + `api` (FastAPI); Ollama já em container separado (`tce-ollama-local`) — FastAPI chama via HTTP interno, sem mudança.

### 3.6 Deploy / Compose futuro

| Atual | Futuro |
|---|---|
| `app` (Streamlit :8501) | `frontend` (Next.js :3000) + `api` (FastAPI :8000) |
| `parquet-db` (pg_duckdb :5433) | mantém (read-only p/ FastAPI) |
| `airflow-*` | mantém (cargas recorrentes) |
| `extrator` / `cli` | podem virar jobs disparados via API |

Volumes: `data/` compartilhado **read-only** entre FastAPI e Airflow. Rede: 3000 + 8000 + 5433 + Ollama 11434.

### 3.7 Próximos passos sugeridos (na cópia)

1. **Spike (1–2 dias):** FastAPI mínimo com `/api/sql` (Monaco → DuckDB → JSON) + `/api/ai/stream` (SSE + Ollama + sqlglot) + auth JWT stub.
2. **PoC Frontend:** Next.js + Tailwind + `@monaco-editor/react` consumindo o spike.
3. **Decisão:** validar UX/performance → Strangler vs. Big Bang.
4. **Spec Kit:** `spec.md` por épico (SQL Studio ✅ nesta Seção 4; AI Assistant, Auth/RBAC, Lazy Ingestion pendentes) antes de implementar.

---

## 4. Spec 001 — SQL Studio com Monaco Editor (pronta p/ planejamento)

> Gerada via Spec Kit em 2026-10-15 a partir da descrição do usuário; validada no checklist de qualidade. Propositalmente **agnóstica de implementação** nos requisitos (detalhes técnicos vão em Assumptions/plan).

### 4.1 User stories

**US-1 (P1) — Executar consultas com editor profissional.** Analista abre o SQL Studio, digita SQL com highlight, autocomplete e Ctrl+Enter, e vê o resultado em grade paginada. Teste independente: abrir a página, rodar `SELECT 1`, ver `1`. Aceitação: (1) `SELECT * FROM notas_empenho LIMIT 10` retorna 10 linhas; (2) Ctrl+Enter executa sem clique; (3) digitar `FROM no` sugere `notas_empenho`, `notas_fiscais`…

**US-2 (P1) — Autocomplete contextual real.** Sugestões de tabelas/views/colunas do catálogo analítico, atualizadas quando o schema muda. Teste: checar que o catálogo é consultado ao conectar. Aceitação: (1) digitar `SELECT mun` sugere `municipio_referencia` em `liquidacoes`; (2) tabela publicada no refresh aparece após recarregar, sem restart do backend.

**US-3 (P2) — Histórico e queries salvas.** Salvar consultas nomeadas e recuperar histórico. Teste: salvar, fechar a aba, reabrir, recuperar. Aceitação: (1) salvar como "Total por Município" lista a query; (2) clicar numa salva carrega o SQL no editor.

**US-4 (P1, non-negotiable) — Guardrails: só leitura.** Pré-análise bloqueia tudo que não seja `SELECT`/`WITH` (INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, COPY, VACUUM, transações). Teste: `DROP TABLE notas_empenho` é bloqueado com erro amigável. Aceitação: (1) DROP bloqueado sem chegar ao banco; (2) `SELECT …; DELETE …` bloqueado (uma statement por execução); (3) `WITH cte AS (…) SELECT …` passa.

**Edge cases:** timeout (default 30 s, cancela no banco, erro amigável); resultado grande (limite default 5000 linhas + aviso de truncamento + export CSV/Parquet); queda de conexão (manter SQL digitado + "tentar novamente"); autocomplete em JOINs/subqueries/aliases no escopo correto; respeito a restrições futuras de RBAC.

### 4.2 Requisitos funcionais

- **FR-001:** editor SQL com syntax highlight (keywords, strings, números, comentários).
- **FR-002:** autocomplete contextual de tabelas/views/colunas a partir do catálogo analítico.
- **FR-003:** execução contra o motor analítico com grade paginada.
- **FR-004:** atalho Ctrl+Enter (Cmd+Enter no Mac) executa query/seleção.
- **FR-005:** validação prévia permitindo só leitura (`SELECT`, `WITH`).
- **FR-006:** rejeitar múltiplas statements (uma por execução).
- **FR-007:** exibir duração e contagem de linhas.
- **FR-008:** exportar resultado completo p/ formatos tabulares (CSV, Parquet).
- **FR-009:** histórico local das últimas N execuções (timestamp + status).
- **FR-010:** queries salvas nomeadas com persistência (por usuário com auth; local no MVP).
- **FR-011:** erros do banco legíveis, com linha/coluna quando possível.
- **FR-012:** timeout configurável (default 30 s) com cancelamento no banco.
- **FR-013:** limite de linhas configurável (default 5000) com indicador de truncamento.

**Entidades:** Query (texto + metadados de execução) · SavedQuery (nome + descrição + visibilidade) · SchemaMetadata (catálogo p/ autocomplete, TTL) · ExecutionResult (linhas + colunas + paginação/truncamento).

### 4.3 Critérios de sucesso (mensuráveis, agnósticos)

- **SC-001:** primeira query com autocomplete executada em < 30 s (abrir página → resultado).
- **SC-002:** 100% de escrita/maliciosas bloqueadas na pré-validação.
- **SC-003:** autocomplete cobre ≥ 95% das tabelas/colunas do catálogo.
- **SC-004:** latência Ctrl+Enter → primeiras linhas ≤ 2 s em query simples (`… LIMIT 10`) no hardware de dev.
- **SC-005:** salvar/listar/recarregar em ≤ 3 cliques.
- **SC-006:** zero perda do SQL digitado em erro/timeout.

### 4.4 Assumptions (pistas de implementação p/ o `plan.md`)

- API HTTP com endpoints de execução, validação, catálogo, histórico e salvas (contratos no `plan.md`/`contracts/`).
- MVP sem auth real (storage local); preparar `Authorization: Bearer <token>` p/ JWT+RBAC.
- Frontend :3000 + backend :8000 no mesmo Compose; `data/` read-only p/ o backend.
- Banco analítico = serviço `parquet-db` existente, conexão read-only; 21 tabelas de `endpoints.json` no schema público.
- Editor baseado no motor do VS Code (Monaco), via CDN ou build local, com workers configurados.
- Defaults: timeout 30 s, max rows 5000, page 50 (env no backend).
- **Fora do v1:** compartilhamento/versionamento de queries, explain plan, formatação automática.

---

## 5. Épicos futuros (esqueleto — especificar antes de implementar)

- **002 — Assistente IA com streaming:** chat Text-to-SQL evoluído (hoje: só contagem por fornecedor/exercício) → SSE token a token, guardrails `sqlglot`, histórico, "ver SQL", RAG sobre schemas/dicionário. Requer: contrato `/api/ai/stream`, política de escopo por perfil, fallback sem Ollama.
- **003 — Auth + RBAC:** login, JWT, papéis (Admin/Gestor/Operador…), proteção de rotas e filtragem de autocomplete/execução por perfil. Requer: escolha de IdP (Seção 3.3).
- **004 — Ingestão sob demanda:** endpoint `POST /auditorias` (município/ano) → check cache → hit serve / miss extrai+valida+persiste (Seção 2.1); fila/background, idempotência, progresso via polling/SSE, respeito a rate limit da API TCE. Requer: decisão FastAPI-task vs. Airflow (Seção 3.2) e Pandera vs. validadores atuais.

---

## 6. Como usar este documento numa cópia/demo

1. Copie o repo: `cp -r automacao_api_tse automacao_api_tse_refatoracao && cd automacao_api_tse_refatoracao`.
2. **Não leve:** `data/` (fonte de verdade local), `.env` (segredos), `tce.duckdb`, `__pycache__`, volumes Docker.
3. **Leve:** `src/`, `scripts/`, `tests/`, `endpoints.json`, `municipios.json`, `docker-compose.yml`, `Dockerfile`, `requirements.txt`, `docs/`, `.specify/`, este arquivo.
4. Na cópia, rode `/speckit-plan` sobre a Seção 4 (gera `plan.md` + `contracts/`), depois `/speckit-tasks` e `/speckit-implement` — épico por épico, começando pelo spike da Seção 3.7.
5. O projeto original **não** recebe commits desta refatoração até decisão explícita de merge.

---

## 7. Decisões registradas (log de alinhamento)

| Data | Decisão | Motivo | Alternativas descartadas |
|---|---|---|---|
| 2026-10-15 | Não implementar nada no projeto atual; só alinhar | Pedido explícito de estudar antes de alterar | Spike imediato no repo original |
| 2026-10-15 | Consolidar tudo neste `.md` standalone | Levar contexto completo p/ a cópia/demo | Manter só no chat |
| 2026-10-15 | Spec 001 (SQL Studio) agnóstica de implementação | Regra de qualidade Spec Kit (requirements sem tech) | Manter `sqlglot`/`FastAPI`/`information_schema` nos FRs |
| 2026-10-15 | Strangler Fig como recomendação inicial | Menor risco, validação precoce de UX | Big Bang direto |

---

## 8. Referências (arquivos-fonte no projeto original)

- `README.md` — comandos, fluxo operacional, tabelas, governança.
- `.specify/memory/constitution.md` (v1.2.0) — princípios e regras.
- `docs/contexto-dos-agentes.md` — handoff entre sessões (confirmar no código).
- `docker-compose.yml` — serviços e portas atuais.
- `endpoints.json` / `municipios.json` — catálogos.
- `src/modules/sql_explorer.py` + `src/modules/execucao_sql.py` — comportamento atual do SQL read-only.
- `src/modules/tce_ai_assistant.py` — Text-to-SQL atual (escopo mínimo).
- `scripts/refresh_parquet_db.py` — publicação staging → swap.
