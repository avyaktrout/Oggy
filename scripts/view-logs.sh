#!/bin/bash
# Log viewer script
# Usage: ./scripts/view-logs.sh [payments|memory|all] [lines]

SERVICE="${1:-all}"
LINES="${2:-50}"

case "$SERVICE" in
    payments|pay)
        echo "📊 Viewing Payments Service logs (last $LINES lines)"
        echo "====================================================="
        docker logs oggy-application-service --tail $LINES -f
        ;;
    memory|mem)
        echo "📊 Viewing Memory Service logs (last $LINES lines)"
        echo "=================================================="
        docker logs oggy-memory-service --tail $LINES -f
        ;;
    all)
        echo "📊 Viewing All Service logs (last $LINES lines)"
        echo "==============================================="
        docker-compose logs --tail=$LINES -f
        ;;
    *)
        echo "Usage: $0 [payments|memory|all] [lines]"
        echo ""
        echo "Examples:"
        echo "  $0 payments 100  - View last 100 lines of payments service"
        echo "  $0 memory        - View last 50 lines of memory service"
        echo "  $0 all 200       - View last 200 lines of all services"
        exit 1
        ;;
esac
