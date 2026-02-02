#!/bin/bash

# Proper Training Loop with Memory Updates
# Creates expenses WITHOUT categories, gets Oggy suggestions, provides feedback

set -e

PAYMENTS_URL="http://localhost:3001"
MEMORY_URL="http://localhost:3000"
USER_ID="test_user_training"

echo "🧠 Oggy Training Loop with Memory Updates"
echo "=========================================="
echo ""

# Training expenses WITHOUT categories (so Oggy will be asked for suggestions)
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

echo "1️⃣  Creating 20 expenses and training Oggy..."
echo ""

success_count=0
trace_count=0

for i in "${!EXPENSES[@]}"; do
    expense_json="${EXPENSES[$i]}"

    # Extract expected category for later validation
    expected_category=$(echo "$expense_json" | grep -o '"category":"[^"]*"' | cut -d'"' -f4)
    merchant=$(echo "$expense_json" | grep -o '"merchant":"[^"]*"' | cut -d'"' -f4)
    amount=$(echo "$expense_json" | grep -o '"amount":[0-9.]*' | grep -o '[0-9.]*$')
    description=$(echo "$expense_json" | grep -o '"description":"[^"]*"' | cut -d'"' -f4)

    # Create expense WITHOUT category first
    create_payload="{\"user_id\":\"$USER_ID\",\"merchant\":\"$merchant\",\"amount\":$amount,\"description\":\"$description\",\"transaction_date\":\"2026-03-$(printf "%02d" $((i+1)))\"}"

    expense_response=$(curl -s -X POST "$PAYMENTS_URL/v0/expenses" \
      -H "Content-Type: application/json" \
      -d "$create_payload")

    expense_id=$(echo "$expense_response" | grep -o '"expense_id":"[^"]*"' | cut -d'"' -f4)

    if [ -z "$expense_id" ]; then
        echo "   ✗ Failed to create expense $((i+1))"
        continue
    fi

    # Get Oggy's suggestion
    suggestion_response=$(curl -s -X POST "$PAYMENTS_URL/v0/categorization/suggest" \
      -H "Content-Type: application/json" \
      -d "{\"user_id\":\"$USER_ID\",\"expense_id\":\"$expense_id\",\"amount\":$amount,\"merchant\":\"$merchant\",\"description\":\"$description\",\"transaction_date\":\"2026-03-$(printf "%02d" $((i+1)))\"}")

    suggested_category=$(echo "$suggestion_response" | grep -o '"suggested_category":"[^"]*"' | cut -d'"' -f4)
    trace_id=$(echo "$suggestion_response" | grep -o '"trace_id":"[^"]*"' | cut -d'"' -f4)
    confidence=$(echo "$suggestion_response" | grep -o '"confidence":[0-9.]*' | grep -o '[0-9.]*$')

    if [ -z "$trace_id" ] || [ "$trace_id" = "null" ]; then
        echo "   ⚠️  No trace_id for expense $((i+1))"
        continue
    fi

    trace_count=$((trace_count + 1))

    # Decide whether to accept or reject (accept 75%, reject 25% for variety)
    if [ $((i % 4)) -eq 0 ]; then
        # Reject and use expected category
        source="oggy_rejected"
        final_category="$expected_category"
        action="rejected"
    else
        # Accept suggestion
        source="oggy_accepted"
        final_category="$suggested_category"
        action="accepted"
    fi

    # Apply categorization with feedback
    categorize_response=$(curl -s -X POST "$PAYMENTS_URL/v0/expenses/$expense_id/categorize" \
      -H "Content-Type: application/json" \
      -d "{\"category\":\"$final_category\",\"source\":\"$source\",\"suggestion_data\":{\"suggested_category\":\"$suggested_category\",\"trace_id\":\"$trace_id\",\"confidence\":$confidence}}")

    success_count=$((success_count + 1))
    echo "   ✓ Expense $((i+1))/20: $merchant -> $final_category ($action, trace: ${trace_id:0:8}...)"
done

echo ""
echo "✅ Created $success_count expenses with $trace_count trace_ids"

# Process events
echo ""
echo "2️⃣  Processing events to update memory..."

sleep 2

process_response=$(curl -s -X POST "$PAYMENTS_URL/v0/process-events" \
  -H "Content-Type: application/json" \
  -d '{"limit":100}')

processed=$(echo "$process_response" | grep -o '"processed_count":[0-9]*' | grep -o '[0-9]*$')
echo "   Processed $processed events"

sleep 3

echo "✅ Events processed"

# Verify memory cards
echo ""
echo "3️⃣  Verifying memory card updates..."

cards_response=$(curl -s "$MEMORY_URL/v0/cards?owner_id=$USER_ID&limit=50")
card_count=$(echo "$cards_response" | grep -o '"card_id"' | wc -l)

echo "   Memory cards found: $card_count"

if [ $card_count -gt 0 ]; then
    echo "   ✅ Memory cards created/updated successfully!"

    # Show sample card
    first_card=$(echo "$cards_response" | grep -o '"card_id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$first_card" ]; then
        echo "   Sample card: $first_card"
    fi
else
    echo "   ⚠️  No memory cards found"
fi

# Check audit log
audit_response=$(curl -s "$MEMORY_URL/v0/audit?owner_id=$USER_ID&limit=20")
audit_count=$(echo "$audit_response" | grep -o '"event_type"' | wc -l)

echo "   Memory audit events: $audit_count"

if [ $audit_count -gt 0 ]; then
    echo "   ✅ Memory audit trail verified"

    # Show recent actions
    update_count=$(echo "$audit_response" | grep -o '"UPDATE_CARD"' | wc -l)
    create_count=$(echo "$audit_response" | grep -o '"CREATE_CARD"' | wc -l)

    echo "   - Card creations: $create_count"
    echo "   - Card updates: $update_count"
fi

echo ""
echo "✅ Training loop complete!"
echo ""
echo "Summary:"
echo "  - Training expenses: $success_count"
echo "  - Trace IDs generated: $trace_count"
echo "  - Memory cards: $card_count"
echo "  - Audit events: $audit_count"
echo ""
