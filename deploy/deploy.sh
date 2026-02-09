#!/bin/bash
# ==============================================================================
# Oggy Deployment Script for EC2
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
echo "[1/5] Pulling latest code..."
git pull --ff-only origin main

# --- Backup database before deploy ---
echo ""
echo "[2/5] Backing up database..."
if command -v aws &> /dev/null && aws sts get-caller-identity &> /dev/null; then
    ./deploy/backup-postgres.sh || echo "WARNING: Backup failed, continuing deploy..."
else
    echo "  Skipping S3 backup (AWS not configured). Taking local backup..."
    docker exec oggy-postgres pg_dump -U oggy oggy_db | gzip > /tmp/oggy-pre-deploy-$(date +%s).sql.gz 2>/dev/null || echo "  No running DB to backup (first deploy?)."
fi

# --- Build and deploy ---
echo ""
echo "[3/5] Building and deploying containers..."
docker compose -f "$COMPOSE_FILE" build --no-cache
docker compose -f "$COMPOSE_FILE" up -d

# --- Wait for health ---
echo ""
echo "[4/5] Waiting for services to be healthy..."
MAX_WAIT=60
WAITED=0

while [ $WAITED -lt $MAX_WAIT ]; do
    # Check payments-service health
    HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/health 2>/dev/null || echo "000")

    if [ "$HTTP_STATUS" = "200" ]; then
        echo "  payments-service healthy (${WAITED}s)"
        break
    fi

    echo "  Waiting... (${WAITED}s, status: ${HTTP_STATUS})"
    sleep 5
    WAITED=$((WAITED + 5))
done

if [ "$HTTP_STATUS" != "200" ]; then
    echo ""
    echo "ERROR: payments-service failed health check after ${MAX_WAIT}s"
    echo "Check logs: docker compose -f $COMPOSE_FILE logs payments-service"
    exit 1
fi

# --- Verify all containers ---
echo ""
echo "[5/5] Container status:"
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
echo "  Site: https://oggy-v1.com"
echo "  Health: curl http://localhost:3001/health"
echo ""
