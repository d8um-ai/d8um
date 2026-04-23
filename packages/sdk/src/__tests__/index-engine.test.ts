import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IndexEngine } from '../index-engine/engine.js'
import { embeddingModelKey } from '../embedding/provider.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestDocument, createTestDocuments } from './helpers/mock-connector.js'
import { defaultChunker } from '../index-engine/chunker.js'

describe('IndexEngine', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let embedding: ReturnType<typeof createMockEmbedding>

  beforeEach(() => {
    adapter = createMockAdapter()
    embedding = createMockEmbedding()
  })

  /** Helper: chunk docs and ingest via engine.ingestBatch */
  async function ingestDocs(
    engine: IndexEngine,
    bucketId: string,
    docs: ReturnType<typeof createTestDocuments>,
    ingestOptions: ReturnType<typeof createMockBucket>['ingestOptions'],
    opts?: Parameters<IndexEngine['ingestBatch']>[2],
  ) {
    const chunkOpts = { chunkSize: ingestOptions.chunkSize ?? 100, chunkOverlap: ingestOptions.chunkOverlap ?? 20 }
    const items = await Promise.all(docs.map(async doc => ({ doc, chunks: await defaultChunker(doc, chunkOpts) })))
    return engine.ingestBatch(bucketId, items, { ...ingestOptions, ...opts })
  }

  describe('ingestBatch', () => {
    it('indexes all documents', async () => {
      const docs = createTestDocuments(3)
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, docs, ingestOptions)
      expect(result.total).toBe(3)
      expect(result.inserted).toBe(3)
      expect(result.skipped).toBe(0)
    })

    it('skips unchanged documents (idempotency)', async () => {
      const docs = createTestDocuments(2)
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, docs, ingestOptions)
      const result2 = await ingestDocs(engine, bucket.id, docs, ingestOptions)
      expect(result2.total).toBe(2)
      expect(result2.skipped).toBe(2)
      expect(result2.inserted).toBe(0)
    })

    it('re-indexes on content change', async () => {
      const docs = [createTestDocument({ id: 'doc-1', content: 'Original content' })]
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, docs, ingestOptions)

      const updatedDocs = [createTestDocument({ id: 'doc-1', content: 'Updated content' })]
      const result = await ingestDocs(engine, bucket.id, updatedDocs, ingestOptions)
      expect(result.inserted).toBe(1)
    })

    it('re-indexes on model change', async () => {
      const docs = [createTestDocument()]
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })

      const engine1 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v1' }))
      await ingestDocs(engine1, bucket.id, docs, ingestOptions)

      const engine2 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v2' }))
      const result = await ingestDocs(engine2, bucket.id, docs, ingestOptions)
      expect(result.inserted).toBe(1)
    })

    it('calls ensureModel', async () => {
      const docs = [createTestDocument()]
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, docs, ingestOptions)
      expect(adapter.calls.some(c => c.method === 'ensureModel')).toBe(true)
    })

    it('supports dryRun', async () => {
      const docs = [createTestDocument()]
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, docs, ingestOptions, { dryRun: true })
      expect(result.inserted).toBe(1)
      expect(adapter.calls.filter(c => c.method === 'upsertDocument')).toHaveLength(0)
    })

    it('strips markdown for embedding when configured', async () => {
      const doc = createTestDocument({ content: '# Heading\n\n**Bold** text' })
      const { bucket, ingestOptions } = createMockBucket({
        documents: [doc],
        stripMarkdownForEmbedding: true,
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embedBatch')
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)
      const embeddedTexts = embedSpy.mock.calls[0]![0]
      expect(embeddedTexts[0]).not.toContain('#')
      expect(embeddedTexts[0]).not.toContain('**')
    })

    it('applies custom preprocessForEmbedding', async () => {
      const doc = createTestDocument({ content: 'Hello World' })
      const { bucket, ingestOptions } = createMockBucket({
        documents: [doc],
        preprocessForEmbedding: (c) => c.toLowerCase(),
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embedBatch')
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)
      const embeddedTexts = embedSpy.mock.calls[0]![0]
      expect(embeddedTexts[0]).toBe('hello world')
    })

    it('propagates default metadata (title, url, updatedAt)', async () => {
      const doc = createTestDocument({
        title: 'My Doc',
        url: 'https://example.com',
        updatedAt: new Date('2024-06-01'),
      })
      const { bucket, ingestOptions } = createMockBucket({ documents: [doc] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.title).toBe('My Doc')
      expect(stored[0]!.metadata.url).toBe('https://example.com')
    })

    it('normalizes url=null to no URL during batch ingest', async () => {
      const doc = createTestDocument({ id: 'doc-null-url', url: null })
      const { bucket, ingestOptions } = createMockBucket({ documents: [doc] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)

      const recordCall = adapter.calls.find(c => c.method === 'upsertDocumentRecord')!
      expect(recordCall.args[0].url).toBeUndefined()
      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.url).toBeUndefined()
    })

    it('normalizes url=null to no URL during pre-chunked ingest', async () => {
      const doc = createTestDocument({ id: 'doc-null-url-prechunked', url: null })
      const { bucket } = createMockBucket({ documents: [] })
      const engine = new IndexEngine(adapter, embedding)

      const result = await engine.ingestWithChunks(
        bucket.id,
        doc,
        [{ content: 'Chunk content', chunkIndex: 0 }],
      )

      expect(result.inserted).toBe(1)
      const recordCall = adapter.calls.find(c => c.method === 'upsertDocumentRecord')!
      expect(recordCall.args[0].url).toBeUndefined()
      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.url).toBeUndefined()
    })

    it('propagates custom metadata fields', async () => {
      const doc = createTestDocument({
        metadata: { category: 'tech', priority: 'high' },
      })
      const { bucket, ingestOptions } = createMockBucket({
        documents: [doc],
        propagateMetadata: ['metadata.category', 'metadata.priority'],
      })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.category).toBe('tech')
      expect(stored[0]!.metadata.priority).toBe('high')
    })

    it('creates document records', async () => {
      const doc = createTestDocument()
      const { bucket, ingestOptions } = createMockBucket({ documents: [doc] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)

      expect(adapter.calls.some(c => c.method === 'upsertDocumentRecord')).toBe(true)
    })
  })

  describe('ingestWithChunks', () => {
    it('ingests pre-built chunks', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [
        { content: 'Chunk 0', chunkIndex: 0 },
        { content: 'Chunk 1', chunkIndex: 1 },
      ]
      const engine = new IndexEngine(adapter, embedding)
      const result = await engine.ingestWithChunks(bucket.id, doc, chunks)
      expect(result.inserted).toBe(1)
      expect(result.total).toBe(1)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored).toHaveLength(2)
    })

    it('supports dryRun', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      const result = await engine.ingestWithChunks(bucket.id, doc, chunks, { dryRun: true })
      expect(result.inserted).toBe(1)
      expect(adapter.calls.filter(c => c.method === 'upsertDocument')).toHaveLength(0)
    })

    it('sets status to failed on error', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]

      const failEmbedding = createMockEmbedding()
      failEmbedding.embedBatch = async () => { throw new Error('Embed failed') }

      const engine = new IndexEngine(adapter, failEmbedding)
      await expect(engine.ingestWithChunks(bucket.id, doc, chunks)).rejects.toThrow('Embed failed')

      const statusCalls = adapter.calls.filter(c => c.method === 'updateDocumentStatus')
      if (statusCalls.length > 0) {
        expect(statusCalls[statusCalls.length - 1]!.args[1]).toBe('failed')
      }
    })

    it('reports triple extraction exceptions as errors, not timeouts', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockRejectedValue(new Error('No output generated.')),
      } as any

      const result = await engine.ingestWithChunks(bucket.id, doc, chunks, { graphExtraction: true })

      expect(result.extraction?.failed).toBe(1)
      expect(result.extraction?.failedChunks?.[0]).toEqual(expect.objectContaining({
        reason: 'error',
        message: 'No output generated.',
      }))
    })

    it('persists passage nodes before graph extraction', async () => {
      const doc = createTestDocument({ id: 'doc-passages' })
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [
        { content: 'Alice met Bob.', chunkIndex: 0 },
        { content: 'Bob works at Acme.', chunkIndex: 1 },
      ]
      const persistPassageNodes = vi.fn().mockResolvedValue(undefined)
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { persistPassageNodes, extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, doc, chunks, { graphExtraction: true, tenantId: 'tenant-1' })

      expect(persistPassageNodes).toHaveBeenCalledTimes(1)
      expect(persistPassageNodes.mock.calls[0]![0]).toEqual([
        expect.objectContaining({
          bucketId: bucket.id,
          documentId: 'doc-passages',
          chunkIndex: 0,
          tenantId: 'tenant-1',
        }),
        expect.objectContaining({
          bucketId: bucket.id,
          documentId: 'doc-passages',
          chunkIndex: 1,
          tenantId: 'tenant-1',
        }),
      ])
      const upsertCallIndex = adapter.calls.findIndex(call => call.method === 'upsertDocument')
      expect(upsertCallIndex).toBeGreaterThanOrEqual(0)
      expect(extractFromChunk).toHaveBeenCalled()
    })

    it('passes accumulated entity context to later chunks', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [
        { content: 'Cole Conway entered the saloon.', chunkIndex: 0 },
        { content: 'Conway met Steve Sharp there.', chunkIndex: 1 },
      ]
      const extractFromChunk = vi.fn()
        .mockResolvedValueOnce({ entities: [{ name: 'Cole Conway', type: 'person' }] })
        .mockResolvedValueOnce({ entities: [{ name: 'Steve Sharp', type: 'person' }] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, doc, chunks, { graphExtraction: true })

      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(extractFromChunk.mock.calls[1]![5]).toEqual([
        { name: 'Cole Conway', type: 'person' },
      ])
    })
  })
})
