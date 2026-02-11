-- =====================================================
-- Domain Knowledge Store for Assessment Generation
-- Stage 0, Week 5: Learning Pipeline Integration
-- =====================================================
-- Purpose:
-- - Provide curated, structured reference corpus for Tessa
-- - Bridge between raw user/app data and memory substrate
-- - Keep assessment generation intelligence separate from Oggy's memory
-- - Enable validation before promoting facts to memory cards
-- =====================================================

CREATE TABLE IF NOT EXISTS domain_knowledge (
    knowledge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Domain classification
    domain TEXT NOT NULL,  -- 'payments' | 'diet' | 'conversation' | 'system'
    topic TEXT NOT NULL,  -- e.g., 'categorization', 'merchant_patterns', 'spending_behavior'
    subtopic TEXT,  -- e.g., 'recurring_expenses', 'category_rules'

    -- Content
    content_text TEXT NOT NULL,  -- markdown allowed
    content_structured JSONB,  -- optional structured representation

    -- Provenance
    source_type TEXT NOT NULL,  -- 'user_note' | 'system_spec' | 'doc_extract' | 'app_event' | 'external_ref' | 'tessa_ai'
    source_ref TEXT NOT NULL,  -- pointer to source (e.g., 'app_event:uuid', 'file:hash', 'doc:anchor')

    -- Assessment generation metadata
    difficulty_band SMALLINT DEFAULT 3,  -- 1-5, for adaptive assessment generation
    visibility TEXT NOT NULL DEFAULT 'tessa_only',  -- 'tessa_only' | 'shareable'

    -- Metadata
    tags JSONB DEFAULT '[]'::jsonb,  -- free-form labels for filtering

    -- Versioning and lifecycle
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    content_hash TEXT,  -- for detecting duplicates/changes
    supersedes_knowledge_id UUID REFERENCES domain_knowledge(knowledge_id),
    retired_at TIMESTAMPTZ,  -- soft delete / archival

    -- Optional: semantic search support
    embedding TEXT  -- placeholder for pgvector embedding

    -- Constraints
    CONSTRAINT valid_domain CHECK (domain IN ('payments', 'diet', 'conversation', 'system')),
    CONSTRAINT valid_source_type CHECK (source_type IN ('user_note', 'system_spec', 'doc_extract', 'app_event', 'external_ref', 'tessa_ai')),
    CONSTRAINT valid_visibility CHECK (visibility IN ('tessa_only', 'shareable')),
    CONSTRAINT valid_difficulty CHECK (difficulty_band BETWEEN 1 AND 5)
);

-- =====================================================
-- Knowledge Promotion Log
-- Track when domain_knowledge items are promoted to memory cards
-- =====================================================
CREATE TABLE IF NOT EXISTS knowledge_promotions (
    promotion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    knowledge_id UUID NOT NULL REFERENCES domain_knowledge(knowledge_id),
    card_id UUID NOT NULL,  -- references memory_cards.card_id (in memory service)
    promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    promoted_by TEXT NOT NULL,  -- 'system' | 'tessa' | agent name
    promotion_reason TEXT NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Track outcome
    promotion_validated BOOLEAN DEFAULT FALSE,
    validation_outcome TEXT,  -- 'confirmed' | 'rejected' | 'modified' | 'pending'
    validated_at TIMESTAMPTZ
);

-- =====================================================
-- Indexes for domain_knowledge
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_domain_knowledge_domain_topic
    ON domain_knowledge (domain, topic, subtopic)
    WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_domain_knowledge_visibility
    ON domain_knowledge (visibility, difficulty_band)
    WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_domain_knowledge_source
    ON domain_knowledge (source_type, source_ref)
    WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_domain_knowledge_created
    ON domain_knowledge (created_at DESC);

-- GIN index for tags
CREATE INDEX IF NOT EXISTS idx_domain_knowledge_tags_gin
    ON domain_knowledge USING GIN (tags);

-- GIN index for structured content
CREATE INDEX IF NOT EXISTS idx_domain_knowledge_structured_gin
    ON domain_knowledge USING GIN (content_structured);

-- Full-text search on content_text
CREATE INDEX IF NOT EXISTS idx_domain_knowledge_content_fts
    ON domain_knowledge USING GIN (to_tsvector('english', content_text));

-- =====================================================
-- Indexes for knowledge_promotions
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_promotions_knowledge_id
    ON knowledge_promotions (knowledge_id, promoted_at DESC);

CREATE INDEX IF NOT EXISTS idx_promotions_card_id
    ON knowledge_promotions (card_id);

CREATE INDEX IF NOT EXISTS idx_promotions_unvalidated
    ON knowledge_promotions (promoted_at DESC)
    WHERE NOT promotion_validated;

-- =====================================================
-- Comments for documentation
-- =====================================================
COMMENT ON TABLE domain_knowledge IS 'Curated knowledge corpus for Tessa assessment generation, separate from Oggy memory';
COMMENT ON COLUMN domain_knowledge.visibility IS 'tessa_only: sealed benchmarks only; shareable: practice assessments allowed';
COMMENT ON COLUMN domain_knowledge.content_hash IS 'SHA256 hash for deduplication and change detection';
COMMENT ON TABLE knowledge_promotions IS 'Audit trail for when domain knowledge is promoted to memory cards';
