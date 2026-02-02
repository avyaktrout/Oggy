-- =====================================================
-- Seed Data and Helper Views
-- Stage 0, Week 5: Initial data and utility views
-- =====================================================

-- =====================================================
-- Helper Views for Event Processing
-- =====================================================

-- View: Unprocessed events for domain knowledge
CREATE OR REPLACE VIEW unprocessed_domain_knowledge_events AS
SELECT
    event_id,
    ts,
    event_type,
    user_id,
    entity_type,
    entity_id,
    action,
    event_data
FROM app_events
WHERE NOT processed_for_domain_knowledge
  AND processing_errors IS NULL
ORDER BY ts ASC;

-- View: Unprocessed events for memory substrate
CREATE OR REPLACE VIEW unprocessed_memory_events AS
SELECT
    event_id,
    ts,
    event_type,
    user_id,
    entity_type,
    entity_id,
    action,
    event_data
FROM app_events
WHERE NOT processed_for_memory_substrate
  AND processing_errors IS NULL
ORDER BY ts ASC;

-- View: User spending summary
CREATE OR REPLACE VIEW user_spending_summary AS
SELECT
    user_id,
    COUNT(*) as expense_count,
    SUM(amount) as total_amount,
    AVG(amount) as avg_amount,
    MIN(transaction_date) as first_expense_date,
    MAX(transaction_date) as last_expense_date,
    COUNT(DISTINCT category) as category_count,
    COUNT(DISTINCT merchant) as merchant_count
FROM expenses
WHERE status = 'active'
GROUP BY user_id;

-- View: Category statistics per user
CREATE OR REPLACE VIEW user_category_stats AS
SELECT
    user_id,
    category,
    COUNT(*) as expense_count,
    SUM(amount) as total_amount,
    AVG(amount) as avg_amount,
    MIN(amount) as min_amount,
    MAX(amount) as max_amount,
    COUNT(DISTINCT merchant) as merchant_count
FROM expenses
WHERE status = 'active'
  AND category IS NOT NULL
GROUP BY user_id, category;

-- View: Merchant patterns per user
CREATE OR REPLACE VIEW user_merchant_patterns AS
SELECT
    user_id,
    merchant,
    category,
    COUNT(*) as visit_count,
    AVG(amount) as avg_amount,
    MIN(transaction_date) as first_visit,
    MAX(transaction_date) as last_visit,
    EXTRACT(DAYS FROM (MAX(transaction_date) - MIN(transaction_date))) as days_span
FROM expenses
WHERE status = 'active'
  AND merchant IS NOT NULL
GROUP BY user_id, merchant, category;

-- =====================================================
-- Seed Data: Initial domain knowledge for payments
-- =====================================================

-- Insert foundational categorization rules
INSERT INTO domain_knowledge (domain, topic, subtopic, content_text, source_type, source_ref, visibility, difficulty_band, tags)
VALUES
(
    'payments',
    'categorization',
    'merchant_rules',
    E'# Merchant Categorization Rules\n\n## Dining & Food\n- Restaurants, cafes, food trucks → "dining"\n- Grocery stores, supermarkets → "groceries"\n- Fast food chains → "dining"\n\n## Transportation\n- Gas stations → "transportation"\n- Public transit → "transportation"\n- Ride sharing services → "transportation"\n\n## Shopping\n- Department stores → "shopping"\n- Online retailers → "shopping"\n- Specialty stores → "shopping"\n\n## Utilities & Services\n- Electric, gas, water providers → "utilities"\n- Internet, phone providers → "utilities"\n- Insurance payments → "utilities"',
    'system_spec',
    'doc:categorization_rules_v1',
    'shareable',
    2,
    '["categorization", "merchants", "rules"]'::jsonb
),
(
    'payments',
    'categorization',
    'keyword_patterns',
    E'# Keyword-Based Categorization Patterns\n\n## Keywords that suggest specific categories:\n\n**Business/Work:**\n- "client", "meeting", "business", "conference", "team"\n→ Likely "business_meal" or "business_expense"\n\n**Entertainment:**\n- "movie", "concert", "show", "tickets", "entertainment"\n→ Likely "entertainment"\n\n**Health:**\n- "pharmacy", "doctor", "medical", "prescription", "health"\n→ Likely "health"\n\n**Personal Care:**\n- "salon", "spa", "gym", "fitness"\n→ Likely "personal_care"',
    'system_spec',
    'doc:categorization_keywords_v1',
    'shareable',
    2,
    '["categorization", "keywords", "patterns"]'::jsonb
),
(
    'payments',
    'spending_behavior',
    'recurring_patterns',
    E'# Recurring Expense Pattern Detection\n\n## Indicators of recurring expenses:\n1. Same merchant + similar amount + regular intervals (weekly/monthly)\n2. Merchant name contains: "subscription", "monthly", "annual"\n3. Amount variance < 10% across multiple transactions\n4. Time interval consistency: ±3 days for weekly, ±5 days for monthly\n\n## Common recurring categories:\n- utilities (monthly)\n- groceries (weekly)\n- dining (variable but frequent)\n- transportation (daily/weekly)',
    'system_spec',
    'doc:recurring_patterns_v1',
    'tessa_only',
    3,
    '["behavior", "patterns", "recurring"]'::jsonb
);

-- =====================================================
-- Seed Data: Sample expenses for testing
-- =====================================================

-- Test user expenses
INSERT INTO expenses (user_id, amount, currency, description, merchant, category, transaction_date, tags)
VALUES
    ('test_user_1', 12.50, 'USD', 'Morning coffee', 'Starbucks', 'dining', '2026-03-02', ARRAY['coffee', 'morning']),
    ('test_user_1', 85.00, 'USD', 'Weekly groceries', 'Whole Foods', 'groceries', '2026-03-03', ARRAY['groceries', 'weekly']),
    ('test_user_1', 45.00, 'USD', 'Client dinner', 'Italian Bistro', NULL, '2026-03-04', ARRAY['dinner', 'client']),
    ('test_user_1', 35.50, 'USD', 'Gas fill-up', 'Shell Station', 'transportation', '2026-03-04', ARRAY['gas']),
    ('test_user_1', 15.75, 'USD', 'Lunch', 'Chipotle', 'dining', '2026-03-05', ARRAY['lunch']),
    ('test_user_1', 120.00, 'USD', 'Monthly internet', 'Comcast', 'utilities', '2026-03-05', ARRAY['utilities', 'monthly']),
    ('test_user_1', 8.50, 'USD', 'Coffee meeting', 'Starbucks', 'dining', '2026-03-06', ARRAY['coffee', 'meeting']);

-- Generate initial app events for testing
INSERT INTO app_events (event_type, app_domain, user_id, entity_type, entity_id, action, event_data)
SELECT
    'EXPENSE_CREATED',
    'payments',
    user_id,
    'expense',
    expense_id,
    'create',
    jsonb_build_object(
        'expense_id', expense_id,
        'amount', amount,
        'merchant', merchant,
        'category', category,
        'description', description,
        'transaction_date', transaction_date
    )
FROM expenses
WHERE user_id = 'test_user_1';

-- =====================================================
-- Helper Functions
-- =====================================================

-- Function to mark event as processed for domain knowledge
CREATE OR REPLACE FUNCTION mark_event_processed_dk(p_event_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE app_events
    SET processed_for_domain_knowledge = TRUE,
        processed_at = COALESCE(processed_at, now())
    WHERE event_id = p_event_id;
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Function to mark event as processed for memory substrate
CREATE OR REPLACE FUNCTION mark_event_processed_memory(p_event_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE app_events
    SET processed_for_memory_substrate = TRUE,
        processed_at = COALESCE(processed_at, now())
    WHERE event_id = p_event_id;
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Function to record processing error
CREATE OR REPLACE FUNCTION record_processing_error(
    p_event_id UUID,
    p_error_type TEXT,
    p_error_message TEXT
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE app_events
    SET processing_errors = jsonb_build_object(
        'error_type', p_error_type,
        'error_message', p_error_message,
        'timestamp', now()
    )
    WHERE event_id = p_event_id;
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- Comments
-- =====================================================
COMMENT ON VIEW unprocessed_domain_knowledge_events IS 'Events waiting to be processed into domain_knowledge table';
COMMENT ON VIEW unprocessed_memory_events IS 'Events waiting to be processed into memory substrate';
COMMENT ON VIEW user_spending_summary IS 'High-level spending statistics per user';
COMMENT ON VIEW user_category_stats IS 'Category breakdown per user for analysis';
COMMENT ON VIEW user_merchant_patterns IS 'Merchant visit patterns and spending habits';
