"""
CIR (Core Integrity Rules) - Application-level safety gates
Week 3 implementation
"""

from .request_gate import validate_request
from .response_gate import validate_response
from .violation_logger import log_violation

__all__ = [
    'validate_request',
    'validate_response',
    'log_violation',
]
