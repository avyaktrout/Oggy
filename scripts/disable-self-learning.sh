#!/bin/bash
# Disable Oggy's self-driven learning
# Usage: ./scripts/disable-self-learning.sh

echo "🛑 Disabling Self-Driven Learning"
echo "=================================="
echo ""

RESPONSE=$(curl -s -X POST http://localhost:3001/v0/learning/stop)

echo "$RESPONSE" | python -m json.tool 2>/dev/null || echo "$RESPONSE"
echo ""

# Extract stats
TOTAL=$(echo "$RESPONSE" | grep -o '"total_attempts":[0-9]*' | cut -d':' -f2)
CORRECT=$(echo "$RESPONSE" | grep -o '"correct":[0-9]*' | cut -d':' -f2)
ACCURACY=$(echo "$RESPONSE" | grep -o '"accuracy":"[^"]*"' | cut -d'"' -f4)

if [ -n "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
    echo "📊 Final Learning Statistics:"
    echo "   Total Attempts: $TOTAL"
    echo "   Correct:        $CORRECT"
    echo "   Accuracy:       $ACCURACY"
    echo ""
    echo "✅ Self-driven learning stopped"
else
    echo "ℹ️  Self-driven learning was not running"
fi
