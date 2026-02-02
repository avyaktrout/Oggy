"""
Work Queue - Redis task queue wrapper for learning loop

Provides a simple queue interface for learning tasks:
- Push tasks to queue (from user interactions, assessments, etc.)
- Pull tasks for processing in learning loop
- Priority queue support for urgent items

Week 4 Deliverable
"""

import os
import json
import uuid
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Any
from datetime import datetime
from enum import Enum

try:
    import redis.asyncio as redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False


class TaskPriority(Enum):
    """Task priority levels"""
    LOW = 0
    NORMAL = 1
    HIGH = 2
    URGENT = 3


class TaskType(Enum):
    """Types of learning tasks"""
    PRACTICE = "practice"  # Regular practice item
    FEEDBACK = "feedback"  # Learning from user feedback
    SDL = "sdl"  # Self-driven learning task
    REMEDIATION = "remediation"  # Re-training on failed items


@dataclass
class WorkItem:
    """
    Single work item in the queue
    """
    task_id: str
    task_type: str  # TaskType value
    priority: int = TaskPriority.NORMAL.value

    # Task data
    user_input: str = ""
    expected_output: Optional[str] = None
    context: Optional[Dict[str, Any]] = None

    # Metadata
    owner_type: str = "user"
    owner_id: str = "default"
    domain: Optional[str] = None
    difficulty: Optional[str] = None
    tags: List[str] = field(default_factory=list)

    # Source tracking
    source: Optional[str] = None  # e.g., "tessa", "user_feedback", "sdl"
    source_id: Optional[str] = None  # e.g., pack_id, trace_id, sdl_plan_id

    # Timestamps
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    processed_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WorkItem":
        """Create WorkItem from dictionary"""
        # Handle potential missing fields
        return cls(
            task_id=data.get("task_id", str(uuid.uuid4())),
            task_type=data.get("task_type", TaskType.PRACTICE.value),
            priority=data.get("priority", TaskPriority.NORMAL.value),
            user_input=data.get("user_input", ""),
            expected_output=data.get("expected_output"),
            context=data.get("context"),
            owner_type=data.get("owner_type", "user"),
            owner_id=data.get("owner_id", "default"),
            domain=data.get("domain"),
            difficulty=data.get("difficulty"),
            tags=data.get("tags", []),
            source=data.get("source"),
            source_id=data.get("source_id"),
            created_at=data.get("created_at", datetime.utcnow().isoformat()),
            processed_at=data.get("processed_at"),
        )


class WorkQueue:
    """
    Redis-backed work queue for learning tasks

    Queues:
    - task_queue:oggy - Main queue (FIFO with priority)
    - task_queue:oggy:priority - Priority items (processed first)
    - task_queue:oggy:processing - Items currently being processed
    """

    MAIN_QUEUE = "task_queue:oggy"
    PRIORITY_QUEUE = "task_queue:oggy:priority"
    PROCESSING_SET = "task_queue:oggy:processing"

    def __init__(
        self,
        redis_url: Optional[str] = None,
        queue_prefix: str = "task_queue:oggy",
    ):
        """
        Initialize work queue

        Args:
            redis_url: Redis connection URL
            queue_prefix: Prefix for queue keys
        """
        self.redis_url = redis_url or os.getenv("REDIS_URL", "redis://localhost:6379/0")
        self.queue_prefix = queue_prefix
        self.main_queue = f"{queue_prefix}"
        self.priority_queue = f"{queue_prefix}:priority"
        self.processing_set = f"{queue_prefix}:processing"

        self._redis: Optional[redis.Redis] = None
        self._in_memory_queue: List[WorkItem] = []  # Fallback for no Redis
        self._in_memory_priority: List[WorkItem] = []

    async def _get_redis(self) -> Optional[redis.Redis]:
        """Get Redis connection (lazy initialization)"""
        if not REDIS_AVAILABLE:
            return None

        if self._redis is None:
            try:
                self._redis = redis.from_url(self.redis_url)
                # Test connection
                await self._redis.ping()
            except Exception as e:
                print(f"Redis connection failed: {e}. Using in-memory queue.")
                self._redis = None

        return self._redis

    async def push(
        self,
        task: WorkItem,
        priority: bool = False,
    ) -> str:
        """
        Push a task to the queue

        Args:
            task: WorkItem to queue
            priority: If True, push to priority queue

        Returns:
            Task ID
        """
        client = await self._get_redis()

        if client:
            # Serialize task
            task_json = json.dumps(task.to_dict())

            if priority or task.priority >= TaskPriority.HIGH.value:
                await client.lpush(self.priority_queue, task_json)
            else:
                await client.lpush(self.main_queue, task_json)
        else:
            # In-memory fallback
            if priority or task.priority >= TaskPriority.HIGH.value:
                self._in_memory_priority.insert(0, task)
            else:
                self._in_memory_queue.insert(0, task)

        return task.task_id

    async def push_many(self, tasks: List[WorkItem]) -> List[str]:
        """
        Push multiple tasks to the queue

        Args:
            tasks: List of WorkItem to queue

        Returns:
            List of task IDs
        """
        task_ids = []
        for task in tasks:
            task_id = await self.push(task)
            task_ids.append(task_id)
        return task_ids

    async def pull(
        self,
        max_items: int = 10,
        timeout: int = 0,
    ) -> List[WorkItem]:
        """
        Pull tasks from the queue (priority first, then main)

        Args:
            max_items: Maximum number of items to pull
            timeout: Timeout in seconds (0 for non-blocking)

        Returns:
            List of WorkItem
        """
        items = []
        client = await self._get_redis()

        if client:
            # First pull from priority queue
            while len(items) < max_items:
                result = await client.rpop(self.priority_queue)
                if result:
                    task_data = json.loads(result)
                    items.append(WorkItem.from_dict(task_data))
                else:
                    break

            # Then from main queue
            while len(items) < max_items:
                result = await client.rpop(self.main_queue)
                if result:
                    task_data = json.loads(result)
                    items.append(WorkItem.from_dict(task_data))
                else:
                    break

            # Track as processing
            for item in items:
                await client.sadd(self.processing_set, item.task_id)
        else:
            # In-memory fallback
            while len(items) < max_items and self._in_memory_priority:
                items.append(self._in_memory_priority.pop())

            while len(items) < max_items and self._in_memory_queue:
                items.append(self._in_memory_queue.pop())

        return items

    async def mark_completed(self, task_id: str) -> None:
        """
        Mark a task as completed (remove from processing set)

        Args:
            task_id: Task ID to mark completed
        """
        client = await self._get_redis()

        if client:
            await client.srem(self.processing_set, task_id)

    async def mark_failed(
        self,
        task: WorkItem,
        retry: bool = True,
    ) -> None:
        """
        Mark a task as failed, optionally re-queue

        Args:
            task: Failed WorkItem
            retry: If True, re-queue the task
        """
        client = await self._get_redis()

        if client:
            await client.srem(self.processing_set, task.task_id)

            if retry:
                # Re-queue with lower priority
                task.priority = max(0, task.priority - 1)
                await self.push(task, priority=False)

    async def get_queue_stats(self) -> Dict[str, Any]:
        """
        Get queue statistics

        Returns:
            Queue statistics
        """
        client = await self._get_redis()

        if client:
            main_length = await client.llen(self.main_queue)
            priority_length = await client.llen(self.priority_queue)
            processing_count = await client.scard(self.processing_set)

            return {
                "main_queue_length": main_length,
                "priority_queue_length": priority_length,
                "processing_count": processing_count,
                "total_pending": main_length + priority_length,
                "redis_connected": True,
            }
        else:
            return {
                "main_queue_length": len(self._in_memory_queue),
                "priority_queue_length": len(self._in_memory_priority),
                "processing_count": 0,
                "total_pending": len(self._in_memory_queue) + len(self._in_memory_priority),
                "redis_connected": False,
            }

    async def clear_queue(self) -> None:
        """Clear all queues (for testing)"""
        client = await self._get_redis()

        if client:
            await client.delete(self.main_queue)
            await client.delete(self.priority_queue)
            await client.delete(self.processing_set)
        else:
            self._in_memory_queue.clear()
            self._in_memory_priority.clear()

    async def close(self) -> None:
        """Close Redis connection"""
        if self._redis:
            await self._redis.close()
            self._redis = None


def create_work_item(
    user_input: str,
    task_type: TaskType = TaskType.PRACTICE,
    priority: TaskPriority = TaskPriority.NORMAL,
    expected_output: Optional[str] = None,
    context: Optional[Dict[str, Any]] = None,
    owner_type: str = "user",
    owner_id: str = "default",
    domain: Optional[str] = None,
    difficulty: Optional[str] = None,
    tags: Optional[List[str]] = None,
    source: Optional[str] = None,
    source_id: Optional[str] = None,
) -> WorkItem:
    """
    Helper function to create a WorkItem

    Args:
        user_input: The input/prompt to process
        task_type: Type of task (practice, feedback, sdl, remediation)
        priority: Task priority
        expected_output: Expected output for scoring
        context: Additional context
        owner_type: Memory owner type
        owner_id: Memory owner ID
        domain: Task domain
        difficulty: Task difficulty
        tags: Task tags
        source: Source of the task
        source_id: Source identifier

    Returns:
        WorkItem ready for queuing
    """
    return WorkItem(
        task_id=str(uuid.uuid4()),
        task_type=task_type.value,
        priority=priority.value,
        user_input=user_input,
        expected_output=expected_output,
        context=context,
        owner_type=owner_type,
        owner_id=owner_id,
        domain=domain,
        difficulty=difficulty,
        tags=tags or [],
        source=source,
        source_id=source_id,
    )


def create_practice_item_from_tessa(practice_item: Any, source_pack_id: str) -> WorkItem:
    """
    Create a WorkItem from a Tessa PracticeItem

    Args:
        practice_item: PracticeItem from Tessa
        source_pack_id: Source practice pack ID

    Returns:
        WorkItem ready for queuing
    """
    return WorkItem(
        task_id=str(uuid.uuid4()),
        task_type=TaskType.PRACTICE.value,
        priority=TaskPriority.NORMAL.value,
        user_input=practice_item.input,
        expected_output=practice_item.expected_output,
        context=practice_item.context,
        owner_type="user",
        owner_id="practice",
        domain=practice_item.domain,
        difficulty=practice_item.difficulty,
        tags=practice_item.tags,
        source="tessa",
        source_id=source_pack_id,
    )
