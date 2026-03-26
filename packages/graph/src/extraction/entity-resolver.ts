import type { EmbeddingProvider } from '@d8um/core'
import type { d8umIdentity } from '@d8um/core'
import type { SemanticEntity } from '../types/memory.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import { createTemporal } from '../temporal.js'
import { randomUUID } from 'crypto'

// ── Entity Resolver ──
// Deduplicates entities using vector similarity on name embeddings + alias matching.
// No external entity resolution service needed.

export interface EntityResolverConfig {
  store: MemoryStoreAdapter
  embedding: EmbeddingProvider
  /** Cosine similarity threshold for considering entities as duplicates. Default: 0.85 */
  similarityThreshold?: number | undefined
}

export class EntityResolver {
  private readonly store: MemoryStoreAdapter
  private readonly embedding: EmbeddingProvider
  private readonly threshold: number

  constructor(config: EntityResolverConfig) {
    this.store = config.store
    this.embedding = config.embedding
    this.threshold = config.similarityThreshold ?? 0.85
  }

  /**
   * Resolve a candidate entity against existing entities in the store.
   * Returns the existing entity if a match is found, or creates a new one.
   */
  async resolve(
    name: string,
    entityType: string,
    aliases: string[],
    scope: d8umIdentity,
  ): Promise<{ entity: SemanticEntity; isNew: boolean }> {
    // Try alias matching first (cheap)
    if (this.store.findEntities) {
      const candidates = await this.store.findEntities(name, scope, 10)
      const aliasMatch = this.findByAlias(name, aliases, candidates)
      if (aliasMatch) {
        const merged = this.merge(aliasMatch, { name, entityType, aliases })
        return { entity: merged, isNew: false }
      }
    }

    // Try vector similarity (more expensive)
    if (this.store.searchEntities) {
      const nameEmbedding = await this.embedding.embed(name)
      const similar = await this.store.searchEntities(nameEmbedding, scope, 5)

      for (const candidate of similar) {
        const similarity = this.cosineSimilarity(nameEmbedding, candidate.embedding ?? [])
        if (similarity >= this.threshold) {
          const merged = this.merge(candidate, { name, entityType, aliases })
          return { entity: merged, isNew: false }
        }
      }
    }

    // No match found - create new entity
    const nameEmbedding = await this.embedding.embed(name)
    const entity: SemanticEntity = {
      id: randomUUID(),
      name,
      entityType,
      aliases,
      properties: {},
      embedding: nameEmbedding,
      scope,
      temporal: createTemporal(),
    }

    return { entity, isNew: true }
  }

  /**
   * Check if a name or any of its aliases match an existing entity.
   */
  private findByAlias(
    name: string,
    aliases: string[],
    candidates: SemanticEntity[],
  ): SemanticEntity | undefined {
    const nameLower = name.toLowerCase()
    const aliasesLower = aliases.map(a => a.toLowerCase())

    for (const candidate of candidates) {
      const candidateNames = [
        candidate.name.toLowerCase(),
        ...candidate.aliases.map(a => a.toLowerCase()),
      ]

      if (candidateNames.includes(nameLower)) return candidate
      for (const alias of aliasesLower) {
        if (candidateNames.includes(alias)) return candidate
      }
    }

    return undefined
  }

  /**
   * Merge incoming data into an existing entity.
   * Adds new aliases, updates type if more specific.
   */
  merge(
    existing: SemanticEntity,
    incoming: { name: string; entityType: string; aliases: string[] },
  ): SemanticEntity {
    const existingAliases = new Set(existing.aliases.map(a => a.toLowerCase()))
    const newAliases = [...existing.aliases]

    // Add the incoming name as an alias if different from canonical
    if (incoming.name.toLowerCase() !== existing.name.toLowerCase()) {
      if (!existingAliases.has(incoming.name.toLowerCase())) {
        newAliases.push(incoming.name)
      }
    }

    // Add new aliases
    for (const alias of incoming.aliases) {
      if (!existingAliases.has(alias.toLowerCase()) && alias.toLowerCase() !== existing.name.toLowerCase()) {
        newAliases.push(alias)
      }
    }

    return {
      ...existing,
      aliases: newAliases,
      // Keep existing type unless it's 'other' and incoming is more specific
      entityType: existing.entityType === 'other' ? incoming.entityType : existing.entityType,
    }
  }

  /**
   * Cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0

    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!
      normA += a[i]! * a[i]!
      normB += b[i]! * b[i]!
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB)
    if (denominator === 0) return 0
    return dotProduct / denominator
  }
}
