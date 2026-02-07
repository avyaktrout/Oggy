-- Oggy Self-Driven Inquiry System
-- Questions Oggy proactively asks users to improve categorization

CREATE TABLE IF NOT EXISTS oggy_inquiries (
    inquiry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    question_type TEXT NOT NULL,
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending',
    user_answer TEXT,
    answered_at TIMESTAMPTZ,
    applied_to_memory BOOLEAN DEFAULT FALSE,
    memory_card_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
    generation_date DATE NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT valid_inquiry_status CHECK (status IN ('pending', 'answered', 'dismissed', 'expired')),
    CONSTRAINT valid_question_type CHECK (question_type IN (
        'ambiguous_merchant', 'category_confusion', 'spending_pattern', 'preference'
    ))
);

CREATE TABLE IF NOT EXISTS oggy_inquiry_preferences (
    user_id TEXT PRIMARY KEY,
    max_questions_per_day INTEGER NOT NULL DEFAULT 5,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    question_types_enabled TEXT[] DEFAULT ARRAY['ambiguous_merchant', 'category_confusion', 'spending_pattern', 'preference'],
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiries_user_status
    ON oggy_inquiries (user_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inquiries_user_date
    ON oggy_inquiries (user_id, generation_date);
CREATE INDEX IF NOT EXISTS idx_inquiries_expires
    ON oggy_inquiries (expires_at) WHERE status = 'pending';
