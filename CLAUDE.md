# CLAUDE.md — d8um Project Guide

d8um is a TypeScript SDK for retrieval + memory for AI agents, built on Postgres + pgvector.

## Architecture

- **Monorepo**: pnpm workspaces + turborepo
- **Benchmarks dir**: Uses npm (not pnpm) with `file:` protocol deps pointing to the SDK
- **Database**: Neon serverless Postgres with pgvector
- **Embeddings**: AI Gateway (Vercel) → openai/text-embedding-3-small
- **LLM**: AI Gateway → google/gemini-3.1-flash-lite-preview
- **Blob storage**: Vercel Blob (for benchmark datasets)

## Sandbox Limitations

Claude Code runs in a sandboxed environment with **no outbound network access** except to GitHub (github.com, api.github.com). All external services (Neon DB, AI Gateway, Vercel Blob, npm registry for installs) are unreachable from the sandbox.

**You cannot run benchmarks or database queries directly.** Use the CI workflows described below.

## Running Benchmarks

Benchmarks are triggered via GitHub Actions using commit message tags. Results are posted as PR comments.

### Prerequisites

1. You must be on a **non-main branch** with an **open PR**
2. Push a commit with a benchmark tag in the commit message

### Commit Message Tags

Format: `[bench:DATASET/VARIANT]` or `[bench:DATASET/VARIANT:seed]`

- **DATASET**: `nfcorpus`, `australian-tax-guidance-retrieval`, `contractual-clause-retrieval`, `license-tldr-retrieval`, `mleb-scalr`, `legal-rag-bench`, or `all`
- **VARIANT**: `core` (hybrid search), `neural` (hybrid + memory + PPR graph), or `all`
- **:seed** (optional): Seeds the database with benchmark corpus first. Required on first run or when testing ingestion changes.

### Examples

```
feat: improve hybrid search scoring [bench:nfcorpus/core]
```

```
refactor: update embedding pipeline [bench:nfcorpus/core:seed] [bench:nfcorpus/neural:seed]
```

```
test: run all benchmarks [bench:all/all:seed]
```

### Reading Results

After pushing, the workflow runs and posts results as PR comments. Use the GitHub MCP tools to read them:

1. List PR comments to find benchmark results
2. Results include: nDCG@10, MAP@10, Recall@10, Precision@10, timing data
3. A consolidated summary table is posted when multiple benchmarks run together
4. If a benchmark fails, a failure comment with a link to the workflow logs is posted

### Timeouts

| Variant | Without seed | With seed |
|---------|-------------|-----------|
| core    | 15 min      | 60 min    |
| neural  | 30 min      | 360 min   |

### Workflow File

`.github/workflows/benchmarks.yml` — Locked to actors `fIa5h` and `claude` only.

## Database Queries

Database queries are executed via a GitHub Actions proxy workflow. You push a SQL file, the workflow runs it against Neon, and commits the result back.

### How to Query

1. Create a folder under `db-queries/` with a descriptive name (e.g., `db-queries/check-tables/`)
2. Write a `query.sql` file in that folder
3. Commit and push — the `db-inspect` workflow triggers automatically
4. Wait for the workflow to complete, then pull or read `db-queries/<folder>/result.json` from the repo

### Example

```sql
-- db-queries/list-tables/query.sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
```

The workflow will commit `db-queries/list-tables/result.json` with the query output in CSV format.

### Reading Results

After pushing, pull the branch to get the result file, or use GitHub MCP tools to read the file contents directly from the repo.

### Workflow File

`.github/workflows/db-inspect.yml` — Locked to actors `fIa5h` and `claude` only. Has `contents: write` permission to push results back.

## Benchmark Datasets (6 datasets × 2 variants = 12 benchmarks)

| Dataset | Description |
|---------|-------------|
| nfcorpus | Biomedical information retrieval (BEIR) |
| australian-tax-guidance-retrieval | Australian tax law documents |
| contractual-clause-retrieval | Legal contract clauses |
| license-tldr-retrieval | Software license summaries |
| mleb-scalr | Multi-language evaluation benchmark |
| legal-rag-bench | Legal RAG evaluation |

## Metrics

All benchmarks report BEIR-standard metrics at cutoff 10:
- **nDCG@10**: Normalized Discounted Cumulative Gain
- **MAP@10**: Mean Average Precision
- **Recall@10**: Recall
- **Precision@10**: Precision

## Development

```bash
pnpm install          # Install SDK deps
pnpm run build        # Build SDK
cd benchmarks && npm install  # Install benchmark deps (separate npm)
```

## Secrets (configured in GitHub repo settings)

- `NEON_DATABASE_URL` — Neon Postgres connection string
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway key (embeddings + LLM)
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob storage token

## Operational Knowledge

Hard-won learnings from debugging the benchmark pipeline. Read this before running benchmarks or DB queries.

### Database Table Naming

Chunk tables use the full embedding model path, not a numeric ID:
- Chunks: `{prefix}_gateway_openai_text_embedding_3_small`
- Registry: `{prefix}_registry`
- Shared across all benchmarks: `d8um_documents`, `d8um_hashes`, `d8um_buckets`

Example table prefixes per benchmark runner:
- `bench_license_core_` → `bench_license_core__gateway_openai_text_embedding_3_small`
- `bench_legalrag_core_` → `bench_legalrag_core__gateway_openai_text_embedding_3_small`

### Core vs Neural Variant Isolation

Core and neural variants are fully isolated — no DB cleanup needed between them:
- Separate table prefixes: `bench_license_core_*` vs `bench_license_neural_*`
- Separate buckets: `license-tldr` vs `license-tldr-neural`
- Neural adds graph tables: `*_memories`, `*_entities`, `*_edges`

### Seeding Behavior

**`--seed` does NOT drop or recreate tables.** It re-ingests via upsert.

- Hash store (`deduplicateBy: ['content']`) creates entries keyed by SHA256 of content
- On re-seed, hash store check skips docs where content + embedding model haven't changed
- `ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE` prevents row duplication at DB level
- Interrupted seeds resume correctly — completed docs have hash entries and get skipped on retry

**Metadata propagation caveat:** If data was seeded WITHOUT `propagateMetadata: ['metadata.corpusId']`, re-seeding won't fix it — the hash store matches on content+model (unchanged) and skips the doc before the upsert fires. To fix: clear hash entries for that bucket, or force re-ingestion.

### DB Query Workflow Gotchas

- **`[skip ci]` prevents ALL workflows** including db-inspect — never use it on query pushes
- **Empty commits won't trigger** — the `query.sql` file must appear in the commit diff (HEAD~1 vs HEAD)
- Results are committed back as `db-queries/{name}/result.json`
- The workflow may push results while you're working — pull before pushing to avoid rejected pushes

### Benchmark CI Notes

- Concurrency groups prevent the same dataset/variant from running in parallel
- History commit step uses fetch/reset/re-apply pattern (not rebase) for concurrent push safety
- `contents: write` permission is required for both PR comments and history commits
- Build is scoped: `pnpm turbo run build --filter=@d8um/adapter-pgvector`

### Corpus Sizes

For estimating seed times (~3 docs/s embedding throughput):

| Dataset | Corpus | Queries | Est. Seed Time |
|---------|--------|---------|----------------|
| license-tldr-retrieval | 65 | 65 | ~30s |
| contractual-clause-retrieval | ~90 | ~90 | ~30s |
| australian-tax-guidance-retrieval | ~105 | ~112 | ~35s |
| nfcorpus | ~3,633 | ~323 | ~20min |
| legal-rag-bench | 4,876 | 100 | ~27min |
| mleb-scalr | unknown | unknown | unknown |

### Baselines & History Files

- External baselines: `benchmarks/{dataset}/baselines.json` — compared in PR comments
- Run history: `benchmarks/{dataset}/{variant}/history.json` — auto-committed by CI
- PR comments show comparison table (d8um vs top-3 baselines) + delta from previous run
- Only nDCG@10 has cross-system baselines; MAP/Recall/Precision are d8um-internal tracking only

### Neon Postgres Compatibility

- Cannot use expressions (e.g. `COALESCE`) in `PRIMARY KEY` constraints — use `DEFAULT ''` instead
- Cannot execute multi-statement prepared statements — split DDL on semicolons and execute individually
- `SET LOCAL` requires explicit transaction wrapping
