"""
Oggy Self-Driven Learning - Gap detection and autonomous learning

From Program Notes Section 11:
Allow Oggy to initiate learning when it detects gaps, uncertainty, or performance drift
without waiting for user prompts.

Gap Detection Triggers:
- Uncertainty: Low confidence or high variance
- Drift: Performance drops below baseline
- Novelty: New domain concepts appear
- Coverage: Repeated low-quality retrieval

Week 4 Deliverable
"""

import os
import uuid
import httpx
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, TYPE_CHECKING
from datetime import datetime, timedelta
from enum import Enum

if TYPE_CHECKING:
    from .memory_validation_utility import MemoryValidationUtility
    from .tessa_integration import TessaClient


class TriggerType(Enum):
    """Gap detection trigger types"""
    UNCERTAINTY = "uncertainty"  # Low confidence or high variance
    DRIFT = "drift"  # Performance drops below baseline
    NOVELTY = "novelty"  # New domain concepts appear
    COVERAGE = "coverage"  # Repeated low-quality retrieval


@dataclass
class GapSignal:
    """
    Signal indicating a detected gap in knowledge or performance
    """
    signal_id: str
    trigger_type: str  # TriggerType value
    severity: float  # 0-1, higher = more urgent

    # Gap details
    domain: Optional[str] = None
    description: str = ""
    evidence: Dict[str, Any] = field(default_factory=dict)

    # Detection context
    detected_at: datetime = field(default_factory=datetime.utcnow)
    recent_scores: List[float] = field(default_factory=list)
    baseline_score: Optional[float] = None


@dataclass
class SDLPlan:
    """
    Self-Driven Learning Plan

    Structure from Program Notes:
    - goal: What we're trying to improve
    - scope: Domain and categories to focus on
    - resources: Prior successful solutions, domain knowledge
    - rehearsal: Practice configuration
    - success_criteria: Target improvements
    - budget: Token and time limits
    """
    plan_id: str
    goal: str
    scope: Dict[str, Any]  # {"domain": "payments", "categories": ["dining"]}
    resources: List[str] = field(default_factory=list)  # ["prior_successful_solutions"]
    rehearsal: Dict[str, Any] = field(default_factory=dict)  # {"count": 10, "type": "practice"}
    success_criteria: Dict[str, Any] = field(default_factory=dict)  # {"target_score_delta": 0.1}
    budget: Dict[str, Any] = field(default_factory=dict)  # {"max_tokens": 50000}

    # Trigger
    trigger_type: str = ""
    trigger_details: Dict[str, Any] = field(default_factory=dict)

    # Status
    status: str = "pending"  # "pending", "in_progress", "completed", "failed"
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    # Results
    items_practiced: int = 0
    final_score: Optional[float] = None
    updates_applied: int = 0
    result_details: Dict[str, Any] = field(default_factory=dict)


@dataclass
class PlanResult:
    """Result of executing an SDL plan"""
    plan_id: str
    status: str
    items_practiced: int
    average_score: float
    updates_applied: int
    duration_seconds: float
    details: Dict[str, Any] = field(default_factory=dict)


class SelfDrivenLearning:
    """
    Self-Driven Learning for Oggy

    Detects gaps in knowledge/performance and initiates targeted learning
    without waiting for external prompts.

    Safety/Guardrails:
    - Rate limit: Max 3 SDL cycles per day
    - Sandbox: Can only create practice tasks and propose memory updates
    - Budget enforcement: Stop if tokens or time exceeded
    - All updates require evidence pointers
    """

    # Configuration defaults
    MAX_CYCLES_PER_DAY = 3
    MAX_TOKENS_PER_PLAN = 50000
    MAX_DURATION_SECONDS = 300

    # Thresholds
    UNCERTAINTY_THRESHOLD = 0.6  # Confidence below this triggers uncertainty gap
    DRIFT_THRESHOLD = 0.1  # Score drop of 0.1+ triggers drift gap
    COVERAGE_THRESHOLD = 0.5  # Retrieval score below this triggers coverage gap

    def __init__(
        self,
        memory_service_url: str,
        validation_utility: "MemoryValidationUtility",
        tessa: "TessaClient",
        max_cycles_per_day: Optional[int] = None,
        max_tokens_per_plan: Optional[int] = None,
        max_duration_seconds: Optional[int] = None,
    ):
        """
        Initialize self-driven learning

        Args:
            memory_service_url: URL of memory service
            validation_utility: Memory validation utility instance
            tessa: Tessa client for practice items
            max_cycles_per_day: Override max cycles per day
            max_tokens_per_plan: Override max tokens per plan
            max_duration_seconds: Override max duration per plan
        """
        self.memory_service_url = memory_service_url
        self.validation_utility = validation_utility
        self.tessa = tessa

        # Configuration from env
        self.max_cycles_per_day = max_cycles_per_day or int(
            os.getenv("SDL_MAX_CYCLES_PER_DAY", str(self.MAX_CYCLES_PER_DAY))
        )
        self.max_tokens_per_plan = max_tokens_per_plan or int(
            os.getenv("SDL_MAX_TOKENS_PER_PLAN", str(self.MAX_TOKENS_PER_PLAN))
        )
        self.max_duration_seconds = max_duration_seconds or int(
            os.getenv("SDL_MAX_DURATION_SECONDS", str(self.MAX_DURATION_SECONDS))
        )

        # Thresholds from env
        self.uncertainty_threshold = float(
            os.getenv("SDL_UNCERTAINTY_THRESHOLD", str(self.UNCERTAINTY_THRESHOLD))
        )
        self.drift_threshold = float(
            os.getenv("SDL_DRIFT_THRESHOLD", str(self.DRIFT_THRESHOLD))
        )
        self.coverage_threshold = float(
            os.getenv("SDL_COVERAGE_THRESHOLD", str(self.COVERAGE_THRESHOLD))
        )

        # Tracking
        self._cycles_today: List[datetime] = []
        self._recent_plans: List[SDLPlan] = []
        self._baseline_scores: Dict[str, float] = {}  # domain -> baseline

    def _check_rate_limit(self) -> bool:
        """Check if we're within daily rate limit"""
        now = datetime.utcnow()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

        # Remove old cycles
        self._cycles_today = [
            ts for ts in self._cycles_today
            if ts >= today_start
        ]

        return len(self._cycles_today) < self.max_cycles_per_day

    def _record_cycle(self) -> None:
        """Record a cycle execution"""
        self._cycles_today.append(datetime.utcnow())

    async def detect_gaps(self) -> List[GapSignal]:
        """
        Detect gaps in knowledge or performance

        Analyzes:
        - Recent training metrics for drift
        - Agent confidence scores for uncertainty
        - Retrieval traces for coverage issues
        - Query patterns for novelty

        Returns:
            List of GapSignal indicating detected gaps
        """
        gaps = []

        try:
            async with httpx.AsyncClient() as client:
                # Check for drift (performance drop)
                drift_gap = await self._detect_drift(client)
                if drift_gap:
                    gaps.append(drift_gap)

                # Check for uncertainty (low confidence)
                uncertainty_gap = await self._detect_uncertainty(client)
                if uncertainty_gap:
                    gaps.append(uncertainty_gap)

                # Check for coverage issues (low retrieval quality)
                coverage_gap = await self._detect_coverage_gaps(client)
                if coverage_gap:
                    gaps.append(coverage_gap)

                # Check for novelty (new concepts)
                novelty_gap = await self._detect_novelty(client)
                if novelty_gap:
                    gaps.append(novelty_gap)

        except Exception as e:
            print(f"Error detecting gaps: {e}")

        # Sort by severity (highest first)
        gaps.sort(key=lambda g: g.severity, reverse=True)

        return gaps

    async def _detect_drift(self, client: httpx.AsyncClient) -> Optional[GapSignal]:
        """
        Detect performance drift by comparing recent scores to baseline

        Args:
            client: HTTP client

        Returns:
            GapSignal if drift detected, None otherwise
        """
        try:
            # Get recent training metrics
            response = await client.get(
                f"{self.memory_service_url}/audit/query",
                params={
                    "event_type": "training_result",
                    "limit": 10,
                },
                timeout=10.0,
            )

            if response.status_code != 200:
                return None

            data = response.json()
            events = data.get("events", [])

            if len(events) < 3:
                return None

            # Calculate recent average
            recent_scores = [e.get("average_score", 0) for e in events[:5] if e.get("average_score")]
            if not recent_scores:
                return None

            recent_avg = sum(recent_scores) / len(recent_scores)

            # Get baseline (older scores)
            baseline_scores = [e.get("average_score", 0) for e in events[5:] if e.get("average_score")]
            if not baseline_scores:
                baseline = 5.0  # Default baseline
            else:
                baseline = sum(baseline_scores) / len(baseline_scores)

            # Check for drift
            drift = baseline - recent_avg
            if drift > self.drift_threshold:
                return GapSignal(
                    signal_id=str(uuid.uuid4()),
                    trigger_type=TriggerType.DRIFT.value,
                    severity=min(1.0, drift / 0.3),  # Normalize severity
                    description=f"Performance dropped by {drift:.2f} from baseline {baseline:.2f}",
                    evidence={
                        "recent_avg": recent_avg,
                        "baseline": baseline,
                        "drift": drift,
                    },
                    recent_scores=recent_scores,
                    baseline_score=baseline,
                )

        except Exception as e:
            print(f"Error detecting drift: {e}")

        return None

    async def _detect_uncertainty(self, client: httpx.AsyncClient) -> Optional[GapSignal]:
        """
        Detect uncertainty by analyzing agent confidence scores

        Args:
            client: HTTP client

        Returns:
            GapSignal if uncertainty detected, None otherwise
        """
        try:
            # Get recent agent responses with confidence
            response = await client.get(
                f"{self.memory_service_url}/audit/query",
                params={
                    "event_type": "agent_response",
                    "limit": 20,
                },
                timeout=10.0,
            )

            if response.status_code != 200:
                return None

            data = response.json()
            events = data.get("events", [])

            # Extract confidence scores
            confidence_scores = []
            low_confidence_domains = {}

            for event in events:
                confidence = event.get("confidence")
                if confidence is not None:
                    confidence_scores.append(confidence)
                    if confidence < self.uncertainty_threshold:
                        domain = event.get("domain", "general")
                        low_confidence_domains[domain] = low_confidence_domains.get(domain, 0) + 1

            if not confidence_scores:
                return None

            avg_confidence = sum(confidence_scores) / len(confidence_scores)
            low_confidence_count = sum(1 for c in confidence_scores if c < self.uncertainty_threshold)

            # Trigger if >30% of responses have low confidence
            if low_confidence_count / len(confidence_scores) > 0.3:
                # Find the most affected domain
                most_affected = max(low_confidence_domains.items(), key=lambda x: x[1]) if low_confidence_domains else ("general", 0)

                return GapSignal(
                    signal_id=str(uuid.uuid4()),
                    trigger_type=TriggerType.UNCERTAINTY.value,
                    severity=min(1.0, (1.0 - avg_confidence)),
                    domain=most_affected[0],
                    description=f"Low confidence detected in {low_confidence_count}/{len(confidence_scores)} responses",
                    evidence={
                        "avg_confidence": avg_confidence,
                        "low_confidence_count": low_confidence_count,
                        "total_responses": len(confidence_scores),
                        "affected_domains": low_confidence_domains,
                    },
                )

        except Exception as e:
            print(f"Error detecting uncertainty: {e}")

        return None

    async def _detect_coverage_gaps(self, client: httpx.AsyncClient) -> Optional[GapSignal]:
        """
        Detect coverage gaps by analyzing retrieval quality

        Args:
            client: HTTP client

        Returns:
            GapSignal if coverage gap detected, None otherwise
        """
        try:
            # Get recent retrieval traces
            response = await client.get(
                f"{self.memory_service_url}/retrieve/traces",
                params={"limit": 20},
                timeout=10.0,
            )

            if response.status_code != 200:
                return None

            data = response.json()
            traces = data.get("traces", [])

            if not traces:
                return None

            # Analyze retrieval scores
            low_retrieval_domains = {}
            retrieval_scores = []

            for trace in traces:
                # Check retrieval quality (average similarity of selected cards)
                selected = trace.get("selected_cards", [])
                if selected:
                    avg_similarity = sum(c.get("similarity", 0) for c in selected) / len(selected)
                    retrieval_scores.append(avg_similarity)

                    if avg_similarity < self.coverage_threshold:
                        domain = trace.get("domain", "general")
                        low_retrieval_domains[domain] = low_retrieval_domains.get(domain, 0) + 1

            if not retrieval_scores:
                return None

            avg_retrieval = sum(retrieval_scores) / len(retrieval_scores)
            low_count = sum(1 for s in retrieval_scores if s < self.coverage_threshold)

            # Trigger if >40% of retrievals are low quality
            if low_count / len(retrieval_scores) > 0.4:
                most_affected = max(low_retrieval_domains.items(), key=lambda x: x[1]) if low_retrieval_domains else ("general", 0)

                return GapSignal(
                    signal_id=str(uuid.uuid4()),
                    trigger_type=TriggerType.COVERAGE.value,
                    severity=min(1.0, (1.0 - avg_retrieval)),
                    domain=most_affected[0],
                    description=f"Low retrieval quality in {low_count}/{len(retrieval_scores)} queries",
                    evidence={
                        "avg_retrieval_score": avg_retrieval,
                        "low_quality_count": low_count,
                        "total_retrievals": len(retrieval_scores),
                        "affected_domains": low_retrieval_domains,
                    },
                )

        except Exception as e:
            print(f"Error detecting coverage gaps: {e}")

        return None

    async def _detect_novelty(self, client: httpx.AsyncClient) -> Optional[GapSignal]:
        """
        Detect novelty by looking for unrecognized concepts

        Args:
            client: HTTP client

        Returns:
            GapSignal if novelty detected, None otherwise
        """
        # For Week 4, this is a simplified implementation
        # A full implementation would use NER or concept extraction
        return None

    async def create_sdl_plan(self, gap: GapSignal) -> Optional[SDLPlan]:
        """
        Create an SDL plan for a detected gap

        Args:
            gap: GapSignal to address

        Returns:
            SDLPlan or None if rate limited
        """
        # Check rate limit
        if not self._check_rate_limit():
            print(f"SDL rate limited: {len(self._cycles_today)} cycles today")
            return None

        # Create plan based on gap type
        plan_id = str(uuid.uuid4())

        if gap.trigger_type == TriggerType.DRIFT.value:
            plan = SDLPlan(
                plan_id=plan_id,
                goal=f"Improve performance to restore baseline ({gap.baseline_score:.2f})",
                scope={
                    "domain": gap.domain or "general",
                    "difficulty": "medium",  # Start with medium difficulty
                },
                resources=["prior_successful_solutions", "high_utility_memories"],
                rehearsal={
                    "count": 10,
                    "type": "practice",
                    "difficulty": "medium",
                },
                success_criteria={
                    "target_score_delta": gap.evidence.get("drift", 0.1),
                    "min_pass_rate": 0.7,
                },
                budget={
                    "max_tokens": self.max_tokens_per_plan,
                    "max_duration_seconds": self.max_duration_seconds,
                },
                trigger_type=gap.trigger_type,
                trigger_details=gap.evidence,
            )

        elif gap.trigger_type == TriggerType.UNCERTAINTY.value:
            plan = SDLPlan(
                plan_id=plan_id,
                goal=f"Increase confidence in {gap.domain or 'general'} domain",
                scope={
                    "domain": gap.domain or "general",
                    "focus": "confidence_building",
                },
                resources=["domain_knowledge", "successful_examples"],
                rehearsal={
                    "count": 8,
                    "type": "practice",
                    "difficulty": "easy",  # Build confidence with easier items first
                },
                success_criteria={
                    "target_confidence": 0.7,
                    "min_pass_rate": 0.8,
                },
                budget={
                    "max_tokens": self.max_tokens_per_plan,
                    "max_duration_seconds": self.max_duration_seconds,
                },
                trigger_type=gap.trigger_type,
                trigger_details=gap.evidence,
            )

        elif gap.trigger_type == TriggerType.COVERAGE.value:
            plan = SDLPlan(
                plan_id=plan_id,
                goal=f"Improve memory coverage for {gap.domain or 'general'} domain",
                scope={
                    "domain": gap.domain or "general",
                    "focus": "coverage_expansion",
                },
                resources=["new_examples", "diverse_scenarios"],
                rehearsal={
                    "count": 12,
                    "type": "practice",
                    "difficulty": "varied",  # Mix difficulties
                },
                success_criteria={
                    "target_retrieval_score": 0.6,
                    "min_pass_rate": 0.6,
                },
                budget={
                    "max_tokens": self.max_tokens_per_plan,
                    "max_duration_seconds": self.max_duration_seconds,
                },
                trigger_type=gap.trigger_type,
                trigger_details=gap.evidence,
            )

        else:
            # Default plan for novelty or other types
            plan = SDLPlan(
                plan_id=plan_id,
                goal=f"Address {gap.trigger_type} gap: {gap.description}",
                scope={
                    "domain": gap.domain or "general",
                },
                rehearsal={
                    "count": 10,
                    "type": "practice",
                    "difficulty": "medium",
                },
                success_criteria={
                    "min_pass_rate": 0.7,
                },
                budget={
                    "max_tokens": self.max_tokens_per_plan,
                    "max_duration_seconds": self.max_duration_seconds,
                },
                trigger_type=gap.trigger_type,
                trigger_details=gap.evidence,
            )

        # Store plan in database
        await self._store_plan(plan)

        self._recent_plans.append(plan)
        return plan

    async def _store_plan(self, plan: SDLPlan) -> None:
        """Store SDL plan in database"""
        async with httpx.AsyncClient() as client:
            try:
                await client.post(
                    f"{self.memory_service_url}/audit/log",
                    json={
                        "event_type": "sdl_plan_created",
                        "plan_id": plan.plan_id,
                        "goal": plan.goal,
                        "scope": plan.scope,
                        "trigger_type": plan.trigger_type,
                        "status": plan.status,
                    },
                    timeout=10.0,
                )
            except Exception as e:
                print(f"Warning: Failed to store SDL plan: {e}")

    async def generate_practice_assessments(self, plan: SDLPlan) -> List[Dict[str, Any]]:
        """
        Generate targeted practice assessments for an SDL plan

        Args:
            plan: SDLPlan to generate assessments for

        Returns:
            List of practice items
        """
        count = plan.rehearsal.get("count", 10)
        difficulty = plan.rehearsal.get("difficulty", "medium")
        domain = plan.scope.get("domain")

        # Use Tessa to get targeted items
        items = self.tessa.generate_targeted_items(
            scope=plan.scope,
            count=count,
        )

        # Convert to assessment format
        assessments = []
        for item in items:
            assessments.append({
                "item_id": item.item_id,
                "input": item.input,
                "expected_output": item.expected_output,
                "context": item.context,
                "difficulty": item.difficulty,
                "domain": item.domain,
                "tags": item.tags,
                "sdl_plan_id": plan.plan_id,
            })

        return assessments

    async def execute_plan(self, plan: SDLPlan) -> PlanResult:
        """
        Execute an SDL plan

        Args:
            plan: SDLPlan to execute

        Returns:
            PlanResult with execution details
        """
        import time
        start_time = time.time()

        # Record cycle
        self._record_cycle()

        # Update plan status
        plan.status = "in_progress"
        plan.started_at = datetime.utcnow()

        items_practiced = 0
        total_score = 0.0
        updates_applied = 0
        details: Dict[str, Any] = {"item_results": []}

        try:
            # Generate practice assessments
            assessments = await self.generate_practice_assessments(plan)

            async with httpx.AsyncClient() as client:
                for assessment in assessments:
                    # Check budget
                    elapsed = time.time() - start_time
                    if elapsed > plan.budget.get("max_duration_seconds", self.max_duration_seconds):
                        details["stopped_reason"] = "time_budget_exceeded"
                        break

                    # Process item
                    try:
                        item_result = await self._process_practice_item(
                            client, assessment, plan
                        )

                        items_practiced += 1
                        if item_result.get("score") is not None:
                            total_score += item_result["score"]
                        updates_applied += item_result.get("updates_applied", 0)

                        details["item_results"].append(item_result)

                    except Exception as e:
                        details["item_results"].append({
                            "item_id": assessment["item_id"],
                            "error": str(e),
                        })

            # Calculate final metrics
            plan.items_practiced = items_practiced
            plan.final_score = total_score / items_practiced if items_practiced > 0 else 0.0
            plan.updates_applied = updates_applied
            plan.result_details = details
            plan.status = "completed"
            plan.completed_at = datetime.utcnow()

            # Update plan in database
            await self._update_plan_status(plan)

        except Exception as e:
            plan.status = "failed"
            plan.result_details = {"error": str(e)}
            await self._update_plan_status(plan)

        duration = time.time() - start_time

        return PlanResult(
            plan_id=plan.plan_id,
            status=plan.status,
            items_practiced=items_practiced,
            average_score=total_score / items_practiced if items_practiced > 0 else 0.0,
            updates_applied=updates_applied,
            duration_seconds=duration,
            details=details,
        )

    async def _process_practice_item(
        self,
        client: httpx.AsyncClient,
        assessment: Dict[str, Any],
        plan: SDLPlan,
    ) -> Dict[str, Any]:
        """
        Process a single practice item

        Args:
            client: HTTP client
            assessment: Practice assessment item
            plan: Parent SDL plan

        Returns:
            Item result dict
        """
        result = {
            "item_id": assessment["item_id"],
            "sdl_plan_id": plan.plan_id,
        }

        # Generate response
        agent_response = await client.post(
            f"{self.memory_service_url.replace(':3000', ':8000')}/agents/generate",
            json={
                "user_input": assessment["input"],
                "agent": "oggy",
                "owner_type": "user",
                "owner_id": "sdl",
                "context": assessment.get("context"),
            },
            timeout=30.0,
        )

        if agent_response.status_code != 200:
            result["error"] = f"Agent error: {agent_response.status_code}"
            return result

        agent_data = agent_response.json()
        result["response"] = agent_data.get("response", "")
        result["trace_id"] = agent_data.get("trace_id")
        memories_used = agent_data.get("memories_used", [])

        # Score the response
        from scoring import score_response

        score_result = await score_response(
            agent_output=result["response"],
            item=assessment,
            scoring_config={},
        )

        result["score"] = score_result.score
        result["passed"] = score_result.passed

        # Apply learning with SDL context
        result["updates_applied"] = 0
        outcome = "success" if score_result.passed else "failure"

        for memory in memories_used:
            card_id = memory.get("card_id")
            if not card_id:
                continue

            # Propose update with SDL evidence
            proposal = await self.validation_utility.propose_update(
                card_id=card_id,
                trace_id=result["trace_id"],
                outcome=outcome,
                score=score_result.score,
                current_utility=memory.get("utility_weight", 0.0),
                assessment_id=assessment["item_id"],
                sdl_plan_id=plan.plan_id,
                agent="oggy",
                program="self_driven_learning",
            )

            if proposal.is_valid:
                applied = await self.validation_utility.apply_update(proposal)
                if applied.applied_at:
                    result["updates_applied"] += 1

        return result

    async def _update_plan_status(self, plan: SDLPlan) -> None:
        """Update SDL plan status in database"""
        async with httpx.AsyncClient() as client:
            try:
                await client.post(
                    f"{self.memory_service_url}/audit/log",
                    json={
                        "event_type": "sdl_plan_updated",
                        "plan_id": plan.plan_id,
                        "status": plan.status,
                        "items_practiced": plan.items_practiced,
                        "final_score": plan.final_score,
                        "updates_applied": plan.updates_applied,
                    },
                    timeout=10.0,
                )
            except Exception as e:
                print(f"Warning: Failed to update SDL plan status: {e}")

    async def propose_memory_updates(
        self,
        plan: SDLPlan,
        results: List[Dict[str, Any]],
    ) -> int:
        """
        Derive and apply memory updates from plan results

        This is called after execute_plan to apply any additional updates
        based on overall plan performance.

        Args:
            plan: Executed SDL plan
            results: Item results from execution

        Returns:
            Number of updates applied
        """
        # For now, updates are applied during execute_plan
        # This method could be extended to apply plan-level updates
        return plan.updates_applied

    def get_stats(self) -> Dict[str, Any]:
        """Get SDL statistics"""
        return {
            "cycles_today": len(self._cycles_today),
            "max_cycles_per_day": self.max_cycles_per_day,
            "recent_plans_count": len(self._recent_plans),
            "thresholds": {
                "uncertainty": self.uncertainty_threshold,
                "drift": self.drift_threshold,
                "coverage": self.coverage_threshold,
            },
        }
