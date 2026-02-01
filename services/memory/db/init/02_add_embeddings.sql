-- Week 3: Add embedding support for smart retrieval
-- Migration: 02_add_embeddings.sql

-- Add embedding column to memory_cards
-- Using JSONB to store vector (Postgres doesn't have native vector type without pgvector extension)
-- For production, consider pgvector extension for better performance

ALTER TABLE memory_cards
ADD COLUMN IF NOT EXISTS embedding JSONB DEFAULT NULL;

-- Add index for faster embedding operations
CREATE INDEX IF NOT EXISTS idx_memory_cards_embedding
ON memory_cards USING GIN (embedding);

-- Add embedding metadata columns
ALTER TABLE memory_cards
ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(50) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMP DEFAULT NULL;

COMMENT ON COLUMN memory_cards.embedding IS 'Vector embedding of card content (JSONB array of floats)';
COMMENT ON COLUMN memory_cards.embedding_model IS 'Model used to generate embedding (e.g., text-embedding-3-small)';
COMMENT ON COLUMN memory_cards.embedding_generated_at IS 'When the embedding was generated';
