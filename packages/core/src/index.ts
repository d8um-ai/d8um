// Main public API
export { typegraphInit, typegraphDeploy, resolveEmbeddingProvider, resolveLLMProvider, DEFAULT_BUCKET_ID } from './typegraph.js'
export type { typegraphConfig, typegraphInstance, BucketsApi, DocumentsApi, JobsApi, GraphApi } from './typegraph.js'
/** @deprecated Use LLMConfig instead. */
export type { LLMInput } from './typegraph.js'

// Types
export type {
  RawDocument,
  ChunkOpts,
  Chunk,
  Bucket,
  CreateBucketInput,
  BucketListFilter,
  IndexDefaults,
  IndexConfig,
  EmbeddingConfig,
  EmbeddedChunk,
  ChunkFilter,
  ScoredChunk,
  SearchOpts,
  HashRecord,
  HashStoreAdapter,
  VectorStoreAdapter,
  UndeployResult,
  ScoredChunkWithDocument,
  QuerySignals,
  typegraphResult,
  RawScores,
  NormalizedScores,
  QueryOpts,
  QueryResponse,
  IndexOpts,
  IndexProgressEvent,
  IndexResult,
  ExtractionFailure,
  typegraphDocument,
  DocumentStatus,
  Visibility,
  DocumentFilter,
  UpsertDocumentInput,
  typegraphHooks,
  LLMProvider,
  LLMGenerateOptions,
  LLMConfig,
  typegraphIdentity,
  MemoryBridge,
  KnowledgeGraphBridge,
  EntityResult,
  EntityDetail,
  EdgeResult,
  SubgraphOpts,
  SubgraphResult,
  GraphStats,
  ExtractionConfig,
  typegraphEvent,
  typegraphEventType,
  typegraphEventSink,
  TokenUsage,
  PolicyType,
  PolicyAction,
  PolicyRule,
  Policy,
  CreatePolicyInput,
  UpdatePolicyInput,
  PolicyEvalContext,
  PolicyDecision,
  PolicyViolation,
  PolicyStoreAdapter,
  MemoryRecord,
  ConversationTurnResult,
  MemoryHealthReport,
  typegraphLogger,
  PaginationOpts,
  PaginatedResult,
  Job,
  JobType,
  JobStatus,
  JobFilter,
} from './types/index.js'
/** @deprecated Use EmbeddingConfig instead. */
export type { EmbeddingInput } from './types/index.js'
export { IndexError } from './types/index.js'
export { TypegraphError, NotFoundError, NotInitializedError, ConfigError } from './types/index.js'

// Embedding
export type { EmbeddingProvider } from './embedding/index.js'
export { aiSdkEmbeddingProvider, isAISDKEmbeddingInput, embeddingModelKey, parseEmbeddingModelKey } from './embedding/index.js'
export type { AISDKEmbeddingInput } from './embedding/index.js'

// LLM
export { aiSdkLlmProvider, isAISDKLLMInput } from './llm/index.js'
export type { AISDKLLMInput } from './llm/index.js'

// Governance
export { PolicyEngine, PolicyViolationError } from './governance/index.js'

// Index engine
export { IndexEngine, defaultChunker, sha256, stripMarkdown } from './index-engine/index.js'

// Query engine (internal assemble removed from public exports — use opts.format on query())
export { mergeAndRank, minMaxNormalize, calibrateSemantic, calibrateKeyword } from './query/index.js'
export { resolveSignals, signalLabel, computeCompositeScore, classifyQuery, type QueryClassification, type QueryType } from './query/index.js'
export type { NormalizedResult } from './query/index.js'

// Utilities
export { generateId } from './utils/id.js'

// Cloud mode
export { createCloudInstance, HttpClient, TypegraphApiError } from './cloud/index.js'
export type { typegraphCloudInstance, CloudConfig } from './cloud/index.js'
