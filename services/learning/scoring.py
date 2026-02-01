"""
Scoring Framework for Oggy Evaluation Bundles
Version: 1.0.0

Implements multiple scoring methods for evaluating agent responses:
- Exact match
- Semantic similarity (using embeddings)
- LLM-as-judge (using GPT-4)
- Rubric-based (using LLM to apply rubric)
"""

import os
from typing import Any, Dict, List, Optional
from openai import AsyncOpenAI
import numpy as np

# Initialize OpenAI client
client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))


class ScoringResult:
    """Result of scoring an agent response"""

    def __init__(
        self,
        score: float,
        max_score: float,
        passed: bool,
        method: str,
        details: Optional[Dict[str, Any]] = None,
    ):
        self.score = score
        self.max_score = max_score
        self.passed = passed
        self.method = method
        self.details = details or {}

    def to_dict(self):
        return {
            "score": self.score,
            "max_score": self.max_score,
            "passed": self.passed,
            "score_percentage": (
                (self.score / self.max_score * 100) if self.max_score > 0 else 0
            ),
            "method": self.method,
            "details": self.details,
        }


async def score_exact_match(
    agent_output: str,
    expected_output: str,
    case_sensitive: bool = False,
    ignore_whitespace: bool = True,
) -> ScoringResult:
    """
    Score using exact string matching

    Args:
        agent_output: The agent's response
        expected_output: The expected/reference answer
        case_sensitive: Whether to match case exactly
        ignore_whitespace: Whether to ignore leading/trailing whitespace

    Returns:
        ScoringResult with score of 1.0 (match) or 0.0 (no match)
    """
    output = agent_output
    expected = expected_output

    if ignore_whitespace:
        output = output.strip()
        expected = expected.strip()

    if not case_sensitive:
        output = output.lower()
        expected = expected.lower()

    match = output == expected
    score = 1.0 if match else 0.0

    return ScoringResult(
        score=score,
        max_score=1.0,
        passed=match,
        method="exact_match",
        details={
            "case_sensitive": case_sensitive,
            "ignore_whitespace": ignore_whitespace,
            "matched": match,
        },
    )


async def score_semantic_similarity(
    agent_output: str,
    expected_output: str,
    threshold: float = 0.85,
    embedding_model: str = "text-embedding-3-small",
) -> ScoringResult:
    """
    Score using semantic similarity via embeddings

    Args:
        agent_output: The agent's response
        expected_output: The expected/reference answer
        threshold: Similarity threshold to pass (0.0 to 1.0)
        embedding_model: OpenAI embedding model to use

    Returns:
        ScoringResult with cosine similarity score
    """
    # Get embeddings for both texts
    response = await client.embeddings.create(
        model=embedding_model, input=[agent_output, expected_output]
    )

    agent_embedding = np.array(response.data[0].embedding)
    expected_embedding = np.array(response.data[1].embedding)

    # Calculate cosine similarity
    cosine_sim = np.dot(agent_embedding, expected_embedding) / (
        np.linalg.norm(agent_embedding) * np.linalg.norm(expected_embedding)
    )

    similarity = float(cosine_sim)
    passed = similarity >= threshold

    return ScoringResult(
        score=similarity,
        max_score=1.0,
        passed=passed,
        method="semantic_similarity",
        details={
            "similarity": similarity,
            "threshold": threshold,
            "embedding_model": embedding_model,
        },
    )


async def score_llm_judge(
    agent_output: str,
    expected_output: Optional[str],
    task_input: str,
    judge_model: str = "gpt-4",
    judge_prompt: Optional[str] = None,
    max_score: float = 10.0,
    pass_threshold: float = 7.0,
) -> ScoringResult:
    """
    Score using LLM as judge

    Args:
        agent_output: The agent's response
        expected_output: Optional reference answer
        task_input: The original task/question
        judge_model: OpenAI model to use as judge
        judge_prompt: Custom prompt template (uses default if None)
        max_score: Maximum possible score
        pass_threshold: Score needed to pass

    Returns:
        ScoringResult with LLM-assigned score and feedback
    """
    # Default judge prompt
    if judge_prompt is None:
        if expected_output:
            judge_prompt = f"""You are evaluating an AI agent's response to a task.

Task: {task_input}

Reference Answer: {expected_output}

Agent's Response: {agent_output}

Rate the agent's response on a scale of 0 to {max_score}.
Consider:
1. Accuracy - Is the information correct?
2. Completeness - Does it fully address the task?
3. Clarity - Is it easy to understand?
4. Relevance - Does it stay on topic?

Provide your rating as a JSON object with this exact format:
{{
  "score": <number between 0 and {max_score}>,
  "reasoning": "<brief explanation of your rating>"
}}"""
        else:
            judge_prompt = f"""You are evaluating an AI agent's response to a task.

Task: {task_input}

Agent's Response: {agent_output}

Rate the agent's response on a scale of 0 to {max_score}.
Consider:
1. Accuracy - Is the information correct?
2. Completeness - Does it fully address the task?
3. Clarity - Is it easy to understand?
4. Relevance - Does it stay on topic?

Provide your rating as a JSON object with this exact format:
{{
  "score": <number between 0 and {max_score}>,
  "reasoning": "<brief explanation of your rating>"
}}"""

    # Call LLM judge
    response = await client.chat.completions.create(
        model=judge_model,
        messages=[{"role": "user", "content": judge_prompt}],
        response_format={"type": "json_object"},
        temperature=0.3,
    )

    # Parse response
    import json

    result = json.loads(response.choices[0].message.content)
    score = float(result.get("score", 0))
    reasoning = result.get("reasoning", "")

    passed = score >= pass_threshold

    return ScoringResult(
        score=score,
        max_score=max_score,
        passed=passed,
        method="llm_judge",
        details={
            "judge_model": judge_model,
            "pass_threshold": pass_threshold,
            "reasoning": reasoning,
            "raw_response": result,
        },
    )


async def score_rubric(
    agent_output: str,
    task_input: str,
    rubric: Dict[str, Any],
    judge_model: str = "gpt-4",
) -> ScoringResult:
    """
    Score using a rubric with LLM evaluation

    Args:
        agent_output: The agent's response
        task_input: The original task/question
        rubric: Rubric definition with criteria
        judge_model: OpenAI model to use for evaluation

    Returns:
        ScoringResult with rubric breakdown
    """
    criteria = rubric["criteria"]
    total_points = rubric["total_points"]

    # Build rubric evaluation prompt
    criteria_text = "\n".join(
        [
            f"{i+1}. {c['name']} ({c['points']} points): {c['description']}"
            for i, c in enumerate(criteria)
        ]
    )

    judge_prompt = f"""You are evaluating an AI agent's response using a rubric.

Task: {task_input}

Agent's Response: {agent_output}

Rubric Criteria:
{criteria_text}

Evaluate the response against each criterion and assign points.

Provide your evaluation as a JSON object with this exact format:
{{
  "criteria_scores": [
    {{
      "criterion_name": "<name>",
      "points_awarded": <number>,
      "points_possible": <number>,
      "feedback": "<brief explanation>"
    }},
    ...
  ],
  "total_score": <sum of points_awarded>,
  "overall_feedback": "<brief overall assessment>"
}}"""

    # Call LLM judge
    response = await client.chat.completions.create(
        model=judge_model,
        messages=[{"role": "user", "content": judge_prompt}],
        response_format={"type": "json_object"},
        temperature=0.3,
    )

    # Parse response
    import json

    result = json.loads(response.choices[0].message.content)
    total_score = float(result.get("total_score", 0))
    passed = total_score >= (total_points * 0.7)  # Default: 70% to pass

    return ScoringResult(
        score=total_score,
        max_score=total_points,
        passed=passed,
        method="rubric",
        details={
            "judge_model": judge_model,
            "criteria_scores": result.get("criteria_scores", []),
            "overall_feedback": result.get("overall_feedback", ""),
            "rubric": rubric,
        },
    )


async def score_response(
    agent_output: str,
    item: Dict[str, Any],
    scoring_config: Dict[str, Any],
) -> ScoringResult:
    """
    Score an agent response using the configured method

    Args:
        agent_output: The agent's response
        item: The evaluation item (contains input, expected_output, etc.)
        scoring_config: Scoring configuration (method + parameters)

    Returns:
        ScoringResult based on the configured method
    """
    method = scoring_config.get("method", "llm_judge")

    if method == "exact_match":
        return await score_exact_match(
            agent_output=agent_output,
            expected_output=item.get("expected_output", ""),
            case_sensitive=scoring_config.get("case_sensitive", False),
            ignore_whitespace=scoring_config.get("ignore_whitespace", True),
        )

    elif method == "semantic_similarity":
        return await score_semantic_similarity(
            agent_output=agent_output,
            expected_output=item.get("expected_output", ""),
            threshold=scoring_config.get("similarity_threshold", 0.85),
            embedding_model=scoring_config.get(
                "embedding_model", "text-embedding-3-small"
            ),
        )

    elif method == "llm_judge":
        return await score_llm_judge(
            agent_output=agent_output,
            expected_output=item.get("expected_output"),
            task_input=str(item.get("input", "")),
            judge_model=scoring_config.get("judge_model", "gpt-4"),
            judge_prompt=scoring_config.get("judge_prompt"),
            max_score=item.get("max_score", 10.0),
            pass_threshold=scoring_config.get("pass_threshold", 7.0),
        )

    elif method == "rubric":
        return await score_rubric(
            agent_output=agent_output,
            task_input=str(item.get("input", "")),
            rubric=item.get("rubric", scoring_config.get("rubric_template", {})),
            judge_model=scoring_config.get("judge_model", "gpt-4"),
        )

    else:
        raise ValueError(f"Unknown scoring method: {method}")
