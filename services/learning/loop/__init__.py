"""
Loop Package - Continuous Learning Loop for Oggy

This package contains the core components for Oggy's continuous learning:
- OggyLearningLoop: Main orchestrator for training cycles
- MemoryValidationUtility: Validates and applies memory updates
- TessaClient: Practice pack provider (separates practice from sealed benchmarks)
- WorkQueue: Redis task queue wrapper
- SelfDrivenLearning: Gap detection and autonomous learning

Week 4 Deliverable - Continuous Learning Loop v1
"""

from .memory_validation_utility import (
    MemoryValidationUtility,
    GateState,
    UpdateProposal,
)
from .tessa_integration import TessaClient, PracticeItem, PracticePack
from .work_queue import WorkQueue, WorkItem
from .oggy_learning_loop import OggyLearningLoop, CycleResult
from .oggy_self_driven_learning import SelfDrivenLearning, SDLPlan, GapSignal

__all__ = [
    "MemoryValidationUtility",
    "GateState",
    "UpdateProposal",
    "TessaClient",
    "PracticeItem",
    "PracticePack",
    "WorkQueue",
    "WorkItem",
    "OggyLearningLoop",
    "CycleResult",
    "SelfDrivenLearning",
    "SDLPlan",
    "GapSignal",
]
