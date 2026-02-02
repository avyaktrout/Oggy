#!/bin/bash
# Enable Oggy's self-driven learning
# Usage: ./scripts/enable-self-learning.sh [user_id] [interval_minutes] [practice_count]

USER_ID="${1}"
INTERVAL_MINUTES="${2:-5}"  # Default 5 minutes
PRACTICE_COUNT="${3:-5}"    # Default 5 exercises per session

if [ -z "$USER_ID" ]; then
    echo "Usage: $0 <user_id> [interval_minutes] [practice_count]"
    echo ""
    echo "Examples:"
    echo "  $0 comprehensive_test_1770066242         # Practice every 5 min, 5 exercises"
    echo "  $0 comprehensive_test_1770066242 10      # Practice every 10 min"
    echo "  $0 comprehensive_test_1770066242 5 10    # Practice every 5 min, 10 exercises"
    exit 1
fi

INTERVAL_MS=$((INTERVAL_MINUTES * 60000))

echo "🧠 Enabling Self-Driven Learning for Oggy"
echo "=========================================="
echo ""
echo "User ID:         $USER_ID"
echo "Practice Every:  $INTERVAL_MINUTES minutes"
echo "Exercises:       $PRACTICE_COUNT per session"
echo ""

RESPONSE=$(curl -s -X POST http://localhost:3001/v0/learning/start \
    -H "Content-Type: application/json" \
    -d "{
        \"user_id\": \"$USER_ID\",
        \"interval\": $INTERVAL_MS,
        \"practice_count\": $PRACTICE_COUNT,
        \"enabled\": true
    }")

echo "$RESPONSE" | python -m json.tool 2>/dev/null || echo "$RESPONSE"
echo ""

# Check if successful
if echo "$RESPONSE" | grep -q "Self-driven learning started"; then
    echo "✅ Self-driven learning is now ACTIVE"
    echo ""
    echo "Oggy will autonomously:"
    echo "  1. Request practice assessments from domain knowledge"
    echo "  2. Attempt categorization"
    echo "  3. Check correctness"
    echo "  4. Update own memory based on results"
    echo ""
    echo "Monitor progress:"
    echo "  ./scripts/check-learning-stats.sh"
    echo ""
    echo "Stop learning:"
    echo "  ./scripts/disable-self-learning.sh"
else
    echo "❌ Failed to start self-driven learning"
    exit 1
fi
