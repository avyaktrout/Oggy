# Sealed Benchmarks with Out-of-Distribution Testing
## Scientific Evaluation & Overfitting Prevention

**Implemented:** 2026-02-03
**Status:** Active
**Purpose:** Measure true performance improvement without overfitting

---

## The Problem: Random Benchmarks Can't Measure Improvement

### What We Observed

In our 5-minute training test:
- **Before training:** Oggy +7.7% advantage over Base
- **After training:** Oggy +7.7% advantage over Base
- **Same result!** But why?

### Issues with Random Benchmarks

1. **Different Questions Each Time**
   - Can't compare before/after directly
   - Random variation dominates signal
   - Easy set vs hard set creates false patterns

2. **In-Distribution Bias**
   - If benchmarks use similar generation as training
   - AI might overfit to generation patterns
   - Not to actual categorization skill!

3. **No Ground Truth**
   - Can't tell if improvement is real
   - Or just lucky question selection

---

## The Solution: Sealed + Out-of-Distribution Benchmarks

### Two-Part Strategy

#### 1. Sealed Benchmarks 🔒
**Fixed question sets tested before/after training**

```
Create Once → Test Many Times
├─ Same questions every time
├─ True before/after comparison
├─ No data leakage
└─ Scientific measurement
```

**Benefits:**
- ✅ True A/B testing
- ✅ Reproducible results
- ✅ Measure real improvement
- ✅ Track progress over time

#### 2. Out-of-Distribution (OOD) Testing 🌍
**Different generator prevents overfitting**

```
Training: Tessa uses GPT-4o-mini
Testing:  Sealed benchmarks use Claude

├─ Different model family
├─ Different generation patterns
├─ Different writing style
└─ Tests true generalization!
```

**Benefits:**
- ✅ Prevents overfitting to Tessa's patterns
- ✅ Tests real categorization ability
- ✅ Ensures model generalizes
- ✅ Scientific rigor

---

## How It Works

### Architecture

```
┌──────────────────────────────────────┐
│         TRAINING PHASE               │
├──────────────────────────────────────┤
│  Tessa (GPT-4o-mini)                │
│  ├─ Generates training scenarios     │
│  ├─ 5-tier adaptive difficulty       │
│  ├─ Adds to domain knowledge         │
│  └─ Oggy trains on these             │
└──────────────────────────────────────┘
            ↓
    (Training happens)
            ↓
┌──────────────────────────────────────┐
│         TESTING PHASE                │
├──────────────────────────────────────┤
│  Sealed Benchmarks (Claude)          │
│  ├─ Fixed question set               │
│  ├─ OOD generator (different!)       │
│  ├─ Never seen during training       │
│  └─ Test on same set before/after    │
└──────────────────────────────────────┘
```

### Key Principles

1. **Sealed = Fixed**
   - Created once
   - Never modified
   - Same IDs for tracking
   - Never used for training

2. **OOD = Different Generator**
   - Training: GPT-4o-mini
   - Testing: Claude Haiku
   - Prevents pattern memorization
   - Tests true understanding

3. **Scientific Method**
   - Baseline test (before training)
   - Training period
   - Follow-up test (same sealed set)
   - Measure delta

---

## Creating Sealed Benchmarks

### API: Create OOD Sealed Benchmark

```bash
# Create 100-question sealed benchmark using Claude
curl -X POST http://localhost:3001/v0/sealed-benchmark/create \
  -H "Content-Type: application/json" \
  -d '{
    "count": 100,
    "name": "ood_eval_v1",
    "description": "Out-of-distribution evaluation set v1",
    "difficulty_mix": "balanced",
    "use_ood": true
  }'
```

**Response:**
```json
{
  "benchmark_id": "uuid-here",
  "benchmark_name": "ood_eval_v1",
  "scenarios_count": 100,
  "errors_count": 0,
  "use_ood": true,
  "message": "Sealed benchmark created with 100 scenarios"
}
```

### Parameters

**count** (10-500): Number of test scenarios
**name** (optional): Unique name for benchmark
**description** (optional): What this benchmark tests
**difficulty_mix**:
  - `balanced`: 25% easy, 25% medium, 25% hard, 25% very_hard
  - `easy`: All easy scenarios
  - `hard`: Mix of hard/very_hard
  - `mixed`: Progressive difficulty (easy→very_hard)

**use_ood** (boolean):
  - `true`: Use Claude (OOD - recommended!)
  - `false`: Use GPT-style (in-distribution control)

---

## Testing on Sealed Benchmarks

### API: Test on Sealed Benchmark

```bash
# Test Oggy vs Base on sealed benchmark
curl -X POST http://localhost:3001/v0/sealed-benchmark/test \
  -H "Content-Type: application/json" \
  -d '{
    "benchmark_name": "ood_eval_v1",
    "user_id": "comprehensive_test_1770066242"
  }'
```

**Response:**
```json
{
  "result_id": "uuid",
  "benchmark_id": "uuid",
  "benchmark_name": "ood_eval_v1",
  "oggy": {
    "correct": 67,
    "total": 100,
    "accuracy": 0.67
  },
  "base": {
    "correct": 52,
    "total": 100,
    "accuracy": 0.52
  },
  "comparison": {
    "advantage_delta": 0.15,
    "advantage_percent": 28.85,
    "verdict": "OGGY_BETTER"
  },
  "training_state": {
    "domain_knowledge_count": 280,
    "baseline_scale": 90,
    "scale_status": "extreme"
  },
  "report": "..."
}
```

---

## Tracking Improvement Over Time

### API: Compare Over Time

```bash
# See improvement across multiple tests
curl -X POST http://localhost:3001/v0/sealed-benchmark/compare-over-time \
  -H "Content-Type: application/json" \
  -d '{
    "benchmark_identifier": "ood_eval_v1",
    "user_id": "comprehensive_test_1770066242"
  }'
```

**Response:**
```json
{
  "benchmark_name": "ood_eval_v1",
  "benchmark_id": "uuid",
  "user_id": "comprehensive_test_1770066242",
  "tests": [
    {
      "result_id": "uuid1",
      "tested_at": "2026-02-03T01:00:00Z",
      "oggy_accuracy": 0.52,
      "advantage_percent": 10.2
    },
    {
      "result_id": "uuid2",
      "tested_at": "2026-02-03T02:00:00Z",
      "oggy_accuracy": 0.58,
      "advantage_percent": 18.5
    },
    {
      "result_id": "uuid3",
      "tested_at": "2026-02-03T03:00:00Z",
      "oggy_accuracy": 0.67,
      "advantage_percent": 28.8
    }
  ],
  "improvement": {
    "oggy_accuracy_change": 0.15,
    "advantage_change": 18.6,
    "tests_count": 3,
    "time_span_days": 0.08
  },
  "message": "Performance improved by 18.6% over 3 tests"
}
```

---

## Scientific Testing Protocol

### Recommended Workflow

**Step 1: Create Sealed Benchmark (Once)**
```bash
curl -X POST http://localhost:3001/v0/sealed-benchmark/create \
  -d '{
    "count": 100,
    "name": "scientific_eval_v1",
    "use_ood": true,
    "difficulty_mix": "balanced"
  }'
```

**Step 2: Baseline Test (Before Training)**
```bash
curl -X POST http://localhost:3001/v0/sealed-benchmark/test \
  -d '{
    "benchmark_name": "scientific_eval_v1",
    "user_id": "user_123"
  }'

# Result: Oggy 52%, Base 48%, +8.3% advantage
```

**Step 3: Training Period**
```bash
# Run 1-hour training session
curl -X POST http://localhost:3001/v0/learning/start \
  -d '{"user_id":"user_123","interval":30000,"practice_count":10}'

# Wait 1 hour...

curl -X POST http://localhost:3001/v0/learning/stop
```

**Step 4: Post-Training Test (Same Sealed Set!)**
```bash
curl -X POST http://localhost:3001/v0/sealed-benchmark/test \
  -d '{
    "benchmark_name": "scientific_eval_v1",
    "user_id": "user_123"
  }'

# Result: Oggy 68%, Base 48%, +41.7% advantage
# TRUE IMPROVEMENT: +33.4 percentage points!
```

**Step 5: Track Progress**
```bash
curl -X POST http://localhost:3001/v0/sealed-benchmark/compare-over-time \
  -d '{"benchmark_identifier":"scientific_eval_v1","user_id":"user_123"}'

# Shows improvement curve over time
```

---

## Preventing Overfitting

### Why This Design Prevents Overfitting

#### Problem: Model Memorizes Generator Patterns

```
Bad Scenario:
Training: GPT generates "The Coffee Shop" → groceries
Testing:  GPT generates "The Coffee Shop" → groceries
Result:   Model learns "The X Y" pattern, not categorization!
```

#### Solution: Different Generators

```
Good Scenario:
Training: GPT generates "The Coffee Shop" → groceries
Testing:  Claude generates "Morning Brew Cafe" → groceries
Result:   Model must understand "cafe purchases" concept!
```

### OOD Benefits

**1. Different Vocabulary**
- GPT: "The Coffee Shop", "Joe's Diner"
- Claude: "Morning Brew Cafe", "Riverside Restaurant"

**2. Different Descriptions**
- GPT: "Coffee and pastry purchase"
- Claude: "Purchased beverages and baked goods"

**3. Different Patterns**
- Tests true categorization ability
- Not pattern matching to generator

**4. Scientific Rigor**
- Industry standard practice
- Used in ML research
- Ensures generalization

---

## Comparison: Random vs Sealed Benchmarks

### Random Benchmarks (Previous System)

```
Test 1: Generate 30 random questions → Test
Test 2: Generate 30 different random questions → Test

Result: Can't compare directly!
- Different questions
- Different difficulty
- Random variation
```

**Problems:**
- ❌ Can't measure improvement
- ❌ High variance
- ❌ No reproducibility

### Sealed Benchmarks (New System)

```
Create: Generate 100 fixed questions (once)
Test 1: Test on same 100 questions
Test 2: Test on same 100 questions

Result: Direct comparison!
- Same questions
- Same difficulty
- True delta
```

**Benefits:**
- ✅ Measure real improvement
- ✅ Low variance
- ✅ Fully reproducible
- ✅ Scientific standard

---

## Database Schema

### Tables Created

**sealed_benchmarks**
```sql
- benchmark_id (UUID, primary key)
- benchmark_name (TEXT, unique)
- description (TEXT)
- scenario_count (INTEGER)
- use_ood (BOOLEAN) -- True = Claude, False = GPT-style
- difficulty_mix (TEXT)
- created_at (TIMESTAMPTZ)
- metadata (JSONB)
```

**sealed_benchmark_scenarios**
```sql
- scenario_id (UUID, primary key)
- benchmark_id (UUID, foreign key)
- order_index (INTEGER)
- merchant (TEXT)
- amount (DECIMAL)
- description (TEXT)
- correct_category (TEXT)
- reasoning (TEXT)
- generator (TEXT) -- 'claude', 'gpt-style'
- model (TEXT) -- Actual model used
```

**sealed_benchmark_results**
```sql
- result_id (UUID, primary key)
- benchmark_id (UUID, foreign key)
- user_id (TEXT)
- tested_at (TIMESTAMPTZ)
- oggy_correct (INTEGER)
- oggy_accuracy (DECIMAL)
- base_correct (INTEGER)
- base_accuracy (DECIMAL)
- advantage_delta (DECIMAL)
- advantage_percent (DECIMAL)
- training_state (JSONB)
- detailed_results (JSONB)
```

---

## API Reference

### POST /v0/sealed-benchmark/create
Create new sealed benchmark

**Body:**
```json
{
  "count": 100,
  "name": "benchmark_name",
  "description": "optional description",
  "difficulty_mix": "balanced",
  "use_ood": true
}
```

### GET /v0/sealed-benchmark/list
List all sealed benchmarks

**Response:** Array of benchmarks with metadata

### GET /v0/sealed-benchmark/:identifier
Get specific benchmark (by ID or name)

**Response:** Full benchmark with all scenarios

### POST /v0/sealed-benchmark/test
Test Oggy vs Base on sealed benchmark

**Body:**
```json
{
  "benchmark_id": "uuid", // or benchmark_name
  "user_id": "user_123"
}
```

**Response:** Complete test results with comparison

### GET /v0/sealed-benchmark/results/:benchmark_identifier
Get all historical results for a benchmark

**Response:** Array of all test results

### POST /v0/sealed-benchmark/compare-over-time
Track improvement across multiple tests

**Body:**
```json
{
  "benchmark_identifier": "name_or_id",
  "user_id": "user_123"
}
```

**Response:** Improvement analysis with timeline

---

## Best Practices

### 1. Create Multiple Sealed Benchmarks

```bash
# Easy set (baseline skill check)
curl -X POST .../create -d '{"count":50,"name":"easy_eval","difficulty_mix":"easy","use_ood":true}'

# Balanced set (general evaluation)
curl -X POST .../create -d '{"count":100,"name":"balanced_eval","difficulty_mix":"balanced","use_ood":true}'

# Hard set (expert evaluation)
curl -X POST .../create -d '{"count":100,"name":"hard_eval","difficulty_mix":"hard","use_ood":true}'
```

### 2. Test Regularly

```bash
# Daily testing schedule
0 9 * * * curl .../test -d '{"benchmark_name":"balanced_eval","user_id":"prod_user"}'
```

### 3. Compare Across Benchmarks

```
Easy Eval:     Track if basics are maintained
Balanced Eval: Track overall improvement
Hard Eval:     Track expert-level growth
```

### 4. Use OOD for Production Validation

```bash
# Always use OOD (Claude) for final evaluation
curl -X POST .../create -d '{"use_ood":true,...}'
```

### 5. Never Train on Sealed Benchmarks!

```
IMPORTANT: Sealed benchmarks must NEVER be added to training data!

They are stored in separate tables:
- sealed_benchmarks (not domain_knowledge)
- sealed_benchmark_scenarios (not training examples)

This ensures no data leakage!
```

---

## Example: Full Scientific Evaluation

### Scenario: Measure 1-Week Training Impact

**Monday (Baseline):**
```bash
# Create sealed benchmark
curl -X POST http://localhost:3001/v0/sealed-benchmark/create \
  -d '{"count":100,"name":"week1_eval","use_ood":true,"difficulty_mix":"balanced"}'

# Baseline test
curl -X POST http://localhost:3001/v0/sealed-benchmark/test \
  -d '{"benchmark_name":"week1_eval","user_id":"user_123"}'

# Result: Oggy 52%, Base 48%, +8.3% advantage
```

**Monday-Friday (Training):**
```bash
# Daily 2-hour training sessions
# (automated or manual)
```

**Friday (Evaluation):**
```bash
# Test on SAME sealed benchmark
curl -X POST http://localhost:3001/v0/sealed-benchmark/test \
  -d '{"benchmark_name":"week1_eval","user_id":"user_123"}'

# Result: Oggy 73%, Base 48%, +52.1% advantage
# IMPROVEMENT: +43.8 percentage points in 1 week!
```

**Analysis:**
```bash
# Get improvement timeline
curl -X POST http://localhost:3001/v0/sealed-benchmark/compare-over-time \
  -d '{"benchmark_identifier":"week1_eval","user_id":"user_123"}'

# Shows day-by-day improvement curve
```

---

## Cost Analysis

### Creating Sealed Benchmarks

**100 scenarios using Claude Haiku:**
```
Cost per scenario: ~$0.0002
Total cost: 100 × $0.0002 = $0.02
```

**Creating is cheap! Do it often!**

### Testing on Sealed Benchmarks

**100 scenarios × 2 models (Oggy + Base):**
```
Cost per test: ~200 categorizations × $0.0015 = $0.30
```

**Testing is also cheap!**

### ROI

```
Investment:
- Create benchmark: $0.02 (once)
- Test 10 times: $3.00
- Total: $3.02

Value:
- Scientific measurement of improvement
- Prevent overfitting
- Track progress over time
- Confidence in production deployment

ROI: Priceless! 💎
```

---

## Roadmap

### Phase 1: Basic Sealed Benchmarks ✅
- ✅ Create fixed question sets
- ✅ Test on same set multiple times
- ✅ Track results over time

### Phase 2: OOD Testing ✅
- ✅ Use different generator (Claude)
- ✅ Prevent overfitting to Tessa
- ✅ Test true generalization

### Phase 3: Advanced Features (Future)
- ⏳ Multiple OOD generators (GPT, Claude, Gemini)
- ⏳ Category-specific sealed benchmarks
- ⏳ Difficulty-stratified evaluation
- ⏳ Confidence calibration analysis
- ⏳ A/B testing framework

---

## Summary

**What We Built:**
- ✅ Sealed benchmark system (fixed questions)
- ✅ OOD generation (Claude vs GPT)
- ✅ Scientific testing protocol
- ✅ Overfitting prevention
- ✅ Progress tracking over time
- ✅ Complete API for evaluation

**Why It Matters:**
- Random benchmarks can't measure improvement
- Same-generator testing causes overfitting
- Sealed + OOD = scientific rigor
- Industry standard practice
- Confidence in production deployment

**Result:**
True measurement of AI improvement with scientific validity and overfitting prevention!

---

**Status:** ✅ Implemented and ready to use!

**Next:** Create your first sealed benchmark and start tracking true improvement!

```bash
curl -X POST http://localhost:3001/v0/sealed-benchmark/create \
  -H "Content-Type: application/json" \
  -d '{
    "count": 100,
    "name": "my_first_sealed_eval",
    "description": "My first OOD evaluation set",
    "use_ood": true,
    "difficulty_mix": "balanced"
  }'
```

---

**Created:** 2026-02-03
**Files:** sealedBenchmarkGenerator.js, sealedBenchmarkEvaluator.js, sealedBenchmark.js (routes)
**Database:** 008_sealed_benchmarks.sql
**Status:** Production Ready
