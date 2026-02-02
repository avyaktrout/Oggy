#!/bin/bash
# Check Oggy's self-driven learning statistics
# Usage: ./scripts/check-learning-stats.sh

echo "📊 Self-Driven Learning Statistics"
echo "==================================="
echo ""

RESPONSE=$(curl -s http://localhost:3001/v0/learning/stats)

echo "$RESPONSE" | python -m json.tool 2>/dev/null || echo "$RESPONSE"
echo ""

# Extract key metrics
IS_RUNNING=$(echo "$RESPONSE" | grep -o '"is_running":[^,]*' | cut -d':' -f2 | tr -d ' ')
TOTAL=$(echo "$RESPONSE" | grep -o '"total_attempts":[0-9]*' | cut -d':' -f2)
CORRECT=$(echo "$RESPONSE" | grep -o '"correct":[0-9]*' | cut -d':' -f2)
INCORRECT=$(echo "$RESPONSE" | grep -o '"incorrect":[0-9]*' | cut -d':' -f2)
SESSIONS=$(echo "$RESPONSE" | grep -o '"sessions":[0-9]*' | cut -d':' -f2)
ACCURACY=$(echo "$RESPONSE" | grep -o '"accuracy":"[^"]*"' | cut -d'"' -f4)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Status:         $([ "$IS_RUNNING" = "true" ] && echo "🟢 ACTIVE" || echo "🔴 INACTIVE")"
echo "Total Attempts: $TOTAL"
echo "Correct:        $CORRECT"
echo "Incorrect:      $INCORRECT"
echo "Sessions:       $SESSIONS"
echo "Accuracy:       $ACCURACY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$IS_RUNNING" = "true" ]; then
    echo "✅ Oggy is actively learning autonomously"
    echo ""
    echo "View logs:"
    echo "  docker logs oggy-payments-service | grep 'self-driven learning'"
else
    echo "ℹ️  Self-driven learning is not active"
    echo ""
    echo "Enable with:"
    echo "  ./scripts/enable-self-learning.sh <user_id>"
fi
