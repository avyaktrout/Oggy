"""
Pattern Learning - Learn from CIR violations to improve detection
Simple pattern learning that tracks successful blocks and adapts
"""

import re
from typing import Dict, List, Optional
from .violation_logger import get_violations
from .request_gate import add_pattern as add_request_pattern


# Track learned patterns
_learned_patterns = []


async def learn_from_violations(min_occurrences: int = 3) -> List[Dict]:
    """
    Analyze recent violations and learn new patterns

    Args:
        min_occurrences: Minimum times a pattern must occur to be learned

    Returns:
        List of newly learned patterns
    """
    # Get recent blocked violations
    violations = await get_violations(blocked_only=True, limit=1000)

    if not violations:
        return []

    # Group by similar inputs to find patterns
    input_groups = _group_similar_inputs(violations)

    # Extract patterns from groups
    new_patterns = []

    for group_key, group_violations in input_groups.items():
        if len(group_violations) >= min_occurrences:
            # Extract common pattern from this group
            pattern = _extract_pattern(group_violations)

            if pattern and pattern not in [p['pattern'] for p in _learned_patterns]:
                # Determine category based on existing violations
                category = _infer_category(group_violations)
                reason = f"Learned pattern: {group_key} ({len(group_violations)} occurrences)"

                new_pattern = {
                    "pattern": pattern,
                    "category": category,
                    "reason": reason,
                    "occurrences": len(group_violations),
                    "examples": [v['user_input'][:100] for v in group_violations[:3]],
                }

                # Add to request gate
                add_request_pattern(pattern, category, reason)

                # Track learned pattern
                _learned_patterns.append(new_pattern)
                new_patterns.append(new_pattern)

    return new_patterns


def _group_similar_inputs(violations: List[Dict]) -> Dict[str, List[Dict]]:
    """
    Group violations by similar input patterns

    Args:
        violations: List of violation records

    Returns:
        Dictionary mapping group key to list of violations
    """
    groups = {}

    for violation in violations:
        user_input = violation.get('user_input', '')
        if not user_input:
            continue

        # Normalize input
        normalized = user_input.lower().strip()

        # Extract key phrases (first few words)
        words = normalized.split()
        if len(words) >= 3:
            key = ' '.join(words[:3])
        else:
            key = normalized

        if key not in groups:
            groups[key] = []
        groups[key].append(violation)

    return groups


def _extract_pattern(violations: List[Dict]) -> Optional[str]:
    """
    Extract a regex pattern from similar violations

    Args:
        violations: List of similar violations

    Returns:
        Regex pattern string or None
    """
    if not violations:
        return None

    # Get all user inputs
    inputs = [v['user_input'].lower() for v in violations]

    # Find common prefix
    common_prefix = _find_common_prefix(inputs)

    if len(common_prefix) >= 5:
        # Create pattern from common prefix
        # Escape special regex characters
        escaped = re.escape(common_prefix)
        return f"{escaped}.*"

    return None


def _find_common_prefix(strings: List[str]) -> str:
    """
    Find common prefix among strings

    Args:
        strings: List of strings

    Returns:
        Common prefix
    """
    if not strings:
        return ""

    prefix = strings[0]
    for s in strings[1:]:
        while not s.startswith(prefix):
            prefix = prefix[:-1]
            if not prefix:
                return ""

    return prefix


def _infer_category(violations: List[Dict]) -> str:
    """
    Infer violation category from existing violations

    Args:
        violations: List of violations

    Returns:
        Category string
    """
    # Extract categories from metadata
    categories = []

    for violation in violations:
        metadata = violation.get('metadata', {})
        if isinstance(metadata, dict):
            category = metadata.get('category')
            if category:
                categories.append(category)

    if not categories:
        return "learned_pattern"

    # Return most common category
    category_counts = {}
    for cat in categories:
        category_counts[cat] = category_counts.get(cat, 0) + 1

    return max(category_counts, key=category_counts.get)


async def get_learned_patterns() -> List[Dict]:
    """
    Get all learned patterns

    Returns:
        List of learned pattern dictionaries
    """
    return _learned_patterns.copy()


async def analyze_effectiveness() -> Dict:
    """
    Analyze effectiveness of pattern learning

    Returns:
        Statistics about learned patterns and their effectiveness
    """
    # Get all violations
    all_violations = await get_violations(limit=1000)
    blocked_violations = await get_violations(blocked_only=True, limit=1000)

    # Count violations by learned patterns
    learned_pattern_blocks = 0

    for violation in blocked_violations:
        pattern = violation.get('pattern', '')
        if any(lp['pattern'] == pattern for lp in _learned_patterns):
            learned_pattern_blocks += 1

    return {
        "total_learned_patterns": len(_learned_patterns),
        "total_violations": len(all_violations),
        "blocked_violations": len(blocked_violations),
        "learned_pattern_blocks": learned_pattern_blocks,
        "block_rate": len(blocked_violations) / len(all_violations) if all_violations else 0,
        "learned_pattern_effectiveness": (
            learned_pattern_blocks / len(_learned_patterns)
            if _learned_patterns else 0
        ),
    }
