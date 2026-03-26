import type { d8umResult } from '../types/query.js'
import type { AssembleOpts } from '../types/query.js'

export function assemble(results: d8umResult[], opts: AssembleOpts = {}): string {
  const {
    format = 'xml',
    citeSources = true,
  } = opts

  // TODO: implement neighbor joining — stitch adjacent chunks into passages
  // TODO: implement token budget trimming

  const trimmed = results

  if (typeof format === 'function') return format(trimmed)

  switch (format) {
    case 'xml':  return assembleXml(trimmed, { citeSources })
    case 'markdown': return assembleMarkdown(trimmed, { citeSources })
    case 'plain': return assemblePlain(trimmed)
    default: return assembleXml(trimmed, { citeSources })
  }
}

export function assembleXml(results: d8umResult[], _opts: { citeSources: boolean }): string {
  const sources = groupBySourceId(results)
  const parts = Object.entries(sources).map(([sourceId, chunks]) => {
    const first = chunks[0]!
    const attrs = [
      `id="${sourceId}"`,
      first.source.title ? `title="${escapeXml(first.source.title)}"` : '',
      first.source.url ? `url="${escapeXml(first.source.url)}"` : '',
    ].filter(Boolean).join(' ')

    const passages = chunks.map(c =>
      `  <passage score="${c.score.toFixed(4)}">\n    ${escapeXml(c.content)}\n  </passage>`
    ).join('\n')

    return `<source ${attrs}>\n${passages}\n</source>`
  })

  return `<context>\n${parts.join('\n')}\n</context>`
}

export function assembleMarkdown(results: d8umResult[], _opts: { citeSources: boolean }): string {
  return results.map(r => {
    const title = r.source.title
    const url = r.source.url
    const heading = url ? `# (${title})[${url}]` : `# ${title}`
    return `${heading}\n${r.content}`
  }).join('\n\n---\n\n')
}

export function assemblePlain(results: d8umResult[]): string {
  return results.map(r => r.content).join('\n\n')
}

export function groupBySourceId(results: d8umResult[]): Record<string, d8umResult[]> {
  return results.reduce((acc, r) => {
    const key = r.source.id
    ;(acc[key] = acc[key] ?? []).push(r)
    return acc
  }, {} as Record<string, d8umResult[]>)
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
