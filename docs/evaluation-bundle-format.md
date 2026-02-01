# Evaluation Bundle Format

**Version:** 1.0.0
**Status:** FROZEN as of Week 2

This document defines the standard format for packaging evaluation tasks used to measure Base vs Oggy performance.

---

## Overview

An **evaluation bundle** is a collection of tasks in a specific domain, packaged with scoring criteria and metadata. Bundles are used to:
- Compare Base agent vs Oggy agent performance
- Track learning progress over time
- Identify areas where memory improves (or hurts) performance
- Create reproducible benchmarks

---

## Bundle Schema

```typescript
interface EvaluationBundle {
  // Bundle identity
  bundle_id: string;              // Unique identifier (UUID)
  version: string;                // Semantic version (e.g., "1.0.0")

  // Metadata
  domain: string;                 // Domain area (e.g., "customer_support")
  task_type: string;              // Type of task (e.g., "response_generation")
  created_at: string;             // ISO 8601 timestamp
  created_by: string;             // Creator identifier

  // Bundle properties
  description: string;            // Human-readable description
  item_count: number;             // Number of items in bundle
  difficulty: 'easy' | 'medium' | 'hard' | 'mixed';

  // Scoring configuration
  scoring_method: 'exact_match' | 'semantic_similarity' | 'llm_judge' | 'rubric' | 'custom';
  scoring_config?: ScoringConfig; // Method-specific configuration

  // The evaluation items
  items: EvaluationItem[];

  // Optional fields
  tags?: string[];                // Categorization tags
  sealed?: boolean;               // If true, benchmark is sealed (no peeking during training)
  metadata?: Record<string, any>; // Additional metadata
}

interface EvaluationItem {
  // Item identity
  item_id: string;                // Unique within bundle

  // The task
  input: string | Record<string, any>;  // Task input (flexible format)
  context?: Record<string, any>;        // Additional context for the task

  // Expected output (reference answer)
  expected_output?: string | Record<string, any>;
  reference_outputs?: string[];         // Multiple acceptable answers

  // Scoring
  rubric?: ScoringRubric;        // Item-specific scoring rubric
  max_score: number;             // Maximum possible score for this item

  // Metadata
  difficulty?: 'easy' | 'medium' | 'hard';
  tags?: string[];
  explanation?: string;          // Why this is the correct answer
  metadata?: Record<string, any>;
}

interface ScoringConfig {
  method: string;

  // For LLM-as-judge
  judge_model?: string;          // e.g., "gpt-4"
  judge_prompt?: string;         // Template for judge

  // For semantic similarity
  similarity_threshold?: number; // 0.0 to 1.0
  embedding_model?: string;      // e.g., "text-embedding-3-small"

  // For rubric-based
  rubric_template?: ScoringRubric;

  // General
  pass_threshold?: number;       // Score needed to "pass" item
}

interface ScoringRubric {
  criteria: RubricCriterion[];
  total_points: number;
}

interface RubricCriterion {
  name: string;
  description: string;
  points: number;
  evaluation_guide?: string;     // How to assess this criterion
}
```

---

## Example: Customer Support Bundle

```json
{
  "bundle_id": "550e8400-e29b-41d4-a716-446655440000",
  "version": "1.0.0",
  "domain": "customer_support",
  "task_type": "response_generation",
  "created_at": "2026-02-01T12:00:00Z",
  "created_by": "oggy-team",
  "description": "Customer support responses for common questions about product features",
  "item_count": 10,
  "difficulty": "easy",
  "scoring_method": "llm_judge",
  "scoring_config": {
    "method": "llm_judge",
    "judge_model": "gpt-4",
    "judge_prompt": "Rate the quality of this customer support response on a scale of 0-10. Consider: accuracy, helpfulness, tone, and completeness.",
    "pass_threshold": 7.0
  },
  "tags": ["customer_support", "product_features", "baseline"],
  "sealed": false,
  "items": [
    {
      "item_id": "item-001",
      "input": "How do I reset my password?",
      "context": {
        "customer_tier": "free",
        "previous_interactions": 0
      },
      "expected_output": "To reset your password, click 'Forgot Password' on the login page. You'll receive an email with a reset link. Follow the link and create a new password. If you don't receive the email within 5 minutes, check your spam folder or contact support.",
      "max_score": 10,
      "difficulty": "easy",
      "tags": ["authentication", "password"],
      "explanation": "Clear step-by-step instructions with troubleshooting tip"
    },
    {
      "item_id": "item-002",
      "input": "What's the difference between the Pro and Enterprise plans?",
      "context": {
        "customer_tier": "free",
        "looking_to_upgrade": true
      },
      "expected_output": "The Pro plan includes unlimited projects, 10GB storage, and email support for $29/month. The Enterprise plan adds SSO, dedicated account manager, 100GB storage, priority support, and custom integrations starting at $299/month. Which features are most important for your team?",
      "max_score": 10,
      "difficulty": "medium",
      "tags": ["pricing", "plans", "sales"],
      "rubric": {
        "criteria": [
          {
            "name": "Accuracy",
            "description": "Correctly states plan features and pricing",
            "points": 4,
            "evaluation_guide": "Check against actual pricing page"
          },
          {
            "name": "Helpfulness",
            "description": "Asks qualifying question to help customer decide",
            "points": 3,
            "evaluation_guide": "Response should guide next step"
          },
          {
            "name": "Clarity",
            "description": "Easy to understand comparison",
            "points": 3,
            "evaluation_guide": "Avoid jargon, clear structure"
          }
        ],
        "total_points": 10
      }
    }
  ]
}
```

---

## Bundle Types

### 1. Training Bundles
- `sealed: false`
- Used during learning loops
- Results used to update memory utility weights
- May be reused across multiple training runs

### 2. Validation Bundles
- `sealed: false`
- Used to monitor overfitting
- Run periodically during training
- Results tracked but don't update memories

### 3. Sealed Benchmarks
- `sealed: true`
- **Never** exposed during training
- Used for final performance evaluation
- Prevents overfitting to evaluation criteria

### 4. Sanity Sets
- Small bundles (5-10 items)
- Very easy tasks that should always pass
- Used to detect catastrophic failures
- Example: "What is 2+2?" should always be correct

---

## Scoring Methods

### 1. Exact Match
```json
{
  "scoring_method": "exact_match",
  "scoring_config": {
    "method": "exact_match",
    "case_sensitive": false,
    "ignore_whitespace": true
  }
}
```
**Use for:** Classification, multiple choice, structured outputs

### 2. Semantic Similarity
```json
{
  "scoring_method": "semantic_similarity",
  "scoring_config": {
    "method": "semantic_similarity",
    "embedding_model": "text-embedding-3-small",
    "similarity_threshold": 0.85,
    "pass_threshold": 0.85
  }
}
```
**Use for:** Open-ended responses where semantic equivalence matters

### 3. LLM-as-Judge
```json
{
  "scoring_method": "llm_judge",
  "scoring_config": {
    "method": "llm_judge",
    "judge_model": "gpt-4",
    "judge_prompt": "Rate from 0-10...",
    "pass_threshold": 7.0
  }
}
```
**Use for:** Complex tasks requiring nuanced evaluation

### 4. Rubric-Based
```json
{
  "scoring_method": "rubric",
  "scoring_config": {
    "method": "rubric",
    "rubric_template": {
      "criteria": [...],
      "total_points": 100
    }
  }
}
```
**Use for:** Tasks with multiple evaluation dimensions

---

## File Storage

Bundles are stored as JSON files:

```
/data/evaluation-bundles/
  ├── customer-support-v1.0.0.json
  ├── code-review-v1.0.0.json
  └── data-extraction-v1.0.0.json
```

Naming convention: `{domain}-v{version}.json`

---

## Bundle Versioning

Follow semantic versioning:
- **Major**: Breaking changes (different task format, incompatible scoring)
- **Minor**: Adding items, non-breaking changes
- **Patch**: Fixing typos, clarifying descriptions

Example: `customer-support-v1.2.3.json`

---

## Validation

All bundles must pass validation before use:

1. **Schema validation**: Matches EvaluationBundle interface
2. **Item count**: `item_count` matches actual `items.length`
3. **Unique IDs**: All `item_id` values are unique within bundle
4. **Scoring config**: Matches declared `scoring_method`
5. **Score totals**: If using rubric, `total_points` equals sum of criteria points

---

## Usage Workflow

1. **Create bundle**: Define tasks, expected outputs, scoring
2. **Validate bundle**: Run schema validation
3. **Register bundle**: Add to bundle registry
4. **Run evaluation**: Execute Base agent vs Oggy agent
5. **Score responses**: Apply scoring method
6. **Store results**: Save evaluation run results
7. **Update memories**: (Training bundles only) Use results to update utility weights

---

## Next Steps

- Week 2: Create first customer support bundle (10-30 items)
- Week 3: Implement evaluation runner service
- Week 4: Use bundles for first Base vs Oggy comparison
- Week 5: Create sealed benchmarks

---

## See Also

- [Contracts Documentation](./contracts.md)
- [Scoring Framework](./scoring-framework.md) (Week 2)
- [Anti-Overfitting Protocol](../pdfs/Stage_0_Program_Notes_folded_v5_domain_knowledge_assessment.pdf)
