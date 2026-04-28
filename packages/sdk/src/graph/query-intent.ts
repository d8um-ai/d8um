import { z } from 'zod/v4-mini'
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
  graphSourceEntityTypes: string[]
  graphTargetEntityTypes: string[]
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
const VALID_ANCHOR_SIDES = new Set<AnchorSide>(['source', 'target', 'either'])
const SYMMETRIC_PREDICATES = new Set<string>([
  'ALLIED_WITH',
  'BORDERS',
  'COLLABORATED_WITH',
  'COMPARED_WITH',
  'COMPATIBLE_WITH',
  'COMPETES_WITH',
  'CONNECTED_TO',
  'CORRESPONDS_WITH',
  'EQUIVALENT_TO',
  'MARRIED',
  'MERGED_WITH',
  'NEAR',
  'PARTNERED_WITH',
  'RIVALED',
  'SIBLING_OF',
])
const IRREGULAR_VERB_VARIANTS = new Map<string, string[]>([
  ['wrote', ['write']],
  ['written', ['write']],
  ['authored', ['author']],
  ['born', ['bear']],
  ['led', ['lead']],
])

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
    graphSourceEntityTypes: ['person', 'organization'],
    graphTargetEntityTypes: ['concept'],
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
    graphSourceEntityTypes: ['person'],
    graphTargetEntityTypes: ['organization'],
    anchorSide: 'target',
  },
  {
    key: 'leadership',
    mode: 'relationship',
    predicates: ['LEADS', 'LED', 'FOUNDED', 'CO_FOUNDED'],
    synonyms: [
      'leaders at', 'leaders of', 'leadership', 'leader', 'leaders', 'founder', 'founders',
      'founded', 'found', 'cofounded', 'co-founded', 'cofounder', 'co-founder', 'runs',
      'run by', 'headed by', 'heads',
    ],
    anchorEntityTypes: ['organization'],
    targetEntityTypes: ['person'],
    graphSourceEntityTypes: ['person'],
    graphTargetEntityTypes: ['organization'],
    anchorSide: 'target',
  },
  {
    key: 'advisory',
    mode: 'relationship',
    predicates: ['ADVISES', 'ADVISED'],
    synonyms: ['advisor', 'advisors', 'advised', 'advises', 'advisory'],
    anchorEntityTypes: ['organization', 'person', 'concept'],
    targetEntityTypes: ['person', 'organization', 'concept'],
    graphSourceEntityTypes: ['person', 'organization', 'concept'],
    graphTargetEntityTypes: ['person', 'organization', 'concept'],
    anchorSide: 'either',
  },
  {
    key: 'creation',
    mode: 'relationship',
    predicates: ['CREATED', 'WROTE', 'AUTHORED', 'DESIGNED', 'INVENTED', 'DEVELOPED'],
    synonyms: [
      'created', 'creator', 'creators', 'built', 'wrote', 'written by', 'authored', 'author',
      'write', 'designed', 'invented', 'developed',
    ],
    anchorEntityTypes: ['organization', 'person', 'concept'],
    targetEntityTypes: ['person', 'organization', 'concept', 'work_of_art', 'product', 'technology'],
    graphSourceEntityTypes: ['person', 'organization', 'concept'],
    graphTargetEntityTypes: ['organization', 'concept', 'work_of_art', 'product', 'technology'],
    anchorSide: 'either',
  },
  {
    key: 'ownership',
    mode: 'relationship',
    predicates: ['OWNS', 'OWNED_BY'],
    synonyms: ['owner', 'owners', 'owned by', 'owns', 'owning'],
    anchorEntityTypes: ['organization', 'person', 'product', 'concept'],
    targetEntityTypes: ['person', 'organization', 'product', 'concept'],
    graphSourceEntityTypes: ['person', 'organization', 'product', 'concept'],
    graphTargetEntityTypes: ['person', 'organization', 'product', 'concept'],
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
    graphSourceEntityTypes: ['organization', 'person'],
    graphTargetEntityTypes: ['location'],
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
    graphSourceEntityTypes: ['organization', 'person'],
    graphTargetEntityTypes: ['organization', 'person'],
    anchorSide: 'either',
  },
  {
    key: 'support',
    mode: 'relationship',
    predicates: ['SUPPORTED'],
    synonyms: ['supported', 'support', 'supports', 'backed', 'endorsed', 'helped'],
    anchorEntityTypes: ['organization', 'person', 'concept'],
    targetEntityTypes: ['organization', 'person', 'concept'],
    graphSourceEntityTypes: ['organization', 'person', 'concept'],
    graphTargetEntityTypes: ['organization', 'person', 'concept'],
    anchorSide: 'either',
  },
  {
    key: 'proposal',
    mode: 'relationship',
    predicates: ['PROPOSED', 'ADVOCATED_FOR', 'CHAMPIONED'],
    synonyms: ['proposed', 'proposal', 'proposals', 'advocated for', 'championed', 'recommended'],
    anchorEntityTypes: ['person', 'organization', 'concept'],
    targetEntityTypes: ['concept', 'organization', 'event'],
    graphSourceEntityTypes: ['person', 'organization', 'concept'],
    graphTargetEntityTypes: ['concept', 'organization', 'event'],
    anchorSide: 'source',
  },
]

const predicateSchema = z.object({
  name: z.string(),
  confidence: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
})

const intentSchema = z.object({
  anchorText: z.optional(z.string()),
  anchorSide: z.optional(z.enum(['source', 'target', 'either'])),
  mode: z.optional(z.enum(['attribute', 'relationship'])),
  predicates: z._default(z.array(predicateSchema), []),
  targetEntityTypes: z._default(z.array(z.string()).check(z.maxLength(8)), []),
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

function normalizeForDirection(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/[Ææ]/g, 'ae')
      .replace(/[Œœ]/g, 'oe')
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/['’]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' '),
  )
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

function resolveAnchorEntityTypes(definitions: PredicateQueryDefinition[], anchorSide: AnchorSide): string[] {
  if (definitions.length === 0) return []
  if (anchorSide === 'source') {
    return unique(definitions.flatMap(definition => definition.graphSourceEntityTypes))
  }
  if (anchorSide === 'target') {
    return unique(definitions.flatMap(definition => definition.graphTargetEntityTypes))
  }

  return unique(definitions.flatMap(definition => definition.anchorEntityTypes))
}

function resolveResultEntityTypes(definitions: PredicateQueryDefinition[], anchorSide: AnchorSide): string[] {
  if (definitions.length === 0) return []
  if (anchorSide === 'source') {
    return unique(definitions.flatMap(definition => definition.graphTargetEntityTypes))
  }
  if (anchorSide === 'target') {
    return unique(definitions.flatMap(definition => definition.graphSourceEntityTypes))
  }

  return unique(definitions.flatMap(definition => definition.targetEntityTypes))
}

function sanitizeAnchorSide(value: unknown): AnchorSide | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeWhitespace(value).toLowerCase()
  return VALID_ANCHOR_SIDES.has(normalized as AnchorSide) ? normalized as AnchorSide : undefined
}

function verbHeadVariants(word: string): string[] {
  const variants = [word, ...(IRREGULAR_VERB_VARIANTS.get(word) ?? [])]

  if (word.endsWith('ies') && word.length > 3) variants.push(`${word.slice(0, -3)}y`)
  if (word.endsWith('ied') && word.length > 3) variants.push(`${word.slice(0, -3)}y`)
  if (word.endsWith('ed') && word.length > 3) {
    variants.push(word.slice(0, -2))
    variants.push(word.slice(0, -1))
  }
  if (word.endsWith('s') && word.length > 3) variants.push(word.slice(0, -1))

  return unique(variants.filter(variant => variant.length > 1))
}

function phraseVariants(phrase: string): string[] {
  const words = normalizeForDirection(phrase).split(' ').filter(Boolean)
  if (words.length === 0) return []

  const [head, ...rest] = words
  return verbHeadVariants(head!)
    .map(variant => [variant, ...rest].join(' '))
    .filter(Boolean)
}

function predicatePhraseCandidates(predicates: string[], definitions: PredicateQueryDefinition[]): string[] {
  const phrases = [
    ...definitions.flatMap(definition => definition.synonyms),
    ...predicates.map(predicate => predicate.toLowerCase().replace(/_/g, ' ')),
  ]

  return unique(phrases.flatMap(phrase => phraseVariants(phrase)))
    .sort((a, b) => b.length - a.length)
}

function allPredicatesAreSymmetric(predicates: string[]): boolean {
  return predicates.length > 0 && predicates.every(predicate => SYMMETRIC_PREDICATES.has(predicate))
}

function inferAnchorSideFromSyntax(input: {
  query: string
  anchorText: string
  mode: GraphExploreMode
  predicates: string[]
  definitions: PredicateQueryDefinition[]
}): AnchorSide | undefined {
  if (input.mode !== 'relationship') return undefined
  if (allPredicatesAreSymmetric(input.predicates)) return 'either'

  const query = normalizeForDirection(input.query)
  const anchor = normalizeForDirection(input.anchorText)
  if (!query || !anchor) return undefined

  const anchorIndex = query.indexOf(anchor)
  if (anchorIndex < 0) return undefined

  const anchorEnd = anchorIndex + anchor.length
  const beforeAnchor = query.slice(0, anchorIndex).trim()
  const afterAnchor = query.slice(anchorEnd).trim()
  const phrases = predicatePhraseCandidates(input.predicates, input.definitions)
  if (phrases.length === 0) return undefined

  const hasAuxiliaryBeforeAnchor = /\b(?:did|does|do|can|could|should|would|will|has|have|had)\s*$/.test(beforeAnchor)

  for (const phrase of phrases) {
    const phrasePattern = escapeRegExp(phrase)
    const anchorPattern = escapeRegExp(anchor)

    if (new RegExp(`\\b${anchorPattern}\\b\\s+(?:was|were|is|are|be|been|being)\\s+\\b${phrasePattern}\\b\\s+by\\b`).test(query)) {
      return 'target'
    }

    if (new RegExp(`\\b${phrasePattern}\\b\\s+by\\s+\\b${anchorPattern}\\b`).test(query)) {
      return 'source'
    }

    if (hasAuxiliaryBeforeAnchor && new RegExp(`\\b${anchorPattern}\\b\\s+\\b${phrasePattern}\\b`).test(query)) {
      return 'source'
    }

    if (new RegExp(`\\b${phrasePattern}\\b\\s+\\b${anchorPattern}\\b`).test(query)) return 'target'

    if (hasAuxiliaryBeforeAnchor && new RegExp(`^\\b${phrasePattern}\\b`).test(afterAnchor)) {
      return 'source'
    }

    if (hasAuxiliaryBeforeAnchor && new RegExp(`\\b${phrasePattern}\\b`).test(afterAnchor)) return 'source'
    if (new RegExp(`\\b${phrasePattern}\\b`).test(beforeAnchor)) return 'target'
  }

  return undefined
}

function resolveAnchorSide(input: {
  query: string
  anchorText: string
  mode: GraphExploreMode
  predicates: GraphExploreIntentPredicate[]
  definitions: PredicateQueryDefinition[]
  defaultAnchorSide: AnchorSide
  parsedAnchorSide?: AnchorSide | undefined
}): AnchorSide {
  const predicateNames = input.predicates.map(predicate => predicate.name)
  const inferred = inferAnchorSideFromSyntax({
    query: input.query,
    anchorText: input.anchorText,
    mode: input.mode,
    predicates: predicateNames,
    definitions: input.definitions,
  })
  if (inferred) return inferred
  if (input.parsedAnchorSide) return input.parsedAnchorSide
  return input.defaultAnchorSide
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
  const definitionAnchorSide = combineAnchorSide(definitions.map(definition => definition.anchorSide))

  return {
    anchorEntityTypes: resolveAnchorEntityTypes(definitions, definitionAnchorSide),
    anchorSide: mode === 'attribute'
      ? (definitionAnchorSide === 'either' ? 'source' : definitionAnchorSide)
      : definitionAnchorSide,
    mode,
    targetEntityTypes: sanitizeTargetEntityTypes(
      (targetEntityTypeHint && targetEntityTypeHint.length > 0)
        ? targetEntityTypeHint
        : resolveResultEntityTypes(definitions, definitionAnchorSide),
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
  const definitions = resolveDefinitionsForPredicates(predicateNames, query)
  const anchorSide = resolveAnchorSide({
    query,
    anchorText,
    mode: metadata.mode,
    predicates,
    definitions,
    defaultAnchorSide: metadata.anchorSide,
  })
  const targetEntityTypes = resolveResultEntityTypes(definitions, anchorSide)

  return {
    parser: 'fallback',
    fallbackUsed: true,
    anchorEntityTypes: resolveAnchorEntityTypes(definitions, anchorSide),
    anchorSide,
    intent: buildIntent(query, metadata.mode, predicates, anchorText || query, targetEntityTypes.length > 0 ? targetEntityTypes : metadata.targetEntityTypes),
  }
}

async function parseWithLlm(query: string, llm: LLMProvider): Promise<ParsedGraphExploreIntent | null> {
  const prompt = [
    'Parse this graph exploration query into anchor text, anchor edge side, query mode, concrete graph predicates, and target entity types.',
    '',
    `Query: ${query}`,
    '',
    'Return JSON only with this shape:',
    '{ "anchorText": string, "anchorSide": "source" | "target" | "either", "mode": "attribute" | "relationship", "predicates": [{ "name": string, "confidence": number }], "targetEntityTypes": string[] }',
    '',
    'Best-effort mapping rules:',
    '- Map indirect wording to the closest supported predicates.',
    '- Prefer the nearest supported predicate over returning an empty predicate list.',
    '- Use mode="attribute" for self-attribute questions about a named entity, such as profession or location.',
    '- Set anchorSide to the side of each matched graph edge where anchorText belongs: source means anchor -> predicate -> answer; target means answer -> predicate -> anchor; either means symmetric or unclear.',
    '- For directed predicates, grammar controls anchorSide: "Who founded X?" means anchorSide="target"; "What did X found?" means anchorSide="source".',
    '- Use anchorSide="either" for symmetric relationship wording like "worked with", "collaborated with", "partnered with", "allied with", or "corresponded with".',
    '- Use only these real entity types: person, organization, location, product, concept, event, work_of_art, technology, law_regulation, time_period.',
    '- Keep anchorText concise and literal.',
    '',
    'Concrete examples:',
    '- "What is Elsie Inglis\' profession?" -> anchorText="Elsie Inglis", anchorSide="source", mode="attribute", predicates=["WORKS_AS","WORKED_AS","HELD_ROLE","PRACTICED_AS"], targetEntityTypes=["concept"]',
    '- "Where did Augustus Le Plongeon live?" -> anchorText="Augustus Le Plongeon", anchorSide="source", mode="attribute", predicates=["LIVES_IN","LIVED_IN"], targetEntityTypes=["location"]',
    '- "Who worked with Elsie Inglis?" -> anchorText="Elsie Inglis", anchorSide="either", mode="relationship", predicates=["COLLABORATED_WITH","PARTNERED_WITH","ALLIED_WITH","CORRESPONDS_WITH"], targetEntityTypes=["person","organization"]',
    '- "Who supported the Scottish Women\'s Hospitals?" -> anchorText="Scottish Women\'s Hospitals", anchorSide="target", mode="relationship", predicates=["SUPPORTED"], targetEntityTypes=["person","organization","concept"]',
    '- "Who founded Maternity Hospice?" -> anchorText="Maternity Hospice", anchorSide="target", mode="relationship", predicates=["FOUNDED","CO_FOUNDED"], targetEntityTypes=["person"]',
    '- "What did Elsie Inglis found?" -> anchorText="Elsie Inglis", anchorSide="source", mode="relationship", predicates=["FOUNDED","CO_FOUNDED"], targetEntityTypes=["organization"]',
    '',
    'Common query bundles and hints:',
    ...QUERY_PREDICATE_DEFINITIONS.map(definition =>
      `- ${definition.key}: mode=${definition.mode}; defaultAnchorSide=${definition.anchorSide}; predicates=${definition.predicates.join(', ')}; graphSourceEntityTypes=${definition.graphSourceEntityTypes.join(', ')}; graphTargetEntityTypes=${definition.graphTargetEntityTypes.join(', ')}; defaultAnchorEntityTypes=${definition.anchorEntityTypes.join(', ')}; defaultResultEntityTypes=${definition.targetEntityTypes.join(', ')}; synonyms=${definition.synonyms.join(', ')}`,
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
  const definitions = resolveDefinitionsForPredicates(predicates.map(predicate => predicate.name), query)
  const anchorSide = resolveAnchorSide({
    query,
    anchorText,
    mode: metadata.mode,
    predicates,
    definitions,
    defaultAnchorSide: metadata.anchorSide,
    parsedAnchorSide: sanitizeAnchorSide(parsed.anchorSide),
  })
  const parsedTargetTypes = sanitizeTargetEntityTypes(parsed.targetEntityTypes)
  const targetEntityTypes = parsedTargetTypes.length > 0
    ? parsedTargetTypes
    : resolveResultEntityTypes(definitions, anchorSide)

  return {
    parser: 'llm',
    fallbackUsed: false,
    anchorEntityTypes: resolveAnchorEntityTypes(definitions, anchorSide),
    anchorSide,
    intent: buildIntent(query, metadata.mode, predicates, anchorText || query, targetEntityTypes.length > 0 ? targetEntityTypes : metadata.targetEntityTypes),
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
