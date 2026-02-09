#!/bin/bash
# ==============================================================================
# Oggy PostgreSQL Restore from S3
# Downloads a backup from S3 and restores it to the running Postgres container.
#
# Usage:
#   List backups:  ./deploy/restore-postgres.sh --list
#   Restore latest: ./deploy/restore-postgres.sh
#   Restore specific: ./deploy/restore-postgres.sh oggy_db_2026-02-08_030000.sql.gz
# ==============================================================================

set -euo pipefail

OGGY_DIR="/opt/oggy"
ENV_FILE="$OGGY_DIR/.env"
S3_BUCKET="${S3_BACKUP_BUCKET:-oggy-backups}"

# Load DB credentials from .env
if [ -f "$ENV_FILE" ]; then
    export $(grep -E '^(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)=' "$ENV_FILE" | xargs)
fi

POSTGRES_USER="${POSTGRES_USER:-oggy}"
POSTGRES_DB="${POSTGRES_DB:-oggy_db}"

# List mode
if [ "${1:-}" = "--list" ]; then
    echo "Available backups in s3://${S3_BUCKET}/postgres/:"
    aws s3 ls "s3://${S3_BUCKET}/postgres/" | sort -r | head -20
    exit 0
fi

# Determine backup file
if [ -n "${1:-}" ]; then
    BACKUP_FILE="$1"
else
    echo "Finding latest backup..."
    BACKUP_FILE=$(aws s3 ls "s3://${S3_BUCKET}/postgres/" | sort -r | head -1 | awk '{print $4}')
    if [ -z "$BACKUP_FILE" ]; then
        echo "ERROR: No backups found in s3://${S3_BUCKET}/postgres/"
        exit 1
    fi
fi

echo "Restoring from: ${BACKUP_FILE}"
echo ""
echo "WARNING: This will DROP and recreate the ${POSTGRES_DB} database."
read -p "Continue? (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted."
    exit 0
fi

# Download
echo "Downloading from S3..."
aws s3 cp "s3://${S3_BUCKET}/postgres/${BACKUP_FILE}" /tmp/oggy-restore.sql.gz

# Stop services that use the DB
echo "Stopping application services..."
cd "$OGGY_DIR"
docker compose -f docker-compose.staging.yml stop payments-service memory-service learning-service 2>/dev/null || true

# Restore
echo "Restoring database..."
gunzip -c /tmp/oggy-restore.sql.gz | docker exec -i oggy-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" --quiet

# Restart services
echo "Restarting services..."
docker compose -f docker-compose.staging.yml up -d

# Cleanup
rm -f /tmp/oggy-restore.sql.gz

echo ""
echo "Restore complete from: ${BACKUP_FILE}"
echo "Verify: curl http://localhost:3001/health"
