import { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor } from '@typegraph-ai/adapter-pgvector'
import { Server } from '@niledatabase/server'
import type { ServerConfig } from '@niledatabase/server'

export type NileAdapterConfig = Omit<PgVectorAdapterConfig, 'sql' | 'transaction'>

/**
 * Creates a PgVectorAdapter from a Nile Server instance.
 * The Nile SDK's db property is a pg.Pool — queries are automatically
 * scoped to the current tenant when server.tenantId is set.
 */
export function createNileAdapter(
  server: Server,
  opts?: NileAdapterConfig
): PgVectorAdapter {
  const sql: SqlExecutor = async (query, params) => {
    const { rows } = await server.db.query(query, params)
    return rows
  }

  const transaction: PgVectorAdapterConfig['transaction'] = async (fn) => {
    const client = await server.db.connect()
    try {
      await client.query('BEGIN')
      const txSql: SqlExecutor = async (query, params) => {
        const { rows } = await client.query(query, params)
        return rows
      }
      const result = await fn(txSql)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  return new PgVectorAdapter({ sql, transaction, ...opts })
}

export { Server, type ServerConfig, PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor }
