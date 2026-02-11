-- Suggestion System Settings (Behavior Design Doc v0.2)
-- Separates clarifications (always on) from suggestions (opt-in with rate limiting)

-- Add suggestion columns to inquiry preferences
ALTER TABLE oggy_inquiry_preferences
    ADD COLUMN IF NOT EXISTS receive_suggestions BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS suggestion_interval_seconds INTEGER NOT NULL DEFAULT 900,
    ADD COLUMN IF NOT EXISTS last_suggestion_at TIMESTAMPTZ;

-- Add response_type to inquiries (clarification vs suggestion)
ALTER TABLE oggy_inquiries
    ADD COLUMN IF NOT EXISTS response_type TEXT NOT NULL DEFAULT 'clarification';

-- Allow new question types
ALTER TABLE oggy_inquiries DROP CONSTRAINT IF EXISTS valid_question_type;
ALTER TABLE oggy_inquiries ADD CONSTRAINT valid_question_type CHECK (question_type IN (
    'ambiguous_merchant', 'category_confusion', 'spending_pattern', 'preference',
    'uncategorized_expense', 'cost_cutting'
));

-- Suggestion telemetry
CREATE TABLE IF NOT EXISTS suggestion_telemetry (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suggestion_telemetry_user
    ON suggestion_telemetry (user_id, created_at DESC);
