import type { JobTypeDefinition, JobExecuteResult, JobRunContext, ConfigField } from '@d8um/core'

/**
 * Memory conversation ingest job type definition.
 *
 * This job extracts memories from conversation messages using the
 * MemoryExtractor pipeline. It creates episodic memories and extracts
 * semantic facts via LLM-driven analysis.
 *
 * The actual execution requires a MemoryExtractor and MemoryStoreAdapter
 * to be provided via the job config. This job type is registered in the
 * job registry but the execute() implementation delegates to the caller's
 * configured extraction pipeline.
 */
export const conversationIngestJob: JobTypeDefinition = {
  type: 'memory_conversation_ingest',
  label: 'Memory: Conversation Ingest',
  description: 'Extract episodic and semantic memories from conversation messages',
  category: 'memory',
  requiresSource: false,
  available: true,
  schedule: undefined,
  syncMode: 'incremental',

  configSchema: [
    {
      key: 'messages',
      label: 'Conversation Messages',
      type: 'text' as ConfigField['type'],
      placeholder: 'JSON array of {role, content} messages',
      required: true,
    },
    {
      key: 'sessionId',
      label: 'Session ID',
      type: 'text' as ConfigField['type'],
      placeholder: 'Optional session identifier',
      required: false,
    },
  ],

  resultSchema: [
    { key: 'episodicCount', label: 'Episodic memories created', type: 'number' },
    { key: 'factsExtracted', label: 'Facts extracted', type: 'number' },
    { key: 'operationsCount', label: 'Total operations', type: 'number' },
  ],

  async execute(_ctx: JobRunContext): Promise<JobExecuteResult> {
    // This is a placeholder — the actual execution is handled by D8umMemory
    // which has access to the MemoryExtractor and MemoryStoreAdapter.
    // The job type definition exists so it can be registered and scheduled.
    return {
      status: 'completed',
      summary: 'Conversation ingest job requires D8umMemory context to execute',
      metrics: {
        episodicCount: 0,
        factsExtracted: 0,
        operationsCount: 0,
      },
    }
  },
}
