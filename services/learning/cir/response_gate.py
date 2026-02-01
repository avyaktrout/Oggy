"""
Response Gate - Output validation for CIR
Validates agent responses for safety, PII leakage, and policy violations
"""

import re
from typing import Dict, List, Optional

# PII patterns to detect in responses
PII_PATTERNS = [
    # Email addresses
    (r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b', "email_address"),

    # Phone numbers (various formats)
    (r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', "phone_number"),
    (r'\b\(\d{3}\)\s*\d{3}[-.]?\d{4}\b', "phone_number"),

    # Social Security Numbers (US)
    (r'\b\d{3}-\d{2}-\d{4}\b', "ssn"),

    # Credit card numbers (simple check)
    (r'\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b', "credit_card"),

    # API keys and tokens (common patterns)
    (r'\b[A-Za-z0-9_-]{32,}\b', "potential_api_key"),
    (r'sk-[A-Za-z0-9]{32,}', "openai_api_key"),
    (r'ghp_[A-Za-z0-9]{36}', "github_token"),
]

# Policy violation patterns
POLICY_VIOLATIONS = [
    # Harmful content
    (r'\b(kill|murder|suicide|self-harm)\b', "harmful_content"),
    (r'\b(hack|exploit|vulnerability)\s+(tutorial|guide|howto)', "security_exploit"),

    # Inappropriate content
    (r'\b(explicit|nsfw|adult)\b', "inappropriate_content"),

    # Disclosure of system information
    (r'(system prompt|internal instructions|model weights)', "system_disclosure"),
    (r'(database|postgres|redis)\s+(password|connection)', "credential_disclosure"),
]


async def validate_response(
    response: str,
    context: Optional[Dict] = None,
    check_pii: bool = True,
    check_policy: bool = True,
) -> Dict:
    """
    Validate agent response for safety violations

    Args:
        response: The agent's response text
        context: Optional context (e.g., user input, retrieved memories)
        check_pii: Whether to check for PII leakage
        check_policy: Whether to check for policy violations

    Returns:
        {
            "blocked": bool,
            "reason": str,
            "violations": List[Dict],
            "pii_detected": List[str],
            "policy_violations": List[str]
        }
    """
    if not response:
        return {
            "blocked": False,
            "reason": None,
            "violations": [],
            "pii_detected": [],
            "policy_violations": [],
        }

    violations = []
    pii_detected = []
    policy_violations_found = []

    # Check for PII leakage
    if check_pii:
        for pattern, pii_type in PII_PATTERNS:
            matches = re.findall(pattern, response, re.IGNORECASE)
            if matches:
                # Filter out common false positives for API keys
                if pii_type == "potential_api_key":
                    # Only flag if it looks suspicious (has mix of letters and numbers)
                    matches = [m for m in matches if re.search(r'[A-Z]', m) and re.search(r'\d', m)]

                if matches:
                    pii_detected.append(pii_type)
                    violations.append({
                        "type": "pii_leakage",
                        "category": pii_type,
                        "pattern": pattern,
                        "count": len(matches),
                    })

    # Check for policy violations
    if check_policy:
        for pattern, violation_type in POLICY_VIOLATIONS:
            if re.search(pattern, response, re.IGNORECASE):
                policy_violations_found.append(violation_type)
                violations.append({
                    "type": "policy_violation",
                    "category": violation_type,
                    "pattern": pattern,
                })

    # Check for hallucinations by comparing to context
    if context and 'retrieved_memories' in context:
        hallucination_risk = _check_hallucination(response, context['retrieved_memories'])
        if hallucination_risk:
            violations.append({
                "type": "hallucination_risk",
                "category": "unsupported_claim",
                "details": hallucination_risk,
            })

    # Determine if response should be blocked
    blocked = False
    reason = None

    # Block if critical PII detected (not potential API keys)
    critical_pii = [p for p in pii_detected if p not in ['potential_api_key']]
    if critical_pii:
        blocked = True
        reason = f"PII detected: {', '.join(critical_pii)}"

    # Block if policy violations detected
    if policy_violations_found:
        blocked = True
        if reason:
            reason += f" | Policy violations: {', '.join(policy_violations_found)}"
        else:
            reason = f"Policy violations: {', '.join(policy_violations_found)}"

    return {
        "blocked": blocked,
        "reason": reason,
        "violations": violations,
        "pii_detected": pii_detected,
        "policy_violations": policy_violations_found,
    }


def _check_hallucination(response: str, retrieved_memories: List[Dict]) -> Optional[str]:
    """
    Check if response makes claims not supported by retrieved memories
    This is a simple heuristic - in production, use more sophisticated methods

    Args:
        response: Agent response
        retrieved_memories: List of memory cards that were retrieved

    Returns:
        Warning message if hallucination risk detected, None otherwise
    """
    # Simple check: if response contains specific numbers/dates not in memories
    # This is a placeholder for more sophisticated hallucination detection

    # Extract specific claims (numbers, dates) from response
    response_numbers = re.findall(r'\b\d+\.\d+|\b\d+%|\$\d+', response)

    if not response_numbers:
        return None

    # Check if these numbers appear in any retrieved memory
    memory_text = " ".join([str(mem.get('content', '')) for mem in retrieved_memories])

    unsupported_numbers = [
        num for num in response_numbers
        if num not in memory_text
    ]

    if len(unsupported_numbers) > 2:
        return f"Response contains specific claims not in memories: {unsupported_numbers[:3]}"

    return None


def sanitize_response(response: str) -> str:
    """
    Sanitize response by removing detected PII and violations
    This is a fallback if we want to clean rather than block

    Args:
        response: Original response

    Returns:
        Sanitized response
    """
    sanitized = response

    # Redact PII
    for pattern, pii_type in PII_PATTERNS:
        sanitized = re.sub(pattern, f"[{pii_type.upper()}_REDACTED]", sanitized, flags=re.IGNORECASE)

    return sanitized
