# Oggy Training Report — 5x 10-Minute Sessions (S1 L5 → S2 L2)

**Date:** 2026-02-07
**User ID:** oggy
**Starting Level:** S1 L5 (Foundation: Expert — edge cases and ambiguity)
**Ending Level:** S2 L2 (Intermediate: Balanced — mixed difficulty)
**Promotion Threshold:** 90% Oggy benchmark accuracy
**Benchmark Size:** 40 sealed scenarios per benchmark
**Session Duration:** 10 minutes each

## Summary

Across 5 cycles of 10-minute training, Oggy promoted **twice** — from S1 L5 through S2 L1 to S2 L2 — and is now training at the Intermediate scale. The longer 10-minute sessions allowed 2-3 benchmarks per cycle (vs 1 per 5-minute cycle), significantly accelerating learning.

A critical **daily token budget exhaustion** was discovered and fixed in cycle 4 — the 2M token/day limit was exceeded, causing Oggy to fall back to a basic categorizer (24% accuracy). The budget was increased to 20M tokens.

- **Total cycles run:** 5
- **Total training questions answered:** ~312 (excluding budget-exhausted cycle 4 attempt)
- **Total training accuracy:** ~99.5%
- **Total benchmarks run:** 14
- **Benchmarks passed:** 8 of 14 (57%)
- **Total mistakes learned from benchmarks:** 83
- **Promotions:** 2 (S1 L5 → S2 L1, S2 L1 → S2 L2)
- **Average benchmark time:** ~50 seconds

## Cycle-by-Cycle Results

### Cycle 1 — S1 L5 → S2 L1 (PROMOTED TWICE)
| Benchmark | Level | Oggy Acc | Base Acc | Advantage | Result | Mistakes |
|-----------|-------|----------|----------|-----------|--------|----------|
| 1 | S1 L5 | 82.5% | 85.0% | -2.9% | **FAILED** | 4 |
| 2 | S1 L5 | **95.0%** | 95.0% | 0% | **PASSED** → Promoted to S2 L1 | 2 |
| 3 | S2 L1 | 72.5% | 72.5% | 0% | **PASSED** | 11 |

Training: 61/61 (100%) | Duration: 12m 10s | Benchmark time: 2m 3s

### Cycle 2 — S2 L1 → S2 L2 (PROMOTED)
| Benchmark | Level | Oggy Acc | Base Acc | Advantage | Result | Mistakes |
|-----------|-------|----------|----------|-----------|--------|----------|
| 1 | S2 L1 | **92.5%** | 90.0% | +2.8% | **PASSED** → Promoted to S2 L2 | 3 |
| 2 | S2 L2 | 77.5% | 72.5% | +6.9% | **PASSED** | 6 |
| 3 | S2 L2 | 72.5% | 60.0% | +20.8% | **PASSED** | 3 |

Training: 63/63 (100%) | Duration: 12m 14s | Benchmark time: 2m 9s

### Cycle 3 — S2 L2 (no promotion)
| Benchmark | Level | Oggy Acc | Base Acc | Advantage | Result | Mistakes |
|-----------|-------|----------|----------|-----------|--------|----------|
| 1 | S2 L2 | 82.5% | 70.0% | +17.9% | **PASSED** | 6 |
| 2 | S2 L2 | 72.5% | 75.0% | -3.3% | **FAILED** | 7 |
| 3 | S2 L2 | 77.5% | 80.0% | -3.1% | **FAILED** | 7 |

Training: 63/63 (100%) | Duration: 12m 21s | Benchmark time: 2m 15s

### Cycle 4 — S2 L2 (no promotion, budget fix applied)
**Note:** First attempt hit daily token budget exhaustion (2M tokens). Accuracy dropped to 24% using fallback categorizer. Fixed by increasing budget to 20M tokens and rebuilding.

| Benchmark | Level | Oggy Acc | Base Acc | Advantage | Result | Mistakes |
|-----------|-------|----------|----------|-----------|--------|----------|
| 1 | S2 L2 | 77.5% | 77.5% | 0% | **PASSED** | 9 |
| 2 | S2 L2 | 82.5% | 85.0% | -2.9% | **FAILED** | 6 |
| 3 | S2 L2 | 77.5% | 75.0% | +3.3% | **PASSED** | 8 |

Training: 61/61 (100%) | Duration: 12m 15s | Benchmark time: 2m 9s

### Cycle 5 — S2 L2 (no promotion)
| Benchmark | Level | Oggy Acc | Base Acc | Advantage | Result | Mistakes |
|-----------|-------|----------|----------|-----------|--------|----------|
| 1 | S2 L2 | 77.5% | 80.0% | -3.1% | **FAILED** | 8 |
| 2 | S2 L2 | **87.5%** | 85.0% | +2.9% | **PASSED** | 3 |

Training: 63/63 (100%) | Duration: 11m 34s | Benchmark time: 1m 27s

## Benchmark Accuracy Trend (All 14 Benchmarks)

```
Oggy Accuracy (%)
100 |
 95 |   *                                                    ← 95.0% (S1 L5 → S2 L1)
 92 |       *                                                ← 92.5% (S2 L1 → S2 L2)
 87 |                                                  *     ← 87.5% (best at S2 L2)
 85 |
 82 | *             *                 *
 80 |
 77 |         *               * *         *   *   *
 75 |
 72 |               *   *
 70 |
     ──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──
       1  2  3  4  5  6  7  8  9  10 11 12 13 14  Benchmark #
       └─ Cycle 1 ─┘└─ Cycle 2 ─┘└ Cycle 3 ┘└ Cycle 4 ┘└C5─┘
```

## Key Observations

### Memory Persistence Verified
Level persisted correctly across all 5 cycles AND through a Docker rebuild (cycle 4). The `continuous_learning_state` table reliably stores and restores Oggy's scale and difficulty level. User ID standardization on `oggy` ensures consistent state.

### Rapid Promotion Through Foundation Scale
Oggy promoted from S1 L5 → S2 L1 → S2 L2 within the first 2 cycles (~24 minutes total). The 47 mistakes learned during the earlier 7-cycle S1 L4 session gave Oggy enough knowledge to quickly master the remaining Foundation levels.

### S2 L2 Plateau
After reaching S2 L2 (Intermediate: Balanced), Oggy's benchmark accuracy stabilized in the 72-87.5% range across 9 benchmarks. The highest was 87.5% — close to but below the 90% promotion threshold. S2 L2 introduces complexity factors:
- Category overlap (ambiguous merchants)
- Context-dependent categorization
- Amount edge cases
- Time sensitivity

### Training vs Benchmark Gap Persists
Training accuracy remains near-perfect (~100%) while benchmark accuracy ranges 72-87.5% at S2 L2. This 15-25% gap indicates that training questions (which leverage Oggy's memory) are substantially easier than sealed benchmark scenarios (which test generalization).

### Bug Found & Fixed: Token Budget Exhaustion
The daily token budget of 2M tokens was silently exhausted mid-session, causing all OpenAI API calls to fail. The system fell back to a basic categorizer with ~24% accuracy. This went undetected because:
- The cost governor logs errors but doesn't halt the training loop
- The training loop counts fallback predictions as valid answers
- No alert/notification mechanism for budget exhaustion

**Fix applied:** Increased `DAILY_TOKEN_BUDGET` to 20M tokens via docker-compose.yml environment variable.

### 10-Minute Sessions Are More Efficient
| Metric | 5-min sessions | 10-min sessions |
|--------|---------------|-----------------|
| Benchmarks per cycle | 1 | 2-3 |
| Training questions per cycle | ~25 | ~62 |
| Promotions per cycle | 0-1 | 0-2 |
| Time efficiency (benchmark overhead) | ~20% | ~15% |

## Infrastructure Performance

| Metric | Value |
|--------|-------|
| Avg benchmark time | ~50 seconds |
| Circuit breakers | All 6 CLOSED throughout all 5 cycles |
| Avg training time per cycle | ~10m 2s |
| Avg questions per minute | ~6.2 |
| Level persistence | Verified across cycles and Docker rebuild |
| Token budget | Increased from 2M to 20M |

## Cumulative Progress (All Sessions)

| Phase | Cycles | Starting Level | Ending Level | Benchmarks | Pass Rate |
|-------|--------|---------------|-------------|------------|-----------|
| 5-min sessions (batch 1) | 5 | S1 L4 | S1 L4 | 5 | 60% |
| 5-min sessions (batch 2) | 2 | S1 L4 | S1 L5 | 2 | 100% |
| 10-min sessions | 5 | S1 L5 | S2 L2 | 14 | 57% |
| **Total** | **12** | **S1 L4** | **S2 L2** | **21** | **62%** |

## Configuration

```
BENCHMARK_UPGRADE_THRESHOLD: 0.90
BENCHMARK_SCENARIO_COUNT: 40
QUESTIONS_PER_BENCHMARK: 20
ACCURACY_THRESHOLD: 0.80
DAILY_TOKEN_BUDGET: 20,000,000 (increased from 2,000,000)
PARALLELIZATION: Enabled (Base=10, Oggy=5 waves, Generation=8)
SELF_DRIVEN_LEARNING_DELAY: 200ms
```

## Next Steps

- Continue training at S2 L2 to push Oggy past the 90% benchmark threshold
- Monitor token budget usage over longer sessions to ensure 20M is sufficient
- Consider adding a budget-exhaustion handler that pauses training instead of falling back to basic categorizer
- Investigate whether increasing the number of corrections stored per confusion pattern improves S2 L2 benchmark accuracy
