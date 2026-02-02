"""
Request Gate - Input validation for CIR
Simple keyword-based validation for prompt injection and malicious content
"""

import re
from typing import Dict, Optional

# Blocked patterns for prompt injection and malicious content
BLOCKED_PATTERNS = [
    # Prompt injection attempts
    (r"ignore\s+.*instructions?", "prompt_injection", "Ignore instructions attempt"),
    (r"system\s+prompt", "prompt_injection", "System prompt access"),
    (r"jailbreak", "prompt_injection", "Jailbreak attempt"),
    (r"you\s+are\s+now", "prompt_injection", "Role override attempt"),
    (r"pretend\s+(you|to)\s+(are|be)", "prompt_injection", "Role pretend attempt"),
    (r"act\s+as\s+(if|a|an)", "prompt_injection", "Act as override"),
    (r"(forget|disregard)\s+your\s+(instructions|rules|training)", "prompt_injection", "Instruction override"),

    # Data extraction attempts
    (r"show\s+me\s+(all|the)\s+(data|users|passwords|secrets)", "data_extraction", "Data extraction attempt"),
    (r"reveal\s+(your|the)\s+(system|config|prompt)", "data_extraction", "System reveal attempt"),
    (r"print\s+(system|config|env|environment)", "data_extraction", "Environment exposure"),

    # Malicious content
    (r"<script[^>]*>", "xss", "XSS script tag"),
    (r"javascript:", "xss", "JavaScript protocol"),
    (r"on(error|load|click|mouseover)\s*=", "xss", "HTML event handler"),
    (r"sql\s+(injection|exploit)", "sql_injection", "SQL injection mention"),
    (r"(union|select|insert|update|delete)\s+.{0,20}(from|into|where)", "sql_injection", "SQL keywords"),
]


async def validate_request(user_input: str, context: Optional[Dict] = None) -> Dict:
    """
    Validate user request for safety violations

    Args:
        user_input: The user's input text
        context: Optional context about the request

    Returns:
        {
            "blocked": bool,
            "reason": str,
            "pattern": str,
            "category": str
        }
    """
    if not user_input:
        return {
            "blocked": False,
            "reason": None,
            "pattern": None,
            "category": None,
        }

    # Normalize input for case-insensitive matching
    normalized_input = user_input.lower()

    # Check each blocked pattern
    for pattern, category, reason in BLOCKED_PATTERNS:
        if re.search(pattern, normalized_input, re.IGNORECASE):
            return {
                "blocked": True,
                "reason": reason,
                "pattern": pattern,
                "category": category,
            }

    # Additional checks

    # Check for excessive length (potential DoS)
    if len(user_input) > 10000:
        return {
            "blocked": True,
            "reason": "Input too long (max 10000 characters)",
            "pattern": "length_check",
            "category": "dos_prevention",
        }

    # Check for repetitive patterns (potential spam/DoS)
    if _has_excessive_repetition(user_input):
        return {
            "blocked": True,
            "reason": "Excessive repetition detected",
            "pattern": "repetition_check",
            "category": "spam_prevention",
        }

    # All checks passed
    return {
        "blocked": False,
        "reason": None,
        "pattern": None,
        "category": None,
    }


def _has_excessive_repetition(text: str, threshold: int = 10) -> bool:
    """
    Check if text has excessive repetition of characters or words

    Args:
        text: Input text
        threshold: Maximum allowed repetitions

    Returns:
        True if excessive repetition detected
    """
    # Check for character repetition (e.g., "aaaaaaaaaa")
    if re.search(r'(.)\1{' + str(threshold) + r',}', text):
        return True

    # Check for word repetition
    words = text.split()
    if len(words) > 5:
        word_counts = {}
        for word in words:
            word_lower = word.lower()
            word_counts[word_lower] = word_counts.get(word_lower, 0) + 1
            if word_counts[word_lower] > threshold:
                return True

    return False


def add_pattern(pattern: str, category: str, reason: str):
    """
    Dynamically add a new blocked pattern (for pattern learning)

    Args:
        pattern: Regex pattern to block
        category: Category of the violation
        reason: Human-readable reason
    """
    BLOCKED_PATTERNS.append((pattern, category, reason))


def get_patterns() -> list:
    """
    Get all currently blocked patterns

    Returns:
        List of (pattern, category, reason) tuples
    """
    return BLOCKED_PATTERNS.copy()
