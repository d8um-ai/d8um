import { describe, it, expect, vi } from 'vitest'
import { createKnowledgeGraphBridge } from '../graph-bridge.js'
import type { MemoryStoreAdapter, SemanticEntity, SemanticEdge } from '../../memory/types/index.js'
import { buildScope } from '../../memory/index.js'

const testScope = buildScope({ userId: 'test-user' })

function makeEntity(id: string, name: string, type: string = 'entity'): SemanticEntity {
  return {
    id,
    name,
    entityType: type,
    aliases: [],
    properties: {},
    embedding: [0.1, 0.2, 0.3],
    scope: testScope,
    temporal: { validAt: new Date(), createdAt: new Date() },
  }
}

function makeEdge(
  id: string,
  sourceId: string,
  targetId: string,
  relation: string,
  properties: Record<string, unknown> = {},
): SemanticEdge {
  return {
    id,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    relation,
    weight: 1.0,
    properties,
    scope: testScope,
    temporal: { validAt: new Date(), createdAt: new Date() },
    evidence: [],
  }
}

interface MockMention {
  entityId: string
  documentId: string
  chunkIndex: number
  bucketId: string
  mentionType: 'subject' | 'object' | 'co_occurrence' | 'entity' | 'alias'
  surfaceText?: string | undefined
  normalizedSurfaceText?: string | undefined
  confidence?: number | undefined
}

function mockStore(
  entities: Map<string, SemanticEntity> = new Map(),
  edges: SemanticEdge[] = [],
  mentions: MockMention[] = [],
) {
  const store: MemoryStoreAdapter = {
    initialize: vi.fn(),
    upsert: vi.fn().mockImplementation(async (r) => r),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    upsertEntity: vi.fn().mockImplementation(async (e: SemanticEntity) => {
      entities.set(e.id, e)
      return e
    }),
    getEntity: vi.fn().mockImplementation(async (id: string) => entities.get(id) ?? null),
    findEntities: vi.fn().mockImplementation(async (query: string) => {
      return [...entities.values()].filter(e =>
        e.name.toLowerCase().includes(query.toLowerCase()),
      )
    }),
    searchEntities: vi.fn().mockImplementation(async () => [...entities.values()]),
    searchEntitiesHybrid: vi.fn().mockImplementation(async (query: string) => {
      const normalized = query
        .replace(/[Ææ]/g, 'ae')
        .replace(/[Œœ]/g, 'oe')
        .normalize('NFKD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
      const exact = [...entities.values()]
        .filter(e =>
          e.name.toLowerCase() === query.toLowerCase()
          || e.aliases.some(a => a.toLowerCase() === query.toLowerCase())
          || mentions.some(m => m.entityId === e.id && m.normalizedSurfaceText === normalized)
        )
        .map(e => ({ ...e, properties: { ...e.properties, _similarity: 1 } }))
      return exact.length > 0
        ? exact
        : [...entities.values()].map(e => ({ ...e, properties: { ...e.properties, _similarity: 0.5 } }))
    }),
    upsertEdge: vi.fn().mockImplementation(async (e: SemanticEdge) => {
      edges.push(e)
      return e
    }),
    getEntitiesBatch: vi.fn().mockImplementation(async (ids: string[]) => {
      return ids.map(id => entities.get(id)).filter(Boolean) as SemanticEntity[]
    }),
    getEdges: vi.fn().mockImplementation(async (entityId: string, direction: string = 'both') => {
      return edges.filter(e => {
        if (direction === 'out') return e.sourceEntityId === entityId
        if (direction === 'in') return e.targetEntityId === entityId
        return e.sourceEntityId === entityId || e.targetEntityId === entityId
      })
    }),
    getEdgesBatch: vi.fn().mockImplementation(async (entityIds: string[], direction: string = 'both') => {
      return edges.filter(e => {
        const matchSource = entityIds.includes(e.sourceEntityId)
        const matchTarget = entityIds.includes(e.targetEntityId)
        if (direction === 'out') return matchSource
        if (direction === 'in') return matchTarget
        return matchSource || matchTarget
      })
    }),
    findEdges: vi.fn().mockResolvedValue([]),
    invalidateEdge: vi.fn(),
    upsertEntityChunkMentions: vi.fn().mockImplementation(async (rows: MockMention[]) => {
      mentions.push(...rows)
    }),
  }
  return store
}

function mockEmbedding() {
  let counter = 0
  return {
    model: 'mock-embed',
    dimensions: 10,
    embed: vi.fn().mockImplementation(async () => {
      counter++
      const vec = new Array(10).fill(0)
      vec[counter % 10] = 1.0
      return vec
    }),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => {
      return texts.map(() => {
        counter++
        const vec = new Array(10).fill(0)
        vec[counter % 10] = 1.0
        return vec
      })
    }),
  }
}

describe('createKnowledgeGraphBridge', () => {
  describe('addTriple', () => {
	    it('creates entities, edge, and entity↔chunk mentions from a triple', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const mentions: MockMention[] = []
      const store = mockStore(entities, edges, mentions)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'prevents',
        object: 'osteoporosis',
        content: 'Vitamin D prevents osteoporosis in elderly patients.',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 0,
      })

      // Two entities created, then profile evidence is updated from the stored fact.
      expect(store.upsertEntity).toHaveBeenCalledTimes(4)
      expect(entities.size).toBe(2)

      // One edge created — content is NOT embedded in properties anymore
      expect(store.upsertEdge).toHaveBeenCalledTimes(1)
      expect(edges).toHaveLength(1)

      const edge = edges[0]!
      expect(edge.relation).toBe('PREVENTS')
      expect(edge.properties.content).toBeUndefined()
      expect(edge.properties.bucketId).toBeUndefined()
      expect(edge.properties.chunkIndex).toBeUndefined()

      // Two mentions written to the junction (subject + object for the same chunk)
      expect(store.upsertEntityChunkMentions).toHaveBeenCalled()
      expect(mentions).toHaveLength(2)
      expect(mentions.every(m => m.documentId === 'doc-1' && m.chunkIndex === 0 && m.bucketId === 'bucket-1')).toBe(true)
	      expect(mentions.map(m => m.mentionType).sort()).toEqual(['object', 'subject'])
	    })

    it('propagates visibility and identity scope to graph rows from a triple', async () => {
      const cases = [
        { visibility: 'tenant' as const, identity: { tenantId: 'tenant-1' } },
        { visibility: 'group' as const, identity: { groupId: 'group-1' } },
        { visibility: 'user' as const, identity: { userId: 'user-1' } },
        { visibility: 'agent' as const, identity: { agentId: 'agent-1' } },
        { visibility: 'conversation' as const, identity: { conversationId: 'conversation-1' } },
      ]

      for (const item of cases) {
        const entities = new Map<string, SemanticEntity>()
        const edges: SemanticEdge[] = []
        const store = mockStore(entities, edges)
        store.upsertPassageEntityEdges = vi.fn().mockResolvedValue(undefined)
        store.upsertFactRecord = vi.fn().mockImplementation(async fact => fact)
        const bridge = createKnowledgeGraphBridge({
          memoryStore: store,
          embedding: mockEmbedding(),
          scope: testScope,
        })

        await bridge.addTriple!({
          subject: `Subject ${item.visibility}`,
          subjectType: 'person',
          predicate: 'leads',
          object: `Object ${item.visibility}`,
          objectType: 'organization',
          content: `Subject ${item.visibility} leads Object ${item.visibility}.`,
          bucketId: 'bucket-1',
          documentId: `doc-${item.visibility}`,
          chunkIndex: 0,
          ...item.identity,
          visibility: item.visibility,
        })

        expect([...entities.values()].every(entity =>
          entity.visibility === item.visibility
          && Object.entries(item.identity).every(([key, value]) => entity.scope[key as keyof typeof item.identity] === value)
        )).toBe(true)
        expect(edges.every(edge =>
          edge.visibility === item.visibility
          && Object.entries(item.identity).every(([key, value]) => edge.scope[key as keyof typeof item.identity] === value)
        )).toBe(true)
        expect(store.upsertFactRecord).toHaveBeenCalledWith(expect.objectContaining({
          visibility: item.visibility,
          scope: expect.objectContaining(item.identity),
        }))
        expect(store.upsertPassageEntityEdges).toHaveBeenCalledWith(expect.arrayContaining([
          expect.objectContaining({
            visibility: item.visibility,
            scope: expect.objectContaining(item.identity),
          }),
        ]))
      }
    })

    it('does not merge same-name group-visible entities across groups in one process', async () => {
      const entities = new Map<string, SemanticEntity>()
      const store = mockStore(entities)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addEntityMentions!([{
        name: 'TypeGraph',
        type: 'organization',
        content: 'TypeGraph appears in group A.',
        bucketId: 'bucket-1',
        documentId: 'doc-a',
        chunkIndex: 0,
        groupId: 'group-a',
        visibility: 'group',
      }])
      await bridge.addEntityMentions!([{
        name: 'TypeGraph',
        type: 'organization',
        content: 'TypeGraph appears in group B.',
        bucketId: 'bucket-1',
        documentId: 'doc-b',
        chunkIndex: 0,
        groupId: 'group-b',
        visibility: 'group',
      }])

      const typegraphEntities = [...entities.values()].filter(entity => entity.name === 'TypeGraph')
      expect(typegraphEntities).toHaveLength(2)
      expect(new Set(typegraphEntities.map(entity => entity.scope.groupId))).toEqual(new Set(['group-a', 'group-b']))
    })

	    it('stores aliases as searchable surface mentions', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const mentions: MockMention[] = []
      const store = mockStore(entities, edges, mentions)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Cæsar Simon',
        subjectType: 'person',
        subjectAliases: ['Conway', 'Cole Conway', 'Cousin Cæsar'],
        predicate: 'collaborated_with',
        object: 'Steve Sharp',
        objectType: 'person',
        content: 'Cæsar Simon was calling himself Cole Conway in company with Steve Sharp.',
        bucketId: 'bucket-1',
        documentId: 'doc-47558',
        chunkIndex: 24,
      })

      expect(mentions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          mentionType: 'alias',
          surfaceText: 'Cole Conway',
          normalizedSurfaceText: 'cole conway',
        }),
      ]))

      const found = await bridge.searchEntities!('Cole Conway', testScope, 10)
      expect(found[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))

      const foundBySurname = await bridge.searchEntities!('Conway', testScope, 10)
      expect(foundBySurname[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))

      const foundByAlias = await bridge.searchEntities!('Cousin Cæsar', testScope, 10)
      expect(foundByAlias[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))

      const foundByAsciiAlias = await bridge.searchEntities!('Cousin Caesar', testScope, 10)
      expect(foundByAsciiAlias[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))
    })

    it('does not persist self-edges after entity resolution', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Cæsar Simon',
        subjectType: 'person',
        subjectAliases: ['Conway'],
        predicate: 'known_as',
        object: 'Conway',
        objectType: 'person',
        objectAliases: ['Cæsar Simon'],
        content: 'Cæsar Simon was known as Conway.',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 0,
      })

      expect(edges).toHaveLength(0)
    })

    it('stores entity mentions even when no relationship is available', async () => {
      const entities = new Map<string, SemanticEntity>()
      const mentions: MockMention[] = []
      const store = mockStore(entities, [], mentions)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addEntityMentions!([{
        name: 'Cole Conway',
        type: 'person',
        aliases: ['Conway'],
        description: 'A name used by Cæsar Simon in Paducah.',
        content: 'At twenty years of age Cousin Cæsar was calling himself Cole Conway.',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 0,
      }])

      expect(entities.size).toBe(1)
      expect(mentions).toEqual(expect.arrayContaining([
        expect.objectContaining({ mentionType: 'entity', surfaceText: 'Cole Conway' }),
        expect.objectContaining({ mentionType: 'alias', surfaceText: 'Conway' }),
      ]))
    })

    it('normalizes predicate to SCREAMING_SNAKE_CASE', async () => {
      const edges: SemanticEdge[] = []
      const store = mockStore(new Map(), edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Alice',
        predicate: 'works at',
        object: 'Acme Corp',
        content: 'Alice works at Acme Corp.',
        bucketId: 'doc-2',
      })

      expect(edges[0]!.relation).toBe('WORKS_FOR')
    })

    it('resolves duplicate entities on repeated addTriple calls', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      // First triple: creates "Vitamin D" and "osteoporosis"
      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'prevents',
        object: 'osteoporosis',
        content: 'Chunk 1',
        bucketId: 'doc-1',
      })

      const firstEntityCount = entities.size

      // Second triple: "Vitamin D" should be resolved to existing entity
      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'supports',
        object: 'bone health',
        content: 'Chunk 2',
        bucketId: 'doc-1',
      })

      // Should have 3 entities (Vitamin D reused, + osteoporosis + bone health)
      expect(firstEntityCount).toBe(2)
      expect(entities.size).toBe(3)
      // 2 explicit edges (prevents, supports), 0 CO_OCCURS (all entities have direct edges)
      expect(edges).toHaveLength(2)
    })
  })

  describe('backfill', () => {
    it('creates passage nodes, passage-entity edges, fact records, and profiles from existing rows', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['alice', makeEntity('alice', 'Alice', 'person')],
        ['beta', makeEntity('beta', 'Beta Inc', 'organization')],
      ])
      const edges = [makeEdge('edge-1', 'alice', 'beta', 'WORKS_AT')]
      const store = mockStore(entities, edges)
      Object.assign(store, {
        listPassageBackfillChunks: vi.fn().mockImplementation(async ({ offset }: { offset?: number }) => {
          if ((offset ?? 0) > 0) return []
          return [{
            chunkId: 'chk-1',
            bucketId: 'bucket-1',
            documentId: 'doc-1',
            chunkIndex: 0,
            embeddingModel: 'mock-embed',
            content: 'Alice works at Beta Inc.',
            metadata: { source: 'test' },
            userId: 'test-user',
          }]
        }),
        listPassageMentionBackfillRows: vi.fn().mockImplementation(async ({ offset }: { offset?: number }) => {
          if ((offset ?? 0) > 0) return []
          return [
            {
              chunkId: 'chk-1',
              bucketId: 'bucket-1',
              documentId: 'doc-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
              content: 'Alice works at Beta Inc.',
              metadata: {},
              userId: 'test-user',
              entityId: 'alice',
              mentionType: 'subject',
              surfaceText: 'Alice',
              confidence: 0.9,
            },
            {
              chunkId: 'chk-1',
              bucketId: 'bucket-1',
              documentId: 'doc-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
              content: 'Alice works at Beta Inc.',
              metadata: {},
              userId: 'test-user',
              entityId: 'beta',
              mentionType: 'object',
              surfaceText: 'Beta Inc',
              confidence: 0.9,
            },
          ]
        }),
        listSemanticEdgesForBackfill: vi.fn().mockImplementation(async ({ offset }: { offset?: number } = {}) => {
          if ((offset ?? 0) > 0) return []
          return edges
        }),
        upsertPassageNodes: vi.fn(),
        upsertPassageEntityEdges: vi.fn(),
        upsertFactRecord: vi.fn().mockImplementation(async fact => fact),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'chunks_mock',
      })

      const result = await bridge.backfill!(testScope, { batchSize: 10 })

      expect(result.passageNodesUpserted).toBe(1)
      expect(result.passageEntityEdgesUpserted).toBe(2)
      expect(result.factRecordsUpserted).toBe(1)
      expect(result.entityProfilesUpdated).toBe(2)
      expect(store.upsertPassageNodes).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({
          bucketId: 'bucket-1',
          documentId: 'doc-1',
          chunkIndex: 0,
        }),
      ]))
      expect(store.upsertFactRecord).toHaveBeenCalledWith(expect.objectContaining({
        factText: 'Alice works at Beta Inc',
      }))
    })
  })

  describe('searchEntities', () => {
    it('embeds query and searches store', async () => {
      const entities = new Map<string, SemanticEntity>()
      entities.set('e1', {
        ...makeEntity('e1', 'Vitamin D', 'supplement'),
        aliases: ['cholecalciferol'],
        properties: { source: 'test fixture' },
      })
      entities.set('e2', makeEntity('e2', 'Calcium'))
      const edges = [
        makeEdge('edge-1', 'e1', 'e2', 'SUPPORTS'),
        makeEdge('edge-2', 'e1', 'e3', 'IMPROVES'),
      ]

      const store = mockStore(entities, edges)
      ;(store.getEdgesBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
        edges[0]!,
        edges[0]!,
        edges[1]!,
      ])
      const emb = mockEmbedding()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: emb,
        scope: testScope,
      })

      const results = await bridge.searchEntities!('vitamin supplements', testScope, 5)

      expect(emb.embed).toHaveBeenCalledWith('vitamin supplements')
      expect(store.searchEntitiesHybrid).toHaveBeenCalled()
      expect(results).toHaveLength(2)
      expect(results[0]).toHaveProperty('id')
      expect(results[0]).toHaveProperty('name')
      expect(results[0]).toHaveProperty('entityType')
      expect(results[0]).toEqual(expect.objectContaining({
        aliases: ['cholecalciferol'],
        similarity: 0.5,
        edgeCount: 2,
        properties: expect.objectContaining({ source: 'test fixture' }),
      }))
      expect(results[0]?.properties).not.toHaveProperty('_similarity')
      expect(results[1]).toEqual(expect.objectContaining({ edgeCount: 1 }))
    })

    it('returns empty array when store does not support searchEntities', async () => {
      const store = mockStore()
      delete (store as any).searchEntities

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const results = await bridge.searchEntities!('query', testScope, 5)
      expect(results).toEqual([])
    })
  })

  describe('searchGraphPassages', () => {
    it('returns ranked passages and keeps direct entity seeding from hybrid entity lookup', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['adarsh', {
          ...makeEntity('adarsh', 'Adarsh Tadimari', 'person'),
          aliases: [],
          properties: { description: 'Technical team member at Plotline.' },
        }],
      ])
      const mentions: MockMention[] = [{
        entityId: 'adarsh',
        documentId: 'doc-1',
        chunkIndex: 0,
        bucketId: 'bucket-1',
        mentionType: 'entity',
        surfaceText: 'Adarsh',
        normalizedSurfaceText: 'adarsh',
      }]
      const store = mockStore(entities, [], mentions)
      Object.assign(store, {
        searchFacts: vi.fn().mockResolvedValue([]),
        searchPassageNodes: vi.fn().mockResolvedValue([]),
        getPassageEdgesForEntities: vi.fn().mockResolvedValue([{
          passageId: 'passage_test',
          entityId: 'adarsh',
          weight: 1.5,
          mentionCount: 1,
          confidence: 0.9,
          surfaceTexts: ['Adarsh'],
          mentionTypes: ['entity'],
        }]),
        getPassagesByIds: vi.fn().mockResolvedValue([{
          passageId: 'passage_test',
          content: 'Adarsh Tadimari is debugging Plotline SDK initialization issues.',
          bucketId: 'bucket-1',
          documentId: 'doc-1',
          chunkIndex: 0,
          totalChunks: 1,
          metadata: { source: 'test' },
          userId: 'test-user',
        }]),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'typegraph_chunks_mock',
      })

      const result = await bridge.searchGraphPassages!('Adarsh', testScope, { count: 5 })

      expect(store.searchEntitiesHybrid).toHaveBeenCalledWith(expect.any(String), expect.any(Array), testScope, 10)
      expect(result.results).toHaveLength(1)
      expect(result.results[0]).toEqual(expect.objectContaining({
        passageId: 'passage_test',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 0,
      }))
      expect(result.results[0]!.score).toBeGreaterThan(0)
      expect(result.trace.entitySeedCount).toBeGreaterThan(0)
      expect(result.trace.selectedEntityIds).toContain('adarsh')
    })
  })

  describe('explore', () => {
    it.each([
      'plotline employees',
      'employees at plotline',
      'who works at plotline',
    ])('resolves employment intent and returns fact projections for "%s"', async (query) => {
      const entities = new Map<string, SemanticEntity>([
        ['plotline', makeEntity('plotline', 'Plotline', 'organization')],
        ['adarsh', makeEntity('adarsh', 'Adarsh Tadimari', 'person')],
        ['rajat', makeEntity('rajat', 'Rajat', 'person')],
      ])
      const edges = [
        makeEdge('edge-1', 'adarsh', 'plotline', 'WORKS_FOR'),
        makeEdge('edge-2', 'rajat', 'plotline', 'MEMBER_OF'),
        makeEdge('edge-3', 'adarsh', 'plotline', 'LEADS'),
      ]
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const result = await bridge.explore!(query, { userId: 'test-user', explain: true })

      expect(result.intent.mode).toBe('relationship')
      expect(result.intent.predicates.map(predicate => predicate.name)).toEqual(expect.arrayContaining([
        'WORKS_FOR',
        'WORKED_FOR',
        'MEMBER_OF',
      ]))
      expect(result.intent.targetEntityTypes).toEqual(['person'])
      expect(result.anchors[0]).toEqual(expect.objectContaining({ name: 'Plotline', entityType: 'organization' }))
      expect(result.entities.map(entity => entity.name)).toEqual(expect.arrayContaining(['Adarsh Tadimari', 'Rajat']))
      expect(result.entities.map(entity => entity.name)).not.toContain('Plotline')
      expect(result.facts.map(fact => fact.relation)).toEqual(expect.arrayContaining(['WORKS_FOR', 'MEMBER_OF']))
      expect(result.facts.map(fact => fact.relation)).not.toContain('LEADS')
      expect(result.facts.every(fact => fact.similarity === undefined)).toBe(true)
      expect(result.trace).toEqual(expect.objectContaining({
        parser: 'fallback',
        fallbackUsed: true,
        mode: 'relationship',
        selectedAnchorIds: ['plotline'],
        selectedPredicates: expect.arrayContaining(['WORKS_FOR', 'WORKED_FOR', 'MEMBER_OF']),
        targetEntityTypes: ['person'],
      }))
    })

    it('uses the configured exploration LLM when it returns valid structured intent', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['plotline', makeEntity('plotline', 'Plotline', 'organization')],
        ['adarsh', makeEntity('adarsh', 'Adarsh Tadimari', 'person')],
      ])
      const edges = [makeEdge('edge-1', 'adarsh', 'plotline', 'WORKS_FOR')]
      const store = mockStore(entities, edges)
      const explorationLlm = {
        generateText: vi.fn().mockResolvedValue(''),
        generateJSON: vi.fn().mockResolvedValue({
          anchorText: 'Plotline',
          mode: 'relationship',
          predicates: [{ name: 'WORKS_FOR', confidence: 0.95 }],
          targetEntityTypes: ['person'],
        }),
      }
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        explorationLlm,
      })

      const result = await bridge.explore!('plotline employees', { userId: 'test-user', explain: true })

      expect(explorationLlm.generateJSON).toHaveBeenCalled()
      expect(result.trace?.parser).toBe('llm')
      expect(result.trace?.fallbackUsed).toBe(false)
      expect(result.intent.anchorText).toBe('Plotline')
      expect(result.intent.mode).toBe('relationship')
      expect(result.intent.predicates[0]).toEqual(expect.objectContaining({
        name: 'WORKS_FOR',
        confidence: 0.95,
      }))
      expect(result.trace?.selectedPredicates).toEqual(['WORKS_FOR'])
    })

    it('falls back to deterministic parsing when the exploration LLM returns invalid output and can include passages', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['plotline', makeEntity('plotline', 'Plotline', 'organization')],
        ['adarsh', makeEntity('adarsh', 'Adarsh Tadimari', 'person')],
      ])
      const edges = [makeEdge('edge-1', 'adarsh', 'plotline', 'WORKS_FOR')]
      const store = mockStore(entities, edges)
      Object.assign(store, {
        getPassageEdgesForEntities: vi.fn().mockResolvedValue([{
          passageId: 'passage_plotline_adarsh',
          entityId: 'adarsh',
          weight: 2,
          mentionCount: 1,
          confidence: 0.9,
          surfaceTexts: ['Adarsh Tadimari'],
          mentionTypes: ['subject'],
        }]),
        getPassagesByIds: vi.fn().mockResolvedValue([{
          passageId: 'passage_plotline_adarsh',
          content: 'Adarsh Tadimari works at Plotline on SDK integration issues.',
          bucketId: 'bucket-1',
          documentId: 'doc-1',
          chunkIndex: 0,
          totalChunks: 1,
          metadata: { source: 'test' },
          userId: 'test-user',
        }]),
      })
      const explorationLlm = {
        generateText: vi.fn().mockResolvedValue(''),
        generateJSON: vi.fn().mockResolvedValue({
          anchorText: 'Plotline',
          mode: 'relationship',
          predicates: [{ name: 'not-a-predicate', confidence: 1 }],
          targetEntityTypes: [],
        }),
      }
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'typegraph_chunks_mock',
        explorationLlm,
      })

      const result = await bridge.explore!('plotline employees', {
        userId: 'test-user',
        include: { passages: true },
        explain: true,
      })

      expect(result.trace?.parser).toBe('fallback')
      expect(result.trace?.fallbackUsed).toBe(true)
      expect(result.intent.mode).toBe('relationship')
      expect(result.intent.predicates.map(predicate => predicate.name)).toEqual(expect.arrayContaining([
        'WORKS_FOR',
        'WORKED_FOR',
        'MEMBER_OF',
      ]))
      expect(result.passages).toEqual([
        expect.objectContaining({
          passageId: 'passage_plotline_adarsh',
          documentId: 'doc-1',
          chunkIndex: 0,
        }),
      ])
      expect(result.passages?.[0]?.score).toBeGreaterThan(0)
    })

    it('returns attribute-mode profession results from anchor-adjacent edges', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['elsie', makeEntity('elsie', 'Elsie Inglis', 'person')],
        ['doctor', makeEntity('doctor', 'doctor', 'concept')],
        ['serbia', makeEntity('serbia', 'Serbia', 'location')],
      ])
      const edges = [
        makeEdge('edge-role', 'elsie', 'doctor', 'WORKS_AS'),
        makeEdge('edge-travel', 'elsie', 'serbia', 'TRAVELED_TO'),
      ]
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const result = await bridge.explore!("What is Elsie Inglis' profession?", {
        userId: 'test-user',
        explain: true,
      })

      expect(result.intent).toEqual(expect.objectContaining({
        anchorText: 'Elsie Inglis',
        mode: 'attribute',
        targetEntityTypes: ['concept'],
      }))
      expect(result.intent.predicates.map(predicate => predicate.name)).toEqual(expect.arrayContaining([
        'WORKS_AS',
        'WORKED_AS',
        'HELD_ROLE',
        'PRACTICED_AS',
      ]))
      expect(result.anchors).toEqual([
        expect.objectContaining({ id: 'elsie', name: 'Elsie Inglis', entityType: 'person' }),
      ])
      expect(result.entities).toEqual([
        expect.objectContaining({ id: 'doctor', name: 'doctor', entityType: 'concept' }),
      ])
      expect(result.facts).toEqual([
        expect.objectContaining({ edgeId: 'edge-role', relation: 'WORKS_AS' }),
      ])
      expect(result.entities.map(entity => entity.name)).not.toContain('Serbia')
      expect(result.trace).toEqual(expect.objectContaining({
        mode: 'attribute',
        selectedPredicates: expect.arrayContaining(['WORKS_AS', 'WORKED_AS', 'HELD_ROLE', 'PRACTICED_AS']),
        targetEntityTypes: ['concept'],
      }))
    })

    it('filters directed support queries to the requested anchor side', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['elsie', makeEntity('elsie', 'Elsie', 'person')],
        ['bishop', makeEntity('bishop', 'Bishop Gore', 'person')],
        ['jugoslav', makeEntity('jugoslav', 'Jugoslav Division', 'organization')],
      ])
      const edges = [
        makeEdge('edge-incoming-support', 'bishop', 'elsie', 'SUPPORTED'),
        makeEdge('edge-outgoing-support', 'elsie', 'jugoslav', 'SUPPORTED'),
      ]
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const incoming = await bridge.explore!('Who supported Elsie?', {
        userId: 'test-user',
        explain: true,
      })

      expect(incoming.trace?.anchorSide).toBe('target')
      expect(incoming.entities.map(entity => entity.name)).toEqual(['Bishop Gore'])
      expect(incoming.entities.map(entity => entity.name)).not.toContain('Jugoslav Division')
      expect(incoming.facts.map(fact => fact.edgeId)).toEqual(['edge-incoming-support'])
      expect(incoming.trace?.droppedByDirection).toBeGreaterThanOrEqual(1)

      const outgoing = await bridge.explore!('Who did Elsie support?', {
        userId: 'test-user',
        explain: true,
      })

      expect(outgoing.trace?.anchorSide).toBe('source')
      expect(outgoing.entities.map(entity => entity.name)).toEqual(['Jugoslav Division'])
      expect(outgoing.entities.map(entity => entity.name)).not.toContain('Bishop Gore')
      expect(outgoing.facts.map(fact => fact.edgeId)).toEqual(['edge-outgoing-support'])
      expect(outgoing.trace?.droppedByDirection).toBeGreaterThanOrEqual(1)
    })

    it('applies direction filtering to non-support predicates', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['elsie', makeEntity('elsie', 'Elsie', 'person')],
        ['hospice', makeEntity('hospice', 'Maternity Hospice', 'organization')],
        ['committee', makeEntity('committee', 'Hospital Committee', 'organization')],
      ])
      const edges = [
        makeEdge('edge-founded-correct', 'elsie', 'hospice', 'FOUNDED'),
        makeEdge('edge-founded-opposite', 'hospice', 'committee', 'FOUNDED'),
      ]
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const founderResult = await bridge.explore!('Who founded Maternity Hospice?', {
        userId: 'test-user',
        explain: true,
      })

      expect(founderResult.trace?.anchorSide).toBe('target')
      expect(founderResult.entities.map(entity => entity.name)).toEqual(['Elsie'])
      expect(founderResult.entities.map(entity => entity.name)).not.toContain('Hospital Committee')
      expect(founderResult.facts.map(fact => fact.edgeId)).toEqual(['edge-founded-correct'])
      expect(founderResult.trace?.droppedByDirection).toBeGreaterThanOrEqual(1)

      const foundedResult = await bridge.explore!('What did Elsie found?', {
        userId: 'test-user',
        explain: true,
      })

      expect(foundedResult.trace?.anchorSide).toBe('source')
      expect(foundedResult.entities.map(entity => entity.name)).toEqual(['Maternity Hospice'])
      expect(foundedResult.entities.map(entity => entity.name)).not.toContain('Hospital Committee')
      expect(foundedResult.facts.map(fact => fact.edgeId)).toEqual(['edge-founded-correct'])
    })

    it('keeps relationship traversal working beyond the anchor while enforcing target types', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['plotline', makeEntity('plotline', 'Plotline', 'organization')],
        ['adarsh', makeEntity('adarsh', 'Adarsh Tadimari', 'person')],
        ['rajat', makeEntity('rajat', 'Rajat', 'person')],
        ['committee', makeEntity('committee', 'Research Committee', 'organization')],
      ])
      const edges = [
        makeEdge('edge-employment', 'adarsh', 'plotline', 'WORKS_FOR'),
        makeEdge('edge-person-collab', 'adarsh', 'rajat', 'COLLABORATED_WITH'),
        makeEdge('edge-mixed-collab', 'adarsh', 'committee', 'COLLABORATED_WITH'),
        makeEdge('edge-anchor-org-collab', 'plotline', 'committee', 'COLLABORATED_WITH'),
      ]
      const store = mockStore(entities, edges)
      const explorationLlm = {
        generateText: vi.fn().mockResolvedValue(''),
        generateJSON: vi.fn().mockResolvedValue({
          anchorText: 'Plotline',
          mode: 'relationship',
          predicates: [{ name: 'COLLABORATED_WITH', confidence: 0.9 }],
          targetEntityTypes: ['person'],
        }),
      }
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        explorationLlm,
      })

      const result = await bridge.explore!('Who worked with Plotline?', {
        userId: 'test-user',
        depth: 2,
        explain: true,
      })

      expect(result.intent).toEqual(expect.objectContaining({
        anchorText: 'Plotline',
        mode: 'relationship',
        targetEntityTypes: ['person'],
      }))
      expect(result.entities.map(entity => entity.name)).toEqual(expect.arrayContaining([
        'Adarsh Tadimari',
        'Rajat',
      ]))
      expect(result.entities.map(entity => entity.name)).not.toContain('Research Committee')
      expect(result.facts.map(fact => fact.relation)).toEqual([
        'COLLABORATED_WITH',
        'COLLABORATED_WITH',
      ])
      expect(result.trace).toEqual(expect.objectContaining({
        parser: 'llm',
        mode: 'relationship',
        selectedPredicates: ['COLLABORATED_WITH'],
      }))
      expect(result.trace?.droppedByType).toBeGreaterThanOrEqual(1)
    })
  })
})
