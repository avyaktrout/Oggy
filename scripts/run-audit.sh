#!/bin/bash
# Audit check script
# Usage: ./scripts/run-audit.sh [quick|full]

set -e

AUDIT_TYPE="${1:-quick}"

echo "🔍 Running $AUDIT_TYPE audit check"
echo "====================================="
echo ""

if [ "$AUDIT_TYPE" = "full" ]; then
    curl -s http://localhost:3001/v0/audit/full | python -m json.tool 2>/dev/null || curl -s http://localhost:3001/v0/audit/full
else
    curl -s http://localhost:3001/v0/audit/quick | python -m json.tool 2>/dev/null || curl -s http://localhost:3001/v0/audit/quick
fi

echo ""
echo ""

# Extract and display summary
STATUS=$(curl -s http://localhost:3001/v0/audit/$AUDIT_TYPE | grep -o '"overall_status":"[^"]*"' | cut -d'"' -f4)

case "$STATUS" in
    "PASS")
        echo "✅ Audit status: PASS"
        exit 0
        ;;
    "WARN")
        echo "⚠️  Audit status: WARN (check details above)"
        exit 0
        ;;
    "FAIL")
        echo "❌ Audit status: FAIL (check details above)"
        exit 1
        ;;
    *)
        echo "❓ Audit status: UNKNOWN"
        exit 1
        ;;
esac
