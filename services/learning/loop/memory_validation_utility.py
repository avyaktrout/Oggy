"""
Memory Validation Utility - Validates and applies memory updates

Implements the Pattern Learning Gate from the design documents:
- Gate states control when updates are allowed
- Evidence bar ensures updates are backed by sufficient observations
- All updates are audited with proper context and evidence pointers

Week 4 Deliverable
"""

import os
import uuid
import httpx
from enum import Enum
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
from datetime import datetime


class GateState(Enum):
    """
    Pattern Learning Gate States

    Controls when memory updates are allowed:
    - GATE_CLOSED: No updates allowed (e.g., during evaluation)
    - GATE_OPEN_LIMITED: Limited updates with evidence bar
    - GATE_OPEN_FULL: Full learning enabled (all valid updates applied)
    """
    GATE_CLOSED = "GATE_CLOSED"
    GATE_OPEN_LIMITED = "GATE_OPEN_LIMITED"
    GATE_OPEN_FULL = "GATE_OPEN_FULL"


@dataclass
class UpdateProposal:
    """
    Proposed memory update with evidence and validation state
    """
    proposal_id: str
    card_id: str
    trace_id: str

    # Update details
    utility_delta: float
    current_utility: float
    new_utility: float

    # Evidence
    outcome: str  # 'success' or 'failure'
    score: Optional[float] = None
    assessment_id: Optional[str] = None
    sdl_plan_id: Optional[str] = None

    # Validation state
    is_valid: bool = False
    rejection_reason: Optional[str] = None

    # Context
    agent: str = "oggy"
    program: str = "learning_loop"
    reason_text: str = ""

    # Timestamps
    created_at: datetime = field(default_factory=datetime.utcnow)
    applied_at: Optional[datetime] = None

    # Result
    event_id: Optional[str] = None
    reason_code: Optional[str] = None


@dataclass
class EvidenceRecord:
    """
    Tracks observations for a card to compute stability
    """
    card_id: str
    observations: List[Dict[str, Any]] = field(default_factory=list)

    def add_observation(self, outcome: str, score: Optional[float], trace_id: str):
        """Add an observation for this card"""
        self.observations.append({
            "outcome": outcome,
            "score": score,
            "trace_id": trace_id,
            "timestamp": datetime.utcnow().isoformat(),
        })

    @property
    def observation_count(self) -> int:
        """Number of observations"""
        return len(self.observations)

    @property
    def stability_score(self) -> float:
        """
        Compute stability as agreement in signal direction
        Returns 0-1 where 1 means all observations agree
        """
        if len(self.observations) < 2:
            return 0.0

        # Count positive vs negative signals
        positive = sum(1 for obs in self.observations if obs.get("outcome") == "success")
        negative = len(self.observations) - positive

        # Stability is the proportion of the majority signal
        majority = max(positive, negative)
        return majority / len(self.observations)

    @property
    def signal_direction(self) -> str:
        """Get the predominant signal direction"""
        positive = sum(1 for obs in self.observations if obs.get("outcome") == "success")
        negative = len(self.observations) - positive
        return "positive" if positive >= negative else "negative"


class MemoryValidationUtility:
    """
    Validates and applies memory updates with evidence requirements

    Implements:
    - Gate state enforcement
    - Minimum Evidence Bar (volume + stability thresholds)
    - Utility delta calculation with dampening
    - Audit trail creation
    """

    # Configuration defaults
    MIN_OBSERVATIONS_FOR_UPDATE = 3  # Require 3+ observations
    STABILITY_THRESHOLD = 0.7  # 70% agreement in signal direction
    MAX_UTILITY_DELTA = 0.2  # Cap at +/- 0.2 per update
    HIGH_UTILITY_THRESHOLD = 0.8  # Apply dampening above this
    HIGH_UTILITY_DAMPENING = 0.5  # Reduce delta by 50% for high-utility cards

    def __init__(
        self,
        memory_service_url: str,
        gate_state: Optional[GateState] = None,
        min_observations: Optional[int] = None,
        stability_threshold: Optional[float] = None,
    ):
        """
        Initialize the validation utility

        Args:
            memory_service_url: URL of the memory service
            gate_state: Override gate state (defaults to env var)
            min_observations: Override min observations threshold
            stability_threshold: Override stability threshold
        """
        self.memory_service_url = memory_service_url

        # Gate state from config
        gate_state_str = os.getenv("LEARNING_GATE_STATE", "GATE_OPEN_LIMITED")
        self.gate_state = gate_state or GateState(gate_state_str)

        # Evidence thresholds from config
        self.min_observations = min_observations or int(
            os.getenv("MIN_OBSERVATIONS_FOR_UPDATE", str(self.MIN_OBSERVATIONS_FOR_UPDATE))
        )
        self.stability_threshold = stability_threshold or float(
            os.getenv("STABILITY_THRESHOLD", str(self.STABILITY_THRESHOLD))
        )

        # In-memory evidence tracking (per card)
        self._evidence_records: Dict[str, EvidenceRecord] = {}

    def get_evidence_record(self, card_id: str) -> EvidenceRecord:
        """Get or create evidence record for a card"""
        if card_id not in self._evidence_records:
            self._evidence_records[card_id] = EvidenceRecord(card_id=card_id)
        return self._evidence_records[card_id]

    def record_observation(
        self,
        card_id: str,
        outcome: str,
        score: Optional[float],
        trace_id: str,
    ):
        """
        Record an observation for a card (builds evidence)

        Args:
            card_id: Memory card ID
            outcome: 'success' or 'failure'
            score: Optional score (0-10)
            trace_id: Trace ID for evidence
        """
        record = self.get_evidence_record(card_id)
        record.add_observation(outcome, score, trace_id)

    def calculate_utility_delta(
        self,
        outcome: str,
        score: Optional[float],
        current_utility: float,
    ) -> float:
        """
        Calculate utility delta based on outcome and score

        Formula:
        - Success: normalized_score -> utility_delta
        - raw_delta = (normalized_score - 0.5) * 0.4  # +0.2 max
        - Apply dampening for high-utility cards
        - Cap at +/- 0.2 per update

        Args:
            outcome: 'success' or 'failure'
            score: Score (0-10) or None
            current_utility: Current utility weight of the card

        Returns:
            Utility delta to apply
        """
        if score is not None:
            # Normalize score to 0-1 range
            normalized_score = score / 10.0
            # Calculate raw delta: score 10 = +0.2, score 5 = 0, score 0 = -0.2
            raw_delta = (normalized_score - 0.5) * 0.4
        else:
            # Binary update based on outcome
            raw_delta = 0.1 if outcome == "success" else -0.1

        # Apply dampening for high-utility cards
        if current_utility > self.HIGH_UTILITY_THRESHOLD:
            raw_delta *= self.HIGH_UTILITY_DAMPENING

        # Cap at max delta
        return max(-self.MAX_UTILITY_DELTA, min(self.MAX_UTILITY_DELTA, raw_delta))

    async def propose_update(
        self,
        card_id: str,
        trace_id: str,
        outcome: str,
        score: Optional[float] = None,
        current_utility: float = 0.0,
        assessment_id: Optional[str] = None,
        sdl_plan_id: Optional[str] = None,
        agent: str = "oggy",
        program: str = "learning_loop",
    ) -> UpdateProposal:
        """
        Create and validate an update proposal

        Args:
            card_id: Memory card ID to update
            trace_id: Trace ID for evidence
            outcome: 'success' or 'failure'
            score: Score (0-10) or None
            current_utility: Current utility weight
            assessment_id: Assessment ID if from evaluation
            sdl_plan_id: SDL plan ID if from self-driven learning
            agent: Agent name
            program: Program name for audit

        Returns:
            UpdateProposal with validation state
        """
        # Record this observation
        self.record_observation(card_id, outcome, score, trace_id)

        # Calculate utility delta
        utility_delta = self.calculate_utility_delta(outcome, score, current_utility)
        new_utility = max(0.0, min(1.0, current_utility + utility_delta))

        # Create proposal
        proposal = UpdateProposal(
            proposal_id=str(uuid.uuid4()),
            card_id=card_id,
            trace_id=trace_id,
            utility_delta=utility_delta,
            current_utility=current_utility,
            new_utility=new_utility,
            outcome=outcome,
            score=score,
            assessment_id=assessment_id,
            sdl_plan_id=sdl_plan_id,
            agent=agent,
            program=program,
            reason_text=f"Learning from {outcome}" + (f" (score: {score})" if score else ""),
        )

        # Validate the proposal
        await self._validate_proposal(proposal)

        return proposal

    async def _validate_proposal(self, proposal: UpdateProposal) -> None:
        """
        Validate a proposal against gate state and evidence bar

        Updates proposal.is_valid and proposal.rejection_reason
        """
        # Check gate state
        if self.gate_state == GateState.GATE_CLOSED:
            proposal.is_valid = False
            proposal.rejection_reason = "Gate is closed - no updates allowed"
            return

        # Get evidence record for this card
        evidence = self.get_evidence_record(proposal.card_id)

        # Check minimum observations (for GATE_OPEN_LIMITED)
        if self.gate_state == GateState.GATE_OPEN_LIMITED:
            if evidence.observation_count < self.min_observations:
                proposal.is_valid = False
                proposal.rejection_reason = (
                    f"Insufficient observations: {evidence.observation_count} < {self.min_observations}"
                )
                return

            # Check stability threshold
            if evidence.stability_score < self.stability_threshold:
                proposal.is_valid = False
                proposal.rejection_reason = (
                    f"Insufficient stability: {evidence.stability_score:.2f} < {self.stability_threshold}"
                )
                return

        # Check that we have required evidence pointers
        if not proposal.trace_id:
            proposal.is_valid = False
            proposal.rejection_reason = "Missing trace_id evidence pointer"
            return

        # For SDL updates, require sdl_plan_id
        if proposal.program == "self_driven_learning" and not proposal.sdl_plan_id:
            proposal.is_valid = False
            proposal.rejection_reason = "SDL updates require sdl_plan_id evidence"
            return

        # Proposal is valid
        proposal.is_valid = True

    async def apply_update(self, proposal: UpdateProposal) -> UpdateProposal:
        """
        Apply a validated update to the memory service

        Args:
            proposal: Validated UpdateProposal

        Returns:
            Updated proposal with result
        """
        if not proposal.is_valid:
            return proposal

        # Build context with evidence pointers
        context = {
            "agent": proposal.agent,
            "program": proposal.program,
            "action": "UPDATE_CARD",
            "evidence": {
                "trace_id": proposal.trace_id,
                "assessment_id": proposal.assessment_id or str(uuid.uuid4()),
            },
            "intent": {
                "event_type": "outcome" if proposal.program != "self_driven_learning" else "self_driven",
                "outcome": proposal.outcome,
                "score": proposal.score,
            },
            "reason_text": proposal.reason_text,
        }

        # Add SDL evidence if present
        if proposal.sdl_plan_id:
            context["evidence"]["sdl_plan_id"] = proposal.sdl_plan_id

        # Build patch
        patch = {
            "utility_delta": proposal.utility_delta,
        }

        # Call memory service
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    f"{self.memory_service_url}/utility/update",
                    json={
                        "card_id": proposal.card_id,
                        "context": context,
                        "patch": patch,
                    },
                    timeout=10.0,
                )

                if response.status_code == 200:
                    update_data = response.json()
                    proposal.applied_at = datetime.utcnow()
                    proposal.event_id = update_data.get("event_id")
                    proposal.reason_code = update_data.get("reason_code")
                    proposal.new_utility = update_data.get("utility_weight", proposal.new_utility)
                else:
                    proposal.is_valid = False
                    proposal.rejection_reason = f"Memory service error: {response.status_code}"

            except Exception as e:
                proposal.is_valid = False
                proposal.rejection_reason = f"Memory service error: {str(e)}"

        # Write audit record
        await self.write_audit_record(proposal)

        return proposal

    async def write_audit_record(self, proposal: UpdateProposal) -> None:
        """
        Write audit record for the update proposal

        Args:
            proposal: UpdateProposal to audit
        """
        event_type = "card_update" if proposal.applied_at else "card_update_rejected"

        audit_record = {
            "event_type": event_type,
            "card_id": proposal.card_id,
            "proposal_id": proposal.proposal_id,
            "trace_id": proposal.trace_id,
            "utility_delta": proposal.utility_delta,
            "old_utility": proposal.current_utility,
            "new_utility": proposal.new_utility if proposal.applied_at else None,
            "outcome": proposal.outcome,
            "score": proposal.score,
            "agent": proposal.agent,
            "program": proposal.program,
            "gate_state": self.gate_state.value,
            "is_valid": proposal.is_valid,
            "rejection_reason": proposal.rejection_reason,
            "event_id": proposal.event_id,
            "reason_code": proposal.reason_code,
        }

        # Add SDL evidence if present
        if proposal.sdl_plan_id:
            audit_record["sdl_plan_id"] = proposal.sdl_plan_id

        async with httpx.AsyncClient() as client:
            try:
                await client.post(
                    f"{self.memory_service_url}/audit/log",
                    json=audit_record,
                    timeout=10.0,
                )
            except Exception as e:
                # Log but don't fail on audit errors
                print(f"Warning: Failed to write audit record: {e}")

    async def propose_and_apply(
        self,
        card_id: str,
        trace_id: str,
        outcome: str,
        score: Optional[float] = None,
        current_utility: float = 0.0,
        assessment_id: Optional[str] = None,
        sdl_plan_id: Optional[str] = None,
        agent: str = "oggy",
        program: str = "learning_loop",
    ) -> UpdateProposal:
        """
        Convenience method to propose and apply an update in one call

        Returns:
            Applied UpdateProposal
        """
        proposal = await self.propose_update(
            card_id=card_id,
            trace_id=trace_id,
            outcome=outcome,
            score=score,
            current_utility=current_utility,
            assessment_id=assessment_id,
            sdl_plan_id=sdl_plan_id,
            agent=agent,
            program=program,
        )

        if proposal.is_valid:
            return await self.apply_update(proposal)

        return proposal

    def get_gate_state(self) -> GateState:
        """Get current gate state"""
        return self.gate_state

    def set_gate_state(self, state: GateState) -> None:
        """Set gate state (for testing or runtime adjustment)"""
        self.gate_state = state

    def get_evidence_stats(self, card_id: str) -> Dict[str, Any]:
        """
        Get evidence statistics for a card

        Returns:
            Dict with observation count, stability, and signal direction
        """
        record = self.get_evidence_record(card_id)
        return {
            "card_id": card_id,
            "observation_count": record.observation_count,
            "stability_score": record.stability_score,
            "signal_direction": record.signal_direction,
            "meets_volume_threshold": record.observation_count >= self.min_observations,
            "meets_stability_threshold": record.stability_score >= self.stability_threshold,
        }

    def clear_evidence(self, card_id: Optional[str] = None) -> None:
        """
        Clear evidence records (for testing)

        Args:
            card_id: Specific card to clear, or None to clear all
        """
        if card_id:
            self._evidence_records.pop(card_id, None)
        else:
            self._evidence_records.clear()
