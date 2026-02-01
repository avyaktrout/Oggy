"""
Base Agent - Control agent without learning capability
Simple agent that retrieves memories and generates responses
Does NOT update memories based on outcomes
"""

import os
import httpx
from typing import Dict, List, Optional
from openai import AsyncOpenAI


class BaseAgent:
    """
    Base agent for control comparisons
    - Retrieves relevant memories
    - Generates responses using LLM
    - NO learning (no memory updates)
    """

    def __init__(self, memory_service_url: str, openai_api_key: Optional[str] = None):
        """
        Initialize Base agent

        Args:
            memory_service_url: URL of the memory service
            openai_api_key: OpenAI API key (defaults to env var)
        """
        self.memory_service_url = memory_service_url
        self.agent_name = "base"

        # Initialize OpenAI client
        api_key = openai_api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY not set")

        self.openai_client = AsyncOpenAI(api_key=api_key)
        self.model = "gpt-4o-mini"  # Use cheaper model for base agent

    async def generate_response(
        self,
        user_input: str,
        owner_type: str = "user",
        owner_id: str = "default",
        context: Optional[Dict] = None,
    ) -> Dict:
        """
        Generate response to user input

        Args:
            user_input: User's input/question
            owner_type: Memory owner type
            owner_id: Memory owner ID
            context: Additional context

        Returns:
            {
                "response": str,
                "trace_id": str,
                "memories_used": List[Dict],
                "learning_applied": bool  # Always False for base agent
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

        # Step 3: Return response (NO learning for base agent)
        return {
            "response": response_text,
            "trace_id": trace_id,
            "memories_used": memories,
            "learning_applied": False,
            "agent": self.agent_name,
        }

    async def _retrieve_memories(
        self,
        query: str,
        owner_type: str,
        owner_id: str,
        top_k: int = 5,
    ) -> tuple[List[Dict], str]:
        """
        Retrieve relevant memories from memory service

        Args:
            query: Query text
            owner_type: Memory owner type
            owner_id: Memory owner ID
            top_k: Number of memories to retrieve

        Returns:
            (memories, trace_id)
        """
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    f"{self.memory_service_url}/retrieve",
                    json={
                        "agent": self.agent_name,
                        "owner_type": owner_type,
                        "owner_id": owner_id,
                        "query": query,
                        "top_k": top_k,
                        "include_scores": True,
                    },
                    timeout=10.0,
                )

                if response.status_code == 200:
                    data = response.json()
                    return data.get("selected", []), data.get("trace_id", "")
                else:
                    print(f"Memory retrieval failed: {response.status_code}")
                    return [], ""

            except Exception as e:
                print(f"Error retrieving memories: {e}")
                return [], ""

    async def _generate_llm_response(
        self,
        user_input: str,
        memories: List[Dict],
        context: Optional[Dict] = None,
    ) -> str:
        """
        Generate response using LLM with retrieved memories

        Args:
            user_input: User's input
            memories: Retrieved memory cards
            context: Additional context

        Returns:
            Generated response text
        """
        # Build prompt with memories
        system_prompt = """You are a helpful customer support assistant.
Use the relevant information from the knowledge base below to answer the user's question.
If the information is not in the knowledge base, say so politely and offer to help in another way.

Knowledge Base:
"""

        # Add memories to prompt
        if memories:
            for i, mem in enumerate(memories, 1):
                content = mem.get("content", {})
                if isinstance(content, str):
                    system_prompt += f"\n{i}. {content}"
                else:
                    system_prompt += f"\n{i}. {str(content)}"
        else:
            system_prompt += "\n(No relevant information found)"

        # Generate response
        try:
            response = await self.openai_client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_input},
                ],
                temperature=0.7,
                max_tokens=500,
            )

            return response.choices[0].message.content

        except Exception as e:
            print(f"Error generating LLM response: {e}")
            return f"I apologize, but I encountered an error processing your request. Please try again."

    def get_agent_info(self) -> Dict:
        """
        Get agent information

        Returns:
            Agent metadata
        """
        return {
            "name": self.agent_name,
            "type": "base",
            "learning_enabled": False,
            "model": self.model,
            "description": "Control agent without learning capability",
        }
