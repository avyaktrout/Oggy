"""
Violation Logger - Audit trail for CIR violations
Logs all CIR violations to database with full context

NOTE: This directly writes to the database, bypassing the memory service.
This is a known architectural compromise for Week 3.
Future: Route through memory service API for unified audit trail.
See docs/AUDIT-ARCHITECTURE.md for details and migration plan.
"""

import os
import json
import asyncpg
from datetime import datetime
from typing import Dict, Optional
import uuid


# Database connection pool (initialized by main.py)
_db_pool = None


async def init_logger(database_url: str):
    """
    Initialize the violation logger with database connection

    Args:
        database_url: PostgreSQL connection URL
    """
    global _db_pool
    _db_pool = await asyncpg.create_pool(database_url, min_size=2, max_size=10)


async def close_logger():
    """Close database connection pool"""
    global _db_pool
    if _db_pool:
        await _db_pool.close()
        _db_pool = None


async def log_violation(
    gate_type: str,
    user_input: str,
    agent_response: Optional[str] = None,
    blocked: bool = True,
    pattern: Optional[str] = None,
    reason: Optional[str] = None,
    category: Optional[str] = None,
    context: Optional[Dict] = None,
) -> str:
    """
    Log a CIR violation to the database

    Args:
        gate_type: 'request' or 'response'
        user_input: The user's input
        agent_response: The agent's response (if response gate)
        blocked: Whether the request/response was blocked
        pattern: Pattern that triggered the violation
        reason: Human-readable reason
        category: Category of violation
        context: Additional context (agent, session, etc.)

    Returns:
        violation_id: UUID of the logged violation
    """
    if not _db_pool:
        # Fallback: log to console if DB not initialized
        print(f"[CIR VIOLATION] {gate_type} | {reason} | blocked={blocked}")
        return str(uuid.uuid4())

    violation_id = str(uuid.uuid4())

    # Prepare metadata JSONB
    metadata = {
        "category": category,
        "context": context or {},
        "timestamp": datetime.utcnow().isoformat(),
    }

    query = """
        INSERT INTO cir_violations (
            violation_id, gate_type, pattern, reason,
            user_input, agent_response, blocked, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING violation_id, created_at
    """

    try:
        async with _db_pool.acquire() as conn:
            result = await conn.fetchrow(
                query,
                violation_id,
                gate_type,
                pattern,
                reason,
                user_input,
                agent_response,
                blocked,
                json.dumps(metadata),
            )

            return result['violation_id']

    except Exception as e:
        # Fallback: log to console if DB insert fails
        print(f"[CIR VIOLATION LOG ERROR] {e}")
        print(f"[CIR VIOLATION] {gate_type} | {reason} | blocked={blocked}")
        return violation_id


async def get_violations(
    gate_type: Optional[str] = None,
    blocked_only: bool = False,
    limit: int = 100,
) -> list:
    """
    Retrieve recent CIR violations

    Args:
        gate_type: Filter by 'request' or 'response' (None for all)
        blocked_only: Only return violations that were blocked
        limit: Maximum number of violations to return

    Returns:
        List of violation records
    """
    if not _db_pool:
        return []

    query = """
        SELECT
            violation_id, gate_type, pattern, reason,
            user_input, agent_response, blocked, metadata, created_at
        FROM cir_violations
        WHERE 1=1
    """

    params = []
    param_idx = 1

    if gate_type:
        query += f" AND gate_type = ${param_idx}"
        params.append(gate_type)
        param_idx += 1

    if blocked_only:
        query += f" AND blocked = ${param_idx}"
        params.append(True)
        param_idx += 1

    query += f" ORDER BY created_at DESC LIMIT ${param_idx}"
    params.append(limit)

    try:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(query, *params)
            return [dict(row) for row in rows]

    except Exception as e:
        print(f"[CIR VIOLATION FETCH ERROR] {e}")
        return []


async def get_violation_stats() -> Dict:
    """
    Get statistics about CIR violations

    Returns:
        {
            "total_violations": int,
            "blocked_count": int,
            "by_gate_type": {...},
            "by_category": {...},
            "recent_patterns": [...]
        }
    """
    if not _db_pool:
        return {}

    try:
        async with _db_pool.acquire() as conn:
            # Total violations
            total = await conn.fetchval("SELECT COUNT(*) FROM cir_violations")

            # Blocked count
            blocked = await conn.fetchval(
                "SELECT COUNT(*) FROM cir_violations WHERE blocked = TRUE"
            )

            # By gate type
            gate_types = await conn.fetch("""
                SELECT gate_type, COUNT(*) as count
                FROM cir_violations
                GROUP BY gate_type
            """)

            # Recent patterns (top 10)
            patterns = await conn.fetch("""
                SELECT pattern, reason, COUNT(*) as count
                FROM cir_violations
                WHERE pattern IS NOT NULL
                GROUP BY pattern, reason
                ORDER BY count DESC
                LIMIT 10
            """)

            return {
                "total_violations": total,
                "blocked_count": blocked,
                "by_gate_type": {row['gate_type']: row['count'] for row in gate_types},
                "recent_patterns": [
                    {
                        "pattern": row['pattern'],
                        "reason": row['reason'],
                        "count": row['count'],
                    }
                    for row in patterns
                ],
            }

    except Exception as e:
        print(f"[CIR STATS ERROR] {e}")
        return {}
