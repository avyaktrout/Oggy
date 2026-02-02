#!/bin/bash
# Health check script
# Usage: ./scripts/check-health.sh

set -e

echo "🏥 Checking Oggy System Health"
echo "=============================="
echo ""

# Check payments service
echo "Payments Service:"
echo "-----------------"
if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    curl -s http://localhost:3001/health | python -m json.tool 2>/dev/null || curl -s http://localhost:3001/health
    echo ""
    echo "✅ Payments service is healthy"
else
    echo "❌ Payments service is down or unhealthy"
    exit 1
fi

echo ""
echo ""

# Check memory service
echo "Memory Service:"
echo "---------------"
if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    curl -s http://localhost:3000/health | python -m json.tool 2>/dev/null || curl -s http://localhost:3000/health
    echo ""
    echo "✅ Memory service is healthy"
else
    echo "❌ Memory service is down or unhealthy"
    exit 1
fi

echo ""
echo ""
echo "✅ All services are healthy"
