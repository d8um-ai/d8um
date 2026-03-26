import type { JobTypeDefinition, JobRunContext, JobRunResult } from '@d8um/core'

export const memoryConsolidationJob: JobTypeDefinition = {
  type: 'memory_consolidation',
  label: 'Memory: Consolidation',
  description: 'Promote episodic memories into semantic facts and procedural knowledge',
  category: 'memory',
  requiresSource: false,
  available: true,
  schedule: '0 3 * * *',

  configSchema: [
    { key: 'strategies', label: 'Consolidation Strategies', type: 'text', placeholder: 'episodic_to_semantic,procedural_promotion', required: false },
    { key: 'minEpisodicAgeMs', label: 'Min Episode Age (ms)', type: 'number', placeholder: '3600000', required: false },
  ],

  resultSchema: [
    { key: 'factsExtracted', label: 'Facts extracted', type: 'number' },
    { key: 'proceduresCreated', label: 'Procedures created', type: 'number' },
    { key: 'episodesConsolidated', label: 'Episodes consolidated', type: 'number' },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    return {
      jobId: ctx.job.id,
      sourceId: ctx.job.sourceId,
      status: 'completed',
      summary: 'Consolidation job requires d8umMemory context to run',
      documentsCreated: 0,
      documentsUpdated: 0,
      documentsDeleted: 0,
      durationMs: 0,
    }
  },
}
