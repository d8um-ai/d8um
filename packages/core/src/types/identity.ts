/**
 * Identity context for all d8um operations.
 * Every API call can pass identity fields to scope the operation.
 * This replaces the previous `tenantId`-only model with a full identity hierarchy.
 */
export interface d8umIdentity {
  /** Organization-level isolation. */
  tenantId?: string | undefined
  /** Team, channel, or project shared context. */
  groupId?: string | undefined
  /** Individual user. */
  userId?: string | undefined
  /** Specific agent instance. */
  agentId?: string | undefined
  /** Conversation session. */
  sessionId?: string | undefined
}
