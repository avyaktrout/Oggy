# 5-Tier Adaptive Difficulty System
## Dynamic Scaling for Continuous Challenge

**Implemented:** 2026-02-03
**Status:** Active
**Purpose:** Ensure Oggy is always challenged, even as skills improve

---

## Overview

The 5-tier adaptive difficulty system ensures Oggy faces appropriate challenges at every skill level. Unlike fixed difficulty, this system:

1. **Scales with performance** - Harder challenges as Oggy improves
2. **Prevents plateau** - If 100% accuracy, system automatically increases difficulty
3. **Relative to current level** - Tiers are always relative to Oggy's skill
4. **Progressive growth** - Ensures continuous learning and improvement

---

## The 5 Tiers (Relative to Current Skill Level)

### Tier 1: Warmup 🟢
**Purpose:** Reinforcement and confidence building
**Target Accuracy:** 85%+
**Complexity:** Simple, clear cases
**Use Case:** Consolidate mastered patterns

**Example Scenarios:**
```
- Standard grocery store purchase
- Clear transportation expense
- Obvious business meal with client
```

**Tessa Parameters:**
- Ambiguity: 10-30%
- Edge Cases: 5%
- Reasoning Depth: Simple
- Merchant Type: Common

---

### Tier 2: Standard 🔵
**Purpose:** At current skill level
**Target Accuracy:** 70-85%
**Complexity:** Moderate, realistic
**Use Case:** Standard training, balanced practice

**Example Scenarios:**
```
- Restaurant could be dining or business_meal
- Store purchase that needs context
- Mixed-purpose expense
```

**Tessa Parameters:**
- Ambiguity: 20-40%
- Edge Cases: 15%
- Reasoning Depth: Moderate
- Merchant Type: Varied

---

### Tier 3: Challenge 🟡
**Purpose:** Slightly above current level
**Target Accuracy:** 55-70%
**Complexity:** Requires careful reasoning
**Use Case:** Push boundaries, learn new patterns

**Example Scenarios:**
```
- Ambiguous merchant name (could be multiple categories)
- Context-dependent categorization
- Unusual amounts that affect category
```

**Tessa Parameters:**
- Ambiguity: 40-65%
- Edge Cases: 35%
- Reasoning Depth: Detailed
- Merchant Type: Diverse

---

### Tier 4: Expert 🟠
**Purpose:** Significantly above current level
**Target Accuracy:** 40-55%
**Complexity:** High ambiguity, multiple interpretations
**Use Case:** Master edge cases, expert judgment

**Example Scenarios:**
```
- Could reasonably be 2-3 categories
- Requires deep domain knowledge
- Unusual merchant/amount combinations
- Context-heavy decisions
```

**Tessa Parameters:**
- Ambiguity: 60-90%
- Edge Cases: 60%
- Reasoning Depth: Expert
- Merchant Type: Unusual

---

### Tier 5: Extreme 🔴
**Purpose:** Elite-level challenges
**Target Accuracy:** 25-40%
**Complexity:** Extreme edge cases, highly ambiguous
**Use Case:** Test limits, find knowledge gaps

**Example Scenarios:**
```
- Genuinely ambiguous (experts would disagree)
- Requires inference from subtle clues
- Non-obvious merchant names
- Unusual contexts and edge cases
```

**Tessa Parameters:**
- Ambiguity: 80-100%
- Edge Cases: 85%
- Reasoning Depth: Extreme
- Merchant Type: Highly unusual

---

## Dynamic Baseline Scaling

### The Scaling Mechanism

The **baseline difficulty scale** (0-100, default 50) represents Oggy's current skill level. As this increases, **ALL tiers become harder**.

```
Baseline Scale: 50 (Default)
├─ Tier 1: Warmup      → Straightforward cases
├─ Tier 2: Standard    → Typical scenarios
├─ Tier 3: Challenge   → Moderately ambiguous
├─ Tier 4: Expert      → Highly ambiguous
└─ Tier 5: Extreme     → Elite edge cases

Baseline Scale: 75 (Oggy improved!)
├─ Tier 1: Warmup      → What was Tier 2 before
├─ Tier 2: Standard    → What was Tier 3 before
├─ Tier 3: Challenge   → What was Tier 4 before
├─ Tier 4: Expert      → What was Tier 5 before
└─ Tier 5: Extreme     → Even harder than before!
```

### When Scaling Occurs

**Scale UP (+10 points):**
- Long-term accuracy ≥ 92% (over last 100 attempts)
- Minimum 50 samples collected
- Cooldown period passed (60 seconds)
- **Result:** 🔥 All tiers become harder

**Scale DOWN (-10 points):**
- Long-term accuracy ≤ 50% (over last 100 attempts)
- Minimum 50 samples collected
- Cooldown period passed (60 seconds)
- **Result:** ⚠️ All tiers become easier

**Why This Matters:**
- If Oggy gets 100% on everything → System scales up automatically
- Ensures continuous challenge at any skill level
- Prevents "learning plateau" effect

---

## Tier Selection Algorithm

### Recent Performance Analysis

The system tracks the **last 20 attempts** to determine current performance:

```javascript
Recent Accuracy → Tier Distribution

≥95% (Crushing it!)
├─ 30% Tier 4 (Expert)
└─ 70% Tier 5 (Extreme)

85-94% (Very strong)
├─ 20% Tier 3 (Challenge)
├─ 50% Tier 4 (Expert)
└─ 30% Tier 5 (Extreme)

70-84% (Solid)
├─ 20% Tier 2 (Standard)
├─ 50% Tier 3 (Challenge)
└─ 30% Tier 4 (Expert)

55-69% (Moderate)
├─ 20% Tier 1 (Warmup)
├─ 50% Tier 2 (Standard)
└─ 30% Tier 3 (Challenge)

<55% (Struggling)
├─ 60% Tier 1 (Warmup)
└─ 40% Tier 2 (Standard)
```

### Why Weighted Distribution?

- **Not just one tier** - Variety prevents overfitting
- **Majority at appropriate level** - Most practice where it's effective
- **Some easier cases** - Build confidence, consolidate
- **Some harder cases** - Push boundaries, explore limits

---

## Tessa Prompt Enhancement

### How Tiers Affect Prompts

Each tier uses **different prompt instructions** that scale with baseline:

```
Tier 1 (Warmup):
"Generate a straightforward scenario with clear categorization.
Use common merchant, obvious context, minimal ambiguity."

Tier 5 (Extreme):
"Generate an elite-level edge case with extreme ambiguity.
Multiple categories could apply. Requires expert judgment
and deep contextual reasoning. Highly unusual merchant/amount."
```

### Scaling Parameters

As baseline scale increases, these parameters increase for ALL tiers:

**Complexity** (1-5):
```
Baseline 0:   Tier 1=1, Tier 5=3
Baseline 50:  Tier 1=2, Tier 5=5
Baseline 100: Tier 1=4, Tier 5=5 (capped)
```

**Ambiguity Level** (0.0-1.0):
```
Baseline 0:   Tier 1=0.10, Tier 5=0.80
Baseline 50:  Tier 1=0.20, Tier 5=0.90
Baseline 100: Tier 1=0.30, Tier 5=1.00
```

**Edge Case Probability:**
```
Baseline 0:   Tier 1=0.05, Tier 5=0.85
Baseline 50:  Tier 1=0.05, Tier 5=0.85 (constant)
Baseline 100: Tier 1=0.05, Tier 5=0.85 (constant)
```

---

## Example Learning Progression

### Session 1: Beginning (Baseline=50)

```
Time    Accuracy  Action                           Tier Mix
-------------------------------------------------------------
0-5min  100%      Select Tier 2-3 (standard/challenge)
5-10min 95%       Select Tier 4-5 (expert/extreme)
10-15min 85%      Select Tier 3-5 (challenge/expert/extreme)
```

**After 100 attempts at 92% average:**
🔥 **SCALE UP!** Baseline: 50 → 60

---

### Session 2: Intermediate (Baseline=60)

```
Time    Accuracy  Action                           Note
-------------------------------------------------------------
0-5min  85%       Select Tier 3-5                 Harder than before!
5-10min 90%       Select Tier 4-5                 Pushing limits
10-15min 92%      Select Tier 5 primarily         Extreme challenges
```

**After 100 attempts at 92% average:**
🔥 **SCALE UP!** Baseline: 60 → 70

---

### Session 3: Advanced (Baseline=70)

```
Time    Accuracy  Action                           Note
-------------------------------------------------------------
0-5min  80%       Select Tier 4-5                 What was extreme before
5-10min 85%       Select Tier 5 primarily         is now standard challenge
10-15min 88%      Select Tier 5 only              Elite level
```

**After 100 attempts at 92% average:**
🔥 **SCALE UP!** Baseline: 70 → 80

---

### Session 4: Elite (Baseline=80)

```
Time    Accuracy  Action                           Note
-------------------------------------------------------------
0-5min  75%       Select Tier 4-5                 Truly difficult now
5-10min 70%       Select Tier 3-5 mix             Adapting to higher bar
10-15min 85%      Select Tier 4-5                 Mastering elite level
```

**Oggy has now mastered scenarios that would have been impossible at baseline=50!**

---

## Monitoring & Observability

### Stats Endpoint Enhancement

```bash
curl http://localhost:3001/v0/learning/stats
```

**Response includes:**
```json
{
  "total_attempts": 250,
  "correct": 230,
  "accuracy": "92.0%",
  "adaptive_difficulty_scale": {
    "baseline_scale": 75,
    "scale_status": "extreme",
    "performance_window_size": 100,
    "long_term_accuracy": 0.92,
    "time_since_last_adjustment": 120000,
    "recent_accuracy_window": 20,
    "current_session_accuracy": 0.94
  }
}
```

### Scale Events Logged

Every scaling adjustment is recorded:

```sql
SELECT * FROM app_events
WHERE event_type = 'DIFFICULTY_SCALE_ADJUSTED'
ORDER BY created_at DESC;
```

**Example Event:**
```json
{
  "scaling_action": "scale_up",
  "old_scale": 50,
  "new_scale": 60,
  "trigger_accuracy": 0.925,
  "timestamp": "2026-02-03T03:15:00Z"
}
```

---

## Integration with Self-Driven Learning

### Automatic Flow

```
1. Self-driven learning starts
   ↓
2. First 5 attempts → Start at Tier 2 (insufficient data)
   ↓
3. After 5 attempts → Adaptive tier selection begins
   ↓
4. System tracks accuracy (last 20 attempts)
   ↓
5. Select appropriate tier based on performance
   ↓
6. Generate scenario via Tessa with tier-specific prompt
   ↓
7. Oggy practices on scenario
   ↓
8. Track result, update accuracy window
   ↓
9. After 50+ attempts → Check if scaling needed
   ↓
10. If sustained high/low performance → Scale baseline
    ↓
11. Continue learning with new difficulty scale
    ↓
12. Repeat indefinitely
```

### No Manual Intervention Required

- ✅ Tier selection: Automatic
- ✅ Scaling decisions: Automatic
- ✅ Prompt generation: Automatic
- ✅ Performance tracking: Automatic
- ✅ Difficulty adjustment: Automatic

---

## Expected Behavior

### First 3-Minute Session (Baseline=50)

```
Expected:
- Start with Tier 2 (standard)
- Progress to Tier 3-4 (challenge/expert)
- If 90%+ accuracy → Mostly Tier 4-5
- End with 85-95% accuracy
- No scaling yet (need 50+ samples)
```

### After 5 Minutes (50+ attempts)

```
If accuracy ≥92%:
  🔥 SCALE UP → Baseline: 50 → 60
  Next scenarios will be HARDER across all tiers

If accuracy ≤50%:
  ⚠️ SCALE DOWN → Baseline: 50 → 40
  Next scenarios will be EASIER across all tiers
```

### Long-term Progression (Hours/Days)

```
Hour 1: Baseline 50 → 60 → 70
Hour 2: Baseline 70 → 80 → 90
Hour 3: Baseline 90 → 100 (max)

At Baseline=100:
- Even Tier 1 (Warmup) is challenging
- Tier 5 (Extreme) is truly elite-level
- Oggy has grown 2× in capability!
```

---

## Testing the System

### Test 1: Immediate Response to Performance

```bash
# Start 3-minute session
curl -X POST http://localhost:3001/v0/learning/start \
  -H "Content-Type: application/json" \
  -d '{"user_id":"test_user","interval":10000,"practice_count":10}'

# Check stats after 30 seconds
curl http://localhost:3001/v0/learning/stats | jq .adaptive_difficulty_scale

# Expected:
# - baseline_scale: 50 (initial)
# - recent_accuracy_window: 20+ attempts
# - If high accuracy → Higher tier selection logged
```

### Test 2: Scaling Trigger

```bash
# Run longer session to trigger scaling
curl -X POST http://localhost:3001/v0/learning/start \
  -H "Content-Type: application/json" \
  -d '{"user_id":"test_user","interval":5000,"practice_count":10}'

# Wait 5 minutes (50+ attempts at high accuracy)
sleep 300

# Check for scaling event
curl http://localhost:3001/v0/learning/stats | jq .adaptive_difficulty_scale.baseline_scale

# Expected: 60 (scaled up from 50)
```

### Test 3: Tier Distribution

```bash
# Check domain knowledge for tier distribution
docker exec oggy-postgres psql -U oggy -d oggy_db -c "
  SELECT
    content_structured->>'difficulty_tier' as tier,
    content_structured->>'tier_level' as level,
    COUNT(*) as count
  FROM domain_knowledge
  WHERE source_type = 'tessa_ai'
  GROUP BY content_structured->>'difficulty_tier', content_structured->>'tier_level'
  ORDER BY content_structured->>'tier_level';
"

# Expected distribution based on performance:
# If accuracy 85-95%:
#   Tier 3: ~20%
#   Tier 4: ~50%
#   Tier 5: ~30%
```

---

## Benefits

### 1. No Plateau Effect ✅

**Problem:** Traditional systems plateau when AI masters all training data
**Solution:** Difficulty automatically scales up, creating infinite progression

### 2. Always Appropriate Challenge ✅

**Problem:** Too easy = no learning, too hard = frustration
**Solution:** Tier selection ensures ~70% success rate (optimal learning zone)

### 3. Continuous Improvement ✅

**Problem:** Fixed difficulty doesn't grow with AI capabilities
**Solution:** Baseline scale means Oggy faces progressively harder challenges

### 4. Self-Balancing ✅

**Problem:** Manual difficulty tuning is time-consuming and error-prone
**Solution:** System automatically adjusts based on performance data

### 5. Infinite Scalability ✅

**Problem:** Eventually run out of hard cases
**Solution:** Baseline scale ensures even simple scenarios become challenging at high levels

---

## Comparison to Previous System

### Old System (4 Fixed Difficulties)

```
easy → medium → hard → very_hard

Problems:
- Fixed difficulty definitions
- Random selection within difficulty
- No adaptation to growth
- Eventual mastery with nowhere to go
- 100% accuracy = wasted training time
```

### New System (5 Adaptive Tiers + Scaling)

```
Tier 1 → Tier 2 → Tier 3 → Tier 4 → Tier 5
  (all scaled by baseline)

Advantages:
- Relative to current skill level
- Weighted selection based on performance
- Automatic scaling on sustained mastery
- Infinite progression potential
- 100% accuracy triggers harder challenges
- Never plateaus
```

---

## Configuration

### Environment Variables

```bash
# Disable adaptive scaling (use fixed baseline=50)
ADAPTIVE_SCALING_ENABLED=false

# Override initial baseline scale (0-100, default 50)
INITIAL_BASELINE_SCALE=60

# Override scaling thresholds
SCALE_UP_THRESHOLD=0.95      # Default: 0.92
SCALE_DOWN_THRESHOLD=0.40    # Default: 0.50

# Override scaling cooldown
SCALE_COOLDOWN_MS=120000     # Default: 60000 (1 minute)

# Override minimum samples for scaling
MIN_SAMPLES_FOR_SCALING=100  # Default: 50
```

### Manual Baseline Adjustment

```javascript
// For testing or manual tuning
const { adaptiveDifficultyScaler } = require('./services/adaptiveDifficultyScaler');

// Set baseline to 80 (advanced)
adaptiveDifficultyScaler.baselineDifficultyScale = 80;

// Reset to default
adaptiveDifficultyScaler.baselineDifficultyScale = 50;
```

---

## Future Enhancements

### 1. Per-Category Scaling

**Idea:** Different baseline scales for different categories
```
payments.groceries: baseline=70 (mastered)
payments.business_meal: baseline=50 (learning)
payments.utilities: baseline=40 (struggling)
```

### 2. Difficulty Prediction

**Idea:** Predict expected accuracy for a given tier
```
Given Oggy's current baseline=60,
Tier 3 should yield ~65% accuracy
```

### 3. Adaptive Mix Ratio

**Idea:** Adjust Tessa/existing ratio based on knowledge size
```
< 50 examples: 70% Tessa, 30% existing (exploration)
50-200 examples: 50% Tessa, 50% existing (balanced)
> 200 examples: 30% Tessa, 70% existing (consolidation)
```

### 4. Historical Baseline Tracking

**Idea:** Graph baseline scale over time
```sql
CREATE TABLE baseline_scale_history (
  timestamp TIMESTAMPTZ,
  user_id TEXT,
  baseline_scale INTEGER,
  trigger_accuracy FLOAT
);
```

---

## Summary

**What We Built:**
- ✅ 5-tier difficulty system (warmup → extreme)
- ✅ Tiers relative to Oggy's current skill level
- ✅ Dynamic baseline scaling (0-100)
- ✅ Automatic scale-up when mastery achieved
- ✅ Automatic scale-down when struggling
- ✅ Tier-specific Tessa prompts
- ✅ Performance-based tier selection
- ✅ Weighted tier distribution
- ✅ Comprehensive monitoring & logging

**Result:**
Oggy can now train indefinitely without plateauing. If Oggy achieves 100% accuracy, the system automatically scales harder. The difficulty is always relative to current skill level, ensuring continuous challenge and growth.

**Status:** ✅ Implemented and ready for testing!

---

**Created:** 2026-02-03
**File:** adaptiveDifficultyScaler.js (new)
**Integration:** selfDrivenLearning.js, tessaAssessmentGenerator.js (modified)
**Testing:** Ready for 3-minute validation run
