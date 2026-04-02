import type { ChunkOpts } from './connector.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { AISDKEmbeddingInput } from '../embedding/ai-sdk-adapter.js'

/**
 * A bucket is a named container for documents.
 * Buckets have no type - they are user-defined namespaces for organizing documents.
 * A bucket named "Marketing Docs" could receive documents from a URL scrape,
 * a domain crawl, file uploads, and a Slack sync - all at the same time.
 */
export interface Bucket {
  id: string
  name: string
  description?: string | undefined
  status: 'active' | 'inactive'
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  sessionId?: string | undefined
}

export interface CreateBucketInput {
  name: string
  description?: string | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  sessionId?: string | undefined
}

export type EmbeddingInput = EmbeddingProvider | AISDKEmbeddingInput

/**
 * Index configuration for chunking & embedding documents.
 * Used inside job configs for ingestion jobs.
 */
export interface IndexConfig extends ChunkOpts {
  deduplicateBy: string[] | ((doc: import('./connector.js').RawDocument) => string)
  propagateMetadata?: string[] | undefined
  /** If true, strip markdown syntax from chunk content before embedding. Original content is stored as-is. */
  stripMarkdownForEmbedding?: boolean | undefined
  /** Custom preprocessing function for embedding. Takes chunk content, returns text to embed. Overrides stripMarkdownForEmbedding. */
  preprocessForEmbedding?: ((content: string) => string) | undefined
  /** App-specific document type applied to all documents from this bucket (e.g. 'pdf', 'webpage'). */
  documentType?: string | undefined
  /** App-specific source type applied to all documents from this bucket (e.g. 'upload', 'web_scrape'). */
  sourceType?: string | undefined
  /** Access visibility for all documents from this bucket. */
  visibility?: import('./d8um-document.js').Visibility | undefined
}
