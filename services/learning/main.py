import os
import httpx
import asyncio
import json
from pathlib import Path
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import uuid
from contextlib import asynccontextmanager
from scoring import score_response
from cir import validate_request, validate_response, log_violation
from cir.violation_logger import init_logger, get_violations, get_violation_stats
from cir.pattern_learning import learn_from_violations, get_learned_patterns, analyze_effectiveness
from evaluation.runner import run_bundle_evaluation, compare_results
from agents import BaseAgent, OggyAgent

# Week 4: Continuous Learning Loop imports
from loop import (
    OggyLearningLoop,
    MemoryValidationUtility,
    GateState,
    TessaClient,
    WorkQueue,
    SelfDrivenLearning,
)

# APScheduler for periodic learning
try:
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger
    SCHEDULER_AVAILABLE = True
except ImportError:
    SCHEDULER_AVAILABLE = False
    print("Warning: APScheduler not available. Scheduled learning disabled.")

# Learning loop instance (initialized on startup)
learning_loop: Optional[OggyLearningLoop] = None
scheduler: Optional["AsyncIOScheduler"] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup/shutdown"""
    global learning_loop, scheduler

    print("\n🚀 Learning Service starting...")

    # Initialize learning loop
    learning_loop = OggyLearningLoop(
        memory_service_url=os.getenv("MEMORY_SERVICE_URL", "http://localhost:3000"),
        enable_self_driven=os.getenv("ENABLE_SELF_DRIVEN", "false").lower() == "true",
    )
    print(f"   Learning Loop: Initialized")
    print(f"   Gate State: {learning_loop.get_gate_state().value}")

    # Initialize scheduler if available
    if SCHEDULER_AVAILABLE:
        scheduler = AsyncIOScheduler()

        # Schedule learning cycle (default: daily at 2am)
        schedule_hour = int(os.getenv("LEARNING_SCHEDULE_HOUR", "2"))
        schedule_minute = int(os.getenv("LEARNING_SCHEDULE_MINUTE", "0"))

        scheduler.add_job(
            scheduled_learning_cycle,
            CronTrigger(hour=schedule_hour, minute=schedule_minute),
            id="learning_cycle",
            name="Daily Learning Cycle",
        )

        scheduler.start()
        print(f"   Scheduler: Running (next cycle at {schedule_hour:02d}:{schedule_minute:02d})")
    else:
        print("   Scheduler: Not available (APScheduler not installed)")

    # Initialize CIR violation logger
    db_url = os.getenv(
        "DATABASE_URL",
        "postgresql://oggy:oggy_password@postgres:5432/oggy_db"
    )
    try:
        await init_logger(db_url)
        print(f"   CIR Logger: Connected to database")
    except Exception as e:
        print(f"   CIR Logger: WARNING - Failed to connect to database: {e}")
        print(f"   CIR violations will be logged to console only")

    print(f"   Memory Service: {os.getenv('MEMORY_SERVICE_URL', 'http://localhost:3000')}")
    print(f"   Endpoints:")
    print(f"     - GET  /health")
    print(f"     - GET  /metrics")
    print(f"     - POST /training/loop (manual trigger)")
    print(f"     - POST /training/sdl (self-driven learning)")
    print(f"     - GET  /training/stats")
    print()

    yield

    # Shutdown
    if scheduler:
        scheduler.shutdown()
    print("Learning Service stopped")


app = FastAPI(title="Learning Service", version="0.1.0", lifespan=lifespan)

# Memory service URL
MEMORY_SERVICE_URL = os.getenv("MEMORY_SERVICE_URL", "http://localhost:3000")

# Metrics (in-memory for Week 1)
metrics = {
    "updates_attempted": 0,
    "updates_applied": 0,
    "updates_rejected": 0,
}


class TrainingLoopRequest(BaseModel):
    owner_type: str = "user"
    owner_id: str
    agent: str = "oggy"


class EvaluationTestRequest(BaseModel):
    bundle_path: str
    agent_response: str
    item_id: str


class ValidateRequestRequest(BaseModel):
    user_input: str
    context: Optional[Dict[str, Any]] = None


class ValidateResponseRequest(BaseModel):
    response: str
    user_input: str
    context: Optional[Dict[str, Any]] = None
    check_pii: bool = True
    check_policy: bool = True


class RunBundleRequest(BaseModel):
    bundle_path: str
    agent: str  # 'base' or 'oggy'
    owner_type: str = "user"
    owner_id: str = "eval"
    apply_learning: bool = False


class AgentGenerateRequest(BaseModel):
    user_input: str
    agent: str  # 'base' or 'oggy'
    owner_type: str = "user"
    owner_id: str = "default"
    context: Optional[Dict[str, Any]] = None
    outcome: Optional[str] = None  # 'success' or 'failure' (for Oggy learning)
    score: Optional[float] = None  # 0-10 (for Oggy learning)


# Week 4: Learning Loop Request Models
class LearningLoopRequest(BaseModel):
    owner_type: str = "user"
    owner_id: str = "training"
    max_items: Optional[int] = None
    cycle_type: str = "manual"


class SDLTriggerRequest(BaseModel):
    owner_type: str = "user"
    owner_id: str = "sdl"
    max_plans: int = 1


class SetGateStateRequest(BaseModel):
    gate_state: str  # GATE_CLOSED, GATE_OPEN_LIMITED, GATE_OPEN_FULL


@app.get("/health")
async def health():
    """Health check endpoint"""
    return {
        "ok": True,
        "service": "learning-service",
        "version": "0.1.0",
        "memory_service": MEMORY_SERVICE_URL,
    }


@app.get("/metrics")
async def get_metrics():
    """Get current metrics"""
    return metrics


@app.post("/training/toy-loop")
async def toy_training_loop(request: TrainingLoopRequest):
    """
    Toy training loop for Week 1 demo.

    Steps:
    1. Call /retrieve to get memory cards
    2. Simulate an outcome (success/failure)
    3. Call /utility/update with evidence pointer
    4. Emit metrics
    """

    async with httpx.AsyncClient() as client:
        try:
            # Step 1: Retrieve memory cards
            retrieve_response = await client.post(
                f"{MEMORY_SERVICE_URL}/retrieve",
                json={
                    "agent": request.agent,
                    "owner_type": request.owner_type,
                    "owner_id": request.owner_id,
                    "top_k": 5,
                },
                timeout=10.0,
            )

            if retrieve_response.status_code != 200:
                raise HTTPException(
                    status_code=500,
                    detail=f"Retrieve failed: {retrieve_response.text}"
                )

            retrieve_data = retrieve_response.json()
            trace_id = retrieve_data["trace_id"]
            selected_cards = retrieve_data["selected"]

            if not selected_cards:
                return {
                    "message": "No cards to update",
                    "trace_id": trace_id,
                    "metrics": metrics,
                }

            # Step 2: Simulate outcome (for demo, we'll say first card was successful)
            card_to_update = selected_cards[0]
            card_id = card_to_update["card_id"]

            # Simulate: card was used and contributed to success
            simulated_outcome = "success"  # or "failure"

            # Step 3: Build context with evidence pointer
            context = {
                "agent": request.agent,
                "program": "learning_loop",
                "action": "UPDATE_CARD",
                "evidence": {
                    "trace_id": trace_id,
                    "assessment_id": str(uuid.uuid4()),  # Simulated assessment
                },
                "intent": {
                    "event_type": "outcome",
                    "outcome": simulated_outcome,
                },
                "reason_text": f"Toy training loop: card used in {simulated_outcome}",
            }

            # Build patch (increase utility for success)
            patch = {
                "utility_delta": 0.1 if simulated_outcome == "success" else -0.05,
            }

            # Step 4: Call /utility/update
            metrics["updates_attempted"] += 1

            update_response = await client.post(
                f"{MEMORY_SERVICE_URL}/utility/update",
                json={
                    "card_id": card_id,
                    "context": context,
                    "patch": patch,
                },
                timeout=10.0,
            )

            if update_response.status_code == 200:
                metrics["updates_applied"] += 1
                update_data = update_response.json()

                return {
                    "message": "Toy training loop completed successfully",
                    "trace_id": trace_id,
                    "card_id": card_id,
                    "event_id": update_data["event_id"],
                    "outcome": simulated_outcome,
                    "new_utility_weight": update_data["utility_weight"],
                    "reason_code": update_data["reason_code"],
                    "metrics": metrics,
                }
            else:
                metrics["updates_rejected"] += 1
                error_data = update_response.json()

                return {
                    "message": "Toy training loop: update rejected",
                    "trace_id": trace_id,
                    "card_id": card_id,
                    "error": error_data,
                    "metrics": metrics,
                }

        except Exception as e:
            metrics["updates_rejected"] += 1
            raise HTTPException(status_code=500, detail=str(e))


@app.post("/evaluation/test-scoring")
async def test_scoring(request: EvaluationTestRequest):
    """
    Test the scoring framework with a specific evaluation item

    Args:
        bundle_path: Path to evaluation bundle JSON file
        agent_response: The agent's response to score
        item_id: Which item in the bundle to evaluate against

    Returns:
        Scoring result with score, feedback, and pass/fail status
    """
    try:
        # Load evaluation bundle
        bundle_file = Path(request.bundle_path)
        if not bundle_file.exists():
            raise HTTPException(status_code=404, detail=f"Bundle not found: {request.bundle_path}")

        with open(bundle_file, 'r') as f:
            bundle = json.load(f)

        # Find the requested item
        item = None
        for eval_item in bundle.get("items", []):
            if eval_item["item_id"] == request.item_id:
                item = eval_item
                break

        if not item:
            raise HTTPException(status_code=404, detail=f"Item not found: {request.item_id}")

        # Get scoring config from bundle
        scoring_config = bundle.get("scoring_config", {})

        # Score the response
        result = await score_response(
            agent_output=request.agent_response,
            item=item,
            scoring_config=scoring_config
        )

        return {
            "bundle_id": bundle.get("bundle_id"),
            "item_id": request.item_id,
            "input": item.get("input"),
            "agent_response": request.agent_response,
            "expected_output": item.get("expected_output"),
            "scoring": result.to_dict(),
            "item_difficulty": item.get("difficulty"),
            "item_tags": item.get("tags", [])
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Evaluation error: {str(e)}")


@app.post("/cir/validate-request")
async def validate_user_request(request: ValidateRequestRequest):
    """
    Validate user request through CIR request gate

    Returns:
        Validation result with blocked status and reason
    """
    try:
        result = await validate_request(request.user_input, request.context)

        # Log if blocked
        if result["blocked"]:
            await log_violation(
                gate_type="request",
                user_input=request.user_input,
                blocked=True,
                pattern=result.get("pattern"),
                reason=result.get("reason"),
                category=result.get("category"),
                context=request.context,
            )

        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Validation error: {str(e)}")


@app.post("/cir/validate-response")
async def validate_agent_response(request: ValidateResponseRequest):
    """
    Validate agent response through CIR response gate

    Returns:
        Validation result with violations and PII detection
    """
    try:
        result = await validate_response(
            response=request.response,
            context=request.context,
            check_pii=request.check_pii,
            check_policy=request.check_policy,
        )

        # Log if blocked
        if result["blocked"]:
            await log_violation(
                gate_type="response",
                user_input=request.user_input,
                agent_response=request.response,
                blocked=True,
                reason=result.get("reason"),
                context=request.context,
            )

        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Validation error: {str(e)}")


@app.get("/cir/violations")
async def get_cir_violations(
    gate_type: Optional[str] = None,
    blocked_only: bool = False,
    limit: int = 100
):
    """
    Get recent CIR violations

    Args:
        gate_type: Filter by 'request' or 'response' (optional)
        blocked_only: Only return blocked violations
        limit: Maximum number of violations to return

    Returns:
        List of violation records
    """
    try:
        violations = await get_violations(gate_type, blocked_only, limit)
        return {
            "count": len(violations),
            "violations": violations
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error fetching violations: {str(e)}")


@app.get("/cir/stats")
async def get_cir_stats():
    """
    Get CIR violation statistics

    Returns:
        Statistics about violations and patterns
    """
    try:
        stats = await get_violation_stats()
        return stats

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error fetching stats: {str(e)}")


@app.post("/cir/learn-patterns")
async def trigger_pattern_learning(min_occurrences: int = 3):
    """
    Trigger pattern learning from recent violations

    Args:
        min_occurrences: Minimum times a pattern must occur to be learned

    Returns:
        List of newly learned patterns
    """
    try:
        new_patterns = await learn_from_violations(min_occurrences)

        return {
            "new_patterns_count": len(new_patterns),
            "new_patterns": new_patterns,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Pattern learning error: {str(e)}")


@app.get("/cir/learned-patterns")
async def get_cir_learned_patterns():
    """
    Get all learned patterns

    Returns:
        List of learned patterns
    """
    try:
        patterns = await get_learned_patterns()
        return {
            "count": len(patterns),
            "patterns": patterns
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error fetching patterns: {str(e)}")


@app.get("/cir/effectiveness")
async def get_cir_effectiveness():
    """
    Analyze effectiveness of pattern learning

    Returns:
        Statistics about learned patterns and their effectiveness
    """
    try:
        effectiveness = await analyze_effectiveness()
        return effectiveness

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error analyzing effectiveness: {str(e)}")


@app.post("/agents/generate")
async def agent_generate(request: AgentGenerateRequest):
    """
    Generate response using Base or Oggy agent

    Args:
        request: Agent generation request with input and optional learning feedback

    Returns:
        Agent response with metadata
    """
    try:
        # Initialize agent
        if request.agent == "base":
            agent = BaseAgent(MEMORY_SERVICE_URL)
        elif request.agent == "oggy":
            agent = OggyAgent(MEMORY_SERVICE_URL)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown agent: {request.agent}")

        # Generate response (with learning for Oggy if outcome/score provided)
        if request.agent == "oggy" and (request.outcome or request.score is not None):
            result = await agent.generate_response(
                user_input=request.user_input,
                owner_type=request.owner_type,
                owner_id=request.owner_id,
                context=request.context,
                outcome=request.outcome,
                score=request.score,
            )
        else:
            result = await agent.generate_response(
                user_input=request.user_input,
                owner_type=request.owner_type,
                owner_id=request.owner_id,
                context=request.context,
            )

        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent generation error: {str(e)}")


@app.post("/evaluation/run-bundle")
async def run_bundle(request: RunBundleRequest):
    """
    Run full evaluation bundle on an agent

    Args:
        request: Bundle evaluation request

    Returns:
        Evaluation results with scores and pass rates
    """
    try:
        result = await run_bundle_evaluation(
            bundle_path=request.bundle_path,
            agent_type=request.agent,
            memory_service_url=MEMORY_SERVICE_URL,
            owner_type=request.owner_type,
            owner_id=request.owner_id,
            apply_learning=request.apply_learning,
        )

        # Convert dataclass to dict
        return {
            "bundle_id": result.bundle_id,
            "agent": result.agent,
            "total_items": result.total_items,
            "completed_items": result.completed_items,
            "failed_items": result.failed_items,
            "average_score": result.average_score,
            "pass_rate": result.pass_rate,
            "item_results": [
                {
                    "item_id": item.item_id,
                    "input": item.input,
                    "agent_response": item.agent_response,
                    "expected_output": item.expected_output,
                    "score": item.score,
                    "max_score": item.max_score,
                    "passed": item.passed,
                    "feedback": item.feedback,
                    "reasoning": item.reasoning,
                    "error": item.error,
                }
                for item in result.item_results
            ],
            "metadata": result.metadata,
        }

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Evaluation error: {str(e)}")


# Week 4: Scheduled Learning Cycle
async def scheduled_learning_cycle():
    """Scheduled learning cycle (called by APScheduler)"""
    global learning_loop

    if not learning_loop:
        print("Warning: Learning loop not initialized, skipping scheduled cycle")
        return

    print(f"🔄 Starting scheduled learning cycle...")
    try:
        result = await learning_loop.run_cycle(
            cycle_type="scheduled",
            owner_type="user",
            owner_id="scheduled",
        )
        print(f"✅ Scheduled cycle completed: {result.completed_items}/{result.total_items} items, "
              f"avg score: {result.average_score:.2f}, updates: {result.updates_applied}")
    except Exception as e:
        print(f"❌ Scheduled cycle failed: {e}")


# Week 4: Learning Loop Endpoints
@app.post("/training/loop")
async def trigger_learning_loop(request: LearningLoopRequest, background_tasks: BackgroundTasks):
    """
    Manually trigger a learning cycle

    Args:
        request: Learning loop configuration

    Returns:
        Cycle result with processing stats
    """
    global learning_loop

    if not learning_loop:
        raise HTTPException(status_code=503, detail="Learning loop not initialized")

    try:
        result = await learning_loop.run_cycle(
            cycle_type=request.cycle_type,
            owner_type=request.owner_type,
            owner_id=request.owner_id,
            max_items=request.max_items,
        )

        return {
            "cycle_id": result.cycle_id,
            "cycle_type": result.cycle_type,
            "total_items": result.total_items,
            "completed_items": result.completed_items,
            "failed_items": result.failed_items,
            "average_score": result.average_score,
            "pass_rate": result.pass_rate,
            "updates_proposed": result.updates_proposed,
            "updates_applied": result.updates_applied,
            "updates_rejected": result.updates_rejected,
            "gate_state": result.gate_state,
            "benchmark_delta": result.benchmark_delta,
            "duration_seconds": result.duration_seconds,
            "metadata": result.metadata,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Learning cycle error: {str(e)}")


@app.post("/training/sdl")
async def trigger_self_driven_learning(request: SDLTriggerRequest):
    """
    Trigger self-driven learning (gap detection and targeted practice)

    Args:
        request: SDL configuration

    Returns:
        SDL execution results
    """
    global learning_loop

    if not learning_loop:
        raise HTTPException(status_code=503, detail="Learning loop not initialized")

    if not learning_loop.enable_self_driven or not learning_loop.sdl:
        raise HTTPException(status_code=400, detail="Self-driven learning is not enabled")

    try:
        # Detect gaps
        gaps = await learning_loop.sdl.detect_gaps()

        if not gaps:
            return {
                "message": "No gaps detected",
                "gaps_detected": 0,
                "plans_executed": 0,
            }

        # Execute SDL plans
        executed_plans = []
        for gap in gaps[:request.max_plans]:
            plan = await learning_loop.sdl.create_sdl_plan(gap)
            if plan:
                plan_result = await learning_loop.sdl.execute_plan(plan)
                executed_plans.append({
                    "plan_id": plan.plan_id,
                    "goal": plan.goal,
                    "trigger_type": plan.trigger_type,
                    "status": plan.status,
                    "items_practiced": plan.items_practiced,
                    "final_score": plan.final_score,
                    "updates_applied": plan.updates_applied,
                    "duration_seconds": plan_result.duration_seconds,
                })

        return {
            "gaps_detected": len(gaps),
            "gaps": [
                {
                    "signal_id": gap.signal_id,
                    "trigger_type": gap.trigger_type,
                    "severity": gap.severity,
                    "domain": gap.domain,
                    "description": gap.description,
                }
                for gap in gaps
            ],
            "plans_executed": len(executed_plans),
            "plans": executed_plans,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SDL error: {str(e)}")


@app.get("/training/stats")
async def get_training_stats():
    """
    Get learning loop and SDL statistics

    Returns:
        Current training statistics
    """
    global learning_loop

    if not learning_loop:
        raise HTTPException(status_code=503, detail="Learning loop not initialized")

    try:
        stats = await learning_loop.get_stats()

        # Add SDL stats if enabled
        if learning_loop.enable_self_driven and learning_loop.sdl:
            stats["sdl"] = learning_loop.sdl.get_stats()

        # Add scheduler info
        if scheduler and SCHEDULER_AVAILABLE:
            jobs = scheduler.get_jobs()
            stats["scheduler"] = {
                "running": scheduler.running,
                "jobs": [
                    {
                        "id": job.id,
                        "name": job.name,
                        "next_run": str(job.next_run_time) if job.next_run_time else None,
                    }
                    for job in jobs
                ],
            }
        else:
            stats["scheduler"] = {"available": False}

        return stats

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Stats error: {str(e)}")


@app.post("/training/gate-state")
async def set_gate_state(request: SetGateStateRequest):
    """
    Set the learning gate state

    Args:
        request: Gate state to set

    Returns:
        New gate state
    """
    global learning_loop

    if not learning_loop:
        raise HTTPException(status_code=503, detail="Learning loop not initialized")

    try:
        state = GateState(request.gate_state)
        learning_loop.set_gate_state(state)

        return {
            "gate_state": state.value,
            "message": f"Gate state set to {state.value}",
        }

    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid gate state: {request.gate_state}. "
                   f"Must be one of: GATE_CLOSED, GATE_OPEN_LIMITED, GATE_OPEN_FULL"
        )


@app.get("/training/gate-state")
async def get_gate_state():
    """Get current learning gate state"""
    global learning_loop

    if not learning_loop:
        raise HTTPException(status_code=503, detail="Learning loop not initialized")

    return {
        "gate_state": learning_loop.get_gate_state().value,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
