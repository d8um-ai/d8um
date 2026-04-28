import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueryPlanner } from '../query/planner.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestDocuments } from './helpers/mock-connector.js'
import { IndexEngine } from '../index-engine/engine.js'
import { defaultChunker } from '../index-engine/chunker.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { KnowledgeGraphBridge } from '../types/graph-bridge.js'
import type { typegraphEvent, typegraphEventSink } from '../types/events.js'

describe('QueryPlanner', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let embedding: ReturnType<typeof createMockEmbedding>
  let bucketIds: string[]
  let bucketEmbeddings: Map<string, EmbeddingProvider>

  beforeEach(async () => {
    adapter = createMockAdapter()
    embedding = createMockEmbedding()
    bucketIds = []
    bucketEmbeddings = new Map()

    const docs = createTestDocuments(3)
    const { bucket, ingestOptions, chunkOpts } = createMockBucket({ id: 'src-1', documents: docs })
    bucketIds.push(bucket.id)
    bucketEmbeddings.set(bucket.id, embedding)

    await adapter.deploy()
    await adapter.connect()
    const engine = new IndexEngine(adapter, embedding)
    const items = await Promise.all(docs.map(async doc => ({ doc, chunks: await defaultChunker(doc, chunkOpts) })))
    await engine.ingestBatch(bucket.id, items, ingestOptions)
  })

  it('returns results for indexed sources', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Document 1')
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.results.chunks[0]!.content).toBeDefined()
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
    expect(response.results.memories).toEqual([])
  })

  it('respects count', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test query', { count: 1 })
    expect(response.results.chunks).toHaveLength(1)
  })

  it('runs true keyword-only indexed search when semantic is explicitly disabled', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    adapter.calls.length = 0

    const response = await planner.execute('Document 1', {
      signals: { semantic: false, keyword: true },
      count: 2,
    })

    const hybridCall = adapter.calls.find(call => call.method === 'hybridSearch')
    expect(hybridCall).toBeDefined()
    expect((hybridCall!.args[3] as { signals?: unknown }).signals).toEqual({ semantic: false, keyword: true })
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.results.chunks[0]!.sources).toContain('keyword')
    expect(response.results.chunks[0]!.sources).not.toContain('semantic')
    expect(response.results.chunks[0]!.scores.normalized.semantic).toBeUndefined()
    expect(response.results.chunks[0]!.scores.normalized.keyword).toBeGreaterThan(0)
  })

  it('filters to requested sources', async () => {
    const docs2 = createTestDocuments(2, 'Other')
    const { bucket: bucket2, ingestOptions: ingestOptions2, chunkOpts: chunkOpts2 } = createMockBucket({ id: 'src-2', documents: docs2 })
    bucketIds.push(bucket2.id)
    bucketEmbeddings.set(bucket2.id, embedding)
    const engine = new IndexEngine(adapter, embedding)
    const items = await Promise.all(docs2.map(async doc => ({ doc, chunks: await defaultChunker(doc, chunkOpts2) })))
    await engine.ingestBatch(bucket2.id, items, ingestOptions2)

    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test', { buckets: ['src-1'] })
    for (const r of response.results.chunks) {
      expect(r.document.bucketId).toBe('src-1')
    }
  })

  it('records per-source timings', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test')
    expect(response.buckets['src-1']).toBeDefined()
    expect(response.buckets['src-1']!.durationMs).toBeGreaterThanOrEqual(0)
    expect(response.buckets['src-1']!.status).toBe('ok')
  })

  it('returns empty results when no sources', async () => {
    const planner = new QueryPlanner(adapter, [], new Map(), new Map())
    const response = await planner.execute('test')
    expect(response.results.chunks).toHaveLength(0)
    expect(response.results.facts).toHaveLength(0)
    expect(response.results.entities).toHaveLength(0)
    expect(response.results.memories).toHaveLength(0)
  })

  it('passes tenantId through', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test', { tenantId: 'tenant-1' })
    expect(response.query.tenantId).toBe('tenant-1')
  })

  it('emits query.execute with structured snake_case result counters', async () => {
    const events: typegraphEvent[] = []
    const eventSink: typegraphEventSink = {
      emit: (event) => {
        events.push(event)
      },
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, eventSink)

    const response = await planner.execute('Document 1', { count: 2 })
    const queryEvents = events.filter(event => event.eventType === 'query.execute')

    expect(queryEvents).toHaveLength(1)
    expect(queryEvents[0]!.payload).toMatchObject({
      query: 'Document 1',
      requested_count: 2,
      result_count: response.results.chunks.length + response.results.memories.length,
      chunk_count: response.results.chunks.length,
      fact_count: 0,
      entity_count: 0,
      memory_count: 0,
      bucket_count: bucketIds.length,
    })
    expect(queryEvents[0]!.payload).not.toHaveProperty('resultCount')
    expect(queryEvents[0]!.payload).not.toHaveProperty('bucketCount')
  })

  it('maps results to structured query response shape', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Document 1')
    expect(response.results).toHaveProperty('chunks')
    expect(response.results).toHaveProperty('facts')
    expect(response.results).toHaveProperty('entities')
    expect(response.results).toHaveProperty('memories')
    const result = response.results.chunks[0]!
    expect(result).toHaveProperty('content')
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('scores')
    expect(result).toHaveProperty('document')
    expect(result).toHaveProperty('chunk')
    expect(result).toHaveProperty('metadata')
    expect(result).not.toHaveProperty('facts')
    expect(result).not.toHaveProperty('entities')
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
    expect(result.document).toHaveProperty('id')
    expect(result.document).toHaveProperty('bucketId')
    expect(result.chunk).toHaveProperty('index')
    expect(result.chunk).toHaveProperty('total')
  })

  it('uses "semantic" source label for indexed results', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Document 1')
    const result = response.results.chunks[0]!
    expect(result.sources).toContain('semantic')
  })

  it('autoWeights adjusts scoring without enabling graph search', async () => {
    const knowledgeGraph: KnowledgeGraphBridge = {
      searchGraphPassages: vi.fn().mockResolvedValue({
        results: [],
        facts: [],
        entities: [],
        trace: {},
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('how does Tennyson relate to Maud?', {
      autoWeights: true,
      count: 1,
    })

    expect(knowledgeGraph.searchGraphPassages).not.toHaveBeenCalled()
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
  })

  it('returns nonzero graph scores for graph-only passage graph results', async () => {
    const firstChunk = [...adapter._chunks.values()][0]![0]!
    const knowledgeGraph: KnowledgeGraphBridge = {
      searchGraphPassages: vi.fn().mockResolvedValue({
        results: [{
          passageId: 'passage-test',
          content: firstChunk.content,
          bucketId: firstChunk.bucketId,
          documentId: firstChunk.documentId,
          chunkIndex: firstChunk.chunkIndex,
          totalChunks: firstChunk.totalChunks,
          score: 0.25,
          metadata: {},
        }],
        facts: [{
          id: 'fact-1',
          edgeId: 'edge-1',
          sourceEntityId: 'ent-1',
          sourceEntityName: 'Tennyson',
          targetEntityId: 'ent-2',
          targetEntityName: 'Maud',
          relation: 'WROTE',
          factText: 'Tennyson wrote Maud',
          weight: 1,
          evidenceCount: 1,
        }],
        entities: [{
          id: 'ent-1',
          name: 'Tennyson',
          entityType: 'person',
          aliases: [],
          edgeCount: 1,
        }],
        trace: {
          entitySeedCount: 1,
          factSeedCount: 1,
          passageSeedCount: 1,
          graphNodeCount: 3,
          graphEdgeCount: 2,
          pprNonzeroCount: 3,
          candidatesBeforeMerge: 1,
          candidatesAfterMerge: 1,
          topGraphScores: [0.25],
          selectedFactIds: ['fact-1'],
          selectedEntityIds: ['ent-1'],
          selectedPassageIds: ['passage-test'],
        },
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('Document 1', {
      signals: { semantic: false, keyword: false, graph: true },
      count: 1,
    })

    expect(response.results.chunks).toHaveLength(1)
    expect(response.results.chunks[0]!.sources).toContain('graph')
    expect(response.results.chunks[0]!.scores.raw.ppr).toBe(0.25)
    expect(response.results.chunks[0]!.scores.normalized.graph).toBeCloseTo(Math.sqrt(Math.sqrt(0.25)))
    expect(response.results.facts).toEqual([expect.objectContaining({ id: 'fact-1', factText: 'Tennyson wrote Maud' })])
    expect(response.results.entities).toEqual([expect.objectContaining({ id: 'ent-1', name: 'Tennyson' })])
    expect(knowledgeGraph.searchGraphPassages).toHaveBeenCalledWith(
      'Document 1',
      expect.anything(),
      expect.objectContaining({
        factFilter: true,
        factCandidateLimit: 80,
        factFilterInputLimit: 12,
        factSeedLimit: 4,
        passageSeedLimit: 80,
        maxExpansionEdgesPerEntity: 25,
        factChainLimit: 2,
        maxPprIterations: 40,
        minPprScore: 1e-8,
      })
    )
  })

  it('merges graph scores into indexed results by chunk identity', async () => {
    const firstChunk = [...adapter._chunks.values()][0]![0]!
    const knowledgeGraph: KnowledgeGraphBridge = {
      searchGraphPassages: vi.fn().mockResolvedValue({
        results: [{
          passageId: 'passage-test',
          content: `${firstChunk.content} with graph-only formatting`,
          bucketId: firstChunk.bucketId,
          documentId: firstChunk.documentId,
          chunkIndex: firstChunk.chunkIndex,
          totalChunks: firstChunk.totalChunks,
          score: 0.36,
          metadata: {},
        }],
        facts: [{
          id: 'fact-1',
          edgeId: 'edge-1',
          sourceEntityId: 'ent-1',
          sourceEntityName: 'Tennyson',
          targetEntityId: 'ent-2',
          targetEntityName: 'Maud',
          relation: 'WROTE',
          factText: 'Tennyson wrote Maud',
          weight: 1,
          evidenceCount: 1,
        }],
        entities: [{
          id: 'ent-1',
          name: 'Tennyson',
          entityType: 'person',
          aliases: [],
          edgeCount: 1,
        }],
        trace: {
          entitySeedCount: 1,
          factSeedCount: 1,
          passageSeedCount: 1,
          graphNodeCount: 3,
          graphEdgeCount: 2,
          pprNonzeroCount: 3,
          candidatesBeforeMerge: 1,
          candidatesAfterMerge: 1,
          topGraphScores: [0.36],
          selectedFactIds: ['fact-1'],
          selectedEntityIds: ['ent-1'],
          selectedPassageIds: ['passage-test'],
        },
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('Document 1', {
      signals: { semantic: true, keyword: false, graph: true },
      count: 10,
    })

    const merged = response.results.chunks.find(result =>
      result.document.id === firstChunk.documentId && result.chunk.index === firstChunk.chunkIndex
    )
    expect(merged).toBeDefined()
    expect(merged!.sources).toContain('graph')
    expect(merged!.scores.raw.ppr).toBe(0.36)
    expect(merged!.scores.normalized.graph).toBeGreaterThan(0)
    expect(response.results.facts).toEqual([expect.objectContaining({ id: 'fact-1', factText: 'Tennyson wrote Maud' })])
    expect(response.results.entities).toEqual([expect.objectContaining({ id: 'ent-1', name: 'Tennyson' })])
  })

  it('surfaces a misconfigured graph bridge when searchGraphPassages is missing', async () => {
    const knowledgeGraph: KnowledgeGraphBridge = {}
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('Document 1', {
      signals: { semantic: false, keyword: false, graph: true },
      count: 1,
    })

    expect(response.results.chunks).toEqual([])
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
    expect(response.warnings).toEqual(expect.arrayContaining([
      'Graph search failed: Knowledge graph bridge must implement searchGraphPassages for graph queries.',
    ]))
  })
})
