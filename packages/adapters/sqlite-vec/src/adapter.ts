import type { VectorStoreAdapter, SearchOpts } from '@d8um/core'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@d8um/core'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { SqliteHashStore } from './hash-store.js'
import {
  REGISTRY_SQL,
  MODEL_CHUNKS_SQL,
  MODEL_VEC_SQL,
  HASH_TABLE_SQL,
  sanitizeModelKey,
} from './migrations.js'

export interface SqliteVecAdapterConfig {
  /** Path to the SQLite database file. Defaults to ':memory:'. */
  dbPath?: string | undefined
  /** Table prefix for chunk tables. Defaults to 'd8um_chunks'. */
  tablePrefix?: string | undefined
  /** Table name for the hash store. Defaults to 'd8um_hashes'. */
  hashesTable?: string | undefined
}

export class SqliteVecAdapter implements VectorStoreAdapter {
  readonly hashStore: SqliteHashStore

  private db: Database.Database
  private tablePrefix: string
  private hashesTable: string
  private registryTable: string

  /** model key → { chunksTable, vecTable } */
  private modelTables = new Map<string, { chunksTable: string; vecTable: string }>()

  constructor(config: SqliteVecAdapterConfig = {}) {
    this.db = new Database(config.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    sqliteVec.load(this.db)

    this.tablePrefix = config.tablePrefix ?? 'd8um_chunks'
    this.hashesTable = config.hashesTable ?? 'd8um_hashes'
    this.registryTable = `${this.tablePrefix}_registry`
    this.hashStore = new SqliteHashStore(this.db, this.hashesTable)
  }

  async initialize(): Promise<void> {
    this.db.exec(REGISTRY_SQL(this.registryTable))
    this.db.exec(HASH_TABLE_SQL(this.hashesTable))
    await this.hashStore.initialize()

    // Load existing model registrations
    const rows = this.db.prepare(
      `SELECT model_key, table_name FROM ${this.registryTable}`
    ).all() as Array<{ model_key: string; table_name: string }>

    for (const row of rows) {
      this.modelTables.set(row.model_key, {
        chunksTable: row.table_name,
        vecTable: `${row.table_name}_vec`,
      })
    }
  }

  async ensureModel(model: string, dimensions: number): Promise<void> {
    const key = sanitizeModelKey(model)
    if (this.modelTables.has(key)) return

    const chunksTable = `${this.tablePrefix}_${key}`
    const vecTable = `${chunksTable}_vec`

    this.db.exec(MODEL_CHUNKS_SQL(chunksTable))
    this.db.exec(MODEL_VEC_SQL(vecTable, dimensions))

    this.db.prepare(
      `INSERT INTO ${this.registryTable} (model_key, model_id, table_name, dimensions)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (model_key) DO NOTHING`
    ).run(key, model, chunksTable, dimensions)

    this.modelTables.set(key, { chunksTable, vecTable })
  }

  private getTables(model: string): { chunksTable: string; vecTable: string } {
    const key = sanitizeModelKey(model)
    const tables = this.modelTables.get(key)
    if (!tables) throw new Error(`No table registered for model "${model}". Call ensureModel() first.`)
    return tables
  }

  async upsertDocument(model: string, chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return
    const { chunksTable, vecTable } = this.getTables(model)

    const upsertChunk = this.db.prepare(
      `INSERT INTO ${chunksTable}
        (id, source_id, tenant_id, document_id, idempotency_key, content,
         embedding_model, chunk_index, total_chunks, metadata, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (idempotency_key, chunk_index, source_id) DO UPDATE SET
        id              = excluded.id,
        content         = excluded.content,
        embedding_model = excluded.embedding_model,
        total_chunks    = excluded.total_chunks,
        metadata        = excluded.metadata,
        indexed_at      = excluded.indexed_at`
    )

    const getRowid = this.db.prepare(
      `SELECT chunk_rowid FROM ${chunksTable} WHERE idempotency_key = ? AND chunk_index = ? AND source_id = ?`
    )

    const deleteVec = this.db.prepare(
      `DELETE FROM ${vecTable} WHERE rowid = ?`
    )

    const insertVec = this.db.prepare(
      `INSERT INTO ${vecTable} (rowid, embedding) VALUES (?, ?)`
    )

    const transaction = this.db.transaction((chunks: EmbeddedChunk[]) => {
      for (const chunk of chunks) {
        const id = crypto.randomUUID()
        upsertChunk.run(
          id,
          chunk.sourceId,
          chunk.tenantId ?? null,
          chunk.documentId,
          chunk.idempotencyKey,
          chunk.content,
          chunk.embeddingModel,
          chunk.chunkIndex,
          chunk.totalChunks,
          JSON.stringify(chunk.metadata),
          chunk.indexedAt.toISOString()
        )

        const row = getRowid.get(
          chunk.idempotencyKey,
          chunk.chunkIndex,
          chunk.sourceId
        ) as { chunk_rowid: number }

        const vecJson = JSON.stringify(chunk.embedding)
        // sqlite-vec requires BigInt for explicit rowid values
        const rowid = BigInt(row.chunk_rowid)
        deleteVec.run(rowid)
        insertVec.run(rowid, vecJson)
      }
    })

    transaction(chunks)
  }

  async delete(model: string, filter: ChunkFilter): Promise<void> {
    const { chunksTable, vecTable } = this.getTables(model)
    const { where, params } = buildWhere(filter)
    if (!where) throw new Error('delete() requires at least one filter field')

    // Get rowids to delete from vec table
    const rows = this.db.prepare(
      `SELECT chunk_rowid FROM ${chunksTable} WHERE ${where}`
    ).all(...params) as Array<{ chunk_rowid: number }>

    const transaction = this.db.transaction(() => {
      // Delete from vec table first
      const deleteVec = this.db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`)
      for (const row of rows) {
        deleteVec.run(BigInt(row.chunk_rowid))
      }
      // Delete from chunks table
      this.db.prepare(`DELETE FROM ${chunksTable} WHERE ${where}`).run(...params)
    })

    transaction()
  }

  async search(model: string, embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]> {
    const { chunksTable, vecTable } = this.getTables(model)
    const vecJson = JSON.stringify(embedding)
    const count = opts.count

    // sqlite-vec KNN: use k=? constraint inside WHERE (LIMIT not supported on vec0)
    // First get KNN results from vec table, then join to chunks for full data
    const { where: filterWhere, params: filterParams } = buildWhere(opts.filter)

    if (filterWhere) {
      // With filters: get KNN candidates first, then filter via subquery
      const rows = this.db.prepare(
        `SELECT c.*, v.distance
         FROM (
           SELECT rowid, distance FROM ${vecTable}
           WHERE embedding MATCH ? AND k = ?
         ) v
         JOIN ${chunksTable} c ON c.chunk_rowid = v.rowid
         WHERE ${filterWhere}
         ORDER BY v.distance`
      ).all(vecJson, count * 3, ...filterParams) as Array<Record<string, unknown>>

      return rows.slice(0, count).map(row => mapRowToScoredChunk(row))
    }

    // Without filters: simple KNN
    const rows = this.db.prepare(
      `SELECT c.*, v.distance
       FROM (
         SELECT rowid, distance FROM ${vecTable}
         WHERE embedding MATCH ? AND k = ?
       ) v
       JOIN ${chunksTable} c ON c.chunk_rowid = v.rowid
       ORDER BY v.distance`
    ).all(vecJson, count) as Array<Record<string, unknown>>

    return rows.map(row => mapRowToScoredChunk(row))
  }

  async countChunks(model: string, filter: ChunkFilter): Promise<number> {
    const { chunksTable } = this.getTables(model)
    const { where, params } = buildWhere(filter)
    const filterClause = where ? `WHERE ${where}` : ''
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM ${chunksTable} ${filterClause}`
    ).get(...params) as { count: number }
    return row.count
  }

  async destroy(): Promise<void> {
    this.db.close()
  }
}

function buildWhere(filter?: ChunkFilter): { where: string; params: unknown[] } {
  if (!filter) return { where: '', params: [] }

  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.sourceId != null) {
    conditions.push(`source_id = ?`)
    params.push(filter.sourceId)
  }
  if (filter.tenantId != null) {
    conditions.push(`tenant_id = ?`)
    params.push(filter.tenantId)
  }
  if (filter.documentId != null) {
    conditions.push(`document_id = ?`)
    params.push(filter.documentId)
  }
  if (filter.idempotencyKey != null) {
    conditions.push(`idempotency_key = ?`)
    params.push(filter.idempotencyKey)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function mapRowToScoredChunk(row: Record<string, unknown>): ScoredChunk {
  // sqlite-vec returns cosine distance (0 = identical, 2 = opposite)
  // Convert to similarity: 1 - (distance / 2) for cosine, or just 1 - distance for common usage
  const distance = row.distance as number
  const similarity = 1 - distance

  return {
    idempotencyKey: row.idempotency_key as string,
    sourceId: row.source_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    documentId: row.document_id as string,
    content: row.content as string,
    embedding: [], // Don't return the full vector
    embeddingModel: row.embedding_model as string,
    chunkIndex: row.chunk_index as number,
    totalChunks: row.total_chunks as number,
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
    indexedAt: new Date(row.indexed_at as string),
    scores: {
      vector: similarity,
    },
  }
}
