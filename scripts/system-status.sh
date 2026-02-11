#!/bin/bash
# Comprehensive system status check
# Usage: ./scripts/system-status.sh

set -e

echo "📊 Oggy System Status Report"
echo "============================"
echo ""
echo "Generated: $(date)"
echo ""

# 1. Service Health
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1. SERVICE HEALTH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    echo "✅ Application Service: UP"
else
    echo "❌ Application Service: DOWN"
fi

if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "✅ Memory Service: UP"
else
    echo "❌ Memory Service: DOWN"
fi

if docker ps | grep -q oggy-postgres; then
    echo "✅ PostgreSQL: UP"
else
    echo "❌ PostgreSQL: DOWN"
fi

echo ""

# 2. Token Budget
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "2. TOKEN BUDGET"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

HEALTH_DATA=$(curl -s http://localhost:3001/health)
CURRENT_USAGE=$(echo "$HEALTH_DATA" | grep -o '"currentUsage":[0-9]*' | cut -d':' -f2)
DAILY_LIMIT=$(echo "$HEALTH_DATA" | grep -o '"dailyLimit":[0-9]*' | cut -d':' -f2)
PERCENT_USED=$(echo "$HEALTH_DATA" | grep -o '"percentUsed":"[^"]*"' | cut -d'"' -f4)

echo "Usage: $CURRENT_USAGE / $DAILY_LIMIT tokens ($PERCENT_USED%)"

PERCENT_NUM=$(echo "$PERCENT_USED" | cut -d'.' -f1)
if [ "$PERCENT_NUM" -ge 80 ]; then
    echo "⚠️  Status: HIGH USAGE"
elif [ "$PERCENT_NUM" -ge 50 ]; then
    echo "⚠️  Status: MODERATE USAGE"
else
    echo "✅ Status: HEALTHY"
fi

echo ""

# 3. Audit Status
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "3. DATA INTEGRITY (AUDIT)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

AUDIT_DATA=$(curl -s http://localhost:3001/v0/audit/quick)
AUDIT_STATUS=$(echo "$AUDIT_DATA" | grep -o '"overall_status":"[^"]*"' | cut -d'"' -f4)

case "$AUDIT_STATUS" in
    "PASS")
        echo "✅ Audit Status: PASS"
        ;;
    "WARN")
        echo "⚠️  Audit Status: WARN"
        # Show warnings
        UNPROCESSED=$(echo "$AUDIT_DATA" | grep -o '"unprocessed_count":[0-9]*' | cut -d':' -f2)
        if [ -n "$UNPROCESSED" ] && [ "$UNPROCESSED" -gt 0 ]; then
            echo "   - $UNPROCESSED unprocessed events"
        fi
        ;;
    "FAIL")
        echo "❌ Audit Status: FAIL"
        ;;
    *)
        echo "❓ Audit Status: UNKNOWN"
        ;;
esac

echo ""

# 4. Recent Activity
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "4. RECENT ACTIVITY (LAST 10 LOG LINES)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

docker logs oggy-application-service --tail 10 2>&1 | grep -E "(info|error|warn)" | tail -10

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "✅ Status report complete"
echo ""
echo "For detailed logs: ./scripts/view-logs.sh"
echo "For full audit: ./scripts/run-audit.sh full"
echo ""
