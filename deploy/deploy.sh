#!/bin/bash
# ==============================================================================
# Oggy Deployment Script for EC2 — Microservices Architecture
# Pulls latest code, rebuilds containers, and verifies health.
#
# Usage: cd /opt/oggy && ./deploy/deploy.sh
# ==============================================================================

set -euo pipefail

OGGY_DIR="/opt/oggy"
COMPOSE_FILE="docker-compose.staging.yml"

cd "$OGGY_DIR"

echo "=========================================="
echo "  Oggy Deploy — $(date)"
echo "=========================================="

# --- Pre-flight checks ---
if [ ! -f ".env" ]; then
    echo "ERROR: .env file not found. Copy .env.example and fill in values."
    exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "ERROR: $COMPOSE_FILE not found."
    exit 1
fi

# --- Pull latest code ---
echo ""
echo "[1/6] Pulling latest code..."
git pull --ff-only origin main

# --- Backup database before deploy ---
echo ""
echo "[2/6] Backing up database..."
if command -v aws &> /dev/null && aws sts get-caller-identity &> /dev/null; then
    ./deploy/backup-postgres.sh || echo "WARNING: Backup failed, continuing deploy..."
else
    echo "  Skipping S3 backup (AWS not configured). Taking local backup..."
    docker exec oggy-postgres pg_dump -U oggy oggy_db | gzip > /tmp/oggy-pre-deploy-$(date +%s).sql.gz 2>/dev/null || echo "  No running DB to backup (first deploy?)."
fi

# --- Build and deploy ---
echo ""
echo "[3/6] Building and deploying containers..."
docker compose -f "$COMPOSE_FILE" build --no-cache
docker compose -f "$COMPOSE_FILE" up -d

# --- Wait for gateway health ---
echo ""
echo "[4/6] Waiting for gateway to be healthy..."
MAX_WAIT=90
WAITED=0

while [ $WAITED -lt $MAX_WAIT ]; do
    HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/health 2>/dev/null || echo "000")

    if [ "$HTTP_STATUS" = "200" ]; then
        echo "  Gateway healthy (${WAITED}s)"
        break
    fi

    echo "  Waiting... (${WAITED}s, status: ${HTTP_STATUS})"
    sleep 5
    WAITED=$((WAITED + 5))
done

if [ "$HTTP_STATUS" != "200" ]; then
    echo ""
    echo "ERROR: Gateway failed health check after ${MAX_WAIT}s"
    echo "Check logs: docker compose -f $COMPOSE_FILE logs gateway"
    exit 1
fi

# --- Check all domain services ---
echo ""
echo "[5/6] Checking domain services..."
SERVICES=("payments-service:3010" "general-service:3011" "diet-service:3012")
ALL_HEALTHY=true

for SVC in "${SERVICES[@]}"; do
    NAME="${SVC%%:*}"
    PORT="${SVC##*:}"
    SVC_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/health" 2>/dev/null || echo "000")

    if [ "$SVC_STATUS" = "200" ]; then
        echo "  ${NAME}: HEALTHY"
    else
        echo "  ${NAME}: UNHEALTHY (status: ${SVC_STATUS})"
        ALL_HEALTHY=false
    fi
done

if [ "$ALL_HEALTHY" = false ]; then
    echo ""
    echo "WARNING: Some domain services are unhealthy. Check logs:"
    echo "  docker compose -f $COMPOSE_FILE logs payments-service general-service diet-service"
fi

# --- Verify all containers ---
echo ""
echo "[6/6] Container status:"
docker compose -f "$COMPOSE_FILE" ps

# --- Check tunnel ---
echo ""
if systemctl is-active --quiet cloudflared-tunnel 2>/dev/null; then
    echo "Cloudflare Tunnel: RUNNING"
else
    echo "Cloudflare Tunnel: NOT RUNNING"
    echo "  Start with: sudo systemctl start cloudflared-tunnel"
fi

echo ""
echo "=========================================="
echo "  Deploy Complete!"
echo "=========================================="
echo "  Site:     https://oggy-v1.com"
echo "  Gateway:  curl http://localhost:3001/health"
echo "  Payments: curl http://localhost:3010/health"
echo "  General:  curl http://localhost:3011/health"
echo "  Diet:     curl http://localhost:3012/health"
echo ""
