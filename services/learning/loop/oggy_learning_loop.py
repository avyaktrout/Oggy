"""
Oggy Learning Loop - Main orchestrator for continuous learning

Pulls working memory (Redis) + persistence (Postgres), trains on practice sets,
and proposes memory updates through the validation utility.

Exit Criteria: Oggy can complete a training cycle daily/periodically without manual intervention.

Week 4 Deliverable
"""

import os
import uuid
import httpx
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
from datetime import datetime

from .memory_validation_utility import MemoryValidationUtility, GateState, UpdateProposal
from .tessa_integration import TessaClient, PracticeItem
from .work_queue import WorkQueue, WorkItem, create_practice_item_from_tessa


@dataclass
class ItemResult:
    """Result of processing a single item"""
    item_id: str
    input: str
    agent_response: Optional[str] = None
    expected_output: Optional[str] = None
    score: Optional[float] = None
    max_score: float = 10.0
    passed: bool = False
    feedback: Optional[str] = None
    reasoning: Optional[str] = None
    error: Optional[str] = None

    # Memory updates
    updates_proposed: int = 0
    updates_applied: int = 0
    update_proposals: List[Dict[str, Any]] = field(default_factory=list)

    # Metadata
    trace_id: Optional[str] = None
    memories_used: List[Dict[str, Any]] = field(default_factory=list)
    processing_time_ms: float = 0.0


@dataclass
class CycleResult:
    """Result of a complete learning cycle"""
    cycle_id: str
    cycle_type: str  # 'scheduled', 'manual', 'self_driven'
    started_at: datetime
    completed_at: Optional[datetime] = None

    # Processing stats
    total_items: int = 0
    completed_items: int = 0
    failed_items: int = 0
    skipped_items: int = 0

    # Scoring
    average_score: float = 0.0
    pass_rate: float = 0.0
    total_score: float = 0.0

    # Memory updates
    updates_proposed: int = 0
    updates_applied: int = 0
    updates_rejected: int = 0

    # Gate state
    gate_state: str = "GATE_OPEN_LIMITED"

    # Benchmark delta
    benchmark_delta: Optional[float] = None
    base_average_score: Optional[float] = None

    # Details
    item_results: List[ItemResult] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def duration_seconds(self) -> float:
        """Calculate cycle duration"""
        if self.completed_at:
            return (self.completed_at - self.started_at).total_seconds()
        return 0.0


class OggyLearningLoop:
    """
    Main orchestrator for Oggy's continuous learning

    Steps per cycle:
    1. Pull work items from Redis queue + Tessa practice packs
    2. For each item: retrieve memories -> generate response -> score
    3. Propose and apply memory updates through validation utility
    4. Calculate benchmark delta vs base agent
    5. Emit metrics and return results
    """

    def __init__(
        self,
        memory_service_url: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        max_items_per_cycle: Optional[int] = None,
        batch_size: Optional[int] = None,
        enable_self_driven: bool = False,
    ):
        """
        Initialize learning loop

        Args:
            memory_service_url: URL of memory service
            openai_api_key: OpenAI API key
            max_items_per_cycle: Max items to process per cycle
            batch_size: Batch size for processing
            enable_self_driven: Enable self-driven learning
        """
        self.memory_service_url = memory_service_url or os.getenv(
            "MEMORY_SERVICE_URL", "http://localhost:3000"
        )
        self.openai_api_key = openai_api_key or os.getenv("OPENAI_API_KEY")

        # Configuration from env
        self.max_items_per_cycle = max_items_per_cycle or int(
            os.getenv("MAX_ITEMS_PER_CYCLE", "50")
        )
        self.batch_size = batch_size or int(
            os.getenv("LEARNING_BATCH_SIZE", "10")
        )
        self.enable_self_driven = enable_self_driven or os.getenv(
            "ENABLE_SELF_DRIVEN", "false"
        ).lower() == "true"

        # Initialize components
        self.validation_utility = MemoryValidationUtility(self.memory_service_url)
        self.tessa = TessaClient()
        self.work_queue = WorkQueue()

        # Self-driven learning (initialized lazily)
        self._sdl = None

        # Metrics tracking
        self._recent_scores: List[float] = []
        self._baseline_score: Optional[float] = None

    @property
    def sdl(self):
        """Lazy initialization of self-driven learning"""
        if self._sdl is None and self.enable_self_driven:
            from .oggy_self_driven_learning import SelfDrivenLearning
            self._sdl = SelfDrivenLearning(
                memory_service_url=self.memory_service_url,
                validation_utility=self.validation_utility,
                tessa=self.tessa,
            )
        return self._sdl

    async def run_cycle(
        self,
        cycle_type: str = "manual",
        owner_type: str = "user",
        owner_id: str = "training",
        max_items: Optional[int] = None,
    ) -> CycleResult:
        """
        Execute a single training cycle

        Args:
            cycle_type: Type of cycle ('scheduled', 'manual', 'self_driven')
            owner_type: Memory owner type for retrieval
            owner_id: Memory owner ID for retrieval
            max_items: Override max items for this cycle

        Returns:
            CycleResult with processing stats
        """
        cycle_id = str(uuid.uuid4())
        max_items = max_items or self.max_items_per_cycle

        result = CycleResult(
            cycle_id=cycle_id,
            cycle_type=cycle_type,
            started_at=datetime.utcnow(),
            gate_state=self.validation_utility.gate_state.value,
        )

        try:
            # Step 1: Pull work items
            work_items = await self._pull_work(max_items, owner_type, owner_id)
            result.total_items = len(work_items)

            if not work_items:
                result.completed_at = datetime.utcnow()
                result.metadata["message"] = "No work items to process"
                return result

            # Step 2: Process each item
            for item in work_items:
                try:
                    item_result = await self._process_item(item, owner_type, owner_id)
                    result.item_results.append(item_result)

                    if item_result.error:
                        result.failed_items += 1
                    else:
                        result.completed_items += 1
                        if item_result.score is not None:
                            result.total_score += item_result.score
                            if item_result.passed:
                                result.pass_rate += 1

                    result.updates_proposed += item_result.updates_proposed
                    result.updates_applied += item_result.updates_applied

                    # Mark completed in queue
                    await self.work_queue.mark_completed(item.task_id)

                except Exception as e:
                    result.failed_items += 1
                    result.item_results.append(ItemResult(
                        item_id=item.task_id,
                        input=item.user_input,
                        error=str(e),
                    ))
                    await self.work_queue.mark_failed(item, retry=True)

            # Calculate averages
            if result.completed_items > 0:
                result.average_score = result.total_score / result.completed_items
                result.pass_rate = result.pass_rate / result.completed_items
            result.updates_rejected = result.updates_proposed - result.updates_applied

            # Track scores for baseline calculation
            if result.average_score > 0:
                self._recent_scores.append(result.average_score)
                if len(self._recent_scores) > 10:
                    self._recent_scores.pop(0)

            # Step 3: Calculate benchmark delta
            result.benchmark_delta, result.base_average_score = await self._calculate_benchmark_delta()

            # Step 4: Self-driven learning (if enabled)
            if self.enable_self_driven and self.sdl:
                sdl_results = await self._run_self_driven_learning(result)
                result.metadata["sdl_results"] = sdl_results

            # Step 5: Store metrics
            await self._store_training_metrics(result)

            # Clear Tessa's recent usage tracking
            self.tessa.clear_recent_usage()

        except Exception as e:
            result.metadata["error"] = str(e)

        result.completed_at = datetime.utcnow()
        return result

    async def _pull_work(
        self,
        max_items: int,
        owner_type: str,
        owner_id: str,
    ) -> List[WorkItem]:
        """
        Pull work items from queue and Tessa

        Args:
            max_items: Maximum items to pull
            owner_type: Memory owner type
            owner_id: Memory owner ID

        Returns:
            List of WorkItem to process
        """
        work_items = []

        # First, pull from Redis queue
        queue_items = await self.work_queue.pull(max_items=max_items // 2)
        work_items.extend(queue_items)

        # Then, get practice items from Tessa
        remaining = max_items - len(work_items)
        if remaining > 0:
            practice_items = self.tessa.get_practice_items(count=remaining)

            # Convert to WorkItems
            for practice_item in practice_items:
                # Merge scoring_criteria into context
                context = practice_item.context or {}
                if practice_item.scoring_criteria:
                    context = {**context, "scoring_criteria": practice_item.scoring_criteria}

                work_item = WorkItem(
                    task_id=str(uuid.uuid4()),
                    task_type="practice",
                    user_input=practice_item.input,
                    expected_output=practice_item.expected_output,
                    context=context,
                    owner_type=owner_type,
                    owner_id=owner_id,
                    domain=practice_item.domain,
                    difficulty=practice_item.difficulty,
                    tags=practice_item.tags,
                    source="tessa",
                    source_id=practice_item.item_id,
                )
                work_items.append(work_item)

        return work_items

    async def _process_item(
        self,
        item: WorkItem,
        owner_type: str,
        owner_id: str,
    ) -> ItemResult:
        """
        Process a single work item through the learning pipeline

        Args:
            item: WorkItem to process
            owner_type: Memory owner type
            owner_id: Memory owner ID

        Returns:
            ItemResult with processing details
        """
        import time
        start_time = time.time()

        result = ItemResult(
            item_id=item.task_id,
            input=item.user_input,
            expected_output=item.expected_output,
        )

        async with httpx.AsyncClient() as client:
            try:
                # Step 1: Generate response using Oggy agent
                # Call the learning service's own agents endpoint
                agent_response = await client.post(
                    "http://localhost:8000/agents/generate",
                    json={
                        "user_input": item.user_input,
                        "agent": "oggy",
                        "owner_type": owner_type,
                        "owner_id": owner_id,
                        "context": item.context,
                    },
                    timeout=30.0,
                )

                if agent_response.status_code != 200:
                    result.error = f"Agent error: {agent_response.status_code}"
                    return result

                agent_data = agent_response.json()
                result.agent_response = agent_data.get("response", "")
                result.trace_id = agent_data.get("trace_id")
                result.memories_used = agent_data.get("memories_used", [])

                # Step 2: Score the response
                from scoring import score_response

                scoring_item = {
                    "item_id": item.task_id,
                    "input": item.user_input,
                    "expected_output": item.expected_output,
                    "difficulty": item.difficulty,
                    "tags": item.tags,
                }

                # Use LLM judge scoring method
                scoring_config = {
                    "method": "llm_judge",
                    "judge_model": "gpt-4o-mini",  # Use cheaper model for scoring
                    "pass_threshold": 7.0,
                }

                score_result = await score_response(
                    agent_output=result.agent_response,
                    item=scoring_item,
                    scoring_config=scoring_config,
                )

                result.score = score_result.score
                result.max_score = score_result.max_score
                result.passed = score_result.passed
                # Extract feedback and reasoning from details if available
                result.feedback = score_result.details.get("overall_feedback", "")
                result.reasoning = score_result.details.get("reasoning", "")

                # Step 3: Apply learning (memory updates)
                if result.memories_used and result.trace_id:
                    outcome = "success" if result.passed else "failure"

                    for memory in result.memories_used:
                        card_id = memory.get("card_id")
                        if not card_id:
                            continue

                        # Propose update through validation utility
                        proposal = await self.validation_utility.propose_update(
                            card_id=card_id,
                            trace_id=result.trace_id,
                            outcome=outcome,
                            score=result.score,
                            current_utility=memory.get("utility_weight", 0.0),
                            assessment_id=item.task_id,
                            agent="oggy",
                            program="learning_loop",
                        )

                        result.updates_proposed += 1

                        if proposal.is_valid:
                            # Apply the update
                            applied_proposal = await self.validation_utility.apply_update(proposal)
                            if applied_proposal.applied_at:
                                result.updates_applied += 1

                            result.update_proposals.append({
                                "card_id": card_id,
                                "is_valid": applied_proposal.is_valid,
                                "utility_delta": applied_proposal.utility_delta,
                                "rejection_reason": applied_proposal.rejection_reason,
                                "event_id": applied_proposal.event_id,
                            })
                        else:
                            result.update_proposals.append({
                                "card_id": card_id,
                                "is_valid": False,
                                "utility_delta": proposal.utility_delta,
                                "rejection_reason": proposal.rejection_reason,
                            })

            except Exception as e:
                result.error = str(e)
                print(f"ERROR processing item {item.task_id}: {e}")
                import traceback
                traceback.print_exc()

        result.processing_time_ms = (time.time() - start_time) * 1000
        return result

    async def _calculate_benchmark_delta(self) -> tuple[Optional[float], Optional[float]]:
        """
        Calculate rolling benchmark delta vs base agent

        Returns:
            Tuple of (delta, base_average_score)
        """
        if len(self._recent_scores) < 3:
            return None, None

        # Get current rolling average
        oggy_avg = sum(self._recent_scores[-5:]) / min(5, len(self._recent_scores))

        # Get base agent baseline (stored or calculated)
        if self._baseline_score is None:
            # TODO: Calculate base agent score on same items
            # For now, use a placeholder
            self._baseline_score = 5.0  # Assume base agent scores 5/10 average

        delta = oggy_avg - self._baseline_score

        return delta, self._baseline_score

    async def _run_self_driven_learning(self, cycle_result: CycleResult) -> Dict[str, Any]:
        """
        Run self-driven learning if enabled

        Args:
            cycle_result: Current cycle result for context

        Returns:
            SDL execution results
        """
        if not self.sdl:
            return {"enabled": False}

        try:
            # Detect gaps based on current cycle
            gaps = await self.sdl.detect_gaps()

            if not gaps:
                return {
                    "enabled": True,
                    "gaps_detected": 0,
                    "plans_executed": 0,
                }

            # Execute SDL for detected gaps (limit to 1 per cycle to avoid overload)
            executed_plans = []
            for gap in gaps[:1]:
                plan = await self.sdl.create_sdl_plan(gap)
                if plan:
                    plan_result = await self.sdl.execute_plan(plan)
                    executed_plans.append({
                        "plan_id": plan.plan_id,
                        "goal": plan.goal,
                        "status": plan.status,
                        "items_practiced": plan.items_practiced,
                        "updates_applied": plan.updates_applied,
                    })

            return {
                "enabled": True,
                "gaps_detected": len(gaps),
                "plans_executed": len(executed_plans),
                "plans": executed_plans,
            }

        except Exception as e:
            return {
                "enabled": True,
                "error": str(e),
            }

    async def _store_training_metrics(self, result: CycleResult) -> None:
        """
        Store training metrics to database

        Args:
            result: CycleResult to store
        """
        metrics = {
            "metric_id": str(uuid.uuid4()),
            "cycle_id": result.cycle_id,
            "cycle_type": result.cycle_type,
            "gate_state": result.gate_state,
            "items_processed": result.completed_items,
            "items_success": int(result.pass_rate * result.completed_items) if result.completed_items > 0 else 0,
            "updates_applied": result.updates_applied,
            "average_score": result.average_score,
            "pass_rate": result.pass_rate,
            "benchmark_delta": result.benchmark_delta,
            "duration_seconds": result.duration_seconds,
            "details": {
                "total_items": result.total_items,
                "failed_items": result.failed_items,
                "updates_proposed": result.updates_proposed,
                "updates_rejected": result.updates_rejected,
            },
        }

        async with httpx.AsyncClient() as client:
            try:
                await client.post(
                    f"{self.memory_service_url}/audit/log",
                    json={
                        "event_type": "training_result",
                        **metrics,
                    },
                    timeout=10.0,
                )
            except Exception as e:
                print(f"Warning: Failed to store training metrics: {e}")

    def set_baseline_score(self, score: float) -> None:
        """Set baseline score for benchmark delta calculation"""
        self._baseline_score = score

    def get_gate_state(self) -> GateState:
        """Get current gate state"""
        return self.validation_utility.gate_state

    def set_gate_state(self, state: GateState) -> None:
        """Set gate state"""
        self.validation_utility.set_gate_state(state)

    async def get_stats(self) -> Dict[str, Any]:
        """
        Get learning loop statistics

        Returns:
            Current statistics
        """
        queue_stats = await self.work_queue.get_queue_stats()

        return {
            "gate_state": self.validation_utility.gate_state.value,
            "recent_scores": self._recent_scores[-5:],
            "rolling_average": sum(self._recent_scores[-5:]) / max(1, len(self._recent_scores[-5:])),
            "baseline_score": self._baseline_score,
            "queue_stats": queue_stats,
            "practice_packs": self.tessa.list_practice_packs(),
            "config": {
                "max_items_per_cycle": self.max_items_per_cycle,
                "batch_size": self.batch_size,
                "enable_self_driven": self.enable_self_driven,
            },
        }
