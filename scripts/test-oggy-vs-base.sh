#!/bin/bash

# Test Oggy vs Base Agent on Tessa Assessments
# Week 6: Demonstrate continuous learning improvement

set -e

echo "🧪 Testing Oggy vs Base Agent - Week 6"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PAYMENTS_URL="http://localhost:3001"
USER_ID="test_user_week6"
BENCHMARK_COUNT=20

echo "📋 Test Configuration:"
echo "   User ID: $USER_ID"
echo "   Benchmark Count: $BENCHMARK_COUNT"
echo "   Payments Service: $PAYMENTS_URL"
echo ""

# Step 1: Check service health
echo "1️⃣  Checking service health..."
if curl -s "$PAYMENTS_URL/health" > /dev/null; then
    echo -e "${GREEN}✓${NC} Payments service is running"
else
    echo -e "❌ Payments service is NOT running"
    echo "   Run: docker-compose up -d payments-service"
    exit 1
fi

# Step 2: Create some training data for Oggy
echo ""
echo "2️⃣  Creating training data for Oggy..."

# Create expenses with correct categories (to train Oggy's memory)
TRAINING_EXPENSES=(
    '{"user_id":"'$USER_ID'","amount":45.50,"merchant":"Pizza Palace","description":"Team lunch","category":"business_meal","transaction_date":"2026-03-01"}'
    '{"user_id":"'$USER_ID'","amount":85.00,"merchant":"Whole Foods","description":"Weekly groceries","category":"groceries","transaction_date":"2026-03-02"}'
    '{"user_id":"'$USER_ID'","amount":12.50,"merchant":"Starbucks","description":"Morning coffee meeting","category":"business_meal","transaction_date":"2026-03-03"}'
    '{"user_id":"'$USER_ID'","amount":120.00,"merchant":"The Steakhouse","description":"Client dinner","category":"business_meal","transaction_date":"2026-03-04"}'
    '{"user_id":"'$USER_ID'","amount":55.00,"merchant":"Shell Gas","description":"Gas fillup","category":"transportation","transaction_date":"2026-03-05"}'
)

EXPENSE_IDS=()

for expense_json in "${TRAINING_EXPENSES[@]}"; do
    response=$(curl -s -X POST "$PAYMENTS_URL/v0/expenses" \
      -H "Content-Type: application/json" \
      -d "$expense_json")

    expense_id=$(echo "$response" | jq -r '.expense_id')
    EXPENSE_IDS+=("$expense_id")
    echo -e "   Created expense: $expense_id"
done

echo -e "${GREEN}✓${NC} Created ${#EXPENSE_IDS[@]} training expenses"

# Step 3: Get Oggy suggestions and accept them (to build memory)
echo ""
echo "3️⃣  Building Oggy's memory through user feedback..."

sleep 1

# Simulate getting suggestions and accepting them for a few expenses
for i in {0..2}; do
    expense_id="${EXPENSE_IDS[$i]}"

    # Get suggestion
    suggestion=$(curl -s -X POST "$PAYMENTS_URL/v0/categorization/suggest" \
      -H "Content-Type: application/json" \
      -d "{\"user_id\":\"$USER_ID\",\"expense_id\":\"$expense_id\",\"amount\":45.0,\"merchant\":\"Test\",\"description\":\"Test\",\"transaction_date\":\"2026-03-05\"}")

    trace_id=$(echo "$suggestion" | jq -r '.trace_id')
    category=$(echo "$suggestion" | jq -r '.suggested_category')

    if [ "$trace_id" != "null" ]; then
        echo -e "   Suggestion for expense $((i+1)): $category (trace: ${trace_id:0:8}...)"
    fi
done

echo -e "${GREEN}✓${NC} Memory building complete"

# Step 4: Process events to update memory
echo ""
echo "4️⃣  Processing events to update memory substrate..."

process_response=$(curl -s -X POST "$PAYMENTS_URL/v0/process-events" \
  -H "Content-Type: application/json" \
  -d '{"limit":100}')

processed_count=$(echo "$process_response" | jq -r '.processed_count')
echo -e "${GREEN}✓${NC} Processed $processed_count events"

# Wait a moment for processing
sleep 2

# Step 5: Run the comparison
echo ""
echo "5️⃣  Running Oggy vs Base comparison..."
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

comparison_response=$(curl -s -X POST "$PAYMENTS_URL/v0/evaluation/compare" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$USER_ID\",\"benchmark_count\":$BENCHMARK_COUNT}")

# Check if comparison succeeded
if echo "$comparison_response" | jq -e '.error' > /dev/null 2>&1; then
    echo -e "❌ Comparison failed:"
    echo "$comparison_response" | jq -r '.error'
    exit 1
fi

# Display the report
report=$(echo "$comparison_response" | jq -r '.report')
echo "$report"

# Extract key metrics
benchmark_id=$(echo "$comparison_response" | jq -r '.benchmark_id')
oggy_score=$(echo "$comparison_response" | jq -r '.comparison.oggy.average_score * 100' | awk '{printf "%.1f", $1}')
base_score=$(echo "$comparison_response" | jq -r '.comparison.base.average_score * 100' | awk '{printf "%.1f", $1}')
delta=$(echo "$comparison_response" | jq -r '.comparison.delta.score_delta * 100' | awk '{printf "%.1f", $1}')
verdict=$(echo "$comparison_response" | jq -r '.comparison.verdict')

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "📊 Summary:"
echo "   Benchmark ID: $benchmark_id"
echo "   Oggy Score:   ${oggy_score}%"
echo "   Base Score:   ${base_score}%"
echo "   Delta:        ${delta}%"
echo ""

if [ "$verdict" = "OGGY_BETTER" ]; then
    echo -e "${GREEN}✅ Result: OGGY WINS!${NC}"
    echo -e "${GREEN}   Continuous learning provides measurable improvement!${NC}"
elif [ "$verdict" = "BASE_BETTER" ]; then
    echo -e "${YELLOW}⚠️  Result: BASE WINS${NC}"
    echo -e "${YELLOW}   Note: Memory may need more training data${NC}"
else
    echo -e "🤝 Result: TIE"
    echo "   Both agents perform equally on this benchmark"
fi

echo ""
echo "For detailed results:"
echo "  curl -s $PAYMENTS_URL/v0/evaluation/compare -d '{\"user_id\":\"$USER_ID\",\"benchmark_count\":$BENCHMARK_COUNT}' | jq '.comparison'"
echo ""

# Save results to file
echo "$comparison_response" | jq '.' > "evaluation-results-$(date +%Y%m%d-%H%M%S).json"
echo -e "${GREEN}✓${NC} Results saved to evaluation-results-*.json"

echo ""
echo -e "${GREEN}🎉 Week 6 Evaluation Complete!${NC}"
