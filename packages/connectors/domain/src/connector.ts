import type { Connector, RawDocument } from '@d8um/core'
import type { UrlMeta } from '@d8um/connector-url'
import { Crawler } from './crawler.js'

export interface DomainConnectorConfig {
  /** Starting URL for the crawl. The domain of this URL is always allowed. */
  startUrl: string
  /** Additional domains/hostnames to follow (subdomains of startUrl are followed by default). */
  allowedDomains?: string[]
  /** URL path patterns to allow. If specified, only matching paths are crawled. */
  allowPatterns?: string[]
  /** URL path patterns to deny. Deny takes precedence over allow. */
  denyPatterns?: string[]
  /** Maximum crawl depth from the start URL. Default: 20 */
  maxDepth?: number
  /** Maximum number of pages to crawl. Default: 500 */
  maxPages?: number
  /** Delay between requests in milliseconds. Default: 200 */
  crawlDelay?: number
  /** HTML elements to strip (e.g. ['nav', 'footer']). Uses UrlConnector defaults if not specified. */
  stripElements?: string[]
  /** CSS selectors to strip (e.g. ['.cookie-banner']). Uses UrlConnector defaults if not specified. */
  stripSelectors?: string[]
  /** User-Agent header for requests. */
  userAgent?: string
}

export class DomainConnector implements Connector<UrlMeta> {
  constructor(private config: DomainConnectorConfig) {}

  async *fetch(): AsyncIterable<RawDocument<UrlMeta>> {
    const crawler = new Crawler(this.config)
    yield* crawler.crawl()
  }

  async *fetchSince(since: Date): AsyncIterable<RawDocument<UrlMeta>> {
    for await (const doc of this.fetch()) {
      if (doc.updatedAt > since) {
        yield doc
      }
    }
  }

  async healthCheck(): Promise<void> {
    const res = await fetch(this.config.startUrl, { method: 'HEAD' })
    if (!res.ok) {
      throw new Error(`Health check failed for ${this.config.startUrl}: ${res.status} ${res.statusText}`)
    }
  }
}
