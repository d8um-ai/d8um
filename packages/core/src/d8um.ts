import type { VectorStoreAdapter, UndeployResult } from './types/adapter.js'
import type { Bucket, CreateBucketInput, BucketListFilter, EmbeddingInput, IndexConfig } from './types/bucket.js'
import type { QueryOpts, QueryResponse, d8umResult, AssembleOpts } from './types/query.js'
import type { IndexOpts, IndexResult } from './types/index-types.js'
import type { EmbeddingProvider } from './embedding/provider.js'
import type { RawDocument, Chunk } from './types/connector.js'
import type { d8umDocument, DocumentFilter } from './types/d8um-document.js'
import type { d8umHooks } from './types/hooks.js'
import type { LLMProvider } from './types/llm-provider.js'
import type { GraphBridge } from './types/graph-bridge.js'
import type { ExtractionConfig } from './types/extraction-config.js'
import type { d8umIdentity } from './types/identity.js'
import type { d8umEventSink, d8umEventType } from './types/events.js'
import type { PolicyStoreAdapter, CreatePolicyInput, UpdatePolicyInput, Policy, PolicyType, PolicyAction } from './types/policy.js'
import { PolicyEngine, PolicyViolationError } from './governance/policy-engine.js'
import type { ContextSearchOpts, ContextSearchResponse } from './query/context-search.js'
import type { AISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { aiSdkEmbeddingProvider, isAISDKEmbeddingInput } from './embedding/ai-sdk-adapter.js'
import { aiSdkLlmProvider, isAISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { IndexEngine } from './index-engine/engine.js'
import { TripleExtractor } from './index-engine/triple-extractor.js'
import { searchWithContext as searchWithContextFn } from './query/context-search.js'
import { assemble as assembleResults } from './query/assemble.js'
import { NotFoundError, NotInitializedError, ConfigError } from './types/errors.js'
import { generateId } from './utils/id.js'

// ── Default Bucket ──

export const DEFAULT_BUCKET_ID = 'bkt_default'
export const DEFAULT_BUCKET_NAME = 'Default'
export const DEFAULT_BUCKET_DESCRIPTION = 'System default bucket. All ingested documents without an explicit bucket assignment are stored here. Cannot be deleted.'

/** Union type: pass a native LLMProvider or an AI SDK model wrapped as { model }. */
export type LLMInput = LLMProvider | AISDKLLMInput

export interface d8umConfig {
  // ── Cloud mode (mutually exclusive with vectorStore/embedding) ──
  /** API key for d8um cloud. When provided, vectorStore and embedding are not required. */
  apiKey?: string | undefined
  /** Base URL for the cloud API. Defaults to 'https://api.d8um.dev'. */
  baseUrl?: string | undefined
  /** Request timeout in milliseconds for cloud mode. Default: 30000. */
  timeout?: number | undefined

  // ── Self-hosted mode ──
  vectorStore?: VectorStoreAdapter | undefined
  embedding?: EmbeddingInput | undefined
  tenantId?: string | undefined
  tokenizer?: ((text: string) => number) | undefined
  hooks?: d8umHooks | undefined
  /** Optional LLM provider for triple extraction, query classification, and memory operations. */
  llm?: LLMInput | undefined
  /** Optional graph bridge for memory operations and neural query mode. */
  graph?: GraphBridge | undefined
  /** Configure triple extraction behavior (single-pass vs two-pass, per-pass models). */
  extraction?: ExtractionConfig | undefined
  /** Optional event sink for observability. Events are emitted fire-and-forget. */
  eventSink?: d8umEventSink | undefined
  /** Optional policy store for governance. When provided, actions are checked against active policies. */
  policyStore?: PolicyStoreAdapter | undefined
}

function isEmbeddingProvider(
  value: EmbeddingInput
): value is EmbeddingProvider {
  return 'embed' in value && 'embedBatch' in value && 'dimensions' in value
}

export function resolveEmbeddingProvider(config: EmbeddingInput): EmbeddingProvider {
  if (isEmbeddingProvider(config)) return config
  if (isAISDKEmbeddingInput(config)) return aiSdkEmbeddingProvider(config)

  throw new ConfigError('Invalid embedding configuration')
}

function isLLMProvider(value: LLMInput): value is LLMProvider {
  return 'generateText' in value && 'generateJSON' in value
}

export function resolveLLMProvider(config: LLMInput): LLMProvider {
  if (isLLMProvider(config)) return config
  if (isAISDKLLMInput(config)) return aiSdkLlmProvider(config)

  throw new ConfigError('Invalid LLM configuration')
}

// ── Buckets Sub-API ──

export interface BucketsApi {
  create(input: CreateBucketInput): Promise<Bucket>
  get(bucketId: string): Promise<Bucket | undefined>
  list(filter?: BucketListFilter): Promise<Bucket[]>
  update(bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status' | 'indexDefaults'>>): Promise<Bucket>
  delete(bucketId: string): Promise<void>
}

// ── Documents Sub-API ──

export interface DocumentsApi {
  get(id: string): Promise<d8umDocument | null>
  list(filter?: DocumentFilter): Promise<d8umDocument[]>
  delete(filter: DocumentFilter): Promise<number>
}

/** The d8um instance interface — all public methods. */
export interface d8umInstance {
  /** One-off infrastructure provisioning. Creates all tables/extensions. Idempotent. */
  deploy(config: d8umConfig): Promise<this>

  /** Lightweight runtime init. Registers jobs, loads state. No DDL. */
  initialize(config: d8umConfig): Promise<this>

  /** Remove all d8um infrastructure. Refuses if any table contains data. */
  undeploy(): Promise<UndeployResult>

  buckets: BucketsApi
  documents: DocumentsApi

  getEmbeddingForBucket(bucketId: string): EmbeddingProvider
  getDistinctEmbeddings(bucketIds?: string[]): Map<string, EmbeddingProvider>
  groupBucketsByModel(bucketIds?: string[]): Map<string, string[]>

  /** Ingest documents directly into a bucket. All chunks are embedded in a single batch call. */
  ingest(bucketId: string | undefined, docs: RawDocument[], indexConfig: IndexConfig, opts?: IndexOpts): Promise<IndexResult>
  ingest(docs: RawDocument[], indexConfig: IndexConfig, opts?: IndexOpts): Promise<IndexResult>

  /** Ingest a document with pre-chunked content. */
  ingestWithChunks(bucketId: string | undefined, doc: RawDocument, chunks: Chunk[], opts?: IndexOpts): Promise<IndexResult>
  ingestWithChunks(doc: RawDocument, chunks: Chunk[], opts?: IndexOpts): Promise<IndexResult>

  /** Search across buckets. */
  query(text: string, opts?: QueryOpts): Promise<QueryResponse>
  searchWithContext(text: string, opts?: ContextSearchOpts): Promise<ContextSearchResponse>
  assemble(results: d8umResult[], opts?: AssembleOpts): string

  // ── Memory operations (require graph bridge) ──

  /** Store a memory. LLM extracts triples → entity graph + memory record. */
  remember(content: string, identity: d8umIdentity, category?: string, opts?: {
    importance?: number
    metadata?: Record<string, unknown>
  }): Promise<unknown>
  /** Invalidate a memory and its associated graph edges. */
  forget(id: string): Promise<void>
  /** Apply a natural language correction. */
  correct(correction: string, identity: d8umIdentity): Promise<{ invalidated: number; created: number; summary: string }>
  /** Search memories by semantic similarity. */
  recall(query: string, identity: d8umIdentity, opts?: { limit?: number; types?: string[] }): Promise<unknown[]>
  /** Build a formatted memory context block for LLM system prompts. */
  assembleContext(query: string, identity: d8umIdentity, opts?: {
    includeWorking?: boolean
    includeFacts?: boolean
    includeEpisodes?: boolean
    includeProcedures?: boolean
    maxMemoryTokens?: number
    format?: 'xml' | 'markdown' | 'plain'
  }): Promise<string>
  /** Check memory system health — returns stats about stored memories, entities, and edges. */
  healthCheck(identity: d8umIdentity): Promise<unknown>
  /** Ingest a conversation turn with extraction. */
  addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: d8umIdentity,
    conversationId?: string,
  ): Promise<unknown>

  // ── Policy operations (require policyStore) ──

  policies: {
    create(input: CreatePolicyInput): Promise<Policy>
    get(id: string): Promise<Policy | null>
    list(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean }): Promise<Policy[]>
    update(id: string, input: UpdatePolicyInput): Promise<Policy>
    delete(id: string): Promise<void>
  }

  destroy(): Promise<void>
}

class d8umImpl implements d8umInstance {
  private _buckets = new Map<string, Bucket>()
  private bucketEmbeddings = new Map<string, EmbeddingProvider>()
  private adapter!: VectorStoreAdapter
  private defaultEmbedding!: EmbeddingProvider
  private config!: d8umConfig
  private configured = false
  private initialized = false
  private policyEngine?: PolicyEngine

  private emitEvent(eventType: d8umEventType, targetId?: string, payload: Record<string, unknown> = {}): void {
    if (!this.config?.eventSink) return
    this.config.eventSink.emit({
      id: crypto.randomUUID(),
      eventType,
      identity: { tenantId: this.config.tenantId },
      targetId,
      payload,
      timestamp: new Date(),
    })
  }

  // ── Buckets ──

  buckets: BucketsApi = {
    create: async (input: CreateBucketInput): Promise<Bucket> => {
      this.assertConfigured()
      const bucket: Bucket = {
        id: generateId('bkt'),
        name: input.name,
        description: input.description,
        status: 'active',
        indexDefaults: input.indexDefaults,
        tenantId: input.tenantId ?? this.config.tenantId,
      }
      if (this.adapter.upsertBucket) {
        const persisted = await this.adapter.upsertBucket(bucket)
        this._buckets.set(persisted.id, persisted)
        this.bucketEmbeddings.set(persisted.id, this.defaultEmbedding)
        this.emitEvent('bucket.create', persisted.id, { name: persisted.name })
        return persisted
      }
      this._buckets.set(bucket.id, bucket)
      this.bucketEmbeddings.set(bucket.id, this.defaultEmbedding)
      this.emitEvent('bucket.create', bucket.id, { name: bucket.name })
      return bucket
    },

    get: async (bucketId: string): Promise<Bucket | undefined> => {
      if (this.adapter.getBucket) {
        const bucket = await this.adapter.getBucket(bucketId)
        if (bucket) {
          // Hydrate in-memory maps so getEmbeddingForBucket() works
          this._buckets.set(bucket.id, bucket)
          if (!this.bucketEmbeddings.has(bucket.id)) {
            this.bucketEmbeddings.set(bucket.id, this.defaultEmbedding)
          }
        }
        return bucket ?? undefined
      }
      return this._buckets.get(bucketId)
    },

    list: async (filter?: BucketListFilter): Promise<Bucket[]> => {
      if (this.adapter.listBuckets) {
        const buckets = await this.adapter.listBuckets(filter)
        for (const b of buckets) {
          this._buckets.set(b.id, b)
          if (!this.bucketEmbeddings.has(b.id)) {
            this.bucketEmbeddings.set(b.id, this.defaultEmbedding)
          }
        }
        return buckets
      }
      let all = [...this._buckets.values()]
      if (filter) {
        if (filter.tenantId) all = all.filter(s => s.tenantId === filter.tenantId)
        if (filter.groupId) all = all.filter(s => s.groupId === filter.groupId)
        if (filter.userId) all = all.filter(s => s.userId === filter.userId)
        if (filter.agentId) all = all.filter(s => s.agentId === filter.agentId)
        if (filter.conversationId) all = all.filter(s => s.conversationId === filter.conversationId)
      }
      return all
    },

    update: async (bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status' | 'indexDefaults'>>): Promise<Bucket> => {
      const bucket = await this.buckets.get(bucketId)
      if (!bucket) throw new NotFoundError('Bucket', bucketId)
      if (input.name !== undefined) bucket.name = input.name
      if (input.description !== undefined) bucket.description = input.description
      if (input.status !== undefined) bucket.status = input.status
      if (input.indexDefaults !== undefined) bucket.indexDefaults = input.indexDefaults
      let result: Bucket
      if (this.adapter.upsertBucket) {
        result = await this.adapter.upsertBucket(bucket)
      } else {
        this._buckets.set(bucket.id, bucket)
        result = bucket
      }
      this.emitEvent('bucket.update', result.id, { name: result.name })
      return result
    },

    delete: async (bucketId: string): Promise<void> => {
      if (bucketId === DEFAULT_BUCKET_ID) {
        throw new Error('Cannot delete the default bucket.')
      }
      await this.enforcePolicy('bucket.delete', { tenantId: this.config.tenantId }, bucketId)
      if (this.adapter.deleteBucket) {
        await this.adapter.deleteBucket(bucketId)
      } else {
        this._buckets.delete(bucketId)
      }
      this.bucketEmbeddings.delete(bucketId)
      this.emitEvent('bucket.delete', bucketId)
    },
  }

  // ── Documents ──

  documents: DocumentsApi = {
    get: async (id: string): Promise<d8umDocument | null> => {
      this.assertConfigured()
      if (!this.adapter.getDocument) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      return this.adapter.getDocument(id)
    },

    list: async (filter?: DocumentFilter): Promise<d8umDocument[]> => {
      this.assertConfigured()
      if (!this.adapter.listDocuments) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      return this.adapter.listDocuments(filter ?? {})
    },

    delete: async (filter: DocumentFilter): Promise<number> => {
      this.assertConfigured()
      if (!this.adapter.deleteDocuments) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      await this.enforcePolicy('document.delete', { tenantId: filter.tenantId ?? this.config.tenantId })
      const count = await this.adapter.deleteDocuments(filter)
      if (count > 0) {
        this.emitEvent('document.delete', undefined, { count, filter })
      }
      return count
    },
  }

  // ── Core Methods ──

  private applyConfig(config: d8umConfig): void {
    this.config = config
    this.adapter = config.vectorStore!
    this.defaultEmbedding = resolveEmbeddingProvider(config.embedding!)
  }

  async deploy(config: d8umConfig): Promise<this> {
    this.applyConfig(config)
    await this.adapter.deploy()
    // Deploy memory/graph tables when graph bridge is configured
    if (config.graph?.deploy) {
      await config.graph.deploy()
    }
    // Initialize policy engine when policyStore is configured
    if (config.policyStore) {
      this.policyEngine = new PolicyEngine(config.policyStore, config.eventSink)
    }
    this.configured = true

    // Create the default protected bucket (idempotent via upsert)
    if (this.adapter.upsertBucket) {
      const defaultBucket: Bucket = {
        id: DEFAULT_BUCKET_ID,
        name: DEFAULT_BUCKET_NAME,
        description: DEFAULT_BUCKET_DESCRIPTION,
        status: 'active',
        tenantId: config.tenantId,
      }
      const persisted = await this.adapter.upsertBucket(defaultBucket)
      this._buckets.set(persisted.id, persisted)
      this.bucketEmbeddings.set(persisted.id, this.defaultEmbedding)
    } else {
      // In-memory only: register default bucket
      const defaultBucket: Bucket = {
        id: DEFAULT_BUCKET_ID,
        name: DEFAULT_BUCKET_NAME,
        description: DEFAULT_BUCKET_DESCRIPTION,
        status: 'active',
        tenantId: config.tenantId,
      }
      this._buckets.set(defaultBucket.id, defaultBucket)
      this.bucketEmbeddings.set(defaultBucket.id, this.defaultEmbedding)
    }

    return this
  }

  async initialize(config: d8umConfig): Promise<this> {
    this.applyConfig(config)

    // Lightweight connect — load model registrations, no DDL
    await this.adapter.connect()

    // Ensure default embedding model table exists even in query-only mode
    // (ensureModel is normally called during ingest, but query-only skips ingest)
    if (this.adapter.ensureModel) {
      await this.adapter.ensureModel(this.defaultEmbedding.model, this.defaultEmbedding.dimensions)
    }

    // Hydrate in-memory state from persistent storage (for adapters that support it)
    if (this.adapter.listBuckets) {
      const allBuckets = await this.adapter.listBuckets()
      for (const s of allBuckets) {
        this._buckets.set(s.id, s)
        this.bucketEmbeddings.set(s.id, this.defaultEmbedding)
      }
    }
    // Initialize policy engine when policyStore is configured
    if (config.policyStore) {
      this.policyEngine = new PolicyEngine(config.policyStore, config.eventSink)
    }
    this.configured = true
    this.initialized = true
    return this
  }

  async undeploy(): Promise<UndeployResult> {
    this.assertConfigured()
    if (!this.adapter.undeploy) {
      return { success: false, message: 'Adapter does not support undeploy().' }
    }
    const result = await this.adapter.undeploy()
    if (result.success) {
      this._buckets.clear()
      this.bucketEmbeddings.clear()
      this.configured = false
      this.initialized = false
    }
    return result
  }

  getEmbeddingForBucket(bucketId: string): EmbeddingProvider {
    const embedding = this.bucketEmbeddings.get(bucketId)
    if (!embedding) throw new NotFoundError('Bucket', bucketId)
    return embedding
  }

  /**
   * Resolves the embedding for a bucket, falling back to a DB lookup if the
   * in-memory cache is stale. Callers in async contexts should prefer this
   * over the synchronous getEmbeddingForBucket().
   */
  private async resolveEmbeddingForBucket(bucketId: string): Promise<EmbeddingProvider> {
    const cached = this.bucketEmbeddings.get(bucketId)
    if (cached) return cached
    // Cache miss — try loading from DB before giving up
    const bucket = await this.buckets.get(bucketId)
    if (!bucket) throw new NotFoundError('Bucket', bucketId)
    // buckets.get() hydrates the maps, so this should now succeed
    return this.bucketEmbeddings.get(bucketId) ?? this.defaultEmbedding
  }

  /** Merge bucket-level index defaults into per-call IndexConfig. Per-call values win. */
  private mergeIndexConfig(config: IndexConfig, bucket: Bucket): IndexConfig {
    const defaults = bucket.indexDefaults
    if (!defaults) return config
    return {
      ...config,
      deduplicateBy: config.deduplicateBy ?? defaults.deduplicateBy,
      visibility: config.visibility ?? defaults.visibility,
      stripMarkdownForEmbedding: config.stripMarkdownForEmbedding ?? defaults.stripMarkdownForEmbedding,
      propagateMetadata: config.propagateMetadata ?? defaults.propagateMetadata,
    }
  }

  getDistinctEmbeddings(bucketIds?: string[]): Map<string, EmbeddingProvider> {
    const map = new Map<string, EmbeddingProvider>()
    const ids = bucketIds ?? [...this._buckets.keys()]
    for (const id of ids) {
      const emb = this.bucketEmbeddings.get(id)
      if (emb) map.set(emb.model, emb)
    }
    return map
  }

  groupBucketsByModel(bucketIds?: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    const ids = bucketIds ?? [...this._buckets.keys()]
    for (const id of ids) {
      const emb = this.bucketEmbeddings.get(id)
      if (!emb) continue
      const group = groups.get(emb.model) ?? []
      group.push(id)
      groups.set(emb.model, group)
    }
    return groups
  }

  async ingest(
    bucketIdOrDocs: string | undefined | RawDocument[],
    docsOrConfig: RawDocument[] | IndexConfig,
    indexConfigOrOpts?: IndexConfig | IndexOpts,
    opts?: IndexOpts
  ): Promise<IndexResult> {
    // Support both: ingest(bucketId, docs, config, opts?) and ingest(docs, config, opts?)
    let bucketId: string | undefined
    let docs: RawDocument[]
    let indexConfig: IndexConfig
    let resolvedOpts: IndexOpts | undefined

    if (Array.isArray(bucketIdOrDocs)) {
      // ingest(docs, config, opts?)
      bucketId = undefined
      docs = bucketIdOrDocs
      indexConfig = docsOrConfig as IndexConfig
      resolvedOpts = indexConfigOrOpts as IndexOpts | undefined
    } else {
      // ingest(bucketId, docs, config, opts?)
      bucketId = bucketIdOrDocs
      docs = docsOrConfig as RawDocument[]
      indexConfig = indexConfigOrOpts as IndexConfig
      resolvedOpts = opts
    }

    await this.ensureInitialized()
    const resolvedBucketId = bucketId || DEFAULT_BUCKET_ID
    await this.enforcePolicy('index', { tenantId: this.config.tenantId }, resolvedBucketId)
    const bucket = await this.buckets.get(resolvedBucketId)
    if (!bucket) throw new NotFoundError('Bucket', resolvedBucketId)
    // Merge bucket-level index defaults with per-call config (per-call wins)
    const merged = this.mergeIndexConfig(indexConfig, bucket)
    const { defaultChunker: chunker } = await import('./index-engine/chunker.js')
    const items = docs.map(doc => ({ doc, chunks: chunker(doc, merged) }))
    const embedding = await this.resolveEmbeddingForBucket(resolvedBucketId)
    const engine = this.createIndexEngine(embedding)
    await this.config.hooks?.onIndexStart?.(resolvedBucketId, resolvedOpts ?? {})
    const result = await engine.ingestBatch(resolvedBucketId, items, resolvedOpts, merged)
    await this.config.hooks?.onIndexComplete?.(resolvedBucketId, result)
    return result
  }

  async ingestWithChunks(
    bucketIdOrDoc: string | undefined | RawDocument,
    docOrChunks: RawDocument | Chunk[],
    chunksOrOpts?: Chunk[] | IndexOpts,
    opts?: IndexOpts
  ): Promise<IndexResult> {
    // Support both: ingestWithChunks(bucketId, doc, chunks, opts?) and ingestWithChunks(doc, chunks, opts?)
    let bucketId: string | undefined
    let doc: RawDocument
    let chunks: Chunk[]
    let resolvedOpts: IndexOpts | undefined

    if (typeof bucketIdOrDoc === 'string' || bucketIdOrDoc === undefined || bucketIdOrDoc === null) {
      // ingestWithChunks(bucketId, doc, chunks, opts?)
      bucketId = bucketIdOrDoc as string | undefined
      doc = docOrChunks as RawDocument
      chunks = chunksOrOpts as Chunk[]
      resolvedOpts = opts
    } else {
      // ingestWithChunks(doc, chunks, opts?)
      bucketId = undefined
      doc = bucketIdOrDoc as RawDocument
      chunks = docOrChunks as Chunk[]
      resolvedOpts = chunksOrOpts as IndexOpts | undefined
    }

    await this.ensureInitialized()
    const resolvedBucketId = bucketId || DEFAULT_BUCKET_ID
    await this.enforcePolicy('index', { tenantId: this.config.tenantId }, resolvedBucketId)
    const bucket = await this.buckets.get(resolvedBucketId)
    if (!bucket) throw new NotFoundError('Bucket', resolvedBucketId)
    const embedding = await this.resolveEmbeddingForBucket(resolvedBucketId)
    const engine = this.createIndexEngine(embedding)

    await this.config.hooks?.onIndexStart?.(resolvedBucketId, resolvedOpts ?? {})
    const result = await engine.ingestWithChunks(resolvedBucketId, doc, chunks, resolvedOpts)
    await this.config.hooks?.onIndexComplete?.(resolvedBucketId, result)
    return result
  }

  async query(text: string, opts?: QueryOpts): Promise<QueryResponse> {
    await this.ensureInitialized()
    await this.enforcePolicy('query', { tenantId: opts?.tenantId ?? this.config.tenantId })
    const { QueryPlanner } = await import('./query/planner.js')
    const planner = new QueryPlanner(
      this.adapter,
      [...this._buckets.keys()],
      this.bucketEmbeddings,
      this.config.graph,
      this.config.eventSink,
    )
    const response = await planner.execute(text, {
      ...opts,
      tenantId: opts?.tenantId ?? this.config.tenantId,
    })
    await this.config.hooks?.onQueryResults?.(text, response.results)
    return response
  }

  async searchWithContext(text: string, opts: ContextSearchOpts = {}): Promise<ContextSearchResponse> {
    await this.ensureInitialized()
    const response = await searchWithContextFn(
      this.adapter,
      [...this._buckets.keys()],
      this.bucketEmbeddings,
      text,
      { ...opts, tenantId: opts.tenantId ?? this.config.tenantId }
    )
    await this.config.hooks?.onQueryResults?.(text, response.rawResults)
    return response
  }

  assemble(results: d8umResult[], opts?: AssembleOpts): string {
    return assembleResults(results, opts)
  }

  // ── Memory operations ──

  private requireGraph(): GraphBridge {
    if (!this.config.graph) {
      throw new ConfigError('Graph not configured. Pass a graph bridge to d8umConfig to enable memory operations.')
    }
    return this.config.graph
  }

  async remember(content: string, identity: d8umIdentity, category?: string, opts?: {
    importance?: number
    metadata?: Record<string, unknown>
  }): Promise<unknown> {
    await this.enforcePolicy('memory.write', identity)
    return this.requireGraph().remember(content, identity, category, opts)
  }

  async forget(id: string): Promise<void> {
    await this.enforcePolicy('memory.delete', { tenantId: this.config.tenantId }, id)
    return this.requireGraph().forget(id)
  }

  async correct(correction: string, identity: d8umIdentity): Promise<{ invalidated: number; created: number; summary: string }> {
    return this.requireGraph().correct(correction, identity)
  }

  async recall(query: string, identity: d8umIdentity, opts?: { limit?: number; types?: string[] }): Promise<unknown[]> {
    await this.enforcePolicy('memory.read', identity)
    return this.requireGraph().recall(query, identity, opts)
  }

  async assembleContext(query: string, identity: d8umIdentity, opts?: {
    includeWorking?: boolean
    includeFacts?: boolean
    includeEpisodes?: boolean
    includeProcedures?: boolean
    maxMemoryTokens?: number
    format?: 'xml' | 'markdown' | 'plain'
  }): Promise<string> {
    const graph = this.requireGraph()
    if (!graph.assembleContext) throw new Error('assembleContext not supported by this graph bridge')
    return graph.assembleContext(query, identity, opts)
  }

  async healthCheck(identity: d8umIdentity): Promise<unknown> {
    const graph = this.requireGraph()
    if (!graph.healthCheck) throw new Error('healthCheck not supported by this graph bridge')
    return graph.healthCheck(identity)
  }

  async addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: d8umIdentity,
    conversationId?: string,
  ): Promise<unknown> {
    return this.requireGraph().addConversationTurn(messages, identity, conversationId)
  }

  // ── Policy operations ──

  private requirePolicyStore(): PolicyStoreAdapter {
    if (!this.config.policyStore) {
      throw new ConfigError('Policy store not configured. Pass a policyStore to d8umConfig to enable policy operations.')
    }
    return this.config.policyStore
  }

  policies = {
    create: async (input: CreatePolicyInput): Promise<Policy> => {
      const store = this.requirePolicyStore()
      const policy = await store.createPolicy(input)
      this.emitEvent('policy.create', policy.id, { name: policy.name, policyType: policy.policyType })
      return policy
    },

    get: async (id: string): Promise<Policy | null> => {
      const store = this.requirePolicyStore()
      return store.getPolicy(id)
    },

    list: async (filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean }): Promise<Policy[]> => {
      const store = this.requirePolicyStore()
      return store.listPolicies(filter)
    },

    update: async (id: string, input: UpdatePolicyInput): Promise<Policy> => {
      const store = this.requirePolicyStore()
      const policy = await store.updatePolicy(id, input)
      this.emitEvent('policy.update', policy.id, { name: policy.name })
      return policy
    },

    delete: async (id: string): Promise<void> => {
      const store = this.requirePolicyStore()
      await store.deletePolicy(id)
      this.emitEvent('policy.delete', id)
    },
  }

  async destroy(): Promise<void> {
    await this.adapter?.destroy?.()
  }

  private createIndexEngine(embedding: EmbeddingProvider): IndexEngine {
    const engine = new IndexEngine(this.adapter, embedding, this.config.eventSink)
    if (this.config.llm && this.config.graph) {
      const mainLlm = resolveLLMProvider(this.config.llm)
      const ext = this.config.extraction
      engine.tripleExtractor = new TripleExtractor({
        llm: ext?.entityLlm ?? mainLlm,
        relationshipLlm: ext?.relationshipLlm,
        graph: this.config.graph,
        twoPass: ext?.twoPass ?? false,
      })
    }
    return engine
  }

  private async enforcePolicy(action: PolicyAction, identity?: d8umIdentity, targetId?: string): Promise<void> {
    if (!this.policyEngine) return
    await this.policyEngine.enforce({
      action,
      identity: identity ?? { tenantId: this.config.tenantId },
      targetId,
    })
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new NotInitializedError()
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.configured || !this.initialized) {
      throw new NotInitializedError()
    }
  }
}

/**
 * Create a d8um instance.
 *
 * - **Cloud mode**: pass `{ apiKey }` — everything runs server-side.
 * - **Self-hosted mode**: pass `{ vectorStore, embedding }` — deploys infrastructure then initializes.
 */
export async function d8umCreate(config: d8umConfig): Promise<d8umInstance> {
  if (config.apiKey) {
    const { createCloudInstance } = await import('./cloud/cloud-instance.js')
    return createCloudInstance({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      tenantId: config.tenantId,
      timeout: config.timeout,
    })
  }

  if (!config.vectorStore || !config.embedding) {
    throw new ConfigError('d8umCreate requires either apiKey (cloud mode) or vectorStore + embedding (self-hosted mode).')
  }

  const instance = new d8umImpl()
  await instance.deploy(config)
  return instance.initialize(config)
}

/** Deploy infrastructure only. Returns an instance that is NOT initialized for runtime use. */
export async function d8umDeploy(config: d8umConfig): Promise<d8umInstance> {
  return new d8umImpl().deploy(config)
}

/** Global singleton d8um instance. Call await d8um.deploy() then d8um.initialize() before use. */
export const d8um: d8umInstance = new d8umImpl()
