import type { JobTypeDefinition, JobRunContext, JobRunResult } from '../../types/job.js'
import type { RawDocument } from '../../types/connector.js'
import { fetchPage } from './url-scrape.js'
import type { UrlMeta } from './url-scrape.js'

// ── Domain Crawl Job ──

export const domainCrawlJob: JobTypeDefinition = {
  type: 'domain_crawl',
  label: 'Domain Crawl',
  description: 'Crawl and index pages from a domain',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  configSchema: [
    { key: 'domain', label: 'Domain', type: 'url', required: true },
    { key: 'max_pages', label: 'Max Pages', type: 'number', required: false, placeholder: '100' },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    const startUrl = ctx.job.config['domain'] as string
    if (!startUrl) throw new Error('domain_crawl: missing "domain" in job config')

    const maxPages = (ctx.job.config['max_pages'] as number | undefined) ?? 500
    const maxDepth = (ctx.job.config['max_depth'] as number | undefined) ?? 20
    const crawlDelay = (ctx.job.config['crawl_delay'] as number | undefined) ?? 200
    const userAgent = ctx.job.config['user_agent'] as string | undefined
    const allowPatterns = ctx.job.config['allow_patterns'] as string[] | undefined
    const denyPatterns = ctx.job.config['deny_patterns'] as string[] | undefined
    const allowedDomains = ctx.job.config['allowed_domains'] as string[] | undefined

    const crawler = new Crawler({
      startUrl,
      maxPages,
      maxDepth,
      crawlDelay,
      userAgent,
      allowPatterns,
      denyPatterns,
      allowedDomains,
    })

    let created = 0
    for await (const doc of crawler.crawl()) {
      ctx.emit?.(doc)
      created++
    }

    return {
      jobId: ctx.job.id,
      bucketId: ctx.job.bucketId,
      status: 'completed',
      documentsCreated: created,
      documentsUpdated: 0,
      documentsDeleted: 0,
      durationMs: 0,
    }
  },
}

// ── Crawler Config ──

export interface CrawlerConfig {
  startUrl: string
  allowedDomains?: string[] | undefined
  allowPatterns?: string[] | undefined
  denyPatterns?: string[] | undefined
  maxDepth?: number | undefined
  maxPages?: number | undefined
  crawlDelay?: number | undefined
  stripElements?: string[] | undefined
  stripSelectors?: string[] | undefined
  userAgent?: string | undefined
}

// ── BFS Crawler ──

interface QueueEntry {
  url: string
  depth: number
}

export class Crawler {
  private queue: QueueEntry[] = []
  private visited = new Set<string>()
  private pageCount = 0

  constructor(private config: CrawlerConfig) {}

  async *crawl(): AsyncGenerator<RawDocument<UrlMeta>> {
    const maxDepth = this.config.maxDepth ?? 20
    const maxPages = this.config.maxPages ?? 500
    const crawlDelay = this.config.crawlDelay ?? 200

    this.enqueue(this.config.startUrl, 0)

    while (this.queue.length > 0 && this.pageCount < maxPages) {
      const entry = this.queue.shift()!
      const normalized = normalizeUrl(entry.url)

      if (this.visited.has(normalized)) continue
      this.visited.add(normalized)
      if (entry.depth > maxDepth) continue
      if (!this.isAllowedDomain(entry.url)) continue
      if (!this.isAllowedPath(entry.url)) continue

      let doc: RawDocument<UrlMeta> | null = null
      try {
        doc = await fetchPage(entry.url, {
          userAgent: this.config.userAgent,
          stripElements: this.config.stripElements,
          stripSelectors: this.config.stripSelectors,
        })
      } catch (err) {
        console.warn(`[d8um/domain-crawl] Failed to fetch ${entry.url}:`, (err as Error).message)
        continue
      }

      if (!doc) continue

      this.pageCount++
      yield doc

      const links = doc.metadata.links ?? []
      for (const link of links) {
        this.enqueue(link, entry.depth + 1)
      }

      if (crawlDelay > 0 && this.queue.length > 0) {
        await sleep(crawlDelay)
      }
    }
  }

  private enqueue(url: string, depth: number): void {
    const normalized = normalizeUrl(url)
    if (this.visited.has(normalized)) return
    this.queue.push({ url, depth })
  }

  private isAllowedDomain(url: string): boolean {
    if (isSameDomain(url, this.config.startUrl)) return true
    if (isSubdomain(url, this.config.startUrl)) return true
    if (this.config.allowedDomains) {
      const parsed = parseUrl(url)
      if (parsed) {
        for (const domain of this.config.allowedDomains) {
          const allowedParsed = parseUrl(domain)
          if (allowedParsed && parsed.hostname === allowedParsed.hostname) return true
          if (allowedParsed && parsed.hostname.endsWith('.' + allowedParsed.hostname)) return true
        }
      }
    }
    return false
  }

  private isAllowedPath(url: string): boolean {
    const parsed = parseUrl(url)
    if (!parsed) return false
    if (this.config.denyPatterns && this.config.denyPatterns.length > 0) {
      if (matchesPattern(parsed.path, this.config.denyPatterns)) return false
    }
    if (this.config.allowPatterns && this.config.allowPatterns.length > 0) {
      return matchesPattern(parsed.path, this.config.allowPatterns)
    }
    return true
  }
}

// ── URL Utilities ──

interface ParsedUrl {
  hostname: string
  path: string
  origin: string
}

export function parseUrl(url: string): ParsedUrl | null {
  try {
    const withProtocol = url.match(/^https?:\/\//) ? url : 'https://' + url
    const u = new URL(withProtocol)
    return {
      hostname: u.hostname.replace(/^www\./, ''),
      path: normalizePath(u.pathname),
      origin: u.origin,
    }
  } catch { return null }
}

export function normalizeUrl(url: string): string {
  const parsed = parseUrl(url)
  if (!parsed) return url
  return parsed.hostname + parsed.path
}

export function normalizePath(path: string): string {
  if (!path) return '/'
  path = path.split('?')[0]!.split('#')[0]!
  if (!path.startsWith('/')) path = '/' + path
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

export function isSameDomain(url: string, startUrl: string): boolean {
  const a = parseUrl(url)
  const b = parseUrl(startUrl)
  if (!a || !b) return false
  return a.hostname === b.hostname
}

export function isSubdomain(url: string, startUrl: string): boolean {
  const a = parseUrl(url)
  const b = parseUrl(startUrl)
  if (!a || !b) return false
  return a.hostname !== b.hostname && a.hostname.endsWith('.' + b.hostname)
}

export function matchesPattern(path: string, patterns: string[]): boolean {
  const normalized = normalizePath(path)
  for (const pattern of patterns) {
    if (matchSingle(normalized, pattern)) return true
  }
  return false
}

function matchSingle(path: string, pattern: string): boolean {
  if (!pattern.includes('*')) return path === normalizePath(pattern)
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    const normalizedPrefix = normalizePath(prefix === '' ? '/' : prefix)
    return path === normalizedPrefix || path.startsWith(normalizedPrefix + '/')
  }
  const segments = pattern.split('*')
  let remaining = path
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? ''
    if (seg === '') continue
    const idx = remaining.indexOf(seg)
    if (idx === -1) return false
    if (i === 0 && idx !== 0) return false
    remaining = remaining.slice(idx + seg.length)
  }
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
