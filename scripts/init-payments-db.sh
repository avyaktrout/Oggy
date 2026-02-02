#!/bin/bash

# Initialize Payments Database Schema
# Run this script after docker-compose up to initialize payments tables

set -e

echo "🔧 Initializing Payments Database Schema..."

# Database connection details
DB_HOST=${POSTGRES_HOST:-localhost}
DB_PORT=${POSTGRES_PORT:-5432}
DB_NAME=${POSTGRES_DB:-oggy_db}
DB_USER=${POSTGRES_USER:-oggy}

export PGPASSWORD=${POSTGRES_PASSWORD:-oggy_dev_password}

# Wait for postgres
echo "⏳ Waiting for PostgreSQL..."
until pg_isready -h $DB_HOST -p $DB_PORT -U $DB_USER > /dev/null 2>&1; do
    sleep 1
done

echo "✅ PostgreSQL is ready"

# Apply schema files in order
SCHEMA_DIR="./services/payments/db/init"

for sql_file in $(ls -1 $SCHEMA_DIR/*.sql | sort); do
    echo "📝 Applying: $(basename $sql_file)"
    psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f "$sql_file"
done

echo "✅ Payments database schema initialized successfully!"
echo ""
echo "📊 Tables created:"
echo "   - expenses"
echo "   - app_events"
echo "   - domain_knowledge"
echo "   - knowledge_promotions"
echo ""
echo "🎯 Ready to test payments application!"
