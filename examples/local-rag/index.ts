/**
 * Fully local RAG example — no API keys, no external services.
 *
 * Stack:
 *   - Embedding: fastembed + BAAI/bge-small-en-v1.5 (MIT, 33M params, 384 dims)
 *   - Storage:   SQLite + sqlite-vec (zero-infra vector search)
 *
 * First run downloads the ONNX model (~32 MB). Subsequent runs use the cache.
 */

import { d8um } from '@d8um/core'
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'
import { LocalEmbeddingProvider } from '@d8um/embedding-local'

async function main() {
  // 1. Create local embedding provider (downloads model on first run)
  const embedding = new LocalEmbeddingProvider()
  console.log(`Using model: ${embedding.model} (${embedding.dimensions} dimensions)`)

  // 2. Initialize d8um with local-only stack
  d8um.initialize({
    embedding,
    vectorStore: new SqliteVecAdapter({ dbPath: './local-rag.db' }),
  })

  // 3. Add a source with sample documents
  d8um.addSource({
    id: 'docs',
    connector: {
      async *fetch() {
        yield {
          id: 'intro',
          title: 'Introduction to d8um',
          content: `d8um is a TypeScript SDK and open protocol for supplying context to LLMs.
It provides a unified system for managing multiple data sources, retrieving relevant context,
and assembling it into prompt-ready format. Define your data sources once — websites, documents,
APIs, databases — and query all of them with a single call.`,
          updatedAt: new Date(),
          metadata: {},
        }
        yield {
          id: 'setup',
          title: 'Getting Started',
          content: `Install d8um with: npm install @d8um/core. Then choose a vector store adapter
like @d8um/adapter-sqlite-vec for local development or @d8um/adapter-pgvector for production.
Pick an embedding provider — use @d8um/embedding-local for fully offline operation, or any
Vercel AI SDK compatible provider for cloud embeddings.`,
          updatedAt: new Date(),
          metadata: {},
        }
        yield {
          id: 'architecture',
          title: 'Architecture',
          content: `d8um uses a connector-based architecture. Each data source is wrapped in a
Connector that implements fetch(), and optionally fetchSince() for incremental sync. Documents
are chunked, embedded, and stored in the vector store. At query time, d8um fans out across all
sources, embeds the query, performs vector search, and merges results using Reciprocal Rank Fusion.`,
          updatedAt: new Date(),
          metadata: {},
        }
        yield {
          id: 'local-stack',
          title: 'Fully Local Setup',
          content: `For a fully local setup with no external dependencies, use @d8um/embedding-local
which bundles the bge-small-en-v1.5 model via fastembed and ONNX Runtime. Pair it with
@d8um/adapter-sqlite-vec for SQLite-based vector storage. This combination requires no API keys,
no network access, and no external databases — perfect for development, testing, and edge deployments.`,
          updatedAt: new Date(),
          metadata: {},
        }
      },
    },
    mode: 'indexed',
    index: {
      chunkSize: 256,
      chunkOverlap: 32,
      deduplicateBy: ['id'],
    },
  })

  // 4. Index the documents
  console.log('\nIndexing documents...')
  const indexResult = await d8um.index('docs')
  console.log('Index result:', {
    total: indexResult.total,
    inserted: indexResult.inserted,
    skipped: indexResult.skipped,
    updated: indexResult.updated,
    durationMs: indexResult.durationMs,
  })

  // 5. Query
  const queries = [
    'How do I install d8um?',
    'What is the architecture of d8um?',
    'How do I run d8um without any API keys?',
  ]

  for (const query of queries) {
    console.log(`\n--- Query: "${query}" ---`)
    const response = await d8um.query(query)

    for (const result of response.results) {
      const score = result.scores.vector?.toFixed(3) ?? 'N/A'
      console.log(`  [${score}] ${result.content.slice(0, 80)}...`)
    }

    // Assemble into prompt-ready context
    const context = d8um.assemble(response.results, { format: 'xml' })
    console.log(`\nAssembled context (${context.length} chars):`)
    console.log(context.slice(0, 200) + (context.length > 200 ? '...' : ''))
  }

  console.log('\nDone! Database saved to ./local-rag.db')
}

main().catch(console.error)
