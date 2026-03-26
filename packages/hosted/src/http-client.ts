import type { HostedConfig } from './types.js'
import { d8umApiError } from './types.js'

const DEFAULT_BASE_URL = 'https://api.d8um.dev'
const DEFAULT_TIMEOUT = 30_000

export class HttpClient {
  private baseUrl: string
  private apiKey: string
  private tenantId: string | undefined
  private timeout: number

  constructor(config: HostedConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.apiKey = config.apiKey
    this.tenantId = config.tenantId
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = this.buildUrl(path, params)
    return this.request<T>(url, { method: 'GET' })
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path)
    const init: RequestInit = { method: 'POST' }
    if (body !== undefined) init.body = JSON.stringify(body, dateReplacer)
    return this.request<T>(url, init)
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path)
    const init: RequestInit = { method: 'PUT' }
    if (body !== undefined) init.body = JSON.stringify(body, dateReplacer)
    return this.request<T>(url, init)
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path)
    const init: RequestInit = { method: 'PATCH' }
    if (body !== undefined) init.body = JSON.stringify(body, dateReplacer)
    return this.request<T>(url, init)
  }

  async delete<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path)
    const init: RequestInit = { method: 'DELETE' }
    if (body !== undefined) init.body = JSON.stringify(body, dateReplacer)
    return this.request<T>(url, init)
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl + '/')
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
    }
    return url.toString()
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }
    if (this.tenantId) {
      headers['X-Tenant-Id'] = this.tenantId
    }

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new d8umApiError(
          `d8um API error: ${response.status} ${response.statusText}`,
          response.status,
          body ? tryParseJson(body) : undefined
        )
      }

      const text = await response.text()
      if (!text) return undefined as T
      return JSON.parse(text, dateReviver) as T
    } catch (error) {
      if (error instanceof d8umApiError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new d8umApiError('Request timed out', 0)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

/** JSON replacer that serializes Date objects as ISO strings. */
function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  return value
}

/** JSON reviver that deserializes ISO date strings back to Date objects. */
function dateReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const date = new Date(value)
    if (!isNaN(date.getTime())) return date
  }
  return value
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}
