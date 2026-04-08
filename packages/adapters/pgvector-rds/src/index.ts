import { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor } from '@typegraph-ai/adapter-pgvector'
import pg from 'pg'

export type RdsAdapterConfig = Omit<PgVectorAdapterConfig, 'sql' | 'transaction'> & {
  connectionString: string
  /** pg.Pool options (e.g., max, idleTimeoutMillis) */
  poolOptions?: pg.PoolConfig
  /** IAM auth config — generates short-lived tokens instead of static passwords.
   *  Requires @aws-sdk/rds-signer to be installed (optional dependency). */
  iam?: {
    region: string
    hostname: string
    port?: number
    username: string
  }
}

export async function createRdsAdapter(
  connectionString: string,
  opts?: Omit<RdsAdapterConfig, 'connectionString'>
): Promise<PgVectorAdapter> {
  let poolConfig: pg.PoolConfig = {
    connectionString,
    ssl: { rejectUnauthorized: true },
    ...opts?.poolOptions,
  }

  if (opts?.iam) {
    const { Signer } = await import('@aws-sdk/rds-signer')
    const signer = new Signer({
      region: opts.iam.region,
      hostname: opts.iam.hostname,
      port: opts.iam.port ?? 5432,
      username: opts.iam.username,
    })
    const token = await signer.getAuthToken()
    poolConfig = { ...poolConfig, password: token }
  }

  const pool = new pg.Pool(poolConfig)

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

  const { poolOptions: _, iam: _iam, ...adapterOpts } = opts ?? {}
  return new PgVectorAdapter({ sql, transaction, ...adapterOpts })
}

export { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor }
