#!/usr/bin/env python3
"""
Oggy vs Base Agent Comparison Test
Runs 5 assessments from the practice pack on both agents and compares results
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
    print(f"{color}{agent:12s}: {score:.1f}/10{Colors.END}")


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
        response = await client.post(
            f"{LEARNING_SERVICE}/agents/generate",
            json={
                "agent": agent_type,
                "user_input": assessment["prompt"],
                "owner_type": "user",
                "owner_id": "comparison_test"
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

        # If no response, score is 0
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

            # Check if any acceptable answer is in the response
            for acceptable_answer in acceptable_lower:
                if acceptable_answer in actual:
                    return rubric["semantic_match"].get("points", 7)

        # Check for components-based scoring (pattern analysis, budget advice)
        if "components" in rubric:
            total_weight = sum(comp.get("weight", 0) for comp in rubric["components"])
            score = 0.0

            for component in rubric["components"]:
                required = component.get("required", "").lower()
                weight = component.get("weight", 0)

                # Simple keyword matching for component presence
                if required in actual:
                    score += weight * 10  # 10 is max points

            return min(score, 10.0)  # Cap at 10

        # Default: partial credit if response contains expected output
        if expected in actual:
            return 5.0

        # No match found
        return 0.0

    except Exception as e:
        print_error(f"Failed to score response: {e}")
        return 0.0


async def run_comparison_test(num_tests: int = 5):
    """Run comparison test between Oggy and Base agents"""
    print_header("OGGY vs BASE AGENT COMPARISON TEST")

    # Load practice pack
    print_info("Loading practice pack...")
    practice_pack = load_practice_pack()
    assessments = practice_pack.get("assessments", [])

    if not assessments:
        print_error("No assessments found in practice pack")
        return

    # Select first num_tests assessments
    test_assessments = assessments[:min(num_tests, len(assessments))]
    print_success(f"Loaded {len(test_assessments)} assessments from practice pack")

    # Run tests
    results = []

    async with httpx.AsyncClient() as client:
        for i, assessment in enumerate(test_assessments, 1):
            print_subheader(f"Assessment {i}/{len(test_assessments)}: {assessment.get('type', 'unknown')}")
            print(f"{Colors.CYAN}Difficulty:{Colors.END} {assessment.get('difficulty', 'N/A')}/5")
            print(f"{Colors.CYAN}Prompt:{Colors.END}")
            print(f"  {assessment['prompt'][:100]}{'...' if len(assessment['prompt']) > 100 else ''}")
            print(f"\n{Colors.CYAN}Expected:{Colors.END} {assessment.get('expected_output', 'N/A')[:80]}...")

            # Run Base agent
            print(f"\n{Colors.MAGENTA}Running Base Agent...{Colors.END}")
            base_result = await run_assessment(client, "base", assessment)
            base_response = base_result.get("response", "")
            print(f"Response: {base_response[:150]}{'...' if len(base_response) > 150 else ''}")

            # Run Oggy agent
            print(f"\n{Colors.MAGENTA}Running Oggy Agent...{Colors.END}")
            oggy_result = await run_assessment(client, "oggy", assessment)
            oggy_response = oggy_result.get("response", "")
            print(f"Response: {oggy_response[:150]}{'...' if len(oggy_response) > 150 else ''}")

            # Score responses
            print(f"\n{Colors.BOLD}Scoring...{Colors.END}")
            base_score = await score_response(client, assessment, base_response)
            oggy_score = await score_response(client, assessment, oggy_response)

            print_score("Base", base_score)
            print_score("Oggy", oggy_score)

            delta = oggy_score - base_score
            delta_color = Colors.GREEN if delta > 0 else Colors.RED if delta < 0 else Colors.YELLOW
            print(f"{delta_color}Delta:{Colors.END} {delta:+.1f}")

            # Store results
            results.append({
                "assessment_id": assessment.get("assessment_id"),
                "type": assessment.get("type"),
                "difficulty": assessment.get("difficulty"),
                "prompt": assessment["prompt"],
                "expected": assessment.get("expected_output"),
                "base_response": base_response,
                "oggy_response": oggy_response,
                "base_score": base_score,
                "oggy_score": oggy_score,
                "delta": delta
            })

    # Summary
    print_header("TEST SUMMARY")

    base_avg = sum(r["base_score"] for r in results) / len(results)
    oggy_avg = sum(r["oggy_score"] for r in results) / len(results)
    avg_delta = oggy_avg - base_avg

    print(f"\n{Colors.BOLD}Average Scores:{Colors.END}")
    print_score("Base Avg", base_avg)
    print_score("Oggy Avg", oggy_avg)

    delta_color = Colors.GREEN if avg_delta > 0 else Colors.RED if avg_delta < 0 else Colors.YELLOW
    print(f"\n{Colors.BOLD}Overall Delta:{Colors.END} {delta_color}{avg_delta:+.2f}{Colors.END}")

    # Wins/Losses/Ties
    wins = sum(1 for r in results if r["delta"] > 0)
    losses = sum(1 for r in results if r["delta"] < 0)
    ties = sum(1 for r in results if r["delta"] == 0)

    print(f"\n{Colors.BOLD}Win/Loss Record:{Colors.END}")
    print(f"{Colors.GREEN}Oggy Wins:{Colors.END} {wins}/{len(results)}")
    print(f"{Colors.RED}Oggy Losses:{Colors.END} {losses}/{len(results)}")
    print(f"{Colors.YELLOW}Ties:{Colors.END} {ties}/{len(results)}")

    # Detailed breakdown by assessment type
    print(f"\n{Colors.BOLD}Performance by Assessment Type:{Colors.END}")
    types = {}
    for r in results:
        atype = r["type"]
        if atype not in types:
            types[atype] = {"base": [], "oggy": []}
        types[atype]["base"].append(r["base_score"])
        types[atype]["oggy"].append(r["oggy_score"])

    for atype, scores in types.items():
        base_type_avg = sum(scores["base"]) / len(scores["base"])
        oggy_type_avg = sum(scores["oggy"]) / len(scores["oggy"])
        type_delta = oggy_type_avg - base_type_avg

        print(f"\n{Colors.CYAN}{atype}:{Colors.END}")
        print(f"  Base: {base_type_avg:.1f}")
        print(f"  Oggy: {oggy_type_avg:.1f}")
        delta_color = Colors.GREEN if type_delta > 0 else Colors.RED if type_delta < 0 else Colors.YELLOW
        print(f"  Delta: {delta_color}{type_delta:+.1f}{Colors.END}")

    # Key insights
    print_header("KEY INSIGHTS")

    if avg_delta > 0.5:
        print_success(f"Oggy shows {Colors.BOLD}meaningful improvement{Colors.END} over Base (+{avg_delta:.1f} avg)")
        print(f"  - Oggy won {wins}/{len(results)} assessments")
        print(f"  - Strongest in: {max(types.items(), key=lambda x: sum(x[1]['oggy'])/len(x[1]['oggy']) - sum(x[1]['base'])/len(x[1]['base']))[0]}")
    elif avg_delta > 0:
        print_info(f"Oggy shows {Colors.BOLD}slight improvement{Colors.END} over Base (+{avg_delta:.1f} avg)")
        print(f"  - This is expected early in training")
        print(f"  - More practice cycles will likely improve performance")
    elif avg_delta == 0:
        print_info("Oggy and Base perform {Colors.BOLD}equally{Colors.END} on these assessments")
        print(f"  - Oggy may need more training cycles")
        print(f"  - Memory substrate may not yet contain relevant patterns")
    else:
        print_info(f"Base slightly outperforms Oggy ({avg_delta:.1f} avg)")
        print(f"  - This can happen early in training")
        print(f"  - Oggy's memory may contain conflicting patterns")
        print(f"  - Pattern Learning Gate may be filtering updates")

    print(f"\n{Colors.BOLD}Recommendations:{Colors.END}")
    print(f"  1. Run more training cycles: POST {LEARNING_SERVICE}/training/loop")
    print(f"  2. Enable self-driven learning for targeted improvement")
    print(f"  3. Review audit trail to see what Oggy is learning")
    print(f"  4. Check gate state - may need to open further for more learning")

    return results


async def main():
    """Main entry point"""
    print(f"\n{Colors.BOLD}Oggy Learning System - Agent Comparison{Colors.END}")
    print(f"Testing Oggy (learning-enabled) vs Base (no learning)\n")

    try:
        results = await run_comparison_test(num_tests=5)

        if results:
            print(f"\n{Colors.GREEN}{Colors.BOLD}[SUCCESS] Comparison test completed{Colors.END}")
            print(f"{Colors.GREEN}Results show baseline performance vs learning-enabled agent{Colors.END}\n")
            sys.exit(0)
        else:
            print(f"\n{Colors.YELLOW}{Colors.BOLD}[WARN] Test completed with issues{Colors.END}\n")
            sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n\n{Colors.YELLOW}Test interrupted by user{Colors.END}\n")
        sys.exit(130)
    except Exception as e:
        print(f"\n{Colors.RED}{Colors.BOLD}[FAILED] Test failed{Colors.END}")
        print(f"{Colors.RED}Error: {e}{Colors.END}\n")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
