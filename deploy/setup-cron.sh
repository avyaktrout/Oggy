#!/bin/bash
# ==============================================================================
# Setup Cron Jobs for Oggy EC2
# Installs nightly backup and weekly Docker cleanup cron jobs.
#
# Usage: sudo ./deploy/setup-cron.sh
# ==============================================================================

set -euo pipefail

OGGY_DIR="/opt/oggy"

echo "Setting up Oggy cron jobs..."

# Create crontab for oggy user
CRON_CONTENT=$(cat <<'CRONEOF'
# Oggy Automated Tasks
# Nightly Postgres backup to S3 at 3:00 AM UTC
0 3 * * * /opt/oggy/deploy/backup-postgres.sh >> /var/log/oggy-backup.log 2>&1

# Weekly Docker cleanup (prune old images) — Sunday 4:00 AM UTC
0 4 * * 0 docker image prune -af --filter "until=168h" >> /var/log/oggy-cleanup.log 2>&1

# Rotate backup log monthly
0 0 1 * * truncate -s 0 /var/log/oggy-backup.log 2>/dev/null; truncate -s 0 /var/log/oggy-cleanup.log 2>/dev/null
CRONEOF
)

echo "$CRON_CONTENT" | crontab -u oggy -

# Create log files
touch /var/log/oggy-backup.log /var/log/oggy-cleanup.log
chown oggy:oggy /var/log/oggy-backup.log /var/log/oggy-cleanup.log

echo "Cron jobs installed for user 'oggy':"
crontab -u oggy -l
echo ""
echo "Done."
