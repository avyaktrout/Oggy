-- Sealed Benchmarks Schema
-- Fixed test sets for scientific evaluation
-- Week 8: Preventing overfitting with OOD testing

-- Sealed benchmark metadata table
CREATE TABLE IF NOT EXISTS sealed_benchmarks (
    benchmark_id UUID PRIMARY KEY,
    benchmark_name TEXT NOT NULL UNIQUE,
    description TEXT,
    scenario_count INTEGER NOT NULL,
    use_ood BOOLEAN NOT NULL DEFAULT true, -- Out-of-distribution (Claude) vs in-distribution (GPT-style)
    difficulty_mix TEXT NOT NULL, -- 'balanced', 'easy', 'hard', 'mixed'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB,

    CONSTRAINT valid_difficulty_mix CHECK (difficulty_mix IN ('balanced', 'easy', 'hard', 'mixed'))
);

-- Individual scenarios in sealed benchmarks
CREATE TABLE IF NOT EXISTS sealed_benchmark_scenarios (
    scenario_id UUID PRIMARY KEY,
    benchmark_id UUID NOT NULL REFERENCES sealed_benchmarks(benchmark_id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL, -- Preserves original order

    -- Scenario data
    merchant TEXT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    description TEXT NOT NULL,
    correct_category TEXT NOT NULL,
    reasoning TEXT,

    -- Generation metadata
    generator TEXT NOT NULL, -- 'claude', 'gpt-style', etc.
    model TEXT NOT NULL, -- Model used to generate

    -- Ensure unique order within benchmark
    CONSTRAINT unique_scenario_order UNIQUE (benchmark_id, order_index),

    -- Validate category
    CONSTRAINT valid_category CHECK (correct_category IN (
        'business_meal', 'groceries', 'transportation', 'utilities',
        'entertainment', 'health', 'dining', 'shopping'
    ))
);

-- Test results against sealed benchmarks
CREATE TABLE IF NOT EXISTS sealed_benchmark_results (
    result_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    benchmark_id UUID NOT NULL REFERENCES sealed_benchmarks(benchmark_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    tested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Aggregate results
    total_scenarios INTEGER NOT NULL,
    oggy_correct INTEGER NOT NULL,
    oggy_accuracy DECIMAL(5, 4) NOT NULL,
    base_correct INTEGER NOT NULL,
    base_accuracy DECIMAL(5, 4) NOT NULL,

    -- Comparison
    advantage_delta DECIMAL(5, 4) NOT NULL, -- Oggy - Base accuracy
    advantage_percent DECIMAL(5, 2) NOT NULL, -- (Oggy / Base - 1) * 100

    -- Metadata
    training_state JSONB, -- Baseline scale, knowledge count, etc. at test time
    detailed_results JSONB -- Per-scenario results
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_sealed_benchmarks_name ON sealed_benchmarks(benchmark_name);
CREATE INDEX IF NOT EXISTS idx_sealed_benchmark_scenarios_benchmark ON sealed_benchmark_scenarios(benchmark_id);
CREATE INDEX IF NOT EXISTS idx_sealed_benchmark_results_benchmark ON sealed_benchmark_results(benchmark_id);
CREATE INDEX IF NOT EXISTS idx_sealed_benchmark_results_user ON sealed_benchmark_results(user_id, tested_at DESC);

-- Comments
COMMENT ON TABLE sealed_benchmarks IS 'Fixed benchmark sets for scientific evaluation - never used for training';
COMMENT ON TABLE sealed_benchmark_scenarios IS 'Individual test scenarios in sealed benchmarks';
COMMENT ON TABLE sealed_benchmark_results IS 'Historical results of testing against sealed benchmarks';
COMMENT ON COLUMN sealed_benchmarks.use_ood IS 'True = out-of-distribution (Claude), False = in-distribution (GPT-style)';
COMMENT ON COLUMN sealed_benchmark_scenarios.generator IS 'Model family used to generate (prevents overfitting to single generator)';
