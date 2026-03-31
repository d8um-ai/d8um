#!/usr/bin/env npx tsx
/**
 * MultiHop-RAG Benchmark — d8um Core (Hybrid + Fast)
 *
 * Runs the yixuantt/MultiHopRAG benchmark (609 docs, ~2556 queries)
 * using d8um core with both hybrid search and fast (pure vector) search.
 * Multi-hop question answering over news articles.
 *
 * Usage:
 *   npx tsx --env-file=.env multihop-rag/core/run.ts                      # query-only
 *   npx tsx --env-file=.env multihop-rag/core/run.ts --seed               # re-index
 *   npx tsx --env-file=.env multihop-rag/core/run.ts --eval-answers-only  # answer eval
 *   npx tsx --env-file=.env multihop-rag/core/run.ts --record             # save to history
 */

import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { getConfig } from '../../lib/config.js'
import {
  parseCliArgs, initCore, resolveBucket, loadDataset,
  runIngestion, runQueries, computeMetrics, buildResult,
  emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import { substringAccuracy, exactMatch, tokenF1 } from '../../lib/metrics.js'
import { recordResults } from '../../lib/history.js'
import type { BenchmarkResult, BenchmarkMetrics } from '../../lib/report.js'

const config = getConfig('multihop-rag/core')
const cli = parseCliArgs()

async function main() {
  const totalStart = performance.now()
  printBanner(config, cli)

  // Phase 1: Initialize
  console.log('Phase 1: Initializing d8um with Neon pgvector...')
  const { d, adapter } = await initCore(config)
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
  if (cli.shouldSeed) {
    console.log(`Phase 3: Ingesting ${corpus.length} documents...`)
    const result = await runIngestion(d, bucket.id, corpus, config)
    ingestDuration = result.ingestDuration
  } else {
    console.log('Phase 3: Skipping ingestion (no --seed flag)')
  }
  console.log()

  // ── Answer-only mode: single loop (retrieve -> generate -> score) ──
  if (cli.evalAnswersOnly) {
    const answers = goldAnswers ?? new Map<string, string>()
    console.log(`Phase 4: Answer-only evaluation (${answerQuerySet.length} queries, mode: hybrid, model: ${cli.evalLlmModel})...`)
    console.log('  Single loop: retrieve -> generate -> score per query')
    const queryStart = performance.now()

    let sumACC = 0, sumEM = 0, sumF1 = 0, answered = 0, errors = 0

    for (const query of answerQuerySet) {
      const queryId = String(query['_id'])
      const queryText = String(query['text'])
      const gold = answers.get(queryId)
      if (!gold) continue

      const response = await d.query(queryText, {
        mode: 'hybrid', count: 50,
        buckets: [bucket.id],
      })

      try {
        const chunks = response.results.slice(0, 6).map(r => r.content)
        const context = chunks.join('\n\n---\n\n')
        const { text: predicted } = await generateText({
          model: gateway(cli.evalLlmModel),
          prompt: `Answer the question based only on the provided context. Be concise.\n\nContext:\n${context}\n\nQuestion: ${queryText}\n\nAnswer:`,
        })

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
        process.stdout.write(`\r  Progress: ${answered + errors}/${answerQuerySet.length} (${elapsed}s)`)
      }
    }

    const queryDuration = (performance.now() - queryStart) / 1000
    const avgQueryMs = answered > 0 ? (queryDuration * 1000) / (answered + errors) : 0
    console.log(`\n  Complete: ${answered} answered${errors > 0 ? `, ${errors} errors` : ''} in ${queryDuration.toFixed(1)}s (avg ${avgQueryMs.toFixed(0)}ms/query)`)
    console.log(`  ACC=${(sumACC / answered).toFixed(4)}, EM=${(sumEM / answered).toFixed(4)}, F1=${(sumF1 / answered).toFixed(4)}`)

    const benchResult = buildResult(config, 'hybrid', corpus.length, answered, {
      ACC: sumACC / answered, EM: sumEM / answered, F1: sumF1 / answered,
    } as BenchmarkMetrics, { avgQueryMs, totalStart, latency }, { evalModel: cli.evalLlmModel })

    emitResults(benchResult)
    if (cli.record) recordResults([benchResult])
    return
  }

  // ── Full retrieval: query in both modes ──
  const benchResults: BenchmarkResult[] = []

  for (const mode of config.modes) {
    console.log(`Running ${testQueries.length} queries (mode: ${mode})...`)
    const { allResults, allChunkResults, avgQueryMs } = await runQueries(d, bucket.id, testQueries, mode, {
      returnChunks: cli.evalAnswers,
    })
    console.log()

    console.log(`Computing IR metrics (${mode})...`)
    const { metrics, scored } = computeMetrics(config, allResults, qrelsMap)
    const mutableMetrics = { ...metrics } as Record<string, number | undefined>

    // ── Answer-generation evaluation (optional, non-fatal) ──
    if (cli.evalAnswers && goldAnswers && allChunkResults) {
      console.log(`Evaluating answer generation (${mode}, model: ${cli.evalLlmModel})...`)
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

    benchResults.push(buildResult(config, mode, corpus.length, scored, mutableMetrics as BenchmarkMetrics, {
      ingestDuration: mode === config.modes[0] ? ingestDuration : undefined,
      avgQueryMs,
      totalStart,
      latency,
    }, cli.evalAnswers ? { evalModel: cli.evalLlmModel } : undefined))
    console.log()
  }

  emitResults(benchResults)
  if (cli.record) recordResults(benchResults)
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
