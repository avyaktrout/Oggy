#!/bin/bash

echo "=========================================="
echo "INTENSIVE TRAINING TEST - 5 CYCLES"
echo "=========================================="
echo ""

ALL_RESULTS=""
TOTAL_BENCHMARKS=0
TOTAL_PASSED=0
TOTAL_OGGY_WINS=0
CIRCUIT_BREAKER_ISSUES=0

for CYCLE in 1 2 3 4 5; do
    echo "=========================================="
    echo "CYCLE $CYCLE OF 5"
    echo "=========================================="
    
    if [ $CYCLE -gt 1 ]; then
        echo "Starting cycle $CYCLE..."
        curl -s -X POST http://localhost:3001/v0/continuous-learning/start \
            -H "Content-Type: application/json" \
            -d '{"user_id": "test-user-123", "duration_minutes": 5, "run_benchmarks": true}'
        echo ""
    fi
    
    echo "Waiting for training to complete..."
    
    # Wait for training phase (5 minutes) plus benchmark time
    WAITED=0
    MAX_WAIT=720  # 12 minutes max per cycle
    
    while [ $WAITED -lt $MAX_WAIT ]; do
        sleep 15
        WAITED=$((WAITED + 15))
        
        STATUS=$(curl -s http://localhost:3001/v0/continuous-learning/status)
        IS_RUNNING=$(echo "$STATUS" | grep -o '"is_running":[^,]*' | cut -d':' -f2)
        
        if [ "$IS_RUNNING" = "false" ]; then
            echo ""
            echo "Cycle $CYCLE completed!"
            break
        fi
        
        # Progress update every minute
        if [ $((WAITED % 60)) -eq 0 ]; then
            TRAINING_TIME=$(echo "$STATUS" | grep -o '"training_time_readable":"[^"]*"' | cut -d'"' -f4)
            BENCHMARKS=$(echo "$STATUS" | grep -o '"benchmarks_generated":[0-9]*' | cut -d':' -f2)
            echo "  Progress: Training time: $TRAINING_TIME, Benchmarks: $BENCHMARKS"
        fi
    done
    
    # Get final status
    FINAL_STATUS=$(curl -s http://localhost:3001/v0/continuous-learning/status)
    
    # Get circuit breaker status
    CB_STATUS=$(curl -s http://localhost:3001/v0/service-health/circuit-breakers)
    OPEN_COUNT=$(echo "$CB_STATUS" | grep -o '"open":[0-9]*' | cut -d':' -f2)
    
    echo ""
    echo "--- CYCLE $CYCLE RESULTS ---"
    
    # Extract benchmark results
    BENCHMARKS_GEN=$(echo "$FINAL_STATUS" | grep -o '"benchmarks_generated":[0-9]*' | cut -d':' -f2)
    BENCHMARKS_PASS=$(echo "$FINAL_STATUS" | grep -o '"benchmarks_passed":[0-9]*' | cut -d':' -f2)
    OVERALL_ACC=$(echo "$FINAL_STATUS" | grep -o '"overall_accuracy":"[^"]*"' | cut -d'"' -f4)
    
    echo "Benchmarks: $BENCHMARKS_PASS/$BENCHMARKS_GEN passed"
    echo "Overall accuracy: $OVERALL_ACC"
    echo "Circuit breakers open: $OPEN_COUNT"
    
    if [ "$OPEN_COUNT" != "0" ] && [ -n "$OPEN_COUNT" ]; then
        CIRCUIT_BREAKER_ISSUES=$((CIRCUIT_BREAKER_ISSUES + 1))
        echo "⚠️ CIRCUIT BREAKER ISSUE DETECTED!"
    else
        echo "✓ All circuit breakers closed"
    fi
    
    TOTAL_BENCHMARKS=$((TOTAL_BENCHMARKS + BENCHMARKS_GEN))
    TOTAL_PASSED=$((TOTAL_PASSED + BENCHMARKS_PASS))
    
    # Extract individual benchmark results
    echo ""
    echo "Benchmark details:"
    echo "$FINAL_STATUS" | grep -o '"benchmark_results":\[.*\]' | sed 's/.*benchmark_results"://' | tr ',' '\n' | grep -E 'oggy_accuracy|base_accuracy|advantage' | head -15
    
    echo ""
    
    # Small delay between cycles
    if [ $CYCLE -lt 5 ]; then
        echo "Starting next cycle in 5 seconds..."
        sleep 5
    fi
done

echo ""
echo "=========================================="
echo "FINAL SUMMARY - ALL 5 CYCLES"
echo "=========================================="
echo "Total benchmarks run: $TOTAL_BENCHMARKS"
echo "Total benchmarks passed: $TOTAL_PASSED"
echo "Pass rate: $(echo "scale=1; $TOTAL_PASSED * 100 / $TOTAL_BENCHMARKS" | bc 2>/dev/null || echo "N/A")%"
echo "Cycles with circuit breaker issues: $CIRCUIT_BREAKER_ISSUES"
echo ""

# Final circuit breaker status
echo "Final circuit breaker status:"
curl -s http://localhost:3001/v0/service-health/circuit-breakers

echo ""
echo "=========================================="
echo "INTENSIVE TEST COMPLETE"
echo "=========================================="
