import type { GraphBridge } from '../../types/graph-bridge.js'
import type { d8umIdentity } from '../../types/identity.js'
import type { NormalizedResult } from '../merger.js'

export class MemoryRunner {
  constructor(private graph: GraphBridge) {}

  async run(
    text: string,
    identity: d8umIdentity,
    count: number
  ): Promise<NormalizedResult[]> {
    const memories = await this.graph.recall(text, identity, { limit: count })

    return memories.map((m, i) => {
      const mem = m as Record<string, unknown>
      return {
        content: (mem.content as string) ?? '',
        bucketId: '__memory__',
        documentId: (mem.id as string) ?? `memory-${i}`,
        rawScores: {
          memory: (mem.importance as number) ?? 0.5,
        },
        normalizedScore: (mem.importance as number) ?? 0.5,
        mode: 'memory' as const,
        metadata: (mem.metadata as Record<string, unknown>) ?? {},
        tenantId: identity.tenantId,
      }
    })
  }
}
