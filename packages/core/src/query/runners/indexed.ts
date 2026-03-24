import type { VectorStoreAdapter } from '../../types/adapter.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'
import type { NormalizedResult } from '../merger.js'

export class IndexedRunner {
  constructor(
    private adapter: VectorStoreAdapter
  ) {}

  /**
   * Run indexed search across sources grouped by embedding model.
   * For each model group: embed the query once, search, collect results.
   */
  async run(
    text: string,
    sourcesByModel: Map<string, { embedding: EmbeddingProvider; sourceIds: string[] }>,
    topK: number,
    tenantId?: string
  ): Promise<NormalizedResult[]> {
    const allResults: NormalizedResult[] = []

    for (const [modelId, group] of sourcesByModel) {
      // Embed query text once per distinct model
      const queryEmbedding = await group.embedding.embed(text)

      // Prefer hybrid search if available, fall back to vector-only
      const filter = {
        tenantId,
        // If only one source, filter to it; otherwise get all and filter client-side
        sourceId: group.sourceIds.length === 1 ? group.sourceIds[0] : undefined,
      }

      const chunks = this.adapter.hybridSearch
        ? await this.adapter.hybridSearch(modelId, queryEmbedding, text, { topK, filter })
        : await this.adapter.search(modelId, queryEmbedding, { topK, filter })

      for (const chunk of chunks) {
        // If multiple sources, filter client-side
        if (group.sourceIds.length > 1 && !group.sourceIds.includes(chunk.sourceId)) {
          continue
        }

        allResults.push({
          content: chunk.content,
          sourceId: chunk.sourceId,
          documentId: chunk.documentId,
          rawScores: {
            vector: chunk.scores.vector,
            keyword: chunk.scores.keyword,
          },
          normalizedScore: chunk.scores.rrf ?? chunk.scores.vector ?? 0,
          mode: 'indexed',
          metadata: chunk.metadata,
          chunk: {
            index: chunk.chunkIndex,
            total: chunk.totalChunks,
            isNeighbor: false,
          },
          url: chunk.metadata.url as string | undefined,
          title: chunk.metadata.title as string | undefined,
          updatedAt: chunk.indexedAt,
          tenantId: chunk.tenantId,
        })
      }
    }

    return allResults
  }
}
