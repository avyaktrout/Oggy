"""
Violation Logger - Audit trail for CIR violations
Week 4: Now routes through Memory Service API for unified audit system

Routes all CIR violations through Memory Service /audit/log endpoint
instead of direct database writes. This ensures proper service boundaries
and enables unified audit querying across all services.
"""

import os
import json
import httpx
from datetime import datetime
from typing import Dict, Optional
import uuid


# Memory Service URL from environment
MEMORY_SERVICE_URL = os.getenv('MEMORY_SERVICE_URL', 'http://memory-service:3000')


async def init_logger(database_url: str = None):
    """
    Initialize the violation logger

    Week 4: No longer needs database connection.
    Kept for backward compatibility with existing code.

    Args:
        database_url: PostgreSQL connection URL (unused, kept for compatibility)
    """
    # No initialization needed - using HTTP API instead
    print(f"CIR Logger: Using Memory Service API at {MEMORY_SERVICE_URL}")


async def close_logger():
    """
    Close logger resources

    Week 4: No cleanup needed (no persistent connections)
    """
    pass


async def log_violation(
    gate_type: str,
    user_input: str,
    agent_response: Optional[str] = None,
    blocked: bool = True,
    pattern: Optional[str] = None,
    reason: Optional[str] = None,
    category: Optional[str] = None,
    context: Optional[Dict] = None,
    correlation_id: Optional[str] = None,
) -> str:
    """
    Log a CIR violation via Memory Service audit API

    Week 4: Routes through /audit/log endpoint instead of direct DB writes

    Args:
        gate_type: 'request' or 'response'
        user_input: The user's input
        agent_response: The agent's response (if response gate)
        blocked: Whether the request/response was blocked
        pattern: Pattern that triggered the violation
        reason: Human-readable reason
        category: Category of violation
        context: Additional context (agent, session, etc.)
        correlation_id: Optional correlation ID to link events

    Returns:
        log_id: UUID of the logged event
    """

    # Prepare payload for audit log
    payload = {
        "gate_type": gate_type,
        "user_input": user_input,
        "agent_response": agent_response,
        "blocked": blocked,
        "pattern": pattern,
        "reason": reason,
        "category": category,
        "context": context or {},
        "timestamp": datetime.utcnow().isoformat(),
    }

    # Extract user_id from context if available
    user_id = None
    if context:
        user_id = context.get("owner_id") or context.get("user_id")

    # Call Memory Service audit API
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{MEMORY_SERVICE_URL}/audit/log",
                json={
                    "event_type": "cir_violation",
                    "service": "learning",
                    "payload": payload,
                    "correlation_id": correlation_id,
                    "user_id": user_id,
                },
                timeout=5.0
            )
            response.raise_for_status()
            result = response.json()
            return result["log_id"]

    except httpx.HTTPError as e:
        # Fallback: log to console if API call fails
        print(f"[CIR VIOLATION LOG ERROR] HTTP error: {e}")
        print(f"[CIR VIOLATION] {gate_type} | {reason} | blocked={blocked}")
        return str(uuid.uuid4())
    except Exception as e:
        # Fallback: log to console for any other errors
        print(f"[CIR VIOLATION LOG ERROR] {e}")
        print(f"[CIR VIOLATION] {gate_type} | {reason} | blocked={blocked}")
        return str(uuid.uuid4())


async def get_violations(
    gate_type: Optional[str] = None,
    blocked_only: bool = False,
    limit: int = 100,
) -> list:
    """
    Retrieve recent CIR violations from Memory Service audit API

    Week 4: Queries via /audit/events endpoint

    Args:
        gate_type: Filter by 'request' or 'response' (None for all)
        blocked_only: Only return violations that were blocked
        limit: Maximum number of violations to return

    Returns:
        List of violation records
    """

    try:
        async with httpx.AsyncClient() as client:
            params = {
                "event_type": "cir_violation",
                "service": "learning",
                "limit": limit
            }

            response = await client.get(
                f"{MEMORY_SERVICE_URL}/audit/events",
                params=params,
                timeout=5.0
            )
            response.raise_for_status()
            result = response.json()

            # Extract violations from events
            violations = result.get("events", [])

            # Apply additional filters on payload
            filtered = []
            for event in violations:
                payload = event.get("payload", {})

                # Filter by gate_type if specified
                if gate_type and payload.get("gate_type") != gate_type:
                    continue

                # Filter by blocked status if specified
                if blocked_only and not payload.get("blocked"):
                    continue

                filtered.append({
                    "violation_id": event.get("log_id"),
                    "gate_type": payload.get("gate_type"),
                    "pattern": payload.get("pattern"),
                    "reason": payload.get("reason"),
                    "user_input": payload.get("user_input"),
                    "agent_response": payload.get("agent_response"),
                    "blocked": payload.get("blocked"),
                    "metadata": {
                        "category": payload.get("category"),
                        "context": payload.get("context", {}),
                        "timestamp": payload.get("timestamp")
                    },
                    "created_at": event.get("ts")
                })

            return filtered

    except httpx.HTTPError as e:
        print(f"[CIR VIOLATION FETCH ERROR] HTTP error: {e}")
        return []
    except Exception as e:
        print(f"[CIR VIOLATION FETCH ERROR] {e}")
        return []


async def get_violation_stats() -> Dict:
    """
    Get statistics about CIR violations from Memory Service audit API

    Week 4: Uses /audit/stats endpoint (filters stats to cir_violation events)

    Returns:
        {
            "total_violations": int,
            "blocked_count": int,
            "by_gate_type": {...},
            "by_category": {...},
            "recent_patterns": [...]
        }
    """

    try:
        async with httpx.AsyncClient() as client:
            # Get all CIR violations
            response = await client.get(
                f"{MEMORY_SERVICE_URL}/audit/events",
                params={
                    "event_type": "cir_violation",
                    "service": "learning",
                    "limit": 1000  # Get a large sample for stats
                },
                timeout=10.0
            )
            response.raise_for_status()
            result = response.json()

            violations = result.get("events", [])

            # Calculate stats from violations
            total_violations = len(violations)
            blocked_count = 0
            by_gate_type = {}
            by_category = {}
            pattern_counts = {}

            for event in violations:
                payload = event.get("payload", {})

                # Count blocked
                if payload.get("blocked"):
                    blocked_count += 1

                # Count by gate type
                gate_type = payload.get("gate_type")
                if gate_type:
                    by_gate_type[gate_type] = by_gate_type.get(gate_type, 0) + 1

                # Count by category
                category = payload.get("category")
                if category:
                    by_category[category] = by_category.get(category, 0) + 1

                # Count patterns
                pattern = payload.get("pattern")
                reason = payload.get("reason")
                if pattern:
                    key = (pattern, reason)
                    pattern_counts[key] = pattern_counts.get(key, 0) + 1

            # Top 10 patterns
            recent_patterns = [
                {"pattern": pattern, "reason": reason, "count": count}
                for (pattern, reason), count in sorted(
                    pattern_counts.items(), key=lambda x: x[1], reverse=True
                )[:10]
            ]

            return {
                "total_violations": total_violations,
                "blocked_count": blocked_count,
                "by_gate_type": by_gate_type,
                "by_category": by_category,
                "recent_patterns": recent_patterns,
            }

    except httpx.HTTPError as e:
        print(f"[CIR STATS ERROR] HTTP error: {e}")
        return {}
    except Exception as e:
        print(f"[CIR STATS ERROR] {e}")
        return {}
