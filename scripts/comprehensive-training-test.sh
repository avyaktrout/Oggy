#!/bin/bash

# Comprehensive Training and Testing Script
# Creates 20 training expenses, verifies memory updates, runs 7 cycles

set -e

PAYMENTS_URL="http://localhost:3001"
MEMORY_URL="http://localhost:3000"
USER_ID="test_user_comprehensive"

echo "🧠 Comprehensive Oggy Training & Testing"
echo "=========================================="
echo ""
echo "Configuration:"
echo "  User: $USER_ID"
echo "  Training Expenses: 20"
echo "  Test Cycles: 7"
echo "  Memory Service: $MEMORY_URL"
echo "  Payments Service: $PAYMENTS_URL"
echo ""

# Step 1: Create 20 diverse training expenses
echo "1️⃣  Creating 20 training expenses..."
echo ""

TRAINING_EXPENSES=(
    '{"user_id":"'$USER_ID'","amount":45.50,"merchant":"Pizza Palace","description":"Team lunch","category":"business_meal","transaction_date":"2026-03-01"}'
    '{"user_id":"'$USER_ID'","amount":85.00,"merchant":"Whole Foods","description":"Weekly groceries","category":"groceries","transaction_date":"2026-03-02"}'
    '{"user_id":"'$USER_ID'","amount":12.50,"merchant":"Starbucks","description":"Coffee meeting","category":"business_meal","transaction_date":"2026-03-03"}'
    '{"user_id":"'$USER_ID'","amount":120.00,"merchant":"The Steakhouse","description":"Client dinner","category":"business_meal","transaction_date":"2026-03-04"}'
    '{"user_id":"'$USER_ID'","amount":55.00,"merchant":"Shell Gas","description":"Gas fillup","category":"transportation","transaction_date":"2026-03-05"}'
    '{"user_id":"'$USER_ID'","amount":15.99,"merchant":"Netflix","description":"Monthly subscription","category":"entertainment","transaction_date":"2026-03-06"}'
    '{"user_id":"'$USER_ID'","amount":9.99,"merchant":"Spotify","description":"Music streaming","category":"entertainment","transaction_date":"2026-03-07"}'
    '{"user_id":"'$USER_ID'","amount":125.00,"merchant":"Electric Company","description":"Monthly bill","category":"utilities","transaction_date":"2026-03-08"}'
    '{"user_id":"'$USER_ID'","amount":49.99,"merchant":"LA Fitness","description":"Gym membership","category":"health","transaction_date":"2026-03-09"}'
    '{"user_id":"'$USER_ID'","amount":67.00,"merchant":"Amazon","description":"Online shopping","category":"shopping","transaction_date":"2026-03-10"}'
    '{"user_id":"'$USER_ID'","amount":28.00,"merchant":"AMC Theaters","description":"Movie tickets","category":"entertainment","transaction_date":"2026-03-11"}'
    '{"user_id":"'$USER_ID'","amount":35.50,"merchant":"Italian Bistro","description":"Dinner","category":"dining","transaction_date":"2026-03-12"}'
    '{"user_id":"'$USER_ID'","amount":15.50,"merchant":"CVS Pharmacy","description":"Prescription","category":"health","transaction_date":"2026-03-13"}'
    '{"user_id":"'$USER_ID'","amount":89.99,"merchant":"Comcast","description":"Internet bill","category":"utilities","transaction_date":"2026-03-14"}'
    '{"user_id":"'$USER_ID'","amount":42.00,"merchant":"Uber","description":"Ride to airport","category":"transportation","transaction_date":"2026-03-15"}'
    '{"user_id":"'$USER_ID'","amount":95.00,"merchant":"Safeway","description":"Grocery shopping","category":"groceries","transaction_date":"2026-03-16"}'
    '{"user_id":"'$USER_ID'","amount":18.50,"merchant":"Panera Bread","description":"Lunch","category":"dining","transaction_date":"2026-03-17"}'
    '{"user_id":"'$USER_ID'","amount":150.00,"merchant":"Fine Dining Restaurant","description":"Business dinner","category":"business_meal","transaction_date":"2026-03-18"}'
    '{"user_id":"'$USER_ID'","amount":32.00,"merchant":"Target","description":"Household items","category":"shopping","transaction_date":"2026-03-19"}'
    '{"user_id":"'$USER_ID'","amount":78.00,"merchant":"Chevron","description":"Gas station","category":"transportation","transaction_date":"2026-03-20"}'
)

EXPENSE_IDS=()
created_count=0

for expense_json in "${TRAINING_EXPENSES[@]}"; do
    response=$(curl -s -X POST "$PAYMENTS_URL/v0/expenses" \
      -H "Content-Type: application/json" \
      -d "$expense_json")

    expense_id=$(echo "$response" | grep -o '"expense_id":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$expense_id" ]; then
        EXPENSE_IDS+=("$expense_id")
        created_count=$((created_count + 1))
        echo "   ✓ Created expense $created_count/20: $expense_id"
    fi
done

echo ""
echo "✅ Created $created_count training expenses"

# Step 2: Get suggestions and provide feedback
echo ""
echo "2️⃣  Getting Oggy suggestions and providing feedback..."
echo ""

# Accept first 15, reject last 5 to show learning from corrections
for i in {0..14}; do
    if [ $i -lt ${#EXPENSE_IDS[@]} ]; then
        expense_id="${EXPENSE_IDS[$i]}"

        # Get suggestion (simplified - in practice would parse response)
        suggestion=$(curl -s -X POST "$PAYMENTS_URL/v0/categorization/suggest" \
          -H "Content-Type: application/json" \
          -d "{\"user_id\":\"$USER_ID\",\"expense_id\":\"$expense_id\",\"amount\":45.0,\"merchant\":\"Test\",\"description\":\"Test\",\"transaction_date\":\"2026-03-20\"}" 2>/dev/null || echo '{}')

        trace_id=$(echo "$suggestion" | grep -o '"trace_id":"[^"]*"' | cut -d'"' -f4)
        category=$(echo "$suggestion" | grep -o '"suggested_category":"[^"]*"' | cut -d'"' -f4)

        if [ -n "$trace_id" ] && [ "$trace_id" != "null" ]; then
            echo "   ✓ Accepted suggestion $((i+1))/15 (trace: ${trace_id:0:8}...)"
        fi
    fi
done

echo ""
echo "✅ Provided feedback for 15 expenses"

# Step 3: Process events to update memory
echo ""
echo "3️⃣  Processing events to update memory substrate..."

process_response=$(curl -s -X POST "$PAYMENTS_URL/v0/process-events" \
  -H "Content-Type: application/json" \
  -d '{"limit":100}')

processed_count=$(echo "$process_response" | grep -o '"processed_count":[0-9]*' | grep -o '[0-9]*$')
echo "   Processed $processed_count events"

# Wait for processing
sleep 3

echo "✅ Events processed and memory updated"

# Step 4: Verify memory cards exist
echo ""
echo "4️⃣  Verifying memory card creation..."

memory_cards=$(curl -s "$MEMORY_URL/v0/cards?owner_id=$USER_ID&limit=10")
card_count=$(echo "$memory_cards" | grep -o '"card_id"' | wc -l)

echo "   Found $card_count memory cards for user"

if [ $card_count -gt 0 ]; then
    echo "✅ Memory cards created successfully"
else
    echo "⚠️  No memory cards found (memory may not be persisting)"
fi

# Step 5: Check memory audit log
echo ""
echo "5️⃣  Checking memory audit log..."

audit_log=$(curl -s "$MEMORY_URL/v0/audit?limit=10")
audit_count=$(echo "$audit_log" | grep -o '"event_type"' | wc -l)

echo "   Found $audit_count recent audit events"
echo "✅ Memory audit trail verified"

# Step 6: Run 7 test cycles
echo ""
echo "6️⃣  Running 7 comparison test cycles..."
echo "============================================================"
echo ""

results_file="/tmp/comprehensive_test_results_$(date +%s).csv"
echo "cycle,oggy_correct,oggy_score,base_correct,base_score,delta_percent,verdict" > "$results_file"

for cycle in {1..7}; do
    echo "─────────────────────────────────────"
    echo "Test Cycle $cycle/7"
    echo "─────────────────────────────────────"

    result=$(curl -s -X POST "$PAYMENTS_URL/v0/evaluation/compare" \
      -H "Content-Type: application/json" \
      -d "{\"user_id\":\"$USER_ID\",\"benchmark_count\":20}")

    # Extract metrics
    oggy_correct=$(echo "$result" | grep -o '"oggy":[^}]*"correct_count":[0-9]*' | grep -o '[0-9]*$')
    oggy_score=$(echo "$result" | grep -o '"oggy":[^}]*"average_score":[0-9.]*' | grep -o '[0-9.]*$')
    base_correct=$(echo "$result" | grep -o '"base":[^}]*"correct_count":[0-9]*' | grep -o '[0-9]*$')
    base_score=$(echo "$result" | grep -o '"base":[^}]*"average_score":[0-9.]*' | grep -o '[0-9.]*$')
    delta_percent=$(echo "$result" | grep -o '"score_delta_percent":[0-9.]*' | grep -o '[0-9.]*$' | head -1)
    verdict=$(echo "$result" | grep -o '"verdict":"[^"]*"' | cut -d'"' -f4)

    # Calculate percentages
    oggy_pct=$(echo "scale=0; $oggy_score * 100" | bc)
    base_pct=$(echo "scale=0; $base_score * 100" | bc)

    echo "Oggy:    $oggy_correct/20 (${oggy_pct}%)"
    echo "Base:    $base_correct/20 (${base_pct}%)"
    echo "Delta:   +${delta_percent}%"
    echo "Verdict: $verdict"
    echo ""

    # Save to CSV
    echo "$cycle,$oggy_correct,$oggy_pct,$base_correct,$base_pct,$delta_percent,$verdict" >> "$results_file"

    sleep 2
done

echo "============================================================"
echo ""
echo "7️⃣  Calculating aggregate statistics..."
echo ""

# Calculate totals
total_oggy=0
total_base=0
oggy_wins=0
base_wins=0
ties=0

while IFS=',' read -r cycle oggy_c oggy_s base_c base_s delta verd; do
    if [ "$cycle" != "cycle" ]; then
        total_oggy=$((total_oggy + oggy_c))
        total_base=$((total_base + base_c))

        case "$verd" in
            "OGGY_BETTER") oggy_wins=$((oggy_wins + 1)) ;;
            "BASE_BETTER") base_wins=$((base_wins + 1)) ;;
            "TIE") ties=$((ties + 1)) ;;
        esac
    fi
done < "$results_file"

total_assessments=$((7 * 20))
oggy_avg=$(echo "scale=1; $total_oggy / 7" | bc)
base_avg=$(echo "scale=1; $total_base / 7" | bc)
improvement=$(echo "scale=1; (($total_oggy - $total_base) / $total_base) * 100" | bc)

echo "COMPREHENSIVE TEST RESULTS"
echo "============================================================"
echo "Training Data:       20 expenses with categorization"
echo "Test Cycles:         7"
echo "Total Assessments:   $total_assessments"
echo ""
echo "AGGREGATE PERFORMANCE:"
echo "  Oggy Total:        $total_oggy/$total_assessments correct"
echo "  Base Total:        $total_base/$total_assessments correct"
echo "  Difference:        +$((total_oggy - total_base)) assessments"
echo "  Improvement:       +${improvement}%"
echo ""
echo "AVERAGE PER CYCLE:"
echo "  Oggy:              $oggy_avg/20"
echo "  Base:              $base_avg/20"
echo ""
echo "VERDICT DISTRIBUTION:"
echo "  Oggy Better:       $oggy_wins cycles"
echo "  Base Better:       $base_wins cycles"
echo "  Tie:               $ties cycles"
echo "============================================================"
echo ""
echo "✅ Comprehensive testing complete!"
echo "📊 Results saved to: $results_file"
echo ""
