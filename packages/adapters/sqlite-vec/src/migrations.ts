/**
 * Sanitize a model identifier into a valid SQL table name suffix.
 * e.g., "openai/text-embedding-3-small" → "openai_text_embedding_3_small"
 */
export function sanitizeModelKey(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * DDL for the model registry table - tracks which embedding models
 * have been initialized and their table names / dimensions.
 */
export const REGISTRY_SQL = (registryTable: string) => `
  CREATE TABLE IF NOT EXISTS ${registryTable} (
    model_key   TEXT PRIMARY KEY,
    model_id    TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    dimensions  INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`

/**
 * DDL for a per-model chunks table (regular table - metadata + content).
 * The vector data lives in a separate vec0 virtual table.
 */
export const MODEL_CHUNKS_SQL = (chunksTable: string) => `
  CREATE TABLE IF NOT EXISTS ${chunksTable} (
    chunk_rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL,
    bucket_id       TEXT NOT NULL,
    tenant_id       TEXT,
    document_id     TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    content         TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    total_chunks    INTEGER NOT NULL,
    metadata        TEXT NOT NULL DEFAULT '{}',
    indexed_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ${chunksTable}_ikey_chunk_idx
    ON ${chunksTable} (idempotency_key, chunk_index, bucket_id);

  CREATE INDEX IF NOT EXISTS ${chunksTable}_source_tenant_idx
    ON ${chunksTable} (bucket_id, tenant_id);

  CREATE INDEX IF NOT EXISTS ${chunksTable}_doc_chunk_idx
    ON ${chunksTable} (document_id, chunk_index);
`

/**
 * DDL for the vec0 virtual table that stores embeddings for vector search.
 * Linked to the chunks table via rowid.
 */
export const MODEL_VEC_SQL = (vecTable: string, dimensions: number) =>
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTable} USING vec0(embedding float[${dimensions}]);`

/**
 * DDL for the shared hash store table.
 */
export const HASH_TABLE_SQL = (hashesTable: string) => `
  CREATE TABLE IF NOT EXISTS ${hashesTable} (
    store_key       TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    bucket_id       TEXT NOT NULL,
    tenant_id       TEXT,
    embedding_model TEXT NOT NULL,
    indexed_at      TEXT NOT NULL,
    chunk_count     INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS ${hashesTable}_bucket_idx
    ON ${hashesTable} (bucket_id, tenant_id);

  CREATE TABLE IF NOT EXISTS ${hashesTable}_run_times (
    bucket_id  TEXT NOT NULL,
    tenant_id  TEXT DEFAULT '',
    last_run   TEXT NOT NULL,
    PRIMARY KEY (bucket_id, tenant_id)
  );
`

/**
 * DDL for the sources table.
 */
export const BUCKETS_TABLE_SQL = (table: string) => `
  CREATE TABLE IF NOT EXISTS ${table} (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    tenant_id   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`

/**
 * DDL for the jobs table.
 */
export const JOBS_TABLE_SQL = (table: string) => `
  CREATE TABLE IF NOT EXISTS ${table} (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT,
    bucket_id   TEXT,
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    config      TEXT NOT NULL DEFAULT '{}',
    schedule    TEXT,
    status      TEXT NOT NULL DEFAULT 'idle',
    last_run_at TEXT,
    next_run_at TEXT,
    run_count   INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`

/**
 * DDL for the job runs table.
 */
export const JOB_RUNS_TABLE_SQL = (table: string) => `
  CREATE TABLE IF NOT EXISTS ${table} (
    id                TEXT PRIMARY KEY,
    job_id            TEXT NOT NULL,
    bucket_id         TEXT,
    status            TEXT NOT NULL DEFAULT 'running',
    summary           TEXT,
    documents_created INTEGER NOT NULL DEFAULT 0,
    documents_updated INTEGER NOT NULL DEFAULT 0,
    documents_deleted INTEGER NOT NULL DEFAULT 0,
    metrics           TEXT NOT NULL DEFAULT '{}',
    error             TEXT,
    duration_ms       INTEGER,
    started_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at      TEXT
  );
`

/**
 * DDL for the document-job relations table.
 */
export const DOCUMENT_JOB_RELATIONS_TABLE_SQL = (table: string) => `
  CREATE TABLE IF NOT EXISTS ${table} (
    document_id TEXT NOT NULL,
    job_id      TEXT NOT NULL,
    relation    TEXT NOT NULL,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, job_id)
  );
`
