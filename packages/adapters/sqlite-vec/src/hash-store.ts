import type { HashStoreAdapter, HashRecord } from '@d8um/core'
import type Database from 'better-sqlite3'

function mapRow(row: Record<string, unknown>): HashRecord {
  return {
    idempotencyKey: row.idempotency_key as string,
    contentHash: row.content_hash as string,
    sourceId: row.source_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    embeddingModel: row.embedding_model as string,
    indexedAt: new Date(row.indexed_at as string),
    chunkCount: row.chunk_count as number,
  }
}

export class SqliteHashStore implements HashStoreAdapter {
  constructor(
    private db: Database.Database,
    private tableName: string
  ) {}

  async initialize(): Promise<void> {
    // Tables created via migrations in adapter.initialize()
  }

  async get(key: string): Promise<HashRecord | null> {
    const row = this.db.prepare(
      `SELECT * FROM ${this.tableName} WHERE store_key = ?`
    ).get(key) as Record<string, unknown> | undefined
    if (!row) return null
    return mapRow(row)
  }

  async set(key: string, record: HashRecord): Promise<void> {
    this.db.prepare(
      `INSERT INTO ${this.tableName}
        (store_key, idempotency_key, content_hash, source_id, tenant_id, embedding_model, indexed_at, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (store_key) DO UPDATE SET
        idempotency_key = excluded.idempotency_key,
        content_hash    = excluded.content_hash,
        source_id       = excluded.source_id,
        tenant_id       = excluded.tenant_id,
        embedding_model = excluded.embedding_model,
        indexed_at      = excluded.indexed_at,
        chunk_count     = excluded.chunk_count`
    ).run(
      key,
      record.idempotencyKey,
      record.contentHash,
      record.sourceId,
      record.tenantId ?? null,
      record.embeddingModel,
      record.indexedAt.toISOString(),
      record.chunkCount
    )
  }

  async delete(key: string): Promise<void> {
    this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE store_key = ?`
    ).run(key)
  }

  async listBySource(sourceId: string, tenantId?: string): Promise<HashRecord[]> {
    const rows = tenantId != null
      ? this.db.prepare(
          `SELECT * FROM ${this.tableName} WHERE source_id = ? AND tenant_id = ?`
        ).all(sourceId, tenantId)
      : this.db.prepare(
          `SELECT * FROM ${this.tableName} WHERE source_id = ? AND tenant_id IS NULL`
        ).all(sourceId)
    return (rows as Record<string, unknown>[]).map(mapRow)
  }

  async getLastRunTime(sourceId: string, tenantId?: string): Promise<Date | null> {
    const row = this.db.prepare(
      `SELECT last_run FROM ${this.tableName}_run_times
       WHERE source_id = ? AND tenant_id = ?`
    ).get(sourceId, tenantId ?? '') as Record<string, unknown> | undefined
    if (!row) return null
    return new Date(row.last_run as string)
  }

  async setLastRunTime(sourceId: string, tenantId: string | undefined, time: Date): Promise<void> {
    this.db.prepare(
      `INSERT INTO ${this.tableName}_run_times (source_id, tenant_id, last_run)
       VALUES (?, ?, ?)
       ON CONFLICT (source_id, tenant_id) DO UPDATE SET
        last_run = excluded.last_run`
    ).run(sourceId, tenantId ?? '', time.toISOString())
  }

  async deleteBySource(sourceId: string, tenantId?: string): Promise<void> {
    if (tenantId != null) {
      this.db.prepare(
        `DELETE FROM ${this.tableName} WHERE source_id = ? AND tenant_id = ?`
      ).run(sourceId, tenantId)
      this.db.prepare(
        `DELETE FROM ${this.tableName}_run_times WHERE source_id = ? AND tenant_id = ?`
      ).run(sourceId, tenantId)
    } else {
      this.db.prepare(
        `DELETE FROM ${this.tableName} WHERE source_id = ? AND tenant_id IS NULL`
      ).run(sourceId)
      this.db.prepare(
        `DELETE FROM ${this.tableName}_run_times WHERE source_id = ? AND tenant_id IS NULL`
      ).run(sourceId)
    }
  }
}
