import type { d8umResult } from '../types/query.js'
import type { AssembleOpts } from '../types/query.js'

export function assemble(results: d8umResult[], opts: AssembleOpts = {}): string {
  const {
    format = 'xml',
    citeBuckets = true,
  } = opts

  // TODO: implement neighbor joining - stitch adjacent chunks into passages
  // TODO: implement token budget trimming

  const trimmed = results

  if (typeof format === 'function') return format(trimmed)

  switch (format) {
    case 'xml':  return assembleXml(trimmed, { citeBuckets })
    case 'markdown': return assembleMarkdown(trimmed, { citeBuckets })
    case 'plain': return assemblePlain(trimmed)
    default: return assembleXml(trimmed, { citeBuckets })
  }
}

export function assembleXml(results: d8umResult[], _opts: { citeBuckets: boolean }): string {
  const sources = groupByBucketId(results)
  const parts = Object.entries(sources).map(([bucketId, chunks]) => {
    const first = chunks[0]!
    const attrs = [
      `id="${bucketId}"`,
      first.bucket.title ? `title="${escapeXml(first.bucket.title)}"` : '',
      first.bucket.url ? `url="${escapeXml(first.bucket.url)}"` : '',
    ].filter(Boolean).join(' ')

    const passages = chunks.map(c =>
      `  <passage score="${c.score.toFixed(4)}">\n    ${escapeXml(c.content)}\n  </passage>`
    ).join('\n')

    return `<source ${attrs}>\n${passages}\n</source>`
  })

  return `<context>\n${parts.join('\n')}\n</context>`
}

export function assembleMarkdown(results: d8umResult[], _opts: { citeBuckets: boolean }): string {
  return results.map(r => {
    const title = r.bucket.title
    const url = r.bucket.url
    const heading = url ? `# (${title})[${url}]` : `# ${title}`
    return `${heading}\n${r.content}`
  }).join('\n\n---\n\n')
}

export function assemblePlain(results: d8umResult[]): string {
  return results.map(r => r.content).join('\n\n')
}

export function groupByBucketId(results: d8umResult[]): Record<string, d8umResult[]> {
  return results.reduce((acc, r) => {
    const key = r.bucket.id
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
