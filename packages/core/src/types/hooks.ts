import type { d8umResult } from './query.js'
import type { IndexOpts, IndexResult } from './index-types.js'

export interface d8umHooks {
  /** Fired after query() returns results. Use for citation tracking. */
  onQueryResults?: ((query: string, results: d8umResult[]) => void | Promise<void>) | undefined
  /** Fired before indexing starts for a source. */
  onIndexStart?: ((sourceId: string, opts: IndexOpts) => void | Promise<void>) | undefined
  /** Fired after indexing completes for a source. */
  onIndexComplete?: ((sourceId: string, result: IndexResult) => void | Promise<void>) | undefined
  /** Fired after memory extraction produces results. */
  onMemoryExtracted?: ((result: { episodicCount: number; factsExtracted: number; operationsCount: number }) => void | Promise<void>) | undefined
  /** Fired when contradictions are detected between memory records. */
  onContradictionDetected?: ((contradictions: { existingId: string; newId: string; conflictType: string; reasoning: string }[]) => void | Promise<void>) | undefined
}
