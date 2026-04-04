import type { d8umIdentity } from '@d8um-ai/core'

/**
 * Build an identity from partial parts. At least one identifier is required.
 */
export function buildScope(parts: Partial<d8umIdentity>): d8umIdentity {
  const scope: d8umIdentity = {}
  if (parts.tenantId !== undefined) scope.tenantId = parts.tenantId
  if (parts.groupId !== undefined) scope.groupId = parts.groupId
  if (parts.userId !== undefined) scope.userId = parts.userId
  if (parts.agentId !== undefined) scope.agentId = parts.agentId
  if (parts.conversationId !== undefined) scope.conversationId = parts.conversationId

  if (!scope.tenantId && !scope.groupId && !scope.userId && !scope.agentId && !scope.conversationId) {
    throw new Error('Identity requires at least one identifier (tenantId, groupId, userId, agentId, or conversationId)')
  }

  return scope
}

/**
 * Deterministic string key for an identity. Used for Map keys and cache lookups.
 */
export function scopeKey(scope: d8umIdentity): string {
  const parts: string[] = []
  if (scope.tenantId) parts.push(`t:${scope.tenantId}`)
  if (scope.groupId) parts.push(`g:${scope.groupId}`)
  if (scope.userId) parts.push(`u:${scope.userId}`)
  if (scope.agentId) parts.push(`a:${scope.agentId}`)
  if (scope.conversationId) parts.push(`s:${scope.conversationId}`)
  return parts.join('|')
}

/**
 * Check if a record's identity matches a query identity.
 * A record matches if every field present in the query
 * is also present and equal in the record.
 */
export function scopeMatches(record: d8umIdentity, query: d8umIdentity): boolean {
  if (query.tenantId !== undefined && record.tenantId !== query.tenantId) return false
  if (query.groupId !== undefined && record.groupId !== query.groupId) return false
  if (query.userId !== undefined && record.userId !== query.userId) return false
  if (query.agentId !== undefined && record.agentId !== query.agentId) return false
  if (query.conversationId !== undefined && record.conversationId !== query.conversationId) return false
  return true
}

/**
 * Convert an identity to a flat Record for storage queries.
 * Only includes defined fields.
 */
export function scopeToFilter(scope: d8umIdentity): Record<string, string> {
  const filter: Record<string, string> = {}
  if (scope.tenantId) filter['tenantId'] = scope.tenantId
  if (scope.groupId) filter['groupId'] = scope.groupId
  if (scope.userId) filter['userId'] = scope.userId
  if (scope.agentId) filter['agentId'] = scope.agentId
  if (scope.conversationId) filter['conversationId'] = scope.conversationId
  return filter
}
