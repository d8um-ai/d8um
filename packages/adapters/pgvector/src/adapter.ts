import type { VectorStoreAdapter, SearchOpts } from '@d8um/core'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@d8um/core'
import { REGISTRY_SQL, MODEL_TABLE_SQL, HASH_TABLE_SQL, sanitizeModelKey } from './migrations.js'
import { PgHashStore } from './hash-store.js'

/**
 * A function that runs a parameterized SQL query and returns rows.
 * Bring your own Postgres driver — Neon, node-postgres, Drizzle, etc.
 *
 * @example
 * ```ts
 * // Neon serverless
 * import { neon } from '@neondatabase/serverless'
 * const sql: SqlExecutor = neon(process.env.DATABASE_URL)
 *
 * // node-postgres
 * import { Pool } from 'pg'
 * const pool = new Pool({ connectionString: '...' })
 * const sql: SqlExecutor = (q, p) => pool.query(q, p).then(r => r.rows)
 * ```
 */
export type SqlExecutor = (
  query: string,
  params?: unknown[]
) => Promise<Record<string, unknown>[]>

export interface PgVectorAdapterConfig {
  sql: SqlExecutor
  /** Optional transaction wrapper for drivers that need explicit transaction blocks.
   *  Required for iterative HNSW scan (SET LOCAL needs a transaction). */
  transaction?: (fn: (sql: SqlExecutor) => Promise<unknown>) => Promise<unknown>
  tablePrefix?: string | undefined
  hashesTable?: string | undefined
}

export class PgVectorAdapter implements VectorStoreAdapter {
  private sql: SqlExecutor
  private transaction?: PgVectorAdapterConfig['transaction']
  readonly hashStore: PgHashStore
  private tablePrefix: string
  private hashesTable: string
  private registryTable: string

  /** model key → table name */
  private modelTables = new Map<string, string>()

  constructor(config: PgVectorAdapterConfig) {
    this.sql = config.sql
    this.transaction = config.transaction
    this.tablePrefix = config.tablePrefix ?? 'd8um_chunks'
    this.hashesTable = config.hashesTable ?? 'd8um_hashes'
    this.registryTable = `${this.tablePrefix}_registry`
    this.hashStore = new PgHashStore(this.sql, this.hashesTable)
  }

  async initialize(): Promise<void> {
    await this.sql(`CREATE EXTENSION IF NOT EXISTS vector;`)
    await this.sql(REGISTRY_SQL(this.registryTable))
    await this.sql(HASH_TABLE_SQL(this.hashesTable))
    await this.hashStore.initialize()

    // Load existing model registrations
    const rows = await this.sql(`SELECT model_key, table_name FROM ${this.registryTable}`)
    for (const row of rows) {
      this.modelTables.set(row.model_key as string, row.table_name as string)
    }
  }

  async ensureModel(model: string, dimensions: number): Promise<void> {
    const key = sanitizeModelKey(model)
    if (this.modelTables.has(key)) return

    const tableName = `${this.tablePrefix}_${key}`
    await this.sql(MODEL_TABLE_SQL(tableName, dimensions))
    await this.sql(
      `INSERT INTO ${this.registryTable} (model_key, model_id, table_name, dimensions)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (model_key) DO NOTHING`,
      [key, model, tableName, dimensions]
    )
    this.modelTables.set(key, tableName)
  }

  private getTable(model: string): string {
    const key = sanitizeModelKey(model)
    const table = this.modelTables.get(key)
    if (!table) throw new Error(`No table registered for model "${model}". Call ensureModel() first.`)
    return table
  }

  async upsertDocument(model: string, chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return
    const table = this.getTable(model)

    const sourceIds: string[] = []
    const tenantIds: (string | null)[] = []
    const documentIds: string[] = []
    const idempotencyKeys: string[] = []
    const contents: string[] = []
    const embeddings: string[] = []
    const embeddingModels: string[] = []
    const chunkIndices: number[] = []
    const totalChunks: number[] = []
    const metadatas: string[] = []
    const indexedAts: string[] = []

    for (const chunk of chunks) {
      sourceIds.push(chunk.sourceId)
      tenantIds.push(chunk.tenantId ?? null)
      documentIds.push(chunk.documentId)
      idempotencyKeys.push(chunk.idempotencyKey)
      contents.push(chunk.content)
      embeddings.push(`[${chunk.embedding.join(',')}]`)
      embeddingModels.push(chunk.embeddingModel)
      chunkIndices.push(chunk.chunkIndex)
      totalChunks.push(chunk.totalChunks)
      metadatas.push(JSON.stringify(chunk.metadata))
      indexedAts.push(chunk.indexedAt.toISOString())
    }

    await this.sql(
      `INSERT INTO ${table}
        (source_id, tenant_id, document_id, idempotency_key, content, embedding,
         embedding_model, chunk_index, total_chunks, metadata, indexed_at)
       SELECT * FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::vector[],
        $7::text[], $8::int[], $9::int[], $10::jsonb[], $11::timestamptz[]
       )
       ON CONFLICT (idempotency_key, chunk_index, source_id) DO UPDATE SET
        content         = EXCLUDED.content,
        embedding       = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        total_chunks    = EXCLUDED.total_chunks,
        metadata        = EXCLUDED.metadata,
        indexed_at      = EXCLUDED.indexed_at`,
      [
        sourceIds, tenantIds, documentIds, idempotencyKeys, contents, embeddings,
        embeddingModels, chunkIndices, totalChunks, metadatas, indexedAts,
      ]
    )
  }

  async delete(model: string, filter: ChunkFilter): Promise<void> {
    const table = this.getTable(model)
    const { where, params } = buildWhere(filter)
    if (!where) throw new Error('delete() requires at least one filter field')
    await this.sql(`DELETE FROM ${table} WHERE ${where}`, params)
  }

  async search(model: string, embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]> {
    const table = this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const { where, params } = buildWhere(opts.filter)
    const filterClause = where ? `WHERE ${where}` : ''
    const topK = opts.topK

    const runQuery = async (sql: SqlExecutor): Promise<ScoredChunk[]> => {
      if (opts.iterativeScan !== false) {
        await sql(`SET LOCAL hnsw.iterative_scan = relaxed_order;`)
      }
      const paramOffset = params.length
      const rows = await sql(
        `SELECT *, 1 - (embedding <=> $${paramOffset + 1}::vector) AS similarity
         FROM ${table}
         ${filterClause}
         ORDER BY embedding <=> $${paramOffset + 1}::vector
         LIMIT $${paramOffset + 2}`,
        [...params, vectorStr, topK]
      )
      return rows.map(row => mapRowToScoredChunk(row, { vector: row.similarity as number }))
    }

    if (this.transaction) {
      return this.transaction(runQuery) as Promise<ScoredChunk[]>
    }
    return runQuery(this.sql)
  }

  async hybridSearch(
    model: string,
    embedding: number[],
    query: string,
    opts: SearchOpts
  ): Promise<ScoredChunk[]> {
    const table = this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const topK = opts.topK
    const { where: filterWhere, params: filterParams } = buildWhere(opts.filter)
    const filterClause = filterWhere ? `AND ${filterWhere}` : ''

    // Offset param indices past filter params: $1=vectorStr, $2=query, $3=topK, then filter params
    const baseOffset = 3
    const reindexedFilter = filterClause.replace(
      /\$(\d+)/g,
      (_, n) => `$${parseInt(n) + baseOffset}`
    )

    const runQuery = async (sql: SqlExecutor): Promise<ScoredChunk[]> => {
      if (opts.iterativeScan !== false) {
        await sql(`SET LOCAL hnsw.iterative_scan = relaxed_order;`)
      }

      const rows = await sql(
        `WITH
          tsq AS (
            SELECT websearch_to_tsquery('english', $2) AS q
          ),
          vector_ranked AS (
            SELECT *, 1 - (embedding <=> $1::vector) AS similarity,
                   ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vrank
            FROM ${table}
            WHERE TRUE ${reindexedFilter}
            ORDER BY embedding <=> $1::vector
            LIMIT 60
          ),
          keyword_ranked AS (
            SELECT *, ts_rank(search_vector, tsq.q) AS kw_score,
                   ROW_NUMBER() OVER (ORDER BY ts_rank(search_vector, tsq.q) DESC) AS krank
            FROM ${table}, tsq
            WHERE search_vector @@ tsq.q ${reindexedFilter}
            ORDER BY ts_rank(search_vector, tsq.q) DESC
            LIMIT 60
          ),
          combined AS (
            SELECT id, source_id, tenant_id, document_id, idempotency_key, content,
                   embedding, embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   similarity, NULL::double precision AS kw_score,
                   vrank, NULL::bigint AS krank
            FROM vector_ranked
            UNION ALL
            SELECT id, source_id, tenant_id, document_id, idempotency_key, content,
                   embedding, embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   NULL::double precision AS similarity, kw_score,
                   NULL::bigint AS vrank, krank
            FROM keyword_ranked
          ),
          scored AS (
            SELECT *,
              COALESCE(1.0 / (60 + vrank), 0) + COALESCE(1.0 / (60 + krank), 0) AS rrf_score,
              ROW_NUMBER() OVER (
                PARTITION BY id
                ORDER BY COALESCE(similarity, 0) DESC
              ) AS dedup_rank
            FROM combined
          )
        SELECT id, source_id, tenant_id, document_id, idempotency_key, content,
               embedding_model, chunk_index, total_chunks, metadata, indexed_at,
               MAX(similarity) AS similarity,
               MAX(kw_score) AS keyword_score,
               SUM(rrf_score) AS rrf_score
        FROM scored
        WHERE dedup_rank = 1
        GROUP BY id, source_id, tenant_id, document_id, idempotency_key, content,
                 embedding_model, chunk_index, total_chunks, metadata, indexed_at
        ORDER BY SUM(rrf_score) DESC
        LIMIT $3`,
        [vectorStr, query, topK, ...filterParams]
      )

      return rows.map(row => mapRowToScoredChunk(row, {
        vector: (row.similarity as number) ?? undefined,
        keyword: (row.keyword_score as number) ?? undefined,
        rrf: row.rrf_score as number,
      }))
    }

    if (this.transaction) {
      return this.transaction(runQuery) as Promise<ScoredChunk[]>
    }
    return runQuery(this.sql)
  }

  async countChunks(model: string, filter: ChunkFilter): Promise<number> {
    const table = this.getTable(model)
    const { where, params } = buildWhere(filter)
    const filterClause = where ? `WHERE ${where}` : ''
    const rows = await this.sql(
      `SELECT COUNT(*)::int AS count FROM ${table} ${filterClause}`,
      params
    )
    return (rows[0]?.count as number) ?? 0
  }

  async destroy(): Promise<void> {
    // No-op — the developer owns the connection lifecycle
  }
}

function buildWhere(filter?: ChunkFilter): { where: string; params: unknown[] } {
  if (!filter) return { where: '', params: [] }

  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.sourceId != null) {
    params.push(filter.sourceId)
    conditions.push(`source_id = $${params.length}`)
  }
  if (filter.tenantId != null) {
    params.push(filter.tenantId)
    conditions.push(`tenant_id = $${params.length}`)
  }
  if (filter.documentId != null) {
    params.push(filter.documentId)
    conditions.push(`document_id = $${params.length}`)
  }
  if (filter.idempotencyKey != null) {
    params.push(filter.idempotencyKey)
    conditions.push(`idempotency_key = $${params.length}`)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function mapRowToScoredChunk(
  row: Record<string, unknown>,
  scores: { vector?: number; keyword?: number; rrf?: number }
): ScoredChunk {
  return {
    idempotencyKey: row.idempotency_key as string,
    sourceId: row.source_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    documentId: row.document_id as string,
    content: row.content as string,
    embedding: [], // Don't return the full vector — too large and unnecessary
    embeddingModel: row.embedding_model as string,
    chunkIndex: row.chunk_index as number,
    totalChunks: row.total_chunks as number,
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>,
    indexedAt: new Date(row.indexed_at as string),
    scores: {
      vector: scores.vector,
      keyword: scores.keyword,
      rrf: scores.rrf,
    },
  }
}
