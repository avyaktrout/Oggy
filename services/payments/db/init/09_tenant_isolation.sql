-- =====================================================
-- Tenant Isolation: Per-user domain knowledge
-- Each tenant gets their own Oggy with independent learning
-- =====================================================

-- Add user_id to domain_knowledge (backfill existing rows as 'oggy')
ALTER TABLE domain_knowledge ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'oggy';

-- Index for per-user queries
CREATE INDEX IF NOT EXISTS idx_domain_knowledge_user_id
    ON domain_knowledge (user_id);

CREATE INDEX IF NOT EXISTS idx_domain_knowledge_user_domain_topic
    ON domain_knowledge (user_id, domain, topic, subtopic)
    WHERE retired_at IS NULL;
