#!/usr/bin/env python3
"""
Before/After Learning Impact Test
Tests Oggy's improvement after continuous learning and self-driven learning
Compares against Base agent (no learning)
"""

import asyncio
import httpx
import json
import sys
from pathlib import Path
from typing import Dict, List, Any

# Service URLs
LEARNING_SERVICE = "http://localhost:8000"
PRACTICE_PACK_PATH = "data/practice_packs/week4_payments_v1.json"

# Test configuration
TIMEOUT = 30.0


class Colors:
    """ANSI color codes"""
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    MAGENTA = '\033[95m'
    BOLD = '\033[1m'
    END = '\033[0m'


def print_header(text: str):
    """Print formatted header"""
    print(f"\n{Colors.BOLD}{Colors.CYAN}{'='*70}{Colors.END}")
    print(f"{Colors.BOLD}{Colors.CYAN}{text:^70}{Colors.END}")
    print(f"{Colors.BOLD}{Colors.CYAN}{'='*70}{Colors.END}\n")


def print_subheader(text: str):
    """Print formatted subheader"""
    print(f"\n{Colors.BOLD}{Colors.BLUE}{text}{Colors.END}")
    print(f"{Colors.BLUE}{'-'*70}{Colors.END}")


def print_success(text: str):
    """Print success message"""
    print(f"{Colors.GREEN}[OK]{Colors.END} {text}")


def print_error(text: str):
    """Print error message"""
    print(f"{Colors.RED}[ERROR]{Colors.END} {text}")


def print_info(text: str):
    """Print info message"""
    print(f"{Colors.BLUE}[INFO]{Colors.END} {text}")


def print_score(agent: str, score: float):
    """Print colored score based on performance"""
    color = Colors.GREEN if score >= 8.0 else Colors.YELLOW if score >= 6.0 else Colors.RED
    print(f"{color}{agent:20s}: {score:.1f}/10{Colors.END}")


def load_practice_pack() -> Dict[str, Any]:
    """Load practice pack from file"""
    try:
        with open(PRACTICE_PACK_PATH, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        print_error(f"Practice pack not found at {PRACTICE_PACK_PATH}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print_error(f"Failed to parse practice pack: {e}")
        sys.exit(1)


async def run_assessment(client: httpx.AsyncClient, agent_type: str, assessment: Dict[str, Any]) -> Dict[str, Any]:
    """Run a single assessment with specified agent"""
    try:
        # Handle both old format (prompt) and new format (input)
        user_input = assessment.get("input", assessment.get("prompt", ""))

        response = await client.post(
            f"{LEARNING_SERVICE}/agents/generate",
            json={
                "agent": agent_type,
                "user_input": user_input,
                "owner_type": "user",
                "owner_id": "learning_impact_test"
            },
            timeout=TIMEOUT
        )
        response.raise_for_status()
        result = response.json()
        return result
    except Exception as e:
        print_error(f"Failed to run assessment with {agent_type}: {e}")
        return {"response": "", "error": str(e)}


async def score_response(client: httpx.AsyncClient, assessment: Dict[str, Any], agent_response: str) -> float:
    """Score a response using rubric-based scoring"""
    try:
        expected = assessment.get("expected_output", "").lower().strip()
        actual = agent_response.lower().strip()
        rubric = assessment.get("rubric", {})

        if not actual:
            return 0.0

        # Check for exact match
        if "exact_match" in rubric:
            if expected in actual or actual in expected:
                return rubric["exact_match"].get("points", 10)

        # Check for semantic match
        if "semantic_match" in rubric:
            acceptable = rubric["semantic_match"].get("acceptable", [])
            acceptable_lower = [a.lower() for a in acceptable]
            for acceptable_answer in acceptable_lower:
                if acceptable_answer in actual:
                    return rubric["semantic_match"].get("points", 7)

        # Check for components-based scoring
        if "components" in rubric:
            score = 0.0
            for component in rubric["components"]:
                required = component.get("required", "").lower()
                weight = component.get("weight", 0)
                if required in actual:
                    score += weight * 10
            return min(score, 10.0)

        # Default: partial credit if response contains expected output
        if expected in actual:
            return 5.0

        return 0.0

    except Exception as e:
        print_error(f"Failed to score response: {e}")
        return 0.0


async def run_assessment_suite(client: httpx.AsyncClient, assessments: List[Dict], phase: str) -> Dict[str, List[float]]:
    """Run all assessments for both agents"""
    print_subheader(f"{phase} - Running {len(assessments)} Assessments")

    base_scores = []
    oggy_scores = []

    for i, assessment in enumerate(assessments, 1):
        # Handle both old and new format for type/difficulty display
        item_type = assessment.get('type', assessment.get('tags', ['unknown'])[0] if assessment.get('tags') else 'unknown')
        difficulty = assessment.get('difficulty', 'unknown')
        print(f"\n{Colors.CYAN}[{i}/{len(assessments)}] {item_type} "
              f"(difficulty: {difficulty}){Colors.END}")

        # Run Base agent
        base_result = await run_assessment(client, "base", assessment)
        base_response = base_result.get("response", "")
        base_score = await score_response(client, assessment, base_response)
        base_scores.append(base_score)

        # Run Oggy agent
        oggy_result = await run_assessment(client, "oggy", assessment)
        oggy_response = oggy_result.get("response", "")
        oggy_score = await score_response(client, assessment, oggy_response)
        oggy_scores.append(oggy_score)

        # Show scores
        print_score(f"Base", base_score)
        print_score(f"Oggy", oggy_score)

        delta = oggy_score - base_score
        delta_color = Colors.GREEN if delta > 0 else Colors.RED if delta < 0 else Colors.YELLOW
        print(f"{delta_color}Delta: {delta:+.1f}{Colors.END}")

    return {"base": base_scores, "oggy": oggy_scores}


async def trigger_continuous_learning(client: httpx.AsyncClient, num_cycles: int = 3) -> Dict[str, Any]:
    """Trigger continuous learning cycles"""
    print_info(f"Triggering {num_cycles} continuous learning cycles...")

    results = []
    for cycle in range(1, num_cycles + 1):
        try:
            print(f"  Cycle {cycle}/{num_cycles}...", end=" ")
            response = await client.post(
                f"{LEARNING_SERVICE}/training/loop",
                json={
                    "max_items": 10,
                    "cycle_type": "manual",
                    "owner_type": "user",
                    "owner_id": "learning_impact_test"
                },
                timeout=120.0
            )
            response.raise_for_status()
            result = response.json()
            results.append(result)
            print(f"{Colors.GREEN}OK{Colors.END} "
                  f"(processed: {result.get('completed_items', 0)}, "
                  f"updates: {result.get('updates_applied', 0)})")
        except Exception as e:
            print(f"{Colors.RED}FAILED{Colors.END} - {e}")
            return {}

    return {
        "total_cycles": len(results),
        "total_items_processed": sum(r.get("completed_items", 0) for r in results),
        "total_updates_applied": sum(r.get("updates_applied", 0) for r in results),
        "cycles": results
    }


async def trigger_self_driven_learning(client: httpx.AsyncClient) -> Dict[str, Any]:
    """Trigger self-driven learning"""
    print_info("Triggering self-driven learning (gap detection & practice)...")

    try:
        response = await client.post(
            f"{LEARNING_SERVICE}/training/sdl",
            json={
                "owner_type": "user",
                "owner_id": "learning_impact_test",
                "max_plans": 2
            },
            timeout=120.0
        )
        response.raise_for_status()
        result = response.json()

        gaps_detected = result.get("gaps_detected", 0)
        plans_executed = result.get("plans_executed", 0)

        print_success(f"Detected {gaps_detected} gaps, executed {plans_executed} SDL plans")
        return result

    except Exception as e:
        print_error(f"SDL failed: {e}")
        return {}


async def run_learning_impact_test():
    """Run comprehensive before/after learning test"""
    print_header("LEARNING IMPACT TEST")
    print(f"{Colors.BOLD}Testing Oggy's improvement after learning vs Base (no learning){Colors.END}\n")

    # Load practice pack
    print_info("Loading practice pack...")
    practice_pack = load_practice_pack()
    # Practice pack uses "items" not "assessments" after conversion
    assessments = practice_pack.get("items", practice_pack.get("assessments", []))

    if not assessments:
        print_error("No items found in practice pack")
        return

    # Use all 10 items
    test_assessments = assessments[:10]
    print_success(f"Loaded {len(test_assessments)} items from practice pack\n")

    async with httpx.AsyncClient() as client:
        # Phase 1: Baseline (before learning)
        print_header("PHASE 1: BASELINE (Before Learning)")
        baseline_results = await run_assessment_suite(client, test_assessments, "Baseline")

        base_baseline_avg = sum(baseline_results["base"]) / len(baseline_results["base"])
        oggy_baseline_avg = sum(baseline_results["oggy"]) / len(baseline_results["oggy"])

        print(f"\n{Colors.BOLD}Baseline Averages:{Colors.END}")
        print_score("Base (gpt-4o-mini)", base_baseline_avg)
        print_score("Oggy (gpt-4o)", oggy_baseline_avg)

        baseline_delta = oggy_baseline_avg - base_baseline_avg
        delta_color = Colors.GREEN if baseline_delta > 0 else Colors.RED
        print(f"{Colors.BOLD}Baseline Delta:{Colors.END} {delta_color}{baseline_delta:+.2f}{Colors.END}")

        # Phase 2: Learning
        print_header("PHASE 2: CONTINUOUS LEARNING")
        learning_results = await trigger_continuous_learning(client, num_cycles=3)

        if not learning_results:
            print_error("Continuous learning failed. Aborting test.")
            return

        print(f"\n{Colors.BOLD}Learning Summary:{Colors.END}")
        print(f"  Total cycles: {learning_results['total_cycles']}")
        print(f"  Items processed: {learning_results['total_items_processed']}")
        print(f"  Updates applied: {learning_results['total_updates_applied']}")

        # Phase 3: Self-Driven Learning
        print_header("PHASE 3: SELF-DRIVEN LEARNING")
        sdl_results = await trigger_self_driven_learning(client)

        if sdl_results:
            print(f"\n{Colors.BOLD}SDL Summary:{Colors.END}")
            print(f"  Gaps detected: {sdl_results.get('gaps_detected', 0)}")
            print(f"  Plans executed: {sdl_results.get('plans_executed', 0)}")

        # Phase 4: Post-Learning Assessment
        print_header("PHASE 4: POST-LEARNING ASSESSMENT")
        postlearning_results = await run_assessment_suite(client, test_assessments, "Post-Learning")

        base_postlearning_avg = sum(postlearning_results["base"]) / len(postlearning_results["base"])
        oggy_postlearning_avg = sum(postlearning_results["oggy"]) / len(postlearning_results["oggy"])

        print(f"\n{Colors.BOLD}Post-Learning Averages:{Colors.END}")
        print_score("Base (gpt-4o-mini)", base_postlearning_avg)
        print_score("Oggy (gpt-4o)", oggy_postlearning_avg)

        postlearning_delta = oggy_postlearning_avg - base_postlearning_avg
        delta_color = Colors.GREEN if postlearning_delta > 0 else Colors.RED
        print(f"{Colors.BOLD}Post-Learning Delta:{Colors.END} {delta_color}{postlearning_delta:+.2f}{Colors.END}")

    # Final Analysis
    print_header("LEARNING IMPACT ANALYSIS")

    base_improvement = base_postlearning_avg - base_baseline_avg
    oggy_improvement = oggy_postlearning_avg - oggy_baseline_avg

    print(f"\n{Colors.BOLD}Score Changes (Baseline -> Post-Learning):{Colors.END}")

    base_color = Colors.GREEN if base_improvement > 0 else Colors.RED if base_improvement < 0 else Colors.YELLOW
    print(f"Base:  {base_baseline_avg:.2f} -> {base_postlearning_avg:.2f} "
          f"{base_color}({base_improvement:+.2f}){Colors.END}")

    oggy_color = Colors.GREEN if oggy_improvement > 0 else Colors.RED if oggy_improvement < 0 else Colors.YELLOW
    print(f"Oggy:  {oggy_baseline_avg:.2f} -> {oggy_postlearning_avg:.2f} "
          f"{oggy_color}({oggy_improvement:+.2f}){Colors.END}")

    print(f"\n{Colors.BOLD}Learning Effectiveness:{Colors.END}")

    if oggy_improvement > base_improvement:
        net_learning_gain = oggy_improvement - base_improvement
        print(f"{Colors.GREEN}Oggy gained {net_learning_gain:+.2f} points MORE than Base{Colors.END}")
        print(f"This demonstrates the effectiveness of continuous + self-driven learning!")
    elif oggy_improvement == base_improvement:
        print(f"{Colors.YELLOW}Both agents improved equally{Colors.END}")
        print(f"Learning may need more cycles or better training data")
    else:
        print(f"{Colors.RED}Base improved more than Oggy{Colors.END}")
        print(f"This suggests learning may be introducing noise or conflicting patterns")

    print(f"\n{Colors.BOLD}Key Metrics:{Colors.END}")
    print(f"  Baseline gap: {baseline_delta:+.2f} (Oggy ahead)")
    print(f"  Post-learning gap: {postlearning_delta:+.2f} (Oggy ahead)")
    gap_change = postlearning_delta - baseline_delta
    gap_color = Colors.GREEN if gap_change > 0 else Colors.RED
    print(f"  Gap change: {gap_color}{gap_change:+.2f}{Colors.END}")

    print(f"\n{Colors.BOLD}Conclusion:{Colors.END}")
    if oggy_improvement > 1.0 and oggy_improvement > base_improvement:
        print(f"{Colors.GREEN}SUCCESS!{Colors.END} Oggy's learning system is working effectively.")
        print(f"  - Oggy improved by {oggy_improvement:.2f} points through learning")
        print(f"  - This is {net_learning_gain:.2f} points more than Base's improvement")
        print(f"  - Continuous learning + SDL successfully enhanced performance")
    elif oggy_improvement > 0:
        print(f"{Colors.YELLOW}PARTIAL SUCCESS{Colors.END} Oggy learned, but improvement is modest.")
        print(f"  - Oggy improved by {oggy_improvement:.2f} points")
        print(f"  - More training cycles or diverse examples may help")
    else:
        print(f"{Colors.RED}LEARNING NOT EFFECTIVE{Colors.END}")
        print(f"  - Oggy did not improve or regressed")
        print(f"  - May need to adjust learning parameters or gate settings")


async def main():
    """Main entry point"""
    print(f"\n{Colors.BOLD}Oggy Learning System - Learning Impact Test{Colors.END}")
    print(f"Measures improvement after continuous + self-driven learning\n")

    try:
        await run_learning_impact_test()
        print(f"\n{Colors.GREEN}{Colors.BOLD}[COMPLETE] Learning impact test finished{Colors.END}\n")
        sys.exit(0)
    except KeyboardInterrupt:
        print(f"\n\n{Colors.YELLOW}Test interrupted by user{Colors.END}\n")
        sys.exit(130)
    except Exception as e:
        print(f"\n{Colors.RED}{Colors.BOLD}[FAILED] Test failed{Colors.END}")
        print(f"{Colors.RED}Error: {e}{Colors.END}\n")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
