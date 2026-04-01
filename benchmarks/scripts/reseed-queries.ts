/**
 * reseed-queries.ts — Re-upload GraphRAG-Bench queries.json with question_type field.
 * One-time script. Safe to run — only touches queries.json, not corpus/graph.
 */
import { put } from '@vercel/blob'
import { parquetRead } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'

const HF_PARQUET_API = 'https://datasets-server.huggingface.co/parquet'
const HF_DATASET = 'GraphRAG-Bench/GraphRAG-Bench'
const BLOB_PREFIX = 'datasets/graphrag-bench'
const DOMAINS = ['novel', 'medical'] as const

function hfHeaders(): Record<string, string> {
  const token = process.env.HF_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('Error: BLOB_READ_WRITE_TOKEN env var is required.')
    process.exit(1)
  }

  const parquetRes = await fetch(`${HF_PARQUET_API}?dataset=${encodeURIComponent(HF_DATASET)}`, { headers: hfHeaders() })
  const parquetData = (await parquetRes.json()) as { parquet_files: { config: string; split: string; url: string }[] }

  for (const domain of DOMAINS) {
    console.log(`\n── ${domain} ──`)

    const questionFiles = parquetData.parquet_files.filter(f => f.config === domain && f.split === 'train')
    if (questionFiles.length === 0) { console.log('  No parquet files found, skipping'); continue }

    const allQuestions: Record<string, unknown>[] = []
    for (const file of questionFiles) {
      const buf = await (await fetch(file.url, { headers: hfHeaders() })).arrayBuffer()
      await parquetRead({
        file: buf,
        rowFormat: 'object',
        compressors,
        onComplete: (data: Record<string, unknown>[]) => { allQuestions.push(...data) },
      })
    }
    console.log(`  Downloaded ${allQuestions.length} questions`)

    const beirQueries: { _id: string; text: string; question_type?: string }[] = []
    for (let qi = 0; qi < allQuestions.length; qi++) {
      const q = allQuestions[qi]!
      const questionType = q['question_type'] ? String(q['question_type']) : undefined
      beirQueries.push({
        _id: String(qi),
        text: String(q['question'] ?? ''),
        ...(questionType ? { question_type: questionType } : {}),
      })
    }

    // Count by type
    const typeCounts = new Map<string, number>()
    for (const q of beirQueries) {
      const t = q.question_type ?? 'unknown'
      typeCounts.set(t, (typeCounts.get(t) || 0) + 1)
    }
    console.log('  Question types:', Object.fromEntries(typeCounts))

    const queriesPath = `${BLOB_PREFIX}/${domain}/queries.json`
    const json = JSON.stringify(beirQueries)
    await put(queriesPath, json, {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    })
    console.log(`  ✓ Uploaded ${queriesPath} (${beirQueries.length} queries, ${(json.length / 1024).toFixed(0)} KB)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
