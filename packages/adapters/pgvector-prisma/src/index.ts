import { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor } from '@typegraph-ai/adapter-pgvector'

/**
 * Minimal PrismaClient interface — only the methods TypeGraph uses.
 * Avoids requiring the full @prisma/client types at compile time.
 */
interface PrismaClientLike {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
  $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T>
}

export type PrismaAdapterConfig = Omit<PgVectorAdapterConfig, 'sql' | 'transaction'>

/**
 * Creates a PgVectorAdapter from an existing PrismaClient instance.
 *
 * Uses $queryRawUnsafe for SQL execution — despite the name, queries are
 * fully parameterized and injection-safe when positional $1/$2 params are
 * passed as separate arguments (which TypeGraph always does).
 */
export function createPrismaAdapter(
  prisma: PrismaClientLike,
  opts?: PrismaAdapterConfig
): PgVectorAdapter {
  const sql: SqlExecutor = async (query, params) => {
    return prisma.$queryRawUnsafe<Record<string, unknown>[]>(query, ...(params ?? []))
  }

  const transaction: PgVectorAdapterConfig['transaction'] = async (fn) => {
    return prisma.$transaction(async (tx) => {
      const txSql: SqlExecutor = async (query, params) => {
        return tx.$queryRawUnsafe<Record<string, unknown>[]>(query, ...(params ?? []))
      }
      return fn(txSql)
    })
  }

  return new PgVectorAdapter({ sql, transaction, ...opts })
}

export { PgVectorAdapter, type PgVectorAdapterConfig, type SqlExecutor }
