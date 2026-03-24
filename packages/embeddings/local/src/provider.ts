import type { EmbeddingProvider } from '@d8um/core'
import { EmbeddingModel, FlagEmbedding } from 'fastembed'

export interface LocalEmbeddingConfig {
  /** Override the default model. Defaults to BGE-small-en-v1.5 (384 dimensions). */
  model?: EmbeddingModel | undefined
  /** Override dimensions (must match the chosen model). */
  dimensions?: number | undefined
}

const MODEL_DIMENSIONS: Partial<Record<EmbeddingModel, number>> = {
  [EmbeddingModel.BGESmallENV15]: 384,
  [EmbeddingModel.BGESmallEN]: 384,
  [EmbeddingModel.AllMiniLML6V2]: 384,
  [EmbeddingModel.BGEBaseENV15]: 768,
  [EmbeddingModel.BGEBaseEN]: 768,
  [EmbeddingModel.MLE5Large]: 1024,
}

/**
 * Local embedding provider using fastembed + ONNX Runtime.
 * Runs entirely on-device — no API keys or network calls needed.
 *
 * Default model: BAAI/bge-small-en-v1.5 (33M params, 384 dims, MIT license)
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  readonly dimensions: number

  private embeddingModel: EmbeddingModel
  private embedder: FlagEmbedding | null = null

  constructor(config: LocalEmbeddingConfig = {}) {
    this.embeddingModel = config.model ?? EmbeddingModel.BGESmallENV15
    this.dimensions = config.dimensions ?? MODEL_DIMENSIONS[this.embeddingModel] ?? 384
    this.model = `local/${this.embeddingModel}`
  }

  /** Pre-initialize the model (downloads on first use). Called automatically if needed. */
  async initialize(): Promise<void> {
    if (this.embedder) return
    this.embedder = await FlagEmbedding.init({
      model: this.embeddingModel as EmbeddingModel.BGESmallENV15,
    })
  }

  async embed(text: string): Promise<number[]> {
    await this.initialize()
    const results = this.embedder!.queryEmbed(text)
    return Array.from(await results)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    await this.initialize()
    const all: number[][] = []
    for await (const batch of this.embedder!.embed(texts)) {
      for (const vec of batch) {
        all.push(Array.from(vec))
      }
    }
    return all
  }
}
