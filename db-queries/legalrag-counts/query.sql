SELECT 'chunks' AS label, COUNT(*) AS cnt FROM bench_legalrag_core__gateway_openai_text_embedding_3_small
UNION ALL
SELECT 'with_corpusId', COUNT(*) FROM bench_legalrag_core__gateway_openai_text_embedding_3_small WHERE metadata->>'corpusId' IS NOT NULL
UNION ALL
SELECT 'without_corpusId', COUNT(*) FROM bench_legalrag_core__gateway_openai_text_embedding_3_small WHERE metadata->>'corpusId' IS NULL
ORDER BY label;
