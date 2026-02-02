#!/bin/bash
# Token budget checker
# Usage: ./scripts/check-budget.sh

set -e

echo "💰 Token Budget Status"
echo "====================="
echo ""

# Get budget from health endpoint
HEALTH_DATA=$(curl -s http://localhost:3001/health)

# Extract budget info using grep and cut (more portable than jq)
DAILY_LIMIT=$(echo "$HEALTH_DATA" | grep -o '"dailyLimit":[0-9]*' | cut -d':' -f2)
CURRENT_USAGE=$(echo "$HEALTH_DATA" | grep -o '"currentUsage":[0-9]*' | cut -d':' -f2)
PERCENT_USED=$(echo "$HEALTH_DATA" | grep -o '"percentUsed":"[^"]*"' | cut -d'"' -f4)
REMAINING=$(echo "$HEALTH_DATA" | grep -o '"remaining":[0-9]*' | cut -d':' -f2)

echo "Daily Limit:    $DAILY_LIMIT tokens"
echo "Current Usage:  $CURRENT_USAGE tokens"
echo "Percent Used:   $PERCENT_USED%"
echo "Remaining:      $REMAINING tokens"
echo ""

# Warn if usage is high
PERCENT_NUM=$(echo "$PERCENT_USED" | cut -d'.' -f1)
if [ "$PERCENT_NUM" -ge 80 ]; then
    echo "⚠️  WARNING: Token budget is at ${PERCENT_USED}%!"
    echo "Consider reducing AI operations or increasing budget."
elif [ "$PERCENT_NUM" -ge 50 ]; then
    echo "⚠️  Budget usage is moderate at ${PERCENT_USED}%"
else
    echo "✅ Budget usage is healthy at ${PERCENT_USED}%"
fi
