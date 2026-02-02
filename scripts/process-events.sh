#!/bin/bash
# Manually trigger event processing
# Usage: ./scripts/process-events.sh [limit]

LIMIT="${1:-100}"

echo "⚙️  Triggering event processing (limit: $LIMIT)"
echo "================================================"
echo ""

RESULT=$(curl -s -X POST http://localhost:3001/v0/process-events \
    -H "Content-Type: application/json" \
    -d "{\"limit\":$LIMIT}")

echo "$RESULT" | python -m json.tool 2>/dev/null || echo "$RESULT"
echo ""

# Extract counts
PROCESSED=$(echo "$RESULT" | grep -o '"processed_count":[0-9]*' | cut -d':' -f2)
DURATION=$(echo "$RESULT" | grep -o '"duration_ms":[0-9]*' | cut -d':' -f2)

if [ -n "$PROCESSED" ] && [ "$PROCESSED" -gt 0 ]; then
    echo "✅ Processed $PROCESSED events in ${DURATION}ms"
else
    echo "ℹ️  No events to process"
fi
