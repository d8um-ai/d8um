import type { Connector, RawDocument } from '@d8um/core'
import * as cheerio from 'cheerio'

export const DEFAULT_STRIP_ELEMENTS = [
  'nav', 'footer', 'aside', 'script', 'style', 'noscript', 'iframe', 'svg',
]

export const DEFAULT_STRIP_SELECTORS = [
  '.cookie-card', '.cookie-modal', '.consent_blackbar', '.mutiny-banner',
  '.sidebar', '.breadcrumbs', '.skiplink',
  '#consent-manager', '#table-of-contents',
  '.nav', '.navbar', '#navbar', '.navigation', '.menu',
  '.footer', '.widget',
  '.ad', '.ads', '.advertisement', '.sponsored',
  '.social', '.share', '.sharing',
  '.disqus', '.related', '#related-topics',
  '.recommended', '.suggestions',
  '.cookie', '.popup', '.modal', '.overlay',
  '.breadcrumb', '.meta', '.tags', '.skip',
  '#header', '#footer', '#nav', '#navigation', '#sidebar',
  '#social', '#ads', '#cookie-notice', '#popup', '#modal',
  '.sidebar-wrapper',
]

export interface UrlConnectorConfig {
  urls: string[]
  sitemapUrls?: string[]
  maxPages?: number
  crawlDelay?: number
  userAgent?: string
  stripElements?: string[]
  stripSelectors?: string[]
  filter?: (url: string) => boolean
}

export type UrlMeta = {
  fetchedAt: Date
  statusCode: number
  contentType: string
  links?: string[]
}

export class UrlConnector implements Connector<UrlMeta> {
  constructor(private config: UrlConnectorConfig) {}

  async *fetch(): AsyncIterable<RawDocument<UrlMeta>> {
    for (const url of this.config.urls) {
      const doc = await this.fetchPage(url)
      if (doc) yield doc
    }
  }

  async *fetchSince(since: Date): AsyncIterable<RawDocument<UrlMeta>> {
    for (const url of this.config.urls) {
      const doc = await this.fetchPage(url, since)
      if (doc) yield doc
    }
  }

  async healthCheck(): Promise<void> {
    if (this.config.urls.length === 0) {
      throw new Error('No URLs configured')
    }
    const res = await fetch(this.config.urls[0]!, {
      method: 'HEAD',
      headers: this.buildHeaders(),
    })
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status} ${res.statusText}`)
    }
  }

  /** Fetch and parse a single page. Returns null if skipped (e.g. 304). */
  async fetchPage(url: string, ifModifiedSince?: Date): Promise<RawDocument<UrlMeta> | null> {
    const headers = this.buildHeaders()
    if (ifModifiedSince) {
      headers['If-Modified-Since'] = ifModifiedSince.toUTCString()
    }

    const res = await fetch(url, { headers })

    if (res.status === 304) return null
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    const lastModified = res.headers.get('last-modified')
    const html = await res.text()

    const isHtml = contentType.includes('text/html') || html.trimStart().startsWith('<')

    let title = ''
    let content = ''
    let links: string[] = []

    if (isHtml) {
      const result = this.parseHtml(html, url)
      title = result.title
      content = result.content
      links = result.links
    } else {
      // Plain text or other content — use as-is
      content = html
      title = url
    }

    return {
      id: normalizeUrlForId(url),
      content,
      title,
      url,
      updatedAt: lastModified ? new Date(lastModified) : new Date(),
      metadata: {
        fetchedAt: new Date(),
        statusCode: res.status,
        contentType,
        links,
      },
    }
  }

  private parseHtml(html: string, baseUrl: string): { title: string; content: string; links: string[] } {
    const $ = cheerio.load(html)

    const stripElements = this.config.stripElements ?? DEFAULT_STRIP_ELEMENTS
    const stripSelectors = this.config.stripSelectors ?? DEFAULT_STRIP_SELECTORS

    // Remove unwanted elements
    for (const el of stripElements) {
      $(el).remove()
    }
    for (const sel of stripSelectors) {
      $(sel).remove()
    }

    const title = $('title').first().text().trim() || $('h1').first().text().trim() || baseUrl

    // Extract links before getting text
    const links: string[] = []
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      if (href) {
        const resolved = resolveUrl(href, baseUrl)
        if (resolved) links.push(resolved)
      }
    })

    // Get text content — normalize whitespace
    const content = $('body').text()
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    return { title, content, links: [...new Set(links)] }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.config.userAgent) {
      headers['User-Agent'] = this.config.userAgent
    }
    return headers
  }
}

function normalizeUrlForId(url: string): string {
  try {
    const u = new URL(url)
    // Strip trailing slash, query, hash for consistent IDs
    let path = u.pathname
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1)
    }
    return `${u.hostname}${path}`
  } catch {
    return url
  }
}

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    // Skip non-http links
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:') || href.startsWith('#')) {
      return null
    }
    const resolved = new URL(href, baseUrl)
    // Only keep http(s) links
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null
    }
    return resolved.href
  } catch {
    return null
  }
}
