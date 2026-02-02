"""
Tessa Integration - Practice Pack Provider

Tessa is the testing agent that provides practice items for training.
Key separation:
- Practice packs (data/practice-packs/) - For training, learning allowed
- Sealed benchmarks (data/sealed-benchmarks/) - For evaluation only, no learning

Week 4 Deliverable
"""

import os
import json
import random
from pathlib import Path
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Set
from datetime import datetime


@dataclass
class PracticeItem:
    """
    Single practice item for training
    """
    item_id: str
    input: str
    expected_output: Optional[str] = None
    context: Optional[Dict[str, Any]] = None
    difficulty: str = "medium"  # easy, medium, hard
    domain: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    scoring_criteria: Optional[Dict[str, Any]] = None

    # Tracking
    times_used: int = 0
    last_used: Optional[datetime] = None


@dataclass
class PracticePack:
    """
    Collection of practice items
    """
    pack_id: str
    name: str
    description: str
    items: List[PracticeItem]
    is_sealed: bool = False  # True for benchmarks, False for practice

    # Metadata
    domain: Optional[str] = None
    difficulty_distribution: Optional[Dict[str, int]] = None
    scoring_config: Optional[Dict[str, Any]] = None
    created_at: Optional[datetime] = None

    @property
    def item_count(self) -> int:
        return len(self.items)

    def get_items_by_difficulty(self, difficulty: str) -> List[PracticeItem]:
        """Get items filtered by difficulty"""
        return [item for item in self.items if item.difficulty == difficulty]

    def get_items_by_domain(self, domain: str) -> List[PracticeItem]:
        """Get items filtered by domain"""
        return [item for item in self.items if item.domain == domain]


class TessaClient:
    """
    Tessa client for loading practice packs and managing item usage

    Separates practice items (learning allowed) from sealed benchmarks (no learning).
    Tracks item usage to avoid repetition during training.
    """

    def __init__(
        self,
        practice_packs_dir: Optional[str] = None,
        sealed_benchmarks_dir: Optional[str] = None,
    ):
        """
        Initialize Tessa client

        Args:
            practice_packs_dir: Directory containing practice pack JSON files
            sealed_benchmarks_dir: Directory containing sealed benchmark JSON files
        """
        # Default paths relative to services/learning
        base_dir = Path(__file__).parent.parent.parent.parent  # Oggy root
        self.practice_packs_dir = Path(
            practice_packs_dir or os.getenv(
                "PRACTICE_PACKS_DIR",
                str(base_dir / "data" / "practice-packs")
            )
        )
        self.sealed_benchmarks_dir = Path(
            sealed_benchmarks_dir or os.getenv(
                "SEALED_BENCHMARKS_DIR",
                str(base_dir / "data" / "sealed-benchmarks")
            )
        )

        # Cached packs
        self._practice_packs: Dict[str, PracticePack] = {}
        self._sealed_benchmarks: Dict[str, PracticePack] = {}

        # Usage tracking (item_id -> times_used)
        self._item_usage: Dict[str, int] = {}
        self._recently_used: Set[str] = set()  # Items used in current session

    def _load_pack_from_file(self, file_path: Path, is_sealed: bool = False) -> Optional[PracticePack]:
        """
        Load a practice pack from a JSON file

        Args:
            file_path: Path to the JSON file
            is_sealed: Whether this is a sealed benchmark

        Returns:
            PracticePack or None if load fails
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # Parse items
            items = []
            for item_data in data.get("items", []):
                item = PracticeItem(
                    item_id=item_data.get("item_id", str(len(items))),
                    input=item_data.get("input", ""),
                    expected_output=item_data.get("expected_output"),
                    context=item_data.get("context"),
                    difficulty=item_data.get("difficulty", "medium"),
                    domain=item_data.get("domain") or data.get("domain"),
                    tags=item_data.get("tags", []),
                    scoring_criteria=item_data.get("scoring_criteria"),
                )
                items.append(item)

            # Create pack
            pack = PracticePack(
                pack_id=data.get("bundle_id") or data.get("pack_id") or file_path.stem,
                name=data.get("name", file_path.stem),
                description=data.get("description", ""),
                items=items,
                is_sealed=is_sealed,
                domain=data.get("domain"),
                difficulty_distribution=data.get("difficulty_distribution"),
                scoring_config=data.get("scoring_config"),
            )

            return pack

        except Exception as e:
            print(f"Error loading pack from {file_path}: {e}")
            return None

    def load_practice_packs(self) -> int:
        """
        Load all practice packs from the practice packs directory

        Returns:
            Number of packs loaded
        """
        self._practice_packs.clear()

        if not self.practice_packs_dir.exists():
            print(f"Practice packs directory not found: {self.practice_packs_dir}")
            return 0

        count = 0
        for file_path in self.practice_packs_dir.glob("*.json"):
            pack = self._load_pack_from_file(file_path, is_sealed=False)
            if pack:
                self._practice_packs[pack.pack_id] = pack
                count += 1

        return count

    def load_sealed_benchmarks(self) -> int:
        """
        Load all sealed benchmarks from the sealed benchmarks directory

        Returns:
            Number of benchmarks loaded
        """
        self._sealed_benchmarks.clear()

        if not self.sealed_benchmarks_dir.exists():
            print(f"Sealed benchmarks directory not found: {self.sealed_benchmarks_dir}")
            return 0

        count = 0
        for file_path in self.sealed_benchmarks_dir.glob("*.json"):
            pack = self._load_pack_from_file(file_path, is_sealed=True)
            if pack:
                self._sealed_benchmarks[pack.pack_id] = pack
                count += 1

        return count

    def get_practice_pack(self, pack_id: str) -> Optional[PracticePack]:
        """
        Get a specific practice pack by ID

        Args:
            pack_id: Pack ID to retrieve

        Returns:
            PracticePack or None if not found
        """
        if not self._practice_packs:
            self.load_practice_packs()
        return self._practice_packs.get(pack_id)

    def get_sealed_benchmark(self, pack_id: str) -> Optional[PracticePack]:
        """
        Get a specific sealed benchmark by ID

        Args:
            pack_id: Benchmark ID to retrieve

        Returns:
            PracticePack or None if not found
        """
        if not self._sealed_benchmarks:
            self.load_sealed_benchmarks()
        return self._sealed_benchmarks.get(pack_id)

    def get_practice_items(
        self,
        count: int = 10,
        domain: Optional[str] = None,
        difficulty: Optional[str] = None,
        avoid_recent: bool = True,
        pack_id: Optional[str] = None,
    ) -> List[PracticeItem]:
        """
        Get practice items for training

        Args:
            count: Number of items to retrieve
            domain: Filter by domain (optional)
            difficulty: Filter by difficulty (optional)
            avoid_recent: Avoid recently used items (default True)
            pack_id: Get items from specific pack (optional)

        Returns:
            List of PracticeItem
        """
        if not self._practice_packs:
            self.load_practice_packs()

        # Collect candidate items
        candidates = []

        if pack_id:
            # From specific pack
            pack = self._practice_packs.get(pack_id)
            if pack:
                candidates.extend(pack.items)
        else:
            # From all packs
            for pack in self._practice_packs.values():
                candidates.extend(pack.items)

        # Filter by domain
        if domain:
            candidates = [item for item in candidates if item.domain == domain]

        # Filter by difficulty
        if difficulty:
            candidates = [item for item in candidates if item.difficulty == difficulty]

        # Avoid recently used
        if avoid_recent:
            candidates = [
                item for item in candidates
                if item.item_id not in self._recently_used
            ]

        # Sort by usage (prefer less-used items)
        candidates.sort(key=lambda item: self._item_usage.get(item.item_id, 0))

        # Select items
        selected = candidates[:count]

        # Update usage tracking
        for item in selected:
            self._item_usage[item.item_id] = self._item_usage.get(item.item_id, 0) + 1
            item.times_used = self._item_usage[item.item_id]
            item.last_used = datetime.utcnow()
            self._recently_used.add(item.item_id)

        return selected

    def get_random_practice_items(
        self,
        count: int = 10,
        domain: Optional[str] = None,
        difficulty: Optional[str] = None,
    ) -> List[PracticeItem]:
        """
        Get random practice items (for variety in training)

        Args:
            count: Number of items to retrieve
            domain: Filter by domain (optional)
            difficulty: Filter by difficulty (optional)

        Returns:
            List of PracticeItem
        """
        if not self._practice_packs:
            self.load_practice_packs()

        # Collect all items
        all_items = []
        for pack in self._practice_packs.values():
            all_items.extend(pack.items)

        # Filter
        if domain:
            all_items = [item for item in all_items if item.domain == domain]
        if difficulty:
            all_items = [item for item in all_items if item.difficulty == difficulty]

        # Random selection
        selected = random.sample(all_items, min(count, len(all_items)))

        # Update usage tracking
        for item in selected:
            self._item_usage[item.item_id] = self._item_usage.get(item.item_id, 0) + 1
            item.times_used = self._item_usage[item.item_id]
            item.last_used = datetime.utcnow()

        return selected

    def generate_targeted_items(
        self,
        scope: Dict[str, Any],
        count: int = 10,
    ) -> List[PracticeItem]:
        """
        Generate targeted practice items based on scope (for SDL)

        This is a simple implementation that filters existing items.
        In a full implementation, this could use LLM to generate new items.

        Args:
            scope: Scope definition with domain, categories, etc.
            count: Number of items to generate

        Returns:
            List of targeted PracticeItem
        """
        domain = scope.get("domain")
        difficulty = scope.get("difficulty")
        tags = scope.get("tags", [])

        # Get base items
        items = self.get_practice_items(
            count=count * 2,  # Get extra to filter
            domain=domain,
            difficulty=difficulty,
            avoid_recent=True,
        )

        # Filter by tags if specified
        if tags:
            items = [
                item for item in items
                if any(tag in item.tags for tag in tags)
            ] or items  # Fall back to unfiltered if no matches

        return items[:count]

    def list_practice_packs(self) -> List[Dict[str, Any]]:
        """
        List available practice packs

        Returns:
            List of pack metadata
        """
        if not self._practice_packs:
            self.load_practice_packs()

        return [
            {
                "pack_id": pack.pack_id,
                "name": pack.name,
                "description": pack.description,
                "item_count": pack.item_count,
                "domain": pack.domain,
                "is_sealed": pack.is_sealed,
            }
            for pack in self._practice_packs.values()
        ]

    def list_sealed_benchmarks(self) -> List[Dict[str, Any]]:
        """
        List available sealed benchmarks

        Returns:
            List of benchmark metadata
        """
        if not self._sealed_benchmarks:
            self.load_sealed_benchmarks()

        return [
            {
                "pack_id": pack.pack_id,
                "name": pack.name,
                "description": pack.description,
                "item_count": pack.item_count,
                "domain": pack.domain,
                "is_sealed": pack.is_sealed,
            }
            for pack in self._sealed_benchmarks.values()
        ]

    def get_usage_stats(self) -> Dict[str, Any]:
        """
        Get item usage statistics

        Returns:
            Usage statistics
        """
        return {
            "total_items_used": len(self._item_usage),
            "recently_used": len(self._recently_used),
            "usage_distribution": dict(self._item_usage),
        }

    def clear_recent_usage(self) -> None:
        """Clear recently used tracking (call at end of training cycle)"""
        self._recently_used.clear()

    def reset_usage(self) -> None:
        """Reset all usage tracking"""
        self._item_usage.clear()
        self._recently_used.clear()

    def get_available_domains(self) -> List[str]:
        """
        Get list of available domains across all practice packs

        Returns:
            List of domain names
        """
        if not self._practice_packs:
            self.load_practice_packs()

        domains = set()
        for pack in self._practice_packs.values():
            if pack.domain:
                domains.add(pack.domain)
            for item in pack.items:
                if item.domain:
                    domains.add(item.domain)

        return list(domains)

    def get_available_difficulties(self) -> List[str]:
        """Get list of available difficulty levels"""
        return ["easy", "medium", "hard"]
