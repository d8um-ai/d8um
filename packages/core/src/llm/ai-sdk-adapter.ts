import type { LLMProvider, LLMGenerateOptions } from '../types/llm-provider.js'

/**
 * Structural type matching the Vercel AI SDK's LanguageModelV3 interface.
 * No imports from `@ai-sdk/provider` needed - pure structural typing.
 * Any object matching this shape works (AI SDK models, custom implementations, test mocks).
 */
export interface AISDKLanguageModel {
  readonly provider: string
  readonly modelId: string
  doGenerate(options: {
    prompt: Array<
      | { role: 'system'; content: string }
      | { role: 'user'; content: Array<{ type: 'text'; text: string }> }
    >
    maxOutputTokens?: number
    temperature?: number
    providerOptions?: Record<string, Record<string, unknown>>
  }): PromiseLike<{
    content: Array<{ type: string; text?: string }>
    finishReason: string | { unified: string; raw?: string }
  }>
}

/**
 * Type for the injected `generateObject` function from the `ai` package.
 *
 * Uses `any` for the parameter type to avoid contravariance issues with the
 * AI SDK's complex generic overloads. Type safety is enforced at the call site
 * inside the adapter, not at the injection boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GenerateObjectFn = (opts: any) => PromiseLike<{ object: any }>

/**
 * Configuration for using an AI SDK language model with typegraph.
 *
 * @example
 * ```ts
 * import { gateway } from '@ai-sdk/gateway'
 * import { generateObject } from 'ai'
 *
 * const llm = aiSdkLlmProvider({
 *   model: gateway('google/gemini-2.5-flash'),
 *   generateObject,
 * })
 * ```
 */
export interface AISDKLLMInput {
  model: AISDKLanguageModel
  /** The `generateObject` function from the `ai` package. Enables schema-validated structured output. */
  generateObject: GenerateObjectFn
}

/**
 * Wraps an AI SDK language model into typegraph's LLMProvider interface.
 * Uses the injected `generateObject` for structured JSON output.
 */
export function aiSdkLlmProvider(config: AISDKLLMInput): LLMProvider {
  const { model, generateObject: generateObjectFn } = config

  const provider: LLMProvider = {
    async generateText(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<string> {
      const messages: Array<
        | { role: 'system'; content: string }
        | { role: 'user'; content: Array<{ type: 'text'; text: string }> }
      > = []

      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt })
      }
      messages.push({ role: 'user', content: [{ type: 'text', text: prompt }] })

      const result = await model.doGenerate({
        prompt: messages,
        ...(options?.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(options?.providerOptions ? { providerOptions: options.providerOptions } : {}),
      })

      return result.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
        .join('')
    },

    async generateJSON<T = unknown>(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<T> {
      const result = await generateObjectFn({
        model,
        ...(options?.schema ? { schema: options.schema } : { output: 'no-schema' }),
        prompt: prompt + '\n\nRespond with valid JSON only, no markdown fences.',
        ...(systemPrompt ? { system: systemPrompt } : {}),
        maxTokens: options?.maxOutputTokens ?? 16384,
        ...(options?.providerOptions ? { providerOptions: options.providerOptions } : {}),
      })

      return result.object as T
    },
  }

  return provider
}

/**
 * Type guard: checks if a value is an AISDKLLMInput
 * by looking for `model.doGenerate` and `generateObject` functions.
 */
export function isAISDKLLMInput(
  value: unknown
): value is AISDKLLMInput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const m = v['model']
  if (typeof m !== 'object' || m === null) return false
  return typeof (m as Record<string, unknown>)['doGenerate'] === 'function'
    && typeof v['generateObject'] === 'function'
}
