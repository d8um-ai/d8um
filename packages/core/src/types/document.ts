export interface EmbeddedChunk {
  idempotencyKey: string
  bucketId: string
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  sessionId?: string | undefined
  /** UUID referencing d8um_documents.id. */
  documentId: string

  content: string
  embedding: number[]
  embeddingModel: string
  chunkIndex: number
  totalChunks: number

  metadata: Record<string, unknown>
  indexedAt: Date
}

export interface ChunkFilter {
  bucketId?: string | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  sessionId?: string | undefined
  documentId?: string | undefined
  idempotencyKey?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface ScoredChunk extends EmbeddedChunk {
  scores: {
    vector?: number | undefined
    keyword?: number | undefined
    rrf?: number | undefined
  }
}
