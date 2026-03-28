-- Clear AU-Tax neural tables for full reseed with fixed pipeline
-- Required because hash store will skip unchanged content, preventing re-ingestion

TRUNCATE TABLE bench_au_tax_neural__gateway_openai_text_embedding_3_small;
TRUNCATE TABLE bench_au_tax_neural__registry;
TRUNCATE TABLE bench_au_tax_neural_memories;
TRUNCATE TABLE bench_au_tax_neural_entities;
TRUNCATE TABLE bench_au_tax_neural_edges;
DELETE FROM d8um_hashes WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = 'au-tax-guidance-neural');
DELETE FROM d8um_documents WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = 'au-tax-guidance-neural');
