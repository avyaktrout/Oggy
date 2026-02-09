#!/bin/bash
# ==============================================================================
# Oggy PostgreSQL Backup to S3
# Creates a compressed pg_dump and uploads to S3 with 30-day retention.
#
# Prerequisites:
#   - AWS CLI configured: aws configure (set access key, secret, region)
#   - S3 bucket created: aws s3 mb s3://oggy-backups
#   - Set lifecycle rule: aws s3api put-bucket-lifecycle-configuration \
#       --bucket oggy-backups \
#       --lifecycle-configuration '{"Rules":[{"ID":"expire-30d","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":30}}]}'
#
# Usage:
#   Manual:  ./deploy/backup-postgres.sh
#   Cron:    0 3 * * * /opt/oggy/deploy/backup-postgres.sh >> /var/log/oggy-backup.log 2>&1
# ==============================================================================

set -euo pipefail

OGGY_DIR="/opt/oggy"
ENV_FILE="$OGGY_DIR/.env"
S3_BUCKET="${S3_BACKUP_BUCKET:-oggy-backups}"
BACKUP_DIR="/tmp/oggy-backups"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_FILE="oggy_db_${TIMESTAMP}.sql.gz"

# Load DB credentials from .env
if [ -f "$ENV_FILE" ]; then
    export $(grep -E '^(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)=' "$ENV_FILE" | xargs)
fi

POSTGRES_USER="${POSTGRES_USER:-oggy}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-oggy_dev_password}"
POSTGRES_DB="${POSTGRES_DB:-oggy_db}"

echo "[$(date)] Starting Oggy database backup..."

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Dump database from Docker container
echo "  Dumping ${POSTGRES_DB}..."
docker exec oggy-postgres pg_dump \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    --no-owner \
    --no-privileges \
    --format=plain \
    | gzip > "${BACKUP_DIR}/${BACKUP_FILE}"

FILESIZE=$(du -h "${BACKUP_DIR}/${BACKUP_FILE}" | cut -f1)
echo "  Backup created: ${BACKUP_FILE} (${FILESIZE})"

# Upload to S3
echo "  Uploading to s3://${S3_BUCKET}/postgres/${BACKUP_FILE}..."
aws s3 cp \
    "${BACKUP_DIR}/${BACKUP_FILE}" \
    "s3://${S3_BUCKET}/postgres/${BACKUP_FILE}" \
    --storage-class STANDARD_IA \
    --quiet

echo "  Upload complete."

# Cleanup local backup
rm -f "${BACKUP_DIR}/${BACKUP_FILE}"

# Keep only last 3 local backups (if any linger)
find "$BACKUP_DIR" -name "oggy_db_*.sql.gz" -mtime +3 -delete 2>/dev/null || true

echo "[$(date)] Backup complete: s3://${S3_BUCKET}/postgres/${BACKUP_FILE}"
