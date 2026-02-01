"""
Oggy Agent - Learning agent with memory update capability
Enhanced agent that retrieves memories, generates responses, and learns from outcomes
Updates memories based on success/failure feedback
"""

import os
import httpx
import uuid
from typing import Dict, List, Optional
from .base_agent import BaseAgent


class OggyAgent(BaseAgent):
    """
    Oggy agent with learning capability
    - Retrieves relevant memories
    - Generates responses using LLM
    - Updates memories based on outcomes (LEARNING!)
    """

    def __init__(self, memory_service_url: str, openai_api_key: Optional[str] = None):
        """
        Initialize Oggy agent

        Args:
            memory_service_url: URL of the memory service
            openai_api_key: OpenAI API key (defaults to env var)
        """
        super().__init__(memory_service_url, openai_api_key)
        self.agent_name = "oggy"
        self.model = "gpt-4o"  # Use better model for Oggy

    async def generate_response(
        self,
        user_input: str,
        owner_type: str = "user",
        owner_id: str = "default",
        context: Optional[Dict] = None,
        outcome: Optional[str] = None,
        score: Optional[float] = None,
    ) -> Dict:
        """
        Generate response to user input with learning

        Args:
            user_input: User's input/question
            owner_type: Memory owner type
            owner_id: Memory owner ID
            context: Additional context
            outcome: Outcome feedback ('success' or 'failure')
            score: Score for the response (0-10)

        Returns:
            {
                "response": str,
                "trace_id": str,
                "memories_used": List[Dict],
                "learning_applied": bool,
                "updates": List[Dict]
            }
        """
        # Step 1: Retrieve relevant memories
        memories, trace_id = await self._retrieve_memories(
            query=user_input,
            owner_type=owner_type,
            owner_id=owner_id,
        )

        # Step 2: Generate response using LLM
        response_text = await self._generate_llm_response(user_input, memories, context)

        # Step 3: Apply learning (update memories based on outcome)
        updates = []
        learning_applied = False

        if outcome or score is not None:
            updates = await self._apply_learning(
                memories=memories,
                trace_id=trace_id,
                outcome=outcome,
                score=score,
            )
            learning_applied = len(updates) > 0

        return {
            "response": response_text,
            "trace_id": trace_id,
            "memories_used": memories,
            "learning_applied": learning_applied,
            "updates": updates,
            "agent": self.agent_name,
        }

    async def _apply_learning(
        self,
        memories: List[Dict],
        trace_id: str,
        outcome: Optional[str] = None,
        score: Optional[float] = None,
    ) -> List[Dict]:
        """
        Update memories based on outcome feedback (learning)

        Args:
            memories: Memories that were used
            trace_id: Trace ID from retrieval
            outcome: 'success' or 'failure'
            score: Score for the response (0-10)

        Returns:
            List of update results
        """
        if not memories:
            return []

        updates = []

        # Determine outcome from score if not explicitly provided
        if outcome is None and score is not None:
            outcome = "success" if score >= 7.0 else "failure"

        if outcome not in ["success", "failure"]:
            return []

        # Update utility weights for used memories
        async with httpx.AsyncClient() as client:
            for memory in memories:
                card_id = memory.get("card_id")
                if not card_id:
                    continue

                # Calculate utility delta based on outcome and score
                if score is not None:
                    # Use score to calculate proportional update
                    # Score 10 = +0.2, Score 7 = +0.1, Score 5 = 0, Score 0 = -0.2
                    utility_delta = ((score - 5.0) / 5.0) * 0.2
                else:
                    # Simple binary update
                    utility_delta = 0.1 if outcome == "success" else -0.1

                # Build context with evidence pointer
                update_context = {
                    "agent": self.agent_name,
                    "program": "oggy_learning",
                    "action": "UPDATE_CARD",
                    "evidence": {
                        "trace_id": trace_id,
                        "assessment_id": str(uuid.uuid4()),
                    },
                    "intent": {
                        "event_type": "outcome",
                        "outcome": outcome,
                        "score": score,
                    },
                    "reason_text": f"Learning from {outcome} (score: {score})",
                }

                # Build patch
                patch = {
                    "utility_delta": utility_delta,
                }

                # Call memory service to update
                try:
                    response = await client.post(
                        f"{self.memory_service_url}/utility/update",
                        json={
                            "card_id": card_id,
                            "context": update_context,
                            "patch": patch,
                        },
                        timeout=10.0,
                    )

                    if response.status_code == 200:
                        update_data = response.json()
                        updates.append({
                            "card_id": card_id,
                            "event_id": update_data.get("event_id"),
                            "old_utility": memory.get("utility_weight", 0),
                            "new_utility": update_data.get("utility_weight"),
                            "delta": utility_delta,
                            "reason_code": update_data.get("reason_code"),
                        })
                    else:
                        print(f"Failed to update card {card_id}: {response.status_code}")

                except Exception as e:
                    print(f"Error updating card {card_id}: {e}")

        return updates

    async def learn_from_feedback(
        self,
        trace_id: str,
        outcome: str,
        score: Optional[float] = None,
    ) -> List[Dict]:
        """
        Apply learning from feedback on a previous response

        Args:
            trace_id: Trace ID from previous response
            outcome: 'success' or 'failure'
            score: Optional score (0-10)

        Returns:
            List of update results
        """
        # Retrieve trace to get memories that were used
        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(
                    f"{self.memory_service_url}/retrieve/trace/{trace_id}",
                    timeout=10.0,
                )

                if response.status_code != 200:
                    print(f"Failed to get trace {trace_id}")
                    return []

                trace_data = response.json()
                selected_card_ids = trace_data.get("selected_card_ids", [])

                # Fetch full card details
                memories = []
                for card_id in selected_card_ids:
                    card_response = await client.get(
                        f"{self.memory_service_url}/cards/{card_id}",
                        timeout=10.0,
                    )
                    if card_response.status_code == 200:
                        memories.append(card_response.json())

                # Apply learning
                return await self._apply_learning(
                    memories=memories,
                    trace_id=trace_id,
                    outcome=outcome,
                    score=score,
                )

            except Exception as e:
                print(f"Error applying feedback learning: {e}")
                return []

    def get_agent_info(self) -> Dict:
        """
        Get agent information

        Returns:
            Agent metadata
        """
        return {
            "name": self.agent_name,
            "type": "oggy",
            "learning_enabled": True,
            "model": self.model,
            "description": "Learning agent with memory update capability",
        }
