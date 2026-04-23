import type { VectorStoreAdapter, HashRecord } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import { embeddingModelKey } from '../embedding/provider.js'
import type { IngestOptions, IndexResult, ExtractionFailure } from '../types/index-types.js'
import type { RawDocument, Chunk } from '../types/connector.js'
import { generateId } from '../utils/id.js'
import { IndexError } from '../types/index-types.js'
import { sha256, resolveIdempotencyKey, buildHashStoreKey } from './hash.js'
import { stripMarkdown } from './strip-markdown.js'
import type { TripleExtractor, EntityContext } from './triple-extractor.js'
import type { typegraphEventSink } from '../types/events.js'
import type { typegraphLogger } from '../types/logger.js'

/** Race a promise against a timeout. Resolves to undefined on timeout (never rejects). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ])
}

const TRIPLE_EXTRACTION_TIMEOUT_MS = 360_000 // 6 minutes per chunk
const ENTITY_CONTEXT_LIMIT = 20

function sanitizeText(value: string): string {
  return sanitizeInvalidSurrogates(value
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ' '))
}

function sanitizeInvalidSurrogates(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += value.charAt(i) + value.charAt(i + 1)
        i++
      } else {
        out += '\uFFFD'
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      out += '\uFFFD'
    } else {
      out += value[i]
    }
  }
  return out
}

function sanitizeDocument(doc: RawDocument): RawDocument {
  return {
    ...doc,
    url: doc.url ?? undefined,
    title: sanitizeText(doc.title),
    content: sanitizeText(doc.content),
  }
}

function sanitizeChunk(chunk: Chunk): Chunk {
  return {
    ...chunk,
    content: sanitizeText(chunk.content),
  }
}

export class IndexEngine {
  tripleExtractor?: TripleExtractor
  eventSink: typegraphEventSink | undefined
  logger: typegraphLogger | undefined

  constructor(
    private adapter: VectorStoreAdapter,
    private embedding: EmbeddingProvider,
    eventSink?: typegraphEventSink,
    logger?: typegraphLogger,
  ) {
    this.eventSink = eventSink
    this.logger = logger
  }

  /**
   * Ingest a document with pre-built chunks.
   * Skips the default chunker - uses the provided chunks directly.
   */
  async ingestWithChunks(
    bucketId: string,
    doc: RawDocument,
    chunks: Chunk[],
    opts: IngestOptions = {},
  ): Promise<IndexResult> {
    const cleanDoc = sanitizeDocument(doc)
    const cleanChunks = chunks.map(sanitizeChunk)
    const { tenantId, groupId, userId, agentId, conversationId, visibility, dryRun = false } = opts
    const shouldExtract = !!this.tripleExtractor && !dryRun && !!opts.graphExtraction

    const modelId = embeddingModelKey(this.embedding)
    const startMs = Date.now()

    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const contentHash = sha256(cleanDoc.content)
    const deduplicateBy = opts.deduplicateBy ?? ['url']
    const ikey = resolveIdempotencyKey(cleanDoc, deduplicateBy)

    const documentId = cleanDoc.id ?? generateId('doc')
    if (this.adapter.upsertDocumentRecord && !dryRun) {
      await this.adapter.upsertDocumentRecord({
        id: documentId,
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        conversationId,
        title: cleanDoc.title,
        url: cleanDoc.url ?? undefined,
        contentHash,
        chunkCount: cleanChunks.length,
        status: 'processing',
        visibility,
        graphExtracted: shouldExtract,
        metadata: cleanDoc.metadata ?? {},
      })
    }

    try {
      const textsForEmbedding = cleanChunks.map(c => this.preprocessForEmbedding(c.content, opts))
      const embeddings = await this.embedding.embedBatch(textsForEmbedding)

      const propagated = this.propagateMetadata(cleanDoc, opts.propagateMetadata)

      const embeddedChunks = cleanChunks.map((chunk, i) => ({
        idempotencyKey: ikey,
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        conversationId,
        documentId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: cleanChunks.length,
        visibility,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      if (!dryRun) {
        await this.adapter.upsertDocument(modelId, embeddedChunks)
        if (shouldExtract) {
          await this.tripleExtractor?.persistPassageNodes?.(embeddedChunks.map(chunk => ({
            bucketId: chunk.bucketId,
            documentId: chunk.documentId,
            chunkIndex: chunk.chunkIndex,
            embeddingModel: chunk.embeddingModel,
            contentHash: sha256(chunk.content),
            metadata: chunk.metadata,
            visibility: chunk.visibility,
            tenantId: chunk.tenantId,
            groupId: chunk.groupId,
            userId: chunk.userId,
            agentId: chunk.agentId,
            conversationId: chunk.conversationId,
          })))
        }
      }

      let extraction: { succeeded: number; failed: number; failedChunks?: ExtractionFailure[] } | undefined
      if (shouldExtract) {
        const documentTitle = (propagated.title as string | undefined) ?? undefined
        extraction = await this.extractTriplesForChunks(
          bucketId,
          documentId,
          cleanChunks,
          propagated,
          documentTitle,
          { tenantId, groupId, userId, agentId, conversationId },
          visibility,
        )
      }

      if (!dryRun) {
        if (this.adapter.updateDocumentStatus) {
          await this.adapter.updateDocumentStatus(documentId, 'complete', cleanChunks.length)
        }

        const storeKey = buildHashStoreKey(tenantId, bucketId, ikey)
        await this.adapter.hashStore.set(storeKey, {
          idempotencyKey: ikey,
          contentHash,
          bucketId,
          tenantId,
          embeddingModel: modelId,
          indexedAt: new Date(),
          chunkCount: cleanChunks.length,
        })
      }

      return {
        bucketId,
        tenantId,
        mode: 'upsert',
        total: 1,
        skipped: 0,
        updated: 0,
        inserted: 1,
        pruned: 0,
        durationMs: Date.now() - startMs,
        extraction,
      }
    } catch (error) {
      if (this.adapter.updateDocumentStatus && !dryRun) {
        await this.adapter.updateDocumentStatus(documentId, 'failed')
      }
      throw error
    }
  }

  /**
   * Ingest a batch of documents with pre-built chunks.
   * All chunks across all documents are embedded in a single embedBatch call.
   */
  async ingestBatch(
    bucketId: string,
    items: Array<{ doc: RawDocument; chunks: Chunk[] }>,
    opts: IngestOptions = {},
  ): Promise<IndexResult> {
    const cleanItems = items.map(({ doc, chunks }) => ({
      doc: sanitizeDocument(doc),
      chunks: chunks.map(sanitizeChunk),
    }))
    const { tenantId, groupId, userId, agentId, conversationId, visibility, dryRun = false, traceId, spanId } = opts
    const shouldExtract = !!this.tripleExtractor && !dryRun && !!opts.graphExtraction
    const modelId = embeddingModelKey(this.embedding)
    const startMs = Date.now()

    this.eventSink?.emit({
      id: crypto.randomUUID(),
      eventType: 'index.start',
      identity: { tenantId, groupId, userId, agentId, conversationId },
      payload: { bucketId, documentCount: cleanItems.length },
      traceId,
      spanId,
      timestamp: new Date(),
    })

    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const deduplicateBy = opts.deduplicateBy ?? ['url']

    const result: IndexResult = {
      bucketId,
      tenantId,
      mode: 'upsert',
      total: cleanItems.length,
      skipped: 0,
      updated: 0,
      inserted: 0,
      pruned: 0,
      durationMs: 0,
    }
    // Tracks documents whose whole processItem rejected in the concurrent path
    // (upsertDocument throw, hashStore failure, etc.). Surfaced in index.complete.
    let processingFailed = 0

    // Phase 1: Prepare all docs and collect all texts for a single embedBatch call
    const prepared: Array<{
      doc: RawDocument
      chunks: Chunk[]
      ikey: string
      contentHash: string
      documentId: string
      textOffset: number
    }> = []
    const allTexts: string[] = []

    // Batch hash store lookup: check all idempotency keys in a single query
    const docMeta = cleanItems.map(({ doc }) => ({
      doc,
      contentHash: sha256(doc.content),
      ikey: resolveIdempotencyKey(doc, deduplicateBy),
      storeKey: buildHashStoreKey(tenantId, bucketId, resolveIdempotencyKey(doc, deduplicateBy)),
    }))

    let hashMap: Map<string, HashRecord> | undefined
    if (!dryRun) {
      const allStoreKeys = docMeta.map(m => m.storeKey)
      hashMap = this.adapter.hashStore.getMany
        ? await this.adapter.hashStore.getMany(allStoreKeys)
        : undefined
    }

    for (let i = 0; i < cleanItems.length; i++) {
      const { chunks } = cleanItems[i]!
      const { doc, contentHash, ikey, storeKey } = docMeta[i]!

      // Hash store dedup: skip docs whose content + model haven't changed
      if (!dryRun) {
        const stored = hashMap
          ? hashMap.get(storeKey) ?? null
          : await this.adapter.hashStore.get(storeKey)
        if (stored?.contentHash === contentHash && stored.embeddingModel === modelId) {
          const actualChunks = await this.adapter.countChunks(modelId, {
            bucketId,
            tenantId,
            idempotencyKey: ikey,
          })
          if (actualChunks === stored.chunkCount) {
            result.skipped++
            continue
          }
        }
      }

      const documentId = doc.id ?? generateId('doc')

      if (this.adapter.upsertDocumentRecord && !dryRun) {
        await this.adapter.upsertDocumentRecord({
          id: documentId,
          bucketId,
          tenantId,
          groupId,
          userId,
          agentId,
          conversationId,
          title: doc.title,
          url: doc.url ?? undefined,
          contentHash,
          chunkCount: chunks.length,
          status: 'processing',
          visibility,
          graphExtracted: shouldExtract,
          metadata: doc.metadata ?? {},
        })
      }

      const textOffset = allTexts.length
      const texts = chunks.map(c => this.preprocessForEmbedding(c.content, opts))
      allTexts.push(...texts)

      prepared.push({ doc, chunks, ikey, contentHash, documentId, textOffset })
    }

    // Phase 2: Single embedBatch call for all chunks across all documents
    const allEmbeddings = allTexts.length > 0
      ? await this.embedding.embedBatch(allTexts)
      : []

    // Phase 3: Per-document upsert + hash store (with optional concurrency for triple extraction)
    const { concurrency = 1 } = opts

    const processItem = async (item: typeof prepared[number]) => {
      const { doc, chunks, ikey, contentHash, documentId, textOffset } = item
      const embeddings = allEmbeddings.slice(textOffset, textOffset + chunks.length)
      const propagated = this.propagateMetadata(doc, opts.propagateMetadata)

      const embeddedChunks = chunks.map((chunk, i) => ({
        idempotencyKey: ikey,
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        conversationId,
        documentId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunks.length,
        visibility,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      if (!dryRun) {
        await this.adapter.upsertDocument(modelId, embeddedChunks)
        if (shouldExtract) {
          await this.tripleExtractor?.persistPassageNodes?.(embeddedChunks.map(chunk => ({
            bucketId: chunk.bucketId,
            documentId: chunk.documentId,
            chunkIndex: chunk.chunkIndex,
            embeddingModel: chunk.embeddingModel,
            contentHash: sha256(chunk.content),
            metadata: chunk.metadata,
            visibility: chunk.visibility,
            tenantId: chunk.tenantId,
            groupId: chunk.groupId,
            userId: chunk.userId,
            agentId: chunk.agentId,
            conversationId: chunk.conversationId,
          })))
        }
      }

      if (shouldExtract) {
        const documentTitle = (propagated.title as string | undefined) ?? undefined
        const extraction = await this.extractTriplesForChunks(
          bucketId,
          documentId,
          chunks,
          propagated,
          documentTitle,
          { tenantId, groupId, userId, agentId, conversationId },
          visibility,
        )

        if (!result.extraction) result.extraction = { succeeded: 0, failed: 0 }
        result.extraction.succeeded += extraction.succeeded
        result.extraction.failed += extraction.failed
        if (extraction.failedChunks && extraction.failedChunks.length > 0) {
          if (!result.extraction.failedChunks) result.extraction.failedChunks = []
          result.extraction.failedChunks.push(...extraction.failedChunks)
          if (result.extraction.failedChunks.length > 100) {
            result.extraction.failedChunks = result.extraction.failedChunks.slice(0, 100)
          }
        }
      }

      if (!dryRun) {
        if (this.adapter.updateDocumentStatus) {
          await this.adapter.updateDocumentStatus(documentId, 'complete', chunks.length)
        }

        const storeKey = buildHashStoreKey(tenantId, bucketId, ikey)
        await this.adapter.hashStore.set(storeKey, {
          idempotencyKey: ikey,
          contentHash,
          bucketId,
          tenantId,
          embeddingModel: modelId,
          indexedAt: new Date(),
          chunkCount: chunks.length,
        })
      }

      result.inserted++

      this.eventSink?.emit({
        id: crypto.randomUUID(),
        eventType: 'index.document',
        identity: { tenantId, groupId, userId, agentId, conversationId },
        targetId: documentId,
        targetType: 'document',
        payload: { bucketId, chunkCount: chunks.length, status: 'new' },
        traceId,
        spanId,
        timestamp: new Date(),
      })
    }

    if (concurrency <= 1) {
      for (const item of prepared) {
        await processItem(item)
      }
    } else {
      // Concurrent processing with semaphore.
      // processItem is wrapped to never reject — errors are swallowed to prevent
      // unhandled promise rejections from crashing the process when concurrent
      // promises continue running after one fails.
      const safeProcessItem = (item: typeof prepared[number]) =>
        processItem(item).catch((err) => {
          processingFailed++
          this.logger?.error?.('[typegraph] Document processing failed:', { documentId: item.documentId, idempotencyKey: item.ikey, error: err instanceof Error ? err.message : String(err) })
          this.eventSink?.emit({
            id: crypto.randomUUID(),
            eventType: 'index.document',
            identity: { tenantId, groupId, userId, agentId, conversationId },
            targetId: item.documentId,
            targetType: 'document',
            payload: { bucketId, status: 'failed', error: err instanceof Error ? err.message : String(err) },
            traceId,
            spanId,
            timestamp: new Date(),
          })
        })
      const active = new Set<Promise<void>>()
      for (const item of prepared) {
        const p = safeProcessItem(item).then(() => { active.delete(p) })
        active.add(p)
        if (active.size >= concurrency) {
          await Promise.race(active)
        }
      }
      await Promise.all(active)
    }

    result.durationMs = Date.now() - startMs

    this.eventSink?.emit({
      id: crypto.randomUUID(),
      eventType: 'index.complete',
      identity: { tenantId, groupId, userId, agentId, conversationId },
      payload: {
        bucketId,
        documentsProcessed: result.inserted,
        documentsSkipped: result.skipped,
        documentsFailed: processingFailed,
        ...(result.extraction ? { extraction: result.extraction } : {}),
      },
      durationMs: result.durationMs,
      traceId,
      spanId,
      timestamp: new Date(),
    })

    // Ensure index events (including this index.complete) are durably written
    // before the ingest call resolves. Short-lived workers (e.g. Inngest steps)
    // otherwise recycle before the buffered flush fires.
    if (this.eventSink?.flush) {
      try {
        await this.eventSink.flush()
      } catch (err) {
        // Flush failures are logged inside the sink; don't fail the ingest.
        console.error('[typegraph] Post-ingest event flush failed:', err instanceof Error ? err.message : err)
      }
    }

    return result
  }

  private async extractTriplesForChunks(
    bucketId: string,
    documentId: string,
    chunks: Chunk[],
    propagated: Record<string, unknown>,
    documentTitle?: string,
    identity?: {
      tenantId?: string | undefined
      groupId?: string | undefined
      userId?: string | undefined
      agentId?: string | undefined
      conversationId?: string | undefined
    },
    visibility?: IngestOptions['visibility'],
  ): Promise<{ succeeded: number; failed: number; failedChunks?: ExtractionFailure[] }> {
    let entityContext: EntityContext[] = []
    let succeeded = 0
    let failed = 0
    const failedChunks: ExtractionFailure[] = []

    for (const chunk of chunks) {
      try {
        const contextForChunk = entityContext.length > 0
          ? entityContext.map(e => ({ ...e }))
          : undefined

        const extractionResult = await withTimeout(
          this.tripleExtractor!.extractFromChunk(
            chunk.content,
            bucketId,
            chunk.chunkIndex,
            documentId,
            { ...propagated, ...chunk.metadata },
            contextForChunk,
            documentTitle,
            identity,
            visibility,
          ),
          TRIPLE_EXTRACTION_TIMEOUT_MS,
        )

        if (extractionResult === undefined) {
          failed++
          failedChunks.push({ documentId, chunkIndex: chunk.chunkIndex, reason: 'timeout' })
          this.logger?.warn?.('[typegraph] Triple extraction timed out', { documentId, chunkIndex: chunk.chunkIndex, bucketId })
          continue
        }

        succeeded++
        for (const e of extractionResult.entities) {
          if (entityContext.length >= ENTITY_CONTEXT_LIMIT) break
          if (!entityContext.some(ec => ec.name.toLowerCase() === e.name.toLowerCase())) {
            entityContext.push(e)
          }
        }
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        failedChunks.push({ documentId, chunkIndex: chunk.chunkIndex, reason: 'error', message: msg })
        this.logger?.error?.('[typegraph] Triple extraction failed', { documentId, chunkIndex: chunk.chunkIndex, bucketId, error: msg })
      }
    }

    return failedChunks.length > 0
      ? { succeeded, failed, failedChunks }
      : { succeeded, failed }
  }

  private preprocessForEmbedding(content: string, opts: IngestOptions): string {
    if (opts.preprocessForEmbedding) {
      return opts.preprocessForEmbedding(content)
    }
    if (opts.stripMarkdownForEmbedding) {
      return stripMarkdown(content)
    }
    return content
  }

  private propagateMetadata(
    doc: RawDocument,
    fields?: string[]
  ): Record<string, unknown> {
    if (!fields) {
      return {
        title: doc.title,
        url: doc.url,
        updatedAt: doc.updatedAt,
      }
    }

    const out: Record<string, unknown> = {}
    for (const field of fields) {
      if (field.startsWith('metadata.')) {
        const key = field.slice('metadata.'.length)
        out[key] = doc.metadata?.[key]
      } else {
        out[field] = (doc as unknown as Record<string, unknown>)[field]
      }
    }
    return out
  }
}
