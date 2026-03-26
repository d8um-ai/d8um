import type { JobTypeDefinition, JobRunContext, JobRunResult } from '../../types/job.js'
import type { RawDocument } from '../../types/connector.js'
import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import TurndownService from 'turndown'
// @ts-expect-error -- no type declarations
import { gfm } from 'turndown-plugin-gfm'

// ── URL Scrape Job ──

export const urlScrapeJob: JobTypeDefinition = {
  type: 'url_scrape',
  label: 'URL Scrape',
  description: 'Scrape and index a single web page',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  configSchema: [
    { key: 'url', label: 'URL', type: 'url', required: true },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    const url = ctx.job.config['url'] as string
    if (!url) throw new Error('url_scrape: missing "url" in job config')

    const doc = await fetchPage(url)
    let created = 0
    if (doc) {
      ctx.emit?.(doc)
      created = 1
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

// ── Scraping Utilities ──

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

export type UrlMeta = {
  fetchedAt: Date
  statusCode: number
  contentType: string
  links?: string[] | undefined
}

/** Fetch and parse a single page. Returns null if skipped (e.g. 304). */
export async function fetchPage(
  url: string,
  opts?: {
    ifModifiedSince?: Date | undefined
    userAgent?: string | undefined
    stripElements?: string[] | undefined
    stripSelectors?: string[] | undefined
  },
): Promise<RawDocument<UrlMeta> | null> {
  const headers: Record<string, string> = {}
  if (opts?.userAgent) headers['User-Agent'] = opts.userAgent
  if (opts?.ifModifiedSince) headers['If-Modified-Since'] = opts.ifModifiedSince.toUTCString()

  const res = await fetch(url, { headers })

  if (res.status === 304) return null
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)

  const contentType = res.headers.get('content-type') ?? ''
  const lastModified = res.headers.get('last-modified')
  const html = await res.text()

  const isHtml = contentType.includes('text/html') || html.trimStart().startsWith('<')

  let title = ''
  let content = ''
  let links: string[] = []

  if (isHtml) {
    const result = parseHtml(html, url, opts?.stripElements, opts?.stripSelectors)
    title = result.title
    content = result.content
    links = result.links
  } else {
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

// ── HTML Parsing ──

function parseHtml(
  html: string,
  baseUrl: string,
  stripElements?: string[],
  stripSelectors?: string[],
): { title: string; content: string; links: string[] } {
  const $ = cheerio.load(html)

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || baseUrl

  // Extract links BEFORE stripping elements (nav/footer contain most links)
  const links: string[] = []
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (href) {
      const resolved = resolveUrl(href, baseUrl)
      if (resolved) links.push(resolved)
    }
  })

  // --- Cheerio preprocessing ---
  expandHiddenContent($)
  stripBase64Images($)
  stripDecorativeImages($)

  const elems = stripElements ?? DEFAULT_STRIP_ELEMENTS
  const sels = stripSelectors ?? DEFAULT_STRIP_SELECTORS

  for (const el of elems) { $(el).remove() }
  for (const sel of sels) { $(sel).remove() }

  // --- Turndown conversion ---
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })

  turndown.use(gfm)

  turndown.addRule('details-summary', {
    filter: 'details' as any,
    replacement(content: string, node: any) {
      const summaryEl = node.querySelector?.('summary')
      const summaryText = (summaryEl?.textContent ?? 'Details').trim()
      const bodyContent = content.replace(summaryText, '').trim()
      return `\n\n**${summaryText}**\n\n${bodyContent}\n\n`
    },
  })

  turndown.addRule('summary-skip', {
    filter: 'summary' as any,
    replacement(_content: string, node: any) {
      return (node.textContent ?? '').trim()
    },
  })

  turndown.addRule('skip-base64-images', {
    filter(node: any) {
      if (node.nodeName !== 'IMG') return false
      const src = node.getAttribute?.('src') ?? ''
      return src.startsWith('data:')
    },
    replacement() { return '' },
  })

  turndown.addRule('skip-decorative-images', {
    filter(node: any) {
      if (node.nodeName !== 'IMG') return false
      const alt = (node.getAttribute?.('alt') ?? '').toLowerCase()
      const src = (node.getAttribute?.('src') ?? '').toLowerCase()
      if (node.getAttribute?.('alt') === '') return true
      if (/\blogo\b/.test(alt) && alt.split(/\s+/).length <= 4) return true
      if (/\/(logos?|brand-logos?|icons?)\//i.test(src)) return true
      return false
    },
    replacement() { return '' },
  })

  turndown.remove(['script', 'style', 'noscript'])

  const bodyHtml = $('body').html() ?? ''
  const content = turndown.turndown(bodyHtml)
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { title, content, links: [...new Set(links)] }
}

// ── Cheerio preprocessing helpers ──

function expandHiddenContent($: CheerioAPI): void {
  $('details').attr('open', '')
  $('[aria-hidden="true"]').removeAttr('aria-hidden')
  $('[hidden]').removeAttr('hidden')
  $('[style*="display: none"], [style*="display:none"]').each((_, el) => {
    const style = $(el).attr('style') ?? ''
    $(el).attr('style', style.replace(/display\s*:\s*none\s*;?/gi, ''))
  })
  $('[aria-expanded="false"]').each((_, el) => {
    $(el).attr('aria-expanded', 'true')
    const controlsId = $(el).attr('aria-controls')
    if (controlsId) {
      $(`#${controlsId}`).removeAttr('hidden').removeAttr('aria-hidden').css('display', '')
    }
  })
  const accordionSelectors = [
    '[class*="accordion-content"]', '[class*="accordion-body"]',
    '[class*="collapse"]', '[class*="expandable"]',
  ].join(', ')
  $(accordionSelectors).each((_, el) => {
    $(el).removeAttr('hidden').removeAttr('aria-hidden')
    const style = $(el).attr('style') ?? ''
    $(el).attr('style', style
      .replace(/display\s*:\s*none\s*;?/gi, '')
      .replace(/height\s*:\s*0[^;]*;?/gi, '')
      .replace(/overflow\s*:\s*hidden\s*;?/gi, '')
    )
  })
  const hidingClasses = ['hidden', 'd-none', 'sr-only', 'visually-hidden', 'invisible']
  for (const cls of hidingClasses) {
    $(`.${cls}`).each((_, el) => {
      const text = $(el).text().trim()
      if (text.length > 20) { $(el).removeClass(cls) }
    })
  }
}

function stripBase64Images($: CheerioAPI): void {
  $('img[src^="data:"]').remove()
  $('img[srcset*="data:"]').remove()
  $('[style*="base64"]').each((_, el) => {
    const style = $(el).attr('style') ?? ''
    $(el).attr('style', style.replace(/background(-image)?\s*:[^;]*base64[^;]*;?/gi, ''))
  })
  $('source[srcset^="data:"]').remove()
}

function stripDecorativeImages($: CheerioAPI): void {
  const decorativeContainerSelectors = [
    '[class*="logo-carousel"]', '[class*="logo-strip"]',
    '[class*="brand-logo"]', '[class*="client-logo"]',
    '[class*="partner-logo"]', '[class*="customer-logo"]',
    '[class*="logo-grid"]', '[class*="logo-wall"]',
    '[class*="logo-bar"]', '[class*="trusted-by"]',
    '[class*="as-seen"]', '[class*="featured-in"]',
  ].join(', ')
  $(decorativeContainerSelectors).find('img').remove()
  $('img').each((_, img) => {
    const width = parseInt($(img).attr('width') ?? '', 10)
    const height = parseInt($(img).attr('height') ?? '', 10)
    if ((width && width < 40) || (height && height < 40)) { $(img).remove() }
  })
  $('img').each((_, img) => {
    const src = ($(img).attr('src') ?? '').toLowerCase()
    const alt = $(img).attr('alt')
    if (alt === '') { $(img).remove(); return }
    if (/pixel|track|beacon|spacer|1x1|clear\.gif/i.test(src)) { $(img).remove(); return }
    const altLower = (alt ?? '').toLowerCase()
    if (/\/(logos?|brand-logos?|icons?|favicon)\//i.test(src) && altLower.split(/\s+/).length <= 4) {
      $(img).remove()
    }
  })
}

function normalizeUrlForId(url: string): string {
  try {
    const u = new URL(url)
    let path = u.pathname
    if (path.length > 1 && path.endsWith('/')) { path = path.slice(0, -1) }
    return `${u.hostname}${path}`
  } catch { return url }
}

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:') || href.startsWith('#')) {
      return null
    }
    const resolved = new URL(href, baseUrl)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null
    return resolved.href
  } catch { return null }
}
