import { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor } from '@typegraph-ai/adapter-pgvector'
import { neon } from '@neondatabase/serverless'

export type NeonAdapterConfig = Omit<PgVectorAdapterConfig, 'sql' | 'transaction'> & {
  connectionString: string
}

export function createNeonAdapter(
  connectionString: string,
  opts?: Omit<NeonAdapterConfig, 'connectionString'>
): PgVectorAdapter {
  const sql = neon(connectionString) as unknown as SqlExecutor
  return new PgVectorAdapter({ sql, ...opts })
}

export { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor }
