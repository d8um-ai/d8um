/**
 * Jobs are the universal "do something" primitive in d8um.
 *
 * Each job has a type that determines what it does, a config that holds
 * type-specific parameters, and an optional schedule for recurring execution.
 *
 * Jobs are not limited to ingestion. The same system handles:
 * - Ingestion: url_scrape, domain_crawl, file_upload, slack_sync, etc.
 * - Processing: reindex, re_embed, content_cleanup
 * - Export: export_csv, webhook_notify
 * - Maintenance: source_health_check, stale_document_cleanup
 * - Memory: consolidation, decay, correction, procedural promotion
 * - Custom: user-defined jobs with arbitrary config
 *
 * Every job type defines a single run() function. The job decides what
 * it does and what it returns via JobRunResult.
 */

export type JobCategory = 'ingestion' | 'processing' | 'export' | 'maintenance' | 'memory' | 'custom'
export type JobStatus = 'idle' | 'running' | 'completed' | 'failed' | 'scheduled'

/**
 * Defines a job type in the registry. Job types are defined in code
 * (not in the database), providing type safety, validation, and UI metadata.
 */
export interface JobTypeDefinition {
  /** Unique identifier for this job type, e.g. 'url_scrape', 'slack_messages' */
  type: string
  /** Human-readable name */
  label: string
  /** What this job does */
  description: string
  category: JobCategory
  /** Must this job target a bucket? Ingestion jobs require one; others may not. */
  requiresBucket: boolean
  /** Is this job type currently implemented and available for use? */
  available: boolean
  /** Expected config shape for validation + UI generation */
  configSchema: ConfigField[]

  /**
   * The execution function. Every job has one run().
   *
   * What run() does is entirely up to the job definition:
   * - Ingestion jobs emit documents via ctx.emit() and return counts
   * - Memory jobs consolidate/decay/extract and return metrics
   * - Processing jobs transform data and return summaries
   *
   * The result shape is defined by the job via resultSchema.
   */
  run?: ((ctx: JobRunContext) => Promise<JobRunResult>) | undefined

  /** Suggested schedule - cron expression or preset ('hourly', 'daily', 'weekly') */
  schedule?: string | undefined

  /** Whether this job supports incremental fetching or always does a full sync */
  syncMode?: 'incremental' | 'full' | undefined

  /** Output entity name - maps to a model in the integration's models.ts (integration jobs only) */
  entity?: string | undefined

  /** Auth scopes required by this job (integration jobs only) */
  scopes?: string[] | undefined

  /** Describes the shape of results this job produces. Mirrors configSchema for outputs. */
  resultSchema?: ResultField[] | undefined
}

export interface ConfigField {
  /** Config JSONB key */
  key: string
  /** Human-readable label */
  label: string
  type: 'text' | 'url' | 'number' | 'boolean' | 'select'
  placeholder?: string | undefined
  required: boolean
  options?: { value: string; label: string }[] | undefined
}

/**
 * A job instance - a configured execution unit.
 */
export interface Job {
  id: string
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  sessionId?: string | undefined
  /** Nullable FK to Bucket. Ingestion jobs target a bucket; other types may not. */
  bucketId?: string | undefined
  /** References a JobTypeDefinition.type */
  type: string
  /** User-defined label, e.g. "Nightly blog crawl" */
  name: string
  description?: string | undefined
  /** Type-specific parameters */
  config: Record<string, unknown>
  /** Cron expression for recurring execution; null = manual/one-shot */
  schedule?: string | undefined
  status: JobStatus
  lastRunAt?: Date | undefined
  nextRunAt?: Date | undefined
  runCount: number
  lastError?: string | undefined
  createdAt: Date
  updatedAt: Date
}

export interface CreateJobInput {
  name: string
  type: string
  bucketId?: string | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  sessionId?: string | undefined
  config?: Record<string, unknown> | undefined
  schedule?: string | undefined
  description?: string | undefined
}

/**
 * Context passed to a job's run function.
 * For integration-backed jobs, `client` is an auth-agnostic API client
 * provided by the consuming application (e.g. Nango-backed in d8um-app).
 */
export interface JobRunContext {
  job: Job
  /** Auth-agnostic API client for integration jobs */
  client?: ApiClient | undefined
  /** For incremental jobs - when was the last successful run? */
  lastRunAt?: Date | undefined
  /** Persisted cursor/page state between runs */
  metadata?: Record<string, unknown> | undefined
  /** Persist a metadata key for the next run */
  setMetadata?: ((key: string, value: unknown) => void) | undefined
  /**
   * Emit a document during ingestion. Ingestion jobs call this
   * to produce documents. Non-ingestion jobs ignore it.
   */
  emit?: ((doc: import('./connector.js').RawDocument) => void) | undefined
}

/**
 * Result from any job's run() function.
 *
 * The shape is flexible - every job reports what's relevant to it:
 * - Ingestion jobs populate documentsCreated/Updated/Deleted
 * - Memory jobs populate metrics (e.g. { factsExtracted: 5, contradictionsResolved: 2 })
 * - Any job can include a summary and arbitrary data
 */
export interface JobRunResult {
  jobId: string
  bucketId?: string | undefined
  status: 'completed' | 'failed'
  /** Human-readable summary of what happened */
  summary?: string | undefined
  /** Document counts - primarily used by ingestion jobs */
  documentsCreated: number
  documentsUpdated: number
  documentsDeleted: number
  /** Typed metrics - used by memory, processing, or any job that wants structured output */
  metrics?: Record<string, number> | undefined
  /** Arbitrary structured data the job wants to return */
  data?: Record<string, unknown> | undefined
  durationMs: number
  error?: string | undefined
}

/**
 * Auth-agnostic API client for integration jobs.
 * The consuming application provides the implementation.
 * For example, d8um-app wraps Nango's proxy() behind this interface.
 */
export interface ApiClient {
  get<T = unknown>(endpoint: string, params?: Record<string, string>): Promise<ApiResponse<T>>
  post<T = unknown>(endpoint: string, data?: unknown): Promise<ApiResponse<T>>
  put<T = unknown>(endpoint: string, data?: unknown): Promise<ApiResponse<T>>
  patch<T = unknown>(endpoint: string, data?: unknown): Promise<ApiResponse<T>>
  delete<T = unknown>(endpoint: string): Promise<ApiResponse<T>>
}

export interface ApiResponse<T> {
  data: T
  status: number
  headers: Record<string, string>
}

export interface ResultField {
  /** Result JSONB key */
  key: string
  /** Human-readable label */
  label: string
  type: 'text' | 'number' | 'boolean' | 'json'
}

/**
 * A persisted record of a single job execution.
 * Created by the adapter when jobs.run() completes.
 */
export interface JobRun {
  id: string
  jobId: string
  bucketId?: string | undefined
  status: 'running' | 'completed' | 'failed'
  summary?: string | undefined
  documentsCreated: number
  documentsUpdated: number
  documentsDeleted: number
  metrics?: Record<string, unknown> | undefined
  error?: string | undefined
  durationMs?: number | undefined
  startedAt: Date
  completedAt?: Date | undefined
}
