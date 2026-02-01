"""
Evaluation Runner - Run full evaluation bundles on agents
Compare Base vs Oggy performance
"""

import json
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass, field
from scoring import score_response
from agents import BaseAgent, OggyAgent


@dataclass
class ItemResult:
    """Result for a single evaluation item"""
    item_id: str
    input: str
    agent_response: str
    expected_output: Optional[str]
    score: float
    max_score: float
    passed: bool
    feedback: str
    reasoning: Optional[str] = None
    error: Optional[str] = None


@dataclass
class ComparisonResult:
    """Result of running an evaluation bundle"""
    bundle_id: str
    agent: str
    total_items: int
    completed_items: int
    failed_items: int
    average_score: float
    pass_rate: float
    item_results: List[ItemResult] = field(default_factory=list)
    metadata: Dict = field(default_factory=dict)


async def run_bundle_evaluation(
    bundle_path: str,
    agent_type: str,
    memory_service_url: str,
    owner_type: str = "user",
    owner_id: str = "eval",
    apply_learning: bool = False,
) -> ComparisonResult:
    """
    Run full evaluation bundle on an agent

    Args:
        bundle_path: Path to evaluation bundle JSON file
        agent_type: 'base' or 'oggy'
        memory_service_url: URL of memory service
        owner_type: Memory owner type
        owner_id: Memory owner ID
        apply_learning: Whether to apply learning from evaluation results (Oggy only)

    Returns:
        ComparisonResult with scores and pass rates
    """
    # Load evaluation bundle
    bundle_file = Path(bundle_path)
    if not bundle_file.exists():
        raise FileNotFoundError(f"Bundle not found: {bundle_path}")

    with open(bundle_file, 'r') as f:
        bundle = json.load(f)

    # Initialize agent
    if agent_type == "base":
        agent = BaseAgent(memory_service_url)
    elif agent_type == "oggy":
        agent = OggyAgent(memory_service_url)
    else:
        raise ValueError(f"Unknown agent type: {agent_type}")

    # Get bundle metadata
    bundle_id = bundle.get("bundle_id")
    scoring_config = bundle.get("scoring_config", {})
    items = bundle.get("items", [])

    # Run evaluation on each item
    item_results = []
    total_score = 0.0
    total_max_score = 0.0
    passed_count = 0
    failed_count = 0

    for item in items:
        try:
            # Get item data
            item_id = item["item_id"]
            user_input = item["input"]
            expected_output = item.get("expected_output")
            max_score = item.get("max_score", 10.0)
            context_data = item.get("context", {})

            # Generate agent response
            response_data = await agent.generate_response(
                user_input=user_input,
                owner_type=owner_type,
                owner_id=owner_id,
                context=context_data,
            )

            agent_response = response_data["response"]

            # Score the response
            scoring_result = await score_response(
                agent_output=agent_response,
                item=item,
                scoring_config=scoring_config,
            )

            # Create item result
            item_result = ItemResult(
                item_id=item_id,
                input=user_input,
                agent_response=agent_response,
                expected_output=expected_output,
                score=scoring_result.score,
                max_score=max_score,
                passed=scoring_result.passed,
                feedback=scoring_result.details.get("feedback"),
                reasoning=scoring_result.details.get("reasoning"),
            )

            item_results.append(item_result)

            # Update totals
            total_score += scoring_result.score
            total_max_score += max_score
            if scoring_result.passed:
                passed_count += 1

            # Apply learning for Oggy if enabled
            if apply_learning and agent_type == "oggy" and hasattr(agent, 'generate_response'):
                # Re-run with learning to update memories
                outcome = "success" if scoring_result.passed else "failure"
                await agent.generate_response(
                    user_input=user_input,
                    owner_type=owner_type,
                    owner_id=owner_id,
                    context=context_data,
                    outcome=outcome,
                    score=scoring_result.score,
                )

        except Exception as e:
            # Log error but continue evaluation
            print(f"Error evaluating item {item.get('item_id', 'unknown')}: {e}")

            item_result = ItemResult(
                item_id=item.get("item_id", "unknown"),
                input=item.get("input", ""),
                agent_response="",
                expected_output=item.get("expected_output"),
                score=0.0,
                max_score=item.get("max_score", 10.0),
                passed=False,
                feedback="Evaluation error",
                error=str(e),
            )

            item_results.append(item_result)
            failed_count += 1
            total_max_score += item.get("max_score", 10.0)

    # Calculate overall metrics
    completed_items = len(items) - failed_count
    average_score = (total_score / total_max_score * 10.0) if total_max_score > 0 else 0.0
    pass_rate = (passed_count / len(items)) if len(items) > 0 else 0.0

    # Build comparison result
    result = ComparisonResult(
        bundle_id=bundle_id,
        agent=agent_type,
        total_items=len(items),
        completed_items=completed_items,
        failed_items=failed_count,
        average_score=average_score,
        pass_rate=pass_rate,
        item_results=item_results,
        metadata={
            "bundle_version": bundle.get("version"),
            "bundle_domain": bundle.get("domain"),
            "bundle_difficulty": bundle.get("difficulty"),
            "agent_info": agent.get_agent_info(),
        },
    )

    return result


def compare_results(base_result: ComparisonResult, oggy_result: ComparisonResult) -> Dict:
    """
    Compare Base vs Oggy results

    Args:
        base_result: Base agent evaluation result
        oggy_result: Oggy agent evaluation result

    Returns:
        Comparison statistics
    """
    score_diff = oggy_result.average_score - base_result.average_score
    pass_rate_diff = oggy_result.pass_rate - base_result.pass_rate

    # Item-by-item comparison
    item_comparisons = []
    for base_item, oggy_item in zip(base_result.item_results, oggy_result.item_results):
        if base_item.item_id == oggy_item.item_id:
            item_comparisons.append({
                "item_id": base_item.item_id,
                "base_score": base_item.score,
                "oggy_score": oggy_item.score,
                "improvement": oggy_item.score - base_item.score,
                "base_passed": base_item.passed,
                "oggy_passed": oggy_item.passed,
            })

    return {
        "bundle_id": base_result.bundle_id,
        "summary": {
            "base_average_score": base_result.average_score,
            "oggy_average_score": oggy_result.average_score,
            "score_improvement": score_diff,
            "score_improvement_pct": (score_diff / base_result.average_score * 100) if base_result.average_score > 0 else 0,
            "base_pass_rate": base_result.pass_rate,
            "oggy_pass_rate": oggy_result.pass_rate,
            "pass_rate_improvement": pass_rate_diff,
        },
        "item_comparisons": item_comparisons,
        "winner": "oggy" if score_diff > 0 else ("base" if score_diff < 0 else "tie"),
    }
