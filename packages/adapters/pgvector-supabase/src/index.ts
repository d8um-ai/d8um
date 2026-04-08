import { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor } from '@typegraph-ai/adapter-pgvector'
import postgres from 'postgres'

export type SupabaseAdapterConfig = Omit<PgVectorAdapterConfig, 'sql' | 'transaction'> & {
  connectionString: string
  /** postgres.js connection options (e.g., max connections, ssl) */
  postgresOptions?: postgres.Options<Record<string, never>>
}

export function createSupabaseAdapter(
  connectionString: string,
  opts?: Omit<SupabaseAdapterConfig, 'connectionString'>
): PgVectorAdapter {
  const client = postgres(connectionString, {
    ssl: 'require',
    ...opts?.postgresOptions,
  })

  // postgres.js uses tagged templates by default; .unsafe() accepts raw SQL
  // strings with $1/$2 positional params — still fully parameterized and
  // injection-safe when params are passed as the second argument.
  const sql: SqlExecutor = async (query, params) => {
    const rows = await client.unsafe(query, params as any[])
    return rows as Record<string, unknown>[]
  }

  const transaction: PgVectorAdapterConfig['transaction'] = async (fn) => {
    return client.begin(async (tx) => {
      const txSql: SqlExecutor = async (query, params) => {
        const rows = await tx.unsafe(query, params as any[])
        return rows as Record<string, unknown>[]
      }
      return fn(txSql)
    })
  }

  const { postgresOptions: _, ...adapterOpts } = opts ?? {}
  return new PgVectorAdapter({ sql, transaction, ...adapterOpts })
}

export { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor }
