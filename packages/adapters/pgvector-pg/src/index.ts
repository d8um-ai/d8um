import { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor } from '@typegraph-ai/adapter-pgvector'
import pg from 'pg'

export type PgAdapterConfig = Omit<PgVectorAdapterConfig, 'sql' | 'transaction'> & {
  connectionString: string
  /** pg.Pool options (e.g., max, idleTimeoutMillis, ssl) */
  poolOptions?: pg.PoolConfig
}

export function createPgAdapter(
  connectionString: string,
  opts?: Omit<PgAdapterConfig, 'connectionString'>
): PgVectorAdapter {
  const pool = new pg.Pool({
    connectionString,
    ...opts?.poolOptions,
  })

  const sql: SqlExecutor = async (query, params) => {
    const { rows } = await pool.query(query, params)
    return rows
  }

  const transaction: PgVectorAdapterConfig['transaction'] = async (fn) => {
    const client = await pool.connect()
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

  const { poolOptions: _, ...adapterOpts } = opts ?? {}
  return new PgVectorAdapter({ sql, transaction, ...adapterOpts })
}

export { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor }
