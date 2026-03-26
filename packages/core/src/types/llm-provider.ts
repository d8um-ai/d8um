/**
 * Structural type for an LLM provider.
 * No imports from `@ai-sdk/*` - pure structural typing.
 * Any object matching this shape works (AI SDK models, custom implementations, test mocks).
 *
 * The provider must support structured JSON output for memory extraction.
 */
export interface LLMProvider {
  /**
   * Generate text from a prompt. Returns the raw text response.
   */
  generateText(prompt: string, systemPrompt?: string): Promise<string>

  /**
   * Generate structured JSON output from a prompt.
   * The provider should parse and return the JSON object.
   */
  generateJSON<T = unknown>(prompt: string, systemPrompt?: string): Promise<T>
}
