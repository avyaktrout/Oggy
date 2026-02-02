# Oggy Project Makefile
# Common commands for development and operations
# Week 7: Developer tools for multi-day operation without babysitting

.PHONY: help up down restart logs health audit test clean

# Default target
help:
	@echo "Oggy Project - Common Commands"
	@echo "==============================="
	@echo ""
	@echo "Development:"
	@echo "  make up          - Start all services"
	@echo "  make down        - Stop all services"
	@echo "  make restart     - Restart all services"
	@echo "  make logs        - View service logs (tail -f)"
	@echo "  make logs-pay    - View payments service logs"
	@echo "  make logs-mem    - View memory service logs"
	@echo ""
	@echo "Health & Monitoring:"
	@echo "  make health      - Check service health"
	@echo "  make audit       - Run audit checks"
	@echo "  make audit-full  - Run full audit with detailed report"
	@echo "  make budget      - Check token budget status"
	@echo ""
	@echo "Operations:"
	@echo "  make process-events  - Manually trigger event processing"
	@echo "  make db-shell    - Open PostgreSQL shell"
	@echo "  make test-cycle  - Run a single test cycle"
	@echo ""
	@echo "Cleanup:"
	@echo "  make clean       - Remove logs and temporary files"
	@echo "  make reset-db    - Reset databases (DESTRUCTIVE)"
	@echo ""

# Start all services
up:
	@echo "🚀 Starting Oggy services..."
	docker-compose up -d
	@echo "✅ Services started"
	@make health

# Stop all services
down:
	@echo "🛑 Stopping Oggy services..."
	docker-compose down
	@echo "✅ Services stopped"

# Restart all services
restart:
	@echo "🔄 Restarting Oggy services..."
	docker-compose restart
	@sleep 3
	@make health

# View logs (all services)
logs:
	@echo "📊 Viewing logs (Ctrl+C to exit)..."
	docker-compose logs -f --tail=50

# View payments service logs
logs-pay:
	@echo "📊 Viewing payments service logs..."
	docker logs oggy-payments-service -f --tail=100

# View memory service logs
logs-mem:
	@echo "📊 Viewing memory service logs..."
	docker logs oggy-memory-service -f --tail=100

# Check service health
health:
	@echo "🏥 Checking service health..."
	@echo ""
	@echo "Payments Service:"
	@curl -s http://localhost:3001/health | python -m json.tool 2>/dev/null || curl -s http://localhost:3001/health
	@echo ""
	@echo ""
	@echo "Memory Service:"
	@curl -s http://localhost:3000/health | python -m json.tool 2>/dev/null || curl -s http://localhost:3000/health
	@echo ""

# Run quick audit
audit:
	@echo "🔍 Running quick audit check..."
	@curl -s http://localhost:3001/v0/audit/quick | python -m json.tool 2>/dev/null || curl -s http://localhost:3001/v0/audit/quick
	@echo ""

# Run full audit
audit-full:
	@echo "🔍 Running full audit check..."
	@curl -s http://localhost:3001/v0/audit/full | python -m json.tool 2>/dev/null || curl -s http://localhost:3001/v0/audit/full
	@echo ""

# Check token budget
budget:
	@echo "💰 Token budget status:"
	@curl -s http://localhost:3001/health | python -c "import sys, json; data=json.load(sys.stdin); print(json.dumps(data.get('tokenBudget', {}), indent=2))" 2>/dev/null || echo "Could not retrieve budget info"
	@echo ""

# Manually trigger event processing
process-events:
	@echo "⚙️  Triggering event processing..."
	@curl -s -X POST http://localhost:3001/v0/process-events -H "Content-Type: application/json" -d '{"limit":100}' | python -m json.tool 2>/dev/null || curl -s -X POST http://localhost:3001/v0/process-events -H "Content-Type: application/json" -d '{"limit":100}'
	@echo ""

# Open PostgreSQL shell (payments DB)
db-shell:
	@echo "🗄️  Opening PostgreSQL shell..."
	docker exec -it oggy-postgres psql -U oggy -d oggy_db

# Run a single test cycle
test-cycle:
	@echo "🧪 Running test cycle..."
	@bash scripts/single-cycle-test.sh

# Clean temporary files
clean:
	@echo "🧹 Cleaning temporary files..."
	@rm -f /tmp/comprehensive_*.txt
	@rm -f /tmp/oggy_*.log
	@echo "✅ Cleanup complete"

# Reset databases (DESTRUCTIVE)
reset-db:
	@echo "⚠️  WARNING: This will delete all data!"
	@echo "Press Ctrl+C to cancel, Enter to continue..."
	@read confirm
	@echo "🗑️  Resetting databases..."
	docker-compose down -v
	docker-compose up -d
	@sleep 5
	@make health
	@echo "✅ Databases reset"

# Development helpers
install-deps:
	@echo "📦 Installing dependencies..."
	docker exec oggy-payments-service npm install
	docker exec oggy-memory-service npm install
	@echo "✅ Dependencies installed"

# View circuit breaker status
status:
	@echo "📊 System Status"
	@echo "==============="
	@echo ""
	@make health
	@echo ""
	@make audit
	@echo ""
	@make budget

# Watch logs with filtering
watch-errors:
	@echo "🔴 Watching for errors..."
	docker-compose logs -f | grep -i "error\|fail\|exception"

watch-warnings:
	@echo "🟡 Watching for warnings..."
	docker-compose logs -f | grep -i "warn\|budget"
