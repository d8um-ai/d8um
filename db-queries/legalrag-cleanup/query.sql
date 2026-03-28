-- Clean all legal-rag-bench core data for fresh reseed
-- Stale duplicates exist from overlapping seeds (6634 doc IDs for 4876 expected)

DELETE FROM bench_legalrag_core__gateway_openai_text_embedding_3_small
WHERE bucket_id IN (SELECT id FROM d8um_buckets WHERE name = 'legal-rag-bench');

DELETE FROM d8um_hashes
WHERE bucket_id IN (SELECT id FROM d8um_buckets WHERE name = 'legal-rag-bench');

DELETE FROM d8um_documents
WHERE bucket_id IN (SELECT id FROM d8um_buckets WHERE name = 'legal-rag-bench');

DELETE FROM d8um_buckets WHERE name = 'legal-rag-bench';

-- Verify cleanup
SELECT 'chunks_remaining' AS metric, COUNT(*)::text AS value
FROM bench_legalrag_core__gateway_openai_text_embedding_3_small
UNION ALL
SELECT 'buckets_remaining', COUNT(*)::text
FROM d8um_buckets WHERE name = 'legal-rag-bench';
