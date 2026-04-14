import { RecursiveChunker } from '@chonkiejs/core'
import type { Chunk, ChunkOpts } from '../types/connector.js'
import type { RawDocument } from '../types/connector.js'

export async function defaultChunker(doc: RawDocument, opts: ChunkOpts): Promise<Chunk[]> {
  if (!doc.content || doc.content.trim().length === 0) return []

  const chunker = await RecursiveChunker.create({
    chunkSize: opts.chunkSize,
  })

  const result = await chunker.chunk(doc.content)

  return result
    .filter(c => c.text.trim().length > 0)
    .map((c, i) => ({ content: c.text, chunkIndex: i }))
}
