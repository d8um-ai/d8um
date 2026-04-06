import type { d8umInstance, d8umConfig, BucketsApi, DocumentsApi } from '../d8um.js'
import type { Bucket, CreateBucketInput, BucketListFilter, IndexConfig } from '../types/bucket.js'
import type { QueryOpts, QueryResponse, d8umResult, AssembleOpts } from '../types/query.js'
import type { IndexOpts, IndexResult } from '../types/index-types.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { RawDocument, Chunk } from '../types/connector.js'
import type { d8umDocument, DocumentFilter } from '../types/d8um-document.js'
import type { d8umIdentity } from '../types/identity.js'
import type { CreatePolicyInput, UpdatePolicyInput, Policy, PolicyType } from '../types/policy.js'
import type { ContextSearchOpts, ContextSearchResponse } from '../query/context-search.js'
import type { UndeployResult } from '../types/adapter.js'
import { assemble as assembleResults } from '../query/assemble.js'
import { DEFAULT_BUCKET_ID } from '../d8um.js'
import { HttpClient } from './http-client.js'
import type { CloudConfig } from './http-client.js'

/**
 * Extended d8um instance for cloud mode.
 * Includes document CRUD methods available via the hosted API.
 */
export interface d8umCloudInstance extends d8umInstance {
  listDocuments(filter?: DocumentFilter): Promise<d8umDocument[]>
  getDocument(documentId: string): Promise<d8umDocument>
  updateDocument(documentId: string, update: Partial<d8umDocument>): Promise<d8umDocument>
  deleteDocuments(filter: DocumentFilter): Promise<number>
}

/**
 * Create a d8um instance backed by the hosted cloud service.
 * Everything runs server-side — embedding, indexing, storage, memory.
 */
export function createCloudInstance(config: CloudConfig): d8umCloudInstance {
  const client = new HttpClient(config)
  const e = encodeURIComponent

  const buckets: BucketsApi = {
    async create(input: CreateBucketInput): Promise<Bucket> {
      return client.post<Bucket>('/v1/buckets', input)
    },
    async get(bucketId: string): Promise<Bucket | undefined> {
      return client.get<Bucket>(`/v1/buckets/${e(bucketId)}`)
    },
    async list(filter?: BucketListFilter): Promise<Bucket[]> {
      const searchParams = new URLSearchParams()
      if (filter?.tenantId) searchParams.set('tenantId', filter.tenantId)
      if (filter?.groupId) searchParams.set('groupId', filter.groupId)
      if (filter?.userId) searchParams.set('userId', filter.userId)
      if (filter?.agentId) searchParams.set('agentId', filter.agentId)
      if (filter?.conversationId) searchParams.set('conversationId', filter.conversationId)
      const qs = searchParams.toString()
      return client.get<Bucket[]>(`/v1/buckets${qs ? `?${qs}` : ''}`)
    },
    async update(bucketId: string, input): Promise<Bucket> {
      return client.patch<Bucket>(`/v1/buckets/${e(bucketId)}`, input)
    },
    async delete(bucketId: string): Promise<void> {
      await client.delete(`/v1/buckets/${e(bucketId)}`)
    },
  }

  const instance: d8umCloudInstance = {
    async deploy(_config: d8umConfig): Promise<d8umCloudInstance> {
      return instance
    },

    async initialize(_config: d8umConfig): Promise<d8umCloudInstance> {
      return instance
    },

    async undeploy(): Promise<UndeployResult> {
      return { success: false, message: 'undeploy() is not available in cloud mode — infrastructure is managed server-side.' }
    },

    buckets,

    documents: {
      async get(id: string): Promise<d8umDocument | null> {
        return client.get<d8umDocument | null>(`/v1/documents/${e(id)}`)
      },
      async list(filter?: DocumentFilter): Promise<d8umDocument[]> {
        return client.post<d8umDocument[]>('/v1/documents/list', filter)
      },
      async delete(filter: DocumentFilter): Promise<number> {
        return client.delete<number>('/v1/documents', filter)
      },
    } satisfies DocumentsApi,

    policies: {
      async create(input: CreatePolicyInput): Promise<Policy> {
        return client.post<Policy>('/v1/policies', input)
      },
      async get(id: string): Promise<Policy | null> {
        return client.get<Policy | null>(`/v1/policies/${e(id)}`)
      },
      async list(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean }): Promise<Policy[]> {
        return client.post<Policy[]>('/v1/policies/list', filter)
      },
      async update(id: string, input: UpdatePolicyInput): Promise<Policy> {
        return client.patch<Policy>(`/v1/policies/${e(id)}`, input)
      },
      async delete(id: string): Promise<void> {
        await client.delete(`/v1/policies/${e(id)}`)
      },
    },

    getEmbeddingForBucket(_bucketId: string): EmbeddingProvider {
      throw new Error('getEmbeddingForBucket() is not available in cloud mode — embedding is managed server-side.')
    },

    getDistinctEmbeddings(): Map<string, EmbeddingProvider> {
      throw new Error('getDistinctEmbeddings() is not available in cloud mode — embedding is managed server-side.')
    },

    groupBucketsByModel(): Map<string, string[]> {
      throw new Error('groupBucketsByModel() is not available in cloud mode — embedding is managed server-side.')
    },

    async query(text: string, opts?: QueryOpts): Promise<QueryResponse> {
      return client.post<QueryResponse>('/v1/query', { text, ...opts })
    },

    async searchWithContext(text: string, opts?: ContextSearchOpts): Promise<ContextSearchResponse> {
      return client.post<ContextSearchResponse>('/v1/search-with-context', { text, ...opts })
    },

    async ingest(
      bucketIdOrDocs: string | undefined | RawDocument[],
      docsOrConfig?: RawDocument[] | IndexConfig,
      indexConfigOrOpts?: IndexConfig | IndexOpts,
      opts?: IndexOpts,
    ): Promise<IndexResult> {
      let resolved: string
      let docs: RawDocument[]
      if (Array.isArray(bucketIdOrDocs)) {
        resolved = DEFAULT_BUCKET_ID
        docs = bucketIdOrDocs
      } else {
        resolved = bucketIdOrDocs || DEFAULT_BUCKET_ID
        docs = docsOrConfig as RawDocument[]
      }
      return client.post<IndexResult>(`/v1/buckets/${e(resolved)}/ingest`, { docs, ...opts })
    },

    async ingestWithChunks(
      bucketIdOrDoc: string | undefined | RawDocument,
      docOrChunks?: RawDocument | Chunk[],
      chunksOrOpts?: Chunk[] | IndexOpts,
      opts?: IndexOpts,
    ): Promise<IndexResult> {
      let resolved: string
      let doc: RawDocument
      let chunks: Chunk[]
      if (typeof bucketIdOrDoc === 'string' || bucketIdOrDoc === undefined || bucketIdOrDoc === null) {
        resolved = (bucketIdOrDoc as string) || DEFAULT_BUCKET_ID
        doc = docOrChunks as RawDocument
        chunks = chunksOrOpts as Chunk[]
      } else {
        resolved = DEFAULT_BUCKET_ID
        doc = bucketIdOrDoc as RawDocument
        chunks = docOrChunks as Chunk[]
      }
      return client.post<IndexResult>(`/v1/buckets/${e(resolved)}/ingest`, { doc, chunks, ...opts })
    },

    assemble(results: d8umResult[], opts?: AssembleOpts): string {
      return assembleResults(results, opts)
    },

    async remember(content: string, identity: d8umIdentity, category?: string, opts?: {
      importance?: number
      metadata?: Record<string, unknown>
    }): Promise<unknown> {
      return client.post('/v1/memory/remember', { content, identity, category, ...opts })
    },

    async forget(id: string): Promise<void> {
      await client.post('/v1/memory/forget', { id })
    },

    async correct(correction: string, identity: d8umIdentity): Promise<{ invalidated: number; created: number; summary: string }> {
      return client.post('/v1/memory/correct', { correction, identity })
    },

    async recall(query: string, identity: d8umIdentity, opts?: { limit?: number; types?: string[] }): Promise<unknown[]> {
      return client.post<unknown[]>('/v1/memory/recall', { query, identity, ...opts })
    },

    async assembleContext(query: string, identity: d8umIdentity, opts?: {
      includeWorking?: boolean
      includeFacts?: boolean
      includeEpisodes?: boolean
      includeProcedures?: boolean
      maxMemoryTokens?: number
      format?: 'xml' | 'markdown' | 'plain'
    }): Promise<string> {
      return client.post<string>('/v1/memory/assemble-context', { query, identity, ...opts })
    },

    async healthCheck(identity: d8umIdentity): Promise<unknown> {
      return client.post('/v1/memory/health', { identity })
    },

    async addConversationTurn(
      messages: Array<{ role: string; content: string; timestamp?: Date }>,
      identity: d8umIdentity,
      conversationId?: string,
    ): Promise<unknown> {
      return client.post('/v1/memory/conversation', { messages, identity, conversationId })
    },

    async destroy(): Promise<void> {
      // No-op in cloud mode
    },

    // ── Document CRUD (cloud-only extensions) ──

    async listDocuments(filter?: DocumentFilter): Promise<d8umDocument[]> {
      return client.post<d8umDocument[]>('/v1/documents/list', filter)
    },

    async getDocument(documentId: string): Promise<d8umDocument> {
      return client.get<d8umDocument>(`/v1/documents/${e(documentId)}`)
    },

    async updateDocument(documentId: string, update: Partial<d8umDocument>): Promise<d8umDocument> {
      return client.patch<d8umDocument>(`/v1/documents/${e(documentId)}`, update)
    },

    async deleteDocuments(filter: DocumentFilter): Promise<number> {
      return client.delete<number>('/v1/documents', filter)
    },
  }

  return instance
}
