-- V3: Diet Agent tables

CREATE TABLE IF NOT EXISTS v3_diet_entries (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('food', 'liquid', 'vitamin', 'supplement')),
    description TEXT NOT NULL,
    quantity REAL,
    unit TEXT,
    meal_type TEXT CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack', 'other')),
    entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    entry_time TIME,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v3_diet_items (
    item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id UUID REFERENCES v3_diet_entries(entry_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    calories REAL,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL,
    fiber_g REAL,
    sugar_g REAL,
    sodium_mg REAL,
    custom_nutrients JSONB DEFAULT '{}',
    source TEXT DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v3_diet_rules (
    rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('goal', 'limit', 'preference', 'allergy', 'avoid')),
    description TEXT NOT NULL,
    target_nutrient TEXT,
    target_value REAL,
    target_unit TEXT,
    active BOOLEAN DEFAULT true,
    source TEXT DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v3_diet_chat_messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    oggy_response BOOLEAN DEFAULT false,
    used_memory BOOLEAN DEFAULT false,
    trace_id TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v3_entries_user_date ON v3_diet_entries(user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_v3_items_entry ON v3_diet_items(entry_id);
CREATE INDEX IF NOT EXISTS idx_v3_rules_user ON v3_diet_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_v3_chat_user ON v3_diet_chat_messages(user_id);
