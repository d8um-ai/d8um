#!/usr/bin/env npx tsx
/**
 * MultiHop-RAG Benchmark — d8um Graph (Neural Search)
 *
 * Runs the yixuantt/MultiHopRAG benchmark (609 docs, ~2556 queries)
 * using d8um graph with neural search (hybrid + memory recall + PPR graph traversal).
 *
 * Usage:
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts                      # query-only
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts --seed               # re-index
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts --eval-answers-only  # answer eval
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts --record             # save to history
 */

import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { getConfig, LLM_MODEL } from '../../lib/config.js'
import {
  parseCliArgs, initNeural, resolveBucket, loadDataset,
  runIngestion, runQueries, computeMetrics, buildResult,
  emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import { substringAccuracy, exactMatch, tokenF1 } from '../../lib/metrics.js'
import { recordResult } from '../../lib/history.js'
import type { BenchmarkMetrics } from '../../lib/report.js'

const config = getConfig('multihop-rag/neural')
const cli = parseCliArgs()

// Catch unhandled errors so we get diagnostics instead of silent death
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason)
  process.exit(1)
})
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err)
  process.exit(1)
})

async function main() {
  const totalStart = performance.now()
  printBanner(config, cli)

  // Phase 1: Initialize with graph bridge
  console.log('Phase 1: Initializing d8um with graph bridge...')
  const { d, adapter } = await initNeural(config)
  console.log(`  LLM: ${LLM_MODEL} (triple extraction during ingest)`)
  const { bucket } = await resolveBucket(d, config.bucketName, cli.shouldSeed)
  const latency = await measureLatencyProfile(adapter)
  console.log()

  // Phase 2: Load dataset (with gold answers if answer eval requested)
  const needAnswers = cli.evalAnswers || cli.evalAnswersOnly
  console.log('Phase 2: Loading MultiHop-RAG from Vercel Blob...')
  const { corpus, testQueries, qrelsMap, goldAnswers } = await loadDataset(config, needAnswers)
  console.log(`  Test queries with relevance judgments: ${testQueries.length}`)

  // Compute answer-only query subset
  let answerQuerySet = testQueries
  if (cli.evalAnswersOnly && goldAnswers) {
    const limit = cli.evalAnswersLimit
    answerQuerySet = testQueries.filter(q => goldAnswers.has(String(q['_id']))).slice(0, limit)
    console.log(`  Answer-only mode: ${answerQuerySet.length} queries (of ${goldAnswers.size} with gold answers)`)
  }
  console.log()

  // Phase 3: Ingest (if needed)
  let ingestDuration: number | undefined
  let tripleErrors = 0
  if (cli.shouldSeed) {
    console.log(`Phase 3: Ingesting ${corpus.length} documents (with LLM triple extraction)...`)
    const result = await runIngestion(d, bucket.id, corpus, config, { concurrency: 5 })
    ingestDuration = result.ingestDuration
    tripleErrors = result.tripleErrors
  } else {
    console.log('Phase 3: Skipping ingestion (no --seed flag)')
  }
  console.log()

  // ── Answer-only mode: single loop with 90s timeout per query ──
  if (cli.evalAnswersOnly) {
    const answers = goldAnswers ?? new Map<string, string>()
    console.log(`Phase 4: Answer-only evaluation (${answerQuerySet.length} queries, model: ${cli.evalLlmModel})...`)
    console.log('  Single loop: retrieve -> generate -> score per query')
    const queryStart = performance.now()

    let sumACC = 0, sumEM = 0, sumF1 = 0, answered = 0, errors = 0

    for (const query of answerQuerySet) {
      const queryId = String(query['_id'])
      const queryText = String(query['text'])
      const gold = answers.get(queryId)
      if (!gold) continue

      try {
        // 90s timeout covers the entire retrieve+generate cycle
        let timer: ReturnType<typeof setTimeout> | undefined
        const predicted = await Promise.race([
          (async () => {
            const response = await d.query(queryText, {
              mode: 'neural', count: 50, buckets: [bucket.id],
            })
            const chunks = response.results.slice(0, 6).map(r => r.content)
            const context = chunks.join('\n\n---\n\n')
            const { text } = await generateText({
              model: gateway(cli.evalLlmModel),
              prompt: `Answer the question based only on the provided context. Be concise.\n\nContext:\n${context}\n\nQuestion: ${queryText}\n\nAnswer:`,
            })
            return text
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('query+answer timeout (90s)')), 90_000) }),
        ]).finally(() => clearTimeout(timer))

        sumACC += substringAccuracy(predicted, gold)
        sumEM += exactMatch(predicted, gold)
        sumF1 += tokenF1(predicted, gold)
        answered++
      } catch (err) {
        errors++
        console.error(`\n  Answer gen error (query ${queryId}): ${err instanceof Error ? err.message : err}`)
      }

      if ((answered + errors) % 10 === 0 || (answered + errors) === answerQuerySet.length) {
        const elapsed = ((performance.now() - queryStart) / 1000).toFixed(0)
        const mem = process.memoryUsage()
        console.log(`\n  Progress: ${answered + errors}/${answerQuerySet.length} (${elapsed}s) heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB`)
      }
    }

    const queryDuration = (performance.now() - queryStart) / 1000
    const avgQueryMs = answered > 0 ? (queryDuration * 1000) / (answered + errors) : 0
    console.log(`\n  Complete: ${answered} answered${errors > 0 ? `, ${errors} errors` : ''} in ${queryDuration.toFixed(1)}s (avg ${avgQueryMs.toFixed(0)}ms/query)`)
    console.log(`  ACC=${(sumACC / answered).toFixed(4)}, EM=${(sumEM / answered).toFixed(4)}, F1=${(sumF1 / answered).toFixed(4)}`)

    const benchResult = buildResult(config, 'neural', corpus.length, answered, {
      ACC: sumACC / answered, EM: sumEM / answered, F1: sumF1 / answered,
    } as BenchmarkMetrics, { avgQueryMs, totalStart, latency }, { evalModel: cli.evalLlmModel })

    emitResults(benchResult)
    if (cli.record) recordResult(benchResult)
    // Force exit: Neon WebSocket connections and orphaned timers can keep the event loop alive
    process.exit(0)
  }

  // ── Full retrieval: query in neural mode ──
  console.log(`Phase 4: Running ${testQueries.length} queries (mode: neural)...`)
  console.log('  Neural = hybrid + memory recall + PPR graph traversal, merged via RRF')
  const { allResults, allChunkResults, avgQueryMs } = await runQueries(d, bucket.id, testQueries, 'neural', {
    returnChunks: cli.evalAnswers,
  })
  console.log()

  // Phase 5: Score
  console.log('Phase 5: Computing IR metrics...')
  const { metrics, scored } = computeMetrics(config, allResults, qrelsMap)
  const mutableMetrics = { ...metrics } as Record<string, number | undefined>

  // ── Answer-generation evaluation (optional, non-fatal) ──
  if (cli.evalAnswers && goldAnswers && allChunkResults) {
    console.log(`Phase 5b: Evaluating answer generation (neural, model: ${cli.evalLlmModel})...`)
    try {
      let sumACC = 0, sumEM = 0, sumF1 = 0, answered = 0
      const limit = cli.evalAnswersLimit
      const targetCount = Math.min(goldAnswers.size, limit)

      for (const [queryId] of allResults) {
        if (answered >= limit) break
        const gold = goldAnswers.get(queryId)
        if (!gold) continue

        const queryText = testQueries.find(q => String(q['_id']) === queryId)?.text ?? ''
        const storedChunks = allChunkResults.get(queryId) ?? []
        const chunks = storedChunks.slice(0, 6).map(c => c.content)
        const context = chunks.join('\n\n---\n\n')

        const { text: predicted } = await generateText({
          model: gateway(cli.evalLlmModel),
          prompt: `Answer the question based only on the provided context. Be concise.\n\nContext:\n${context}\n\nQuestion: ${queryText}\n\nAnswer:`,
        })

        sumACC += substringAccuracy(predicted, gold)
        sumEM += exactMatch(predicted, gold)
        sumF1 += tokenF1(predicted, gold)
        answered++
        if (answered % 50 === 0 || answered === targetCount) {
          process.stdout.write(`\r  Answers: ${answered}/${targetCount}`)
        }
      }
      console.log(`\n  Answer eval complete: ${answered} queries, ACC=${(sumACC / answered).toFixed(4)}, EM=${(sumEM / answered).toFixed(4)}, F1=${(sumF1 / answered).toFixed(4)}`)
      mutableMetrics['ACC'] = sumACC / answered
      mutableMetrics['EM'] = sumEM / answered
      mutableMetrics['F1'] = sumF1 / answered
    } catch (err) {
      console.log(`  Answer eval skipped: ${err instanceof Error ? err.message : err}`)
    }
  }

  const result = buildResult(config, 'neural', corpus.length, scored, mutableMetrics as BenchmarkMetrics, {
    ingestDuration,
    avgQueryMs,
    totalStart,
    latency,
  }, { tripleExtractionErrors: tripleErrors, ...(cli.evalAnswers ? { evalModel: cli.evalLlmModel } : {}) })

  emitResults(result)
  if (cli.record) recordResult(result)
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
