#!/bin/bash

# Full Training and 7-Cycle Testing
# Creates 20 training expenses, verifies memory, runs 7 comprehensive test cycles

set -e

PAYMENTS_URL="http://localhost:3001"
MEMORY_URL="http://localhost:3000"
USER_ID="comprehensive_test_$(date +%s)"

echo "🧠 Comprehensive Oggy Training & 7-Cycle Testing"
echo "================================================="
echo ""
echo "User: $USER_ID"
echo "Training: 20 expenses"
echo "Test Cycles: 7"
echo ""

# Training expenses (diverse categories)
EXPENSES=(
    '{"merchant":"Pizza Palace","amount":45.50,"description":"Team lunch","category":"business_meal"}'
    '{"merchant":"Whole Foods","amount":85.00,"description":"Weekly groceries","category":"groceries"}'
    '{"merchant":"Starbucks","amount":12.50,"description":"Coffee meeting","category":"business_meal"}'
    '{"merchant":"The Steakhouse","amount":120.00,"description":"Client dinner","category":"business_meal"}'
    '{"merchant":"Shell Gas","amount":55.00,"description":"Gas fillup","category":"transportation"}'
    '{"merchant":"Netflix","amount":15.99,"description":"Monthly subscription","category":"entertainment"}'
    '{"merchant":"Spotify","amount":9.99,"description":"Music streaming","category":"entertainment"}'
    '{"merchant":"Electric Company","amount":125.00,"description":"Monthly bill","category":"utilities"}'
    '{"merchant":"LA Fitness","amount":49.99,"description":"Gym membership","category":"health"}'
    '{"merchant":"Amazon","amount":67.00,"description":"Online shopping","category":"shopping"}'
    '{"merchant":"AMC Theaters","amount":28.00,"description":"Movie tickets","category":"entertainment"}'
    '{"merchant":"Italian Bistro","amount":35.50,"description":"Dinner","category":"dining"}'
    '{"merchant":"CVS Pharmacy","amount":15.50,"description":"Prescription","category":"health"}'
    '{"merchant":"Comcast","amount":89.99,"description":"Internet bill","category":"utilities"}'
    '{"merchant":"Uber","amount":42.00,"description":"Ride to airport","category":"transportation"}'
    '{"merchant":"Safeway","amount":95.00,"description":"Grocery shopping","category":"groceries"}'
    '{"merchant":"Panera Bread","amount":18.50,"description":"Lunch","category":"dining"}'
    '{"merchant":"Fancy Restaurant","amount":150.00,"description":"Business dinner","category":"business_meal"}'
    '{"merchant":"Target","amount":32.00,"description":"Household items","category":"shopping"}'
    '{"merchant":"Chevron","amount":78.00,"description":"Gas station","category":"transportation"}'
)

echo "1️⃣  Creating 20 training expenses..."

success_count=0
for i in "${!EXPENSES[@]}"; do
    expense_json="${EXPENSES[$i]}"
    expected_category=$(echo "$expense_json" | grep -o '"category":"[^"]*"' | cut -d'"' -f4)
    merchant=$(echo "$expense_json" | grep -o '"merchant":"[^"]*"' | cut -d'"' -f4)
    amount=$(echo "$expense_json" | grep -o '"amount":[0-9.]*' | grep -o '[0-9.]*$')
    description=$(echo "$expense_json" | grep -o '"description":"[^"]*"' | cut -d'"' -f4)

    create_payload="{\"user_id\":\"$USER_ID\",\"merchant\":\"$merchant\",\"amount\":$amount,\"description\":\"$description\",\"transaction_date\":\"2026-03-$(printf "%02d" $((i+1)))\"}"
    expense_response=$(curl -s -X POST "$PAYMENTS_URL/v0/expenses" -H "Content-Type: application/json" -d "$create_payload")
    expense_id=$(echo "$expense_response" | grep -o '"expense_id":"[^"]*"' | cut -d'"' -f4)

    if [ -n "$expense_id" ]; then
        suggestion_response=$(curl -s -X POST "$PAYMENTS_URL/v0/categorization/suggest" -H "Content-Type: application/json" -d "{\"user_id\":\"$USER_ID\",\"expense_id\":\"$expense_id\",\"amount\":$amount,\"merchant\":\"$merchant\",\"description\":\"$description\",\"transaction_date\":\"2026-03-$(printf "%02d" $((i+1)))\"}")
        suggested_category=$(echo "$suggestion_response" | grep -o '"suggested_category":"[^"]*"' | cut -d'"' -f4)
        trace_id=$(echo "$suggestion_response" | grep -o '"trace_id":"[^"]*"' | cut -d'"' -f4)
        confidence=$(echo "$suggestion_response" | grep -o '"confidence":[0-9.]*' | grep -o '[0-9.]*$')

        if [ -n "$trace_id" ] && [ "$trace_id" != "null" ]; then
            if [ $((i % 4)) -eq 0 ]; then
                source="oggy_rejected"
                final_category="$expected_category"
            else
                source="oggy_accepted"
                final_category="$suggested_category"
            fi

            curl -s -X POST "$PAYMENTS_URL/v0/expenses/$expense_id/categorize" -H "Content-Type: application/json" -d "{\"category\":\"$final_category\",\"source\":\"$source\",\"suggestion_data\":{\"suggested_category\":\"$suggested_category\",\"trace_id\":\"$trace_id\",\"confidence\":$confidence}}" > /dev/null

            success_count=$((success_count + 1))
            echo "   ✓ $((i+1))/20: $merchant -> $final_category"
        fi
    fi
done

echo "✅ Created $success_count training expenses"

# Process events
echo ""
echo "2️⃣  Processing events and updating memory..."
sleep 2

process_response=$(curl -s -X POST "$PAYMENTS_URL/v0/process-events" -H "Content-Type: application/json" -d '{"limit":200}')
processed=$(echo "$process_response" | grep -o '"processed_count":[0-9]*' | grep -o '[0-9]*$')
echo "   Processed $processed events"

sleep 3

# Verify memory cards in database
card_count=$(docker exec oggy-postgres psql -U oggy -d oggy_db -t -c "SELECT COUNT(*) FROM memory_cards WHERE owner_id = '$USER_ID';" 2>/dev/null | tr -d ' ')

echo "   Memory cards created: $card_count"
echo "✅ Memory substrate updated"

# Run 7 test cycles
echo ""
echo "3️⃣  Running 7 test cycles..."
echo "============================================================"

results_file="/tmp/comprehensive_7cycles_$(date +%s).txt"
echo "Cycle,Oggy_Correct,Oggy_Pct,Base_Correct,Base_Pct,Delta,Verdict" > "$results_file"

total_oggy=0
total_base=0
oggy_wins=0
ties=0

for cycle in {1..7}; do
    echo ""
    echo "────────────────────────────────────────"
    echo "Cycle $cycle/7"
    echo "────────────────────────────────────────"

    result=$(curl -s -X POST "$PAYMENTS_URL/v0/evaluation/compare" -H "Content-Type: application/json" -d "{\"user_id\":\"$USER_ID\",\"benchmark_count\":20}")

    oggy_correct=$(echo "$result" | grep -o '"oggy":[^}]*"correct_count":[0-9]*' | grep -o '[0-9]*$')
    oggy_score=$(echo "$result" | grep -o '"oggy":[^}]*"average_score":[0-9.]*' | grep -o '[0-9.]*$')
    base_correct=$(echo "$result" | grep -o '"base":[^}]*"correct_count":[0-9]*' | grep -o '[0-9]*$')
    base_score=$(echo "$result" | grep -o '"base":[^}]*"average_score":[0-9.]*' | grep -o '[0-9.]*$')
    verdict=$(echo "$result" | grep -o '"verdict":"[^"]*"' | cut -d'"' -f4)

    # Simple percentage calculation
    oggy_pct=$(awk "BEGIN {printf \"%.0f\", $oggy_score * 100}")
    base_pct=$(awk "BEGIN {printf \"%.0f\", $base_score * 100}")
    delta=$(awk "BEGIN {if ($base_score > 0) printf \"%.1f\", (($oggy_score - $base_score) / $base_score) * 100; else print 0}")

    total_oggy=$((total_oggy + oggy_correct))
    total_base=$((total_base + base_correct))

    case "$verdict" in
        "OGGY_BETTER") oggy_wins=$((oggy_wins + 1)) ;;
        "TIE") ties=$((ties + 1)) ;;
    esac

    echo "Oggy:    $oggy_correct/20 (${oggy_pct}%)"
    echo "Base:    $base_correct/20 (${base_pct}%)"
    echo "Delta:   ${delta}%"
    echo "Verdict: $verdict"

    echo "$cycle,$oggy_correct,$oggy_pct,$base_correct,$base_pct,$delta,$verdict" >> "$results_file"

    sleep 2
done

# Final summary
echo ""
echo "============================================================"
echo "📊 FINAL RESULTS"
echo "============================================================"
echo ""
echo "Training Data:       $success_count expenses"
echo "Memory Cards:        $card_count"
echo "Test Cycles:         7"
echo "Total Assessments:   140 (7 × 20)"
echo ""
echo "AGGREGATE PERFORMANCE:"
echo "  Oggy Total:        $total_oggy/140 correct"
echo "  Base Total:        $total_base/140 correct"
echo "  Difference:        +$((total_oggy - total_base)) assessments"
if [ $total_base -gt 0 ]; then
    improvement=$(awk "BEGIN {printf \"%.1f\", (($total_oggy - $total_base) / $total_base) * 100}")
    echo "  Improvement:       +${improvement}%"
fi
echo ""
echo "VERDICT DISTRIBUTION:"
echo "  Oggy Better:       $oggy_wins/7 cycles"
echo "  Tie:               $ties/7 cycles"
echo ""
echo "✅ Testing complete!"
echo "📊 Results saved to: $results_file"
echo ""
