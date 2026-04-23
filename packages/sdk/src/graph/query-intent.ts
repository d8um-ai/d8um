import { z } from 'zod'
import type { LLMProvider } from '../types/llm-provider.js'
import type { GraphExploreIntent, GraphExploreIntentPredicate } from '../types/graph-bridge.js'
import { ALL_PREDICATES, getPredicatesForPrompt } from '../index-engine/ontology.js'

type GraphExploreMode = GraphExploreIntent['mode']
type AnchorSide = 'source' | 'target' | 'either'

interface PredicateQueryDefinition {
  key: string
  mode: GraphExploreMode
  predicates: string[]
  synonyms: string[]
  anchorEntityTypes: string[]
  targetEntityTypes: string[]
  anchorSide: AnchorSide
}

export interface ParsedGraphExploreIntent {
  parser: 'llm' | 'fallback'
  fallbackUsed: boolean
  anchorEntityTypes: string[]
  anchorSide: AnchorSide
  intent: GraphExploreIntent
}

const ENTITY_TYPES = [
  'person', 'organization', 'location', 'product', 'concept', 'event',
  'work_of_art', 'technology', 'law_regulation', 'time_period',
] as const

const VALID_ENTITY_TYPES = new Set<string>(ENTITY_TYPES)
const VALID_PREDICATES = new Set<string>([...ALL_PREDICATES])

const QUERY_PREDICATE_DEFINITIONS: PredicateQueryDefinition[] = [
  {
    key: 'profession',
    mode: 'attribute',
    predicates: ['WORKS_AS', 'WORKED_AS', 'HELD_ROLE', 'PRACTICED_AS'],
    synonyms: [
      'profession', 'occupation', 'job', 'career', 'role', 'title', 'position',
      'worked as', 'works as', 'served as', 'serves as', 'practiced as', 'practises as',
      'by profession',
    ],
    anchorEntityTypes: ['person', 'organization'],
    targetEntityTypes: ['concept'],
    anchorSide: 'source',
  },
  {
    key: 'employment',
    mode: 'relationship',
    predicates: ['WORKS_FOR', 'WORKED_FOR', 'MEMBER_OF'],
    synonyms: [
      'employees at', 'employees of', 'employee at', 'employee of', 'employees', 'employee',
      'works at', 'works for', 'worked at', 'worked for', 'employed by',
      'staff at', 'staff of', 'team at', 'team members',
    ],
    anchorEntityTypes: ['organization'],
    targetEntityTypes: ['person'],
    anchorSide: 'target',
  },
  {
    key: 'leadership',
    mode: 'relationship',
    predicates: ['LEADS', 'LED', 'FOUNDED', 'CO_FOUNDED'],
    synonyms: [
      'leaders at', 'leaders of', 'leadership', 'leader', 'leaders', 'founder', 'founders',
      'cofounder', 'co-founder', 'runs', 'run by', 'headed by', 'heads',
    ],
    anchorEntityTypes: ['organization'],
    targetEntityTypes: ['person'],
    anchorSide: 'target',
  },
  {
    key: 'advisory',
    mode: 'relationship',
    predicates: ['ADVISES', 'ADVISED'],
    synonyms: ['advisor', 'advisors', 'advised', 'advises', 'advisory'],
    anchorEntityTypes: ['organization', 'person', 'concept'],
    targetEntityTypes: ['person', 'organization', 'concept'],
    anchorSide: 'either',
  },
  {
    key: 'creation',
    mode: 'relationship',
    predicates: ['CREATED', 'WROTE', 'AUTHORED', 'DESIGNED', 'INVENTED', 'DEVELOPED'],
    synonyms: [
      'created', 'creator', 'creators', 'built', 'wrote', 'written by', 'authored', 'author',
      'designed', 'invented', 'developed',
    ],
    anchorEntityTypes: ['organization', 'person', 'concept'],
    targetEntityTypes: ['person', 'organization', 'concept', 'work_of_art', 'product', 'technology'],
    anchorSide: 'either',
  },
  {
    key: 'ownership',
    mode: 'relationship',
    predicates: ['OWNS', 'OWNED_BY'],
    synonyms: ['owner', 'owners', 'owned by', 'owns', 'owning'],
    anchorEntityTypes: ['organization', 'person', 'product', 'concept'],
    targetEntityTypes: ['person', 'organization', 'product', 'concept'],
    anchorSide: 'either',
  },
  {
    key: 'location',
    mode: 'attribute',
    predicates: ['HEADQUARTERED_IN', 'LOCATED_IN', 'OPERATES_IN', 'BORN_IN', 'LIVES_IN', 'LIVED_IN'],
    synonyms: [
      'located in', 'based in', 'headquartered in', 'operates in', 'born in',
      'lives in', 'lived in', 'where is', 'where was', 'where are', 'where were',
      'where did', 'where does', 'where do', 'live', 'lived',
    ],
    anchorEntityTypes: ['organization', 'person'],
    targetEntityTypes: ['location'],
    anchorSide: 'source',
  },
  {
    key: 'collaboration',
    mode: 'relationship',
    predicates: ['COLLABORATED_WITH', 'PARTNERED_WITH', 'ALLIED_WITH', 'CORRESPONDS_WITH'],
    synonyms: [
      'collaborated with', 'collaborators', 'collaboration', 'partnered with',
      'partners', 'worked with', 'allied with', 'corresponded with',
    ],
    anchorEntityTypes: ['organization', 'person'],
    targetEntityTypes: ['organization', 'person'],
    anchorSide: 'either',
  },
  {
    key: 'support',
    mode: 'relationship',
    predicates: ['SUPPORTED'],
    synonyms: ['supported', 'support', 'supports', 'backed', 'endorsed', 'helped'],
    anchorEntityTypes: ['organization', 'person', 'concept'],
    targetEntityTypes: ['organization', 'person', 'concept'],
    anchorSide: 'either',
  },
  {
    key: 'proposal',
    mode: 'relationship',
    predicates: ['PROPOSED', 'ADVOCATED_FOR', 'CHAMPIONED'],
    synonyms: ['proposed', 'proposal', 'proposals', 'advocated for', 'championed', 'recommended'],
    anchorEntityTypes: ['person', 'organization', 'concept'],
    targetEntityTypes: ['concept', 'organization', 'event'],
    anchorSide: 'source',
  },
]

const intentSchema = z.object({
  anchorText: z.string().optional(),
  mode: z.enum(['attribute', 'relationship']).optional(),
  predicates: z.array(z.object({
    name: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  })).default([]),
  targetEntityTypes: z.array(z.string()).max(8).default([]),
})

const FILLER_WORDS = new Set([
  'a', 'an', 'all', 'and', 'are', 'at', 'did', 'do', 'does', 'find', 'for', 'from',
  'in', 'is', 'list', 'me', 'of', 'on', 'show', 'tell', 'the', 'their', 'these',
  'those', 'was', 'were', 'what', 'where', 'who', 'with',
])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function sanitizeTargetEntityTypes(entityTypes: string[]): string[] {
  return unique(entityTypes
    .map(type => normalizeWhitespace(type).toLowerCase())
    .filter(type => VALID_ENTITY_TYPES.has(type)))
}

function normalizeAnchorText(value: string): string {
  const normalized = normalizeWhitespace(
    value
      .replace(/[?]/g, ' ')
      .split(/\s+/)
      .map(token => token.replace(/^[("'“”]+|[),.:;!?]+$/g, ''))
      .filter(token => token.length > 0)
      .filter(token => !FILLER_WORDS.has(token.toLowerCase()))
      .join(' '),
  )

  return normalized.replace(/(?:['’]s|['’])$/u, '').trim()
}

function stripPredicatePhrases(query: string, definitions: PredicateQueryDefinition[]): string {
  let text = query
  const phrases = unique(definitions.flatMap(definition => definition.synonyms))
    .sort((a, b) => b.length - a.length)

  for (const phrase of phrases) {
    const pattern = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'gi')
    text = text.replace(pattern, ' ')
  }

  return normalizeAnchorText(text)
}

function combineAnchorSide(sides: AnchorSide[]): AnchorSide {
  const uniqueSides = unique(sides)
  if (uniqueSides.length === 0) return 'either'
  if (uniqueSides.length === 1) return uniqueSides[0]!
  return 'either'
}

function resolveDefinitionsForPredicates(predicates: string[], query: string): PredicateQueryDefinition[] {
  const definitions = QUERY_PREDICATE_DEFINITIONS
    .filter(definition => definition.predicates.some(predicate => predicates.includes(predicate)))
  if (definitions.length > 0) return definitions
  return matchDefinitions(query)
}

function inferMode(query: string, definitions: PredicateQueryDefinition[]): GraphExploreMode {
  const lowered = query.toLowerCase()
  if (definitions.some(definition => definition.mode === 'attribute')) {
    if (
      /(?:\bwhat\b|\bwhere\b)/i.test(lowered)
      || /['’]s\b/.test(query)
      || lowered.includes('profession')
      || lowered.includes('occupation')
      || lowered.includes('career')
      || lowered.includes('role')
      || lowered.includes('title')
      || lowered.includes('position')
    ) {
      return 'attribute'
    }
  }

  return definitions[0]?.mode ?? 'relationship'
}

function buildIntent(
  rawQuery: string,
  mode: GraphExploreMode,
  predicates: GraphExploreIntentPredicate[],
  anchorText: string,
  targetEntityTypes: string[],
): GraphExploreIntent {
  return {
    rawQuery,
    anchorText: anchorText.trim(),
    mode,
    predicates,
    targetEntityTypes: sanitizeTargetEntityTypes(targetEntityTypes),
  }
}

function deriveIntentMetadata(
  query: string,
  predicates: GraphExploreIntentPredicate[],
  modeHint?: GraphExploreMode | undefined,
  targetEntityTypeHint?: string[] | undefined,
): {
  anchorEntityTypes: string[]
  anchorSide: AnchorSide
  mode: GraphExploreMode
  targetEntityTypes: string[]
} {
  const predicateNames = predicates.map(predicate => predicate.name)
  const definitions = resolveDefinitionsForPredicates(predicateNames, query)
  const mode = modeHint ?? inferMode(query, definitions)

  return {
    anchorEntityTypes: unique(definitions.flatMap(definition => definition.anchorEntityTypes)),
    anchorSide: mode === 'attribute'
      ? (combineAnchorSide(definitions.map(definition => definition.anchorSide)) === 'either' ? 'source' : combineAnchorSide(definitions.map(definition => definition.anchorSide)))
      : combineAnchorSide(definitions.map(definition => definition.anchorSide)),
    mode,
    targetEntityTypes: sanitizeTargetEntityTypes(
      (targetEntityTypeHint && targetEntityTypeHint.length > 0)
        ? targetEntityTypeHint
        : definitions.flatMap(definition => definition.targetEntityTypes),
    ),
  }
}

function matchDefinitions(query: string): Array<PredicateQueryDefinition & { score: number }> {
  const lowered = normalizeWhitespace(query).toLowerCase()
  const matches: Array<PredicateQueryDefinition & { score: number }> = []

  for (const definition of QUERY_PREDICATE_DEFINITIONS) {
    let bestScore = 0
    for (const synonym of definition.synonyms) {
      const pattern = new RegExp(`\\b${escapeRegExp(synonym.toLowerCase())}\\b`, 'i')
      if (!pattern.test(lowered)) continue
      bestScore = Math.max(bestScore, synonym.length)
    }
    if (bestScore > 0) matches.push({ ...definition, score: bestScore })
  }

  return matches.sort((a, b) => b.score - a.score)
}

function buildFallbackIntent(query: string): ParsedGraphExploreIntent {
  const matches = matchDefinitions(query)
  if (matches.length === 0) {
    return {
      parser: 'fallback',
      fallbackUsed: true,
      anchorEntityTypes: [],
      anchorSide: 'either',
      intent: buildIntent(query, 'relationship', [], normalizeAnchorText(query), []),
    }
  }

  const topScore = matches[0]!.score
  const selected = matches.filter(match => match.score >= Math.max(3, topScore * 0.7))
  const predicateNames = unique(selected.flatMap(match => match.predicates))
  const predicates = predicateNames.map((name): GraphExploreIntentPredicate => ({
    name,
    confidence: Math.min(0.98, 0.65 + (selected.find(match => match.predicates.includes(name))!.score / Math.max(query.length, 1)) * 0.5),
  }))
  const metadata = deriveIntentMetadata(query, predicates)
  const anchorText = stripPredicatePhrases(query, selected) || normalizeAnchorText(query)

  return {
    parser: 'fallback',
    fallbackUsed: true,
    anchorEntityTypes: metadata.anchorEntityTypes,
    anchorSide: metadata.anchorSide,
    intent: buildIntent(query, metadata.mode, predicates, anchorText || query, metadata.targetEntityTypes),
  }
}

async function parseWithLlm(query: string, llm: LLMProvider): Promise<ParsedGraphExploreIntent | null> {
  const prompt = [
    'Parse this graph exploration query into anchor text, query mode, concrete graph predicates, and target entity types.',
    '',
    `Query: ${query}`,
    '',
    'Return JSON only with this shape:',
    '{ "anchorText": string, "mode": "attribute" | "relationship", "predicates": [{ "name": string, "confidence": number }], "targetEntityTypes": string[] }',
    '',
    'Best-effort mapping rules:',
    '- Map indirect wording to the closest supported predicates.',
    '- Prefer the nearest supported predicate over returning an empty predicate list.',
    '- Use mode="attribute" for self-attribute questions about a named entity, such as profession or location.',
    '- Use only these real entity types: person, organization, location, product, concept, event, work_of_art, technology, law_regulation, time_period.',
    '- Keep anchorText concise and literal.',
    '',
    'Concrete examples:',
    '- "What is Elsie Inglis\' profession?" -> anchorText="Elsie Inglis", mode="attribute", predicates=["WORKS_AS","WORKED_AS","HELD_ROLE","PRACTICED_AS"], targetEntityTypes=["concept"]',
    '- "Where did Augustus Le Plongeon live?" -> anchorText="Augustus Le Plongeon", mode="attribute", predicates=["LIVES_IN","LIVED_IN"], targetEntityTypes=["location"]',
    '- "Who worked with Elsie Inglis?" -> anchorText="Elsie Inglis", mode="relationship", predicates=["COLLABORATED_WITH","PARTNERED_WITH","ALLIED_WITH","CORRESPONDS_WITH"], targetEntityTypes=["person","organization"]',
    '- "Who supported the Scottish Women\'s Hospitals?" -> anchorText="Scottish Women\'s Hospitals", mode="relationship", predicates=["SUPPORTED"], targetEntityTypes=["person","organization","concept"]',
    '',
    'Common query bundles and hints:',
    ...QUERY_PREDICATE_DEFINITIONS.map(definition =>
      `- ${definition.key}: mode=${definition.mode}; predicates=${definition.predicates.join(', ')}; anchorEntityTypes=${definition.anchorEntityTypes.join(', ')}; targetEntityTypes=${definition.targetEntityTypes.join(', ')}; synonyms=${definition.synonyms.join(', ')}`,
    ),
    '',
    getPredicatesForPrompt(),
  ].join('\n')

  const raw = await llm.generateJSON<z.infer<typeof intentSchema>>(prompt, undefined, {
    schema: intentSchema,
    maxOutputTokens: 768,
  })
  const parsed = intentSchema.parse(raw)
  const predicates = unique(parsed.predicates
    .map(predicate => normalizeWhitespace(predicate.name).toUpperCase())
    .filter(predicate => VALID_PREDICATES.has(predicate)))
    .map((name): GraphExploreIntentPredicate => ({
      name,
      confidence: parsed.predicates.find(predicate => normalizeWhitespace(predicate.name).toUpperCase() === name)?.confidence ?? 0.8,
    }))

  if (predicates.length === 0) return null

  const metadata = deriveIntentMetadata(query, predicates, parsed.mode, parsed.targetEntityTypes)
  const anchorText = normalizeAnchorText(parsed.anchorText ?? '')
    || stripPredicatePhrases(query, resolveDefinitionsForPredicates(predicates.map(predicate => predicate.name), query))
    || normalizeAnchorText(query)

  return {
    parser: 'llm',
    fallbackUsed: false,
    anchorEntityTypes: metadata.anchorEntityTypes,
    anchorSide: metadata.anchorSide,
    intent: buildIntent(query, metadata.mode, predicates, anchorText || query, metadata.targetEntityTypes),
  }
}

export async function parseGraphExploreIntent(input: {
  query: string
  llm?: LLMProvider | undefined
}): Promise<ParsedGraphExploreIntent> {
  if (input.llm) {
    try {
      const llmIntent = await parseWithLlm(input.query, input.llm)
      if (llmIntent) return llmIntent
    } catch {
      // Fall through to deterministic parsing.
    }
  }

  return buildFallbackIntent(input.query)
}
