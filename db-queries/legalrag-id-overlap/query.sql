-- Check chunk distribution and corpusId coverage for legal-rag-bench
-- We need to understand if relevant_passage_ids from QA can match stored corpusIds

-- 1. Chunk count distribution per document
SELECT
  'chunks_per_doc_distribution' AS section,
  total_chunks::text AS key,
  COUNT(DISTINCT document_id)::text AS value
FROM bench_legalrag_core__gateway_openai_text_embedding_3_small
WHERE metadata->>'corpusId' IS NOT NULL
GROUP BY total_chunks
ORDER BY total_chunks;
