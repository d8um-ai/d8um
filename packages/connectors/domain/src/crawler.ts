import type { RawDocument } from '@d8um/core'
import type { UrlMeta, UrlConnectorConfig } from '@d8um/connector-url'
import { UrlConnector } from '@d8um/connector-url'
import type { DomainConnectorConfig } from './connector.js'
import { parseUrl, normalizeUrl, isSameDomain, isSubdomain, matchesPattern } from './url-utils.js'

interface QueueEntry {
  url: string
  depth: number
}

/**
 * BFS web crawler that yields pages as RawDocuments.
 * Respects domain boundaries, allow/deny patterns, and depth/page limits.
 */
export class Crawler {
  private queue: QueueEntry[] = []
  private visited = new Set<string>()
  private pageCount = 0

  constructor(private config: DomainConnectorConfig) {}

  async *crawl(): AsyncGenerator<RawDocument<UrlMeta>> {
    const maxDepth = this.config.maxDepth ?? 20
    const maxPages = this.config.maxPages ?? 500
    const crawlDelay = this.config.crawlDelay ?? 200

    // Seed the queue
    this.enqueue(this.config.startUrl, 0)

    while (this.queue.length > 0 && this.pageCount < maxPages) {
      const entry = this.queue.shift()!
      const normalized = normalizeUrl(entry.url)

      // Skip if already visited
      if (this.visited.has(normalized)) continue
      this.visited.add(normalized)

      // Skip if beyond max depth
      if (entry.depth > maxDepth) continue

      // Check domain boundary
      if (!this.isAllowedDomain(entry.url)) continue

      // Check allow/deny patterns
      if (!this.isAllowedPath(entry.url)) continue

      // Fetch the page using UrlConnector for a single URL
      const connectorConfig: UrlConnectorConfig = { urls: [entry.url] }
      if (this.config.userAgent) connectorConfig.userAgent = this.config.userAgent
      if (this.config.stripElements) connectorConfig.stripElements = this.config.stripElements
      if (this.config.stripSelectors) connectorConfig.stripSelectors = this.config.stripSelectors
      const connector = new UrlConnector(connectorConfig)

      let doc: RawDocument<UrlMeta> | null = null
      try {
        for await (const d of connector.fetch()) {
          doc = d
          break // Only one URL, so one document
        }
      } catch (err) {
        // Log and continue crawling — don't let one bad page stop the whole crawl
        console.warn(`[d8um/domain] Failed to fetch ${entry.url}:`, (err as Error).message)
        continue
      }

      if (!doc) continue

      this.pageCount++
      yield doc

      // Extract links and enqueue
      const links = doc.metadata.links ?? []
      for (const link of links) {
        this.enqueue(link, entry.depth + 1)
      }

      // Respect crawl delay
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
    // Same domain as start URL is always allowed
    if (isSameDomain(url, this.config.startUrl)) return true

    // Subdomains of start URL are allowed by default
    if (isSubdomain(url, this.config.startUrl)) return true

    // Check additional allowed domains
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

    // Check deny patterns first — deny takes precedence
    if (this.config.denyPatterns && this.config.denyPatterns.length > 0) {
      if (matchesPattern(parsed.path, this.config.denyPatterns)) return false
    }

    // If allow patterns are specified, URL must match at least one
    if (this.config.allowPatterns && this.config.allowPatterns.length > 0) {
      return matchesPattern(parsed.path, this.config.allowPatterns)
    }

    return true
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
