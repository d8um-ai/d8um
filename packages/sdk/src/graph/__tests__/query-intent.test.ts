import { describe, expect, it, vi } from 'vitest'
import { parseGraphExploreIntent } from '../query-intent.js'
import type { LLMProvider } from '../../types/llm-provider.js'

function mockLlm(output: unknown): LLMProvider {
  return {
    generateText: vi.fn().mockResolvedValue(''),
    generateJSON: vi.fn().mockResolvedValue(output),
  }
}

describe('parseGraphExploreIntent', () => {
  it('maps profession questions to attribute mode and role predicates', async () => {
    const result = await parseGraphExploreIntent({
      query: "What is Elsie Inglis' profession?",
    })

    expect(result.parser).toBe('fallback')
    expect(result.fallbackUsed).toBe(true)
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
  })

  it('maps occupation wording to the same role predicates', async () => {
    const result = await parseGraphExploreIntent({
      query: 'What was Elsie Inglis occupation?',
    })

    expect(result.intent.anchorText).toBe('Elsie Inglis')
    expect(result.intent.mode).toBe('attribute')
    expect(result.intent.predicates.map(predicate => predicate.name)).toEqual(expect.arrayContaining([
      'WORKS_AS',
      'WORKED_AS',
      'HELD_ROLE',
      'PRACTICED_AS',
    ]))
  })

  it('maps location questions to concrete location predicates', async () => {
    const result = await parseGraphExploreIntent({
      query: 'Where did Augustus Le Plongeon live?',
    })

    expect(result.intent).toEqual(expect.objectContaining({
      anchorText: 'Augustus Le Plongeon',
      mode: 'attribute',
      targetEntityTypes: ['location'],
    }))
    expect(result.intent.predicates.map(predicate => predicate.name)).toEqual(expect.arrayContaining([
      'LIVES_IN',
      'LIVED_IN',
    ]))
  })

  it('maps support questions without mangling apostrophes inside entity names', async () => {
    const result = await parseGraphExploreIntent({
      query: "Who supported Scottish Women's Hospitals?",
    })

    expect(result.intent).toEqual(expect.objectContaining({
      anchorText: "Scottish Women's Hospitals",
      mode: 'relationship',
    }))
    expect(result.intent.predicates.map(predicate => predicate.name)).toEqual(['SUPPORTED'])
  })

  it('handles short indirect wording with deterministic fallback', async () => {
    const result = await parseGraphExploreIntent({
      query: 'Elsie Inglis job?',
    })

    expect(result.parser).toBe('fallback')
    expect(result.intent.anchorText).toBe('Elsie Inglis')
    expect(result.intent.mode).toBe('attribute')
    expect(result.intent.predicates.map(predicate => predicate.name)).toContain('WORKS_AS')
  })

  it('uses valid structured LLM output directly', async () => {
    const result = await parseGraphExploreIntent({
      query: "Who supported Scottish Women's Hospitals?",
      llm: mockLlm({
        anchorText: "Scottish Women's Hospitals",
        mode: 'relationship',
        predicates: [{ name: 'SUPPORTED', confidence: 0.93 }],
        targetEntityTypes: ['organization', 'person'],
      }),
    })

    expect(result.parser).toBe('llm')
    expect(result.fallbackUsed).toBe(false)
    expect(result.intent).toEqual(expect.objectContaining({
      anchorText: "Scottish Women's Hospitals",
      mode: 'relationship',
      targetEntityTypes: ['organization', 'person'],
    }))
    expect(result.intent.predicates).toEqual([
      { name: 'SUPPORTED', confidence: 0.93 },
    ])
  })
})
