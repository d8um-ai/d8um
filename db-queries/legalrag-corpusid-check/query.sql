-- Check how many of the 100 expected relevant_passage_ids exist as corpusId in chunks
-- Also sample some corpusId values to verify format

-- 1. Count total chunks and distinct corpusIds in the legal-rag-bench table
SELECT
  'total_chunks' AS metric,
  COUNT(*)::text AS value
FROM bench_legalrag_core__gateway_openai_text_embedding_3_small

UNION ALL

SELECT
  'distinct_corpus_ids' AS metric,
  COUNT(DISTINCT metadata->>'corpusId')::text AS value
FROM bench_legalrag_core__gateway_openai_text_embedding_3_small

UNION ALL

SELECT
  'chunks_with_corpusid' AS metric,
  COUNT(*)::text AS value
FROM bench_legalrag_core__gateway_openai_text_embedding_3_small
WHERE metadata->>'corpusId' IS NOT NULL

UNION ALL

SELECT
  'chunks_without_corpusid' AS metric,
  COUNT(*)::text AS value
FROM bench_legalrag_core__gateway_openai_text_embedding_3_small
WHERE metadata->>'corpusId' IS NULL

UNION ALL

-- 2. Sample 10 corpusId values to see the format
SELECT
  'sample_corpusid_' || ROW_NUMBER() OVER () AS metric,
  metadata->>'corpusId' AS value
FROM bench_legalrag_core__gateway_openai_text_embedding_3_small
WHERE metadata->>'corpusId' IS NOT NULL
LIMIT 10;
