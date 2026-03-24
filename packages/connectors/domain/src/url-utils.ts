export interface ParsedUrl {
  hostname: string
  path: string
  origin: string
}

export function parseUrl(url: string): ParsedUrl | null {
  try {
    const withProtocol = url.match(/^https?:\/\//) ? url : "https://" + url
    const u = new URL(withProtocol)
    return {
      hostname: u.hostname.replace(/^www\./, ""),
      path: normalizePath(u.pathname),
      origin: u.origin,
    }
  } catch {
    return null
  }
}

export function normalizeUrl(url: string): string {
  const parsed = parseUrl(url)
  if (!parsed) return url
  return parsed.hostname + parsed.path
}

export function normalizePath(path: string): string {
  if (!path) return "/"
  path = path.split("?")[0]!.split("#")[0]!
  if (!path.startsWith("/")) {
    path = "/" + path
  }
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1)
  }
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
  return a.hostname !== b.hostname && a.hostname.endsWith("." + b.hostname)
}

export function matchesPattern(path: string, patterns: string[]): boolean {
  const normalized = normalizePath(path)
  for (const pattern of patterns) {
    if (matchSingle(normalized, pattern)) return true
  }
  return false
}

function matchSingle(path: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return path === normalizePath(pattern)
  }

  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2)
    const normalizedPrefix = normalizePath(prefix === "" ? "/" : prefix)
    return path === normalizedPrefix || path.startsWith(normalizedPrefix + "/")
  }

  const segments = pattern.split("*")
  let remaining = path
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? ""
    if (seg === "") continue
    const idx = remaining.indexOf(seg)
    if (idx === -1) return false
    if (i === 0 && idx !== 0) return false
    remaining = remaining.slice(idx + seg.length)
  }
  return true
}
