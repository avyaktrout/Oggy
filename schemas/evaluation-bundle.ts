/**
 * Evaluation Bundle Schema - v1.0.0
 * FROZEN as of Week 2
 *
 * Defines the structure for packaging evaluation tasks used to measure
 * Base vs Oggy performance.
 */

export interface EvaluationBundle {
  // Bundle identity
  bundle_id: string;
  version: string;

  // Metadata
  domain: string;
  task_type: string;
  created_at: string;
  created_by: string;

  // Bundle properties
  description: string;
  item_count: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'mixed';

  // Scoring configuration
  scoring_method: 'exact_match' | 'semantic_similarity' | 'llm_judge' | 'rubric' | 'custom';
  scoring_config?: ScoringConfig;

  // The evaluation items
  items: EvaluationItem[];

  // Optional fields
  tags?: string[];
  sealed?: boolean;
  metadata?: Record<string, any>;
}

export interface EvaluationItem {
  // Item identity
  item_id: string;

  // The task
  input: string | Record<string, any>;
  context?: Record<string, any>;

  // Expected output (reference answer)
  expected_output?: string | Record<string, any>;
  reference_outputs?: string[];

  // Scoring
  rubric?: ScoringRubric;
  max_score: number;

  // Metadata
  difficulty?: 'easy' | 'medium' | 'hard';
  tags?: string[];
  explanation?: string;
  metadata?: Record<string, any>;
}

export interface ScoringConfig {
  method: string;

  // For LLM-as-judge
  judge_model?: string;
  judge_prompt?: string;

  // For semantic similarity
  similarity_threshold?: number;
  embedding_model?: string;

  // For rubric-based
  rubric_template?: ScoringRubric;

  // General
  pass_threshold?: number;
}

export interface ScoringRubric {
  criteria: RubricCriterion[];
  total_points: number;
}

export interface RubricCriterion {
  name: string;
  description: string;
  points: number;
  evaluation_guide?: string;
}

/**
 * Evaluation Run Result
 *
 * Stores the results of running an agent (Base or Oggy) against a bundle
 */
export interface EvaluationRunResult {
  run_id: string;
  bundle_id: string;
  agent: 'base' | 'oggy' | 'tessa';

  // Timing
  started_at: string;
  completed_at: string;
  duration_ms: number;

  // Results
  item_results: ItemResult[];

  // Aggregate metrics
  total_score: number;
  max_possible_score: number;
  score_percentage: number;
  items_passed: number;
  items_failed: number;

  // Metadata
  agent_version?: string;
  memory_snapshot_id?: string;
  metadata?: Record<string, any>;
}

export interface ItemResult {
  item_id: string;

  // Agent response
  agent_output: string | Record<string, any>;

  // Scoring
  score: number;
  max_score: number;
  passed: boolean;

  // Rubric breakdown (if applicable)
  rubric_scores?: RubricScore[];

  // Timing
  response_time_ms: number;

  // Evidence (for memory updates)
  trace_id?: string;
  assessment_id?: string;

  // Metadata
  error?: string;
  metadata?: Record<string, any>;
}

export interface RubricScore {
  criterion_name: string;
  points_awarded: number;
  points_possible: number;
  feedback?: string;
}

/**
 * Comparison Result
 *
 * Compares Base vs Oggy performance on the same bundle
 */
export interface ComparisonResult {
  comparison_id: string;
  bundle_id: string;

  base_run_id: string;
  oggy_run_id: string;

  // Win/Loss/Tie counts
  oggy_wins: number;
  base_wins: number;
  ties: number;

  // Score comparison
  base_total_score: number;
  oggy_total_score: number;
  score_delta: number;
  score_delta_percentage: number;

  // Item-level comparison
  item_comparisons: ItemComparison[];

  // Summary
  oggy_improved: boolean;
  improvement_magnitude: 'none' | 'marginal' | 'moderate' | 'significant';

  created_at: string;
  metadata?: Record<string, any>;
}

export interface ItemComparison {
  item_id: string;

  base_score: number;
  oggy_score: number;
  score_delta: number;

  winner: 'base' | 'oggy' | 'tie';

  base_output: string | Record<string, any>;
  oggy_output: string | Record<string, any>;
}
