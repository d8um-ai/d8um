import type { EmbeddingProvider } from './provider.js'

/**
 * Structural type matching the Vercel AI SDK's EmbeddingModelV3 interface.
 * No imports from `@ai-sdk/provider` needed - pure structural typing.
 * Any object matching this shape works (AI SDK models, custom implementations, test mocks).
 */
export interface AISDKEmbeddingModel {
  readonly provider: string
  readonly modelId: string
  readonly maxEmbeddingsPerCall: number | PromiseLike<number | undefined> | undefined
  readonly supportsParallelCalls: boolean | PromiseLike<boolean>
  doEmbed(options: { values: string[] }): PromiseLike<{ embeddings: number[][] }>
}

/**
 * Configuration for using an AI SDK embedding model with d8um.
 *
 * @example
 * ```ts
 * import { openai } from '@ai-sdk/openai'
 *
 * const embedding: AISDKEmbeddingInput = {
 *   model: openai.embedding('text-embedding-3-small'),
 *   dimensions: 1536,
 * }
 * ```
 */
export interface AISDKEmbeddingInput {
  model: AISDKEmbeddingModel
  dimensions: number
}

/**
 * Wraps an AI SDK embedding model into d8um's EmbeddingProvider interface.
 * Calls `model.doEmbed()` directly - no dependency on the `ai` core package.
 * Automatically batches requests according to `model.maxEmbeddingsPerCall`.
 */
export function aiSdkEmbeddingProvider(config: AISDKEmbeddingInput): EmbeddingProvider {
  const { model, dimensions } = config

  return {
    model: `${model.provider}/${model.modelId}`,
    dimensions,

    async embed(text: string): Promise<number[]> {
      const result = await model.doEmbed({ values: [text] })
      return result.embeddings[0]!
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []

      const batchSize = (await model.maxEmbeddingsPerCall) ?? texts.length
      const allEmbeddings: number[][] = []

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize)
        const result = await model.doEmbed({ values: batch })
        allEmbeddings.push(...result.embeddings)
      }

      return allEmbeddings
    },
  }
}

/**
 * Type guard: checks if a value is an AISDKEmbeddingInput
 * by looking for the `model.doEmbed` function signature.
 */
export function isAISDKEmbeddingInput(
  value: unknown
): value is AISDKEmbeddingInput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v['dimensions'] !== 'number') return false
  const m = v['model']
  if (typeof m !== 'object' || m === null) return false
  return typeof (m as Record<string, unknown>)['doEmbed'] === 'function'
}
