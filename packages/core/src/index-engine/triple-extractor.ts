import type { LLMProvider } from '../types/llm-provider.js'
import type { GraphBridge } from '../types/graph-bridge.js'

export interface TripleExtractorConfig {
  llm: LLMProvider
  graph: GraphBridge
}

interface ExtractedTriple {
  subject: string
  predicate: string
  object: string
}

const TRIPLE_EXTRACTION_PROMPT = `Extract factual relationships from the following text as subject-predicate-object triples.

Rules:
- Each triple should represent a clear factual relationship
- Subject and object should be specific entities (people, organizations, concepts, locations, etc.)
- Predicate should be a concise relationship verb/phrase
- Only extract relationships explicitly stated in the text
- Return an empty array if no clear relationships exist

Return a JSON array of objects with "subject", "predicate", and "object" fields.

Text:
`

export class TripleExtractor {
  private llm: LLMProvider
  private graph: GraphBridge

  constructor(config: TripleExtractorConfig) {
    this.llm = config.llm
    this.graph = config.graph
  }

  async extractFromChunk(content: string, bucketId: string, chunkIndex?: number): Promise<void> {
    if (!this.graph.addTriple) return

    try {
      const triples = await this.llm.generateJSON<ExtractedTriple[]>(
        TRIPLE_EXTRACTION_PROMPT + content,
        'You are a precise entity-relationship extractor. Return only valid JSON arrays.'
      )

      if (!Array.isArray(triples)) return

      for (const triple of triples) {
        if (!triple.subject || !triple.predicate || !triple.object) continue
        const tripleData: { subject: string; predicate: string; object: string; content: string; bucketId: string; chunkIndex?: number } = {
          subject: triple.subject,
          predicate: triple.predicate,
          object: triple.object,
          content,
          bucketId,
        }
        if (chunkIndex !== undefined) tripleData.chunkIndex = chunkIndex
        await this.graph.addTriple(tripleData)
      }
    } catch {
      // Triple extraction failures should not block indexing
    }
  }
}
