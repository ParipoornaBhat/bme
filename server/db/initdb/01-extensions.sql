-- Runs once, on first container start (empty data volume only).
-- pgvector backs series_embedding and report_chunk; see schema/bme.ts.
CREATE EXTENSION IF NOT EXISTS vector;
