# Multi-Day Stability Testing Guide
## Week 7 Exit Criteria Verification

**Last Updated:** 2026-02-02
**Purpose:** Verify system can run for multiple days without babysitting with trustworthy logs

---

## Exit Criteria

✅ **Primary Goal:** System runs for 3+ days without manual intervention
✅ **Secondary Goal:** Logs are trustworthy - structured, complete, and auditable

---

## Pre-Test Checklist

Before starting the multi-day stability test, ensure:

- [ ] All services are healthy: `./scripts/check-health.sh`
- [ ] Audit checks pass: `./scripts/run-audit.sh`
- [ ] Token budget configured: Check `DAILY_TOKEN_BUDGET` env var (default: 2M)
- [ ] Disk space adequate: At least 10GB free for logs
- [ ] OpenAI API key valid and funded

---

## Test Procedure

### Day 0: Setup and Baseline

1. **Start fresh with clean state**
   ```bash
   docker-compose down -v
   docker-compose up -d
   sleep 10
   ```

2. **Verify all services healthy**
   ```bash
   ./scripts/check-health.sh
   ```

3. **Run initial audit**
   ```bash
   ./scripts/run-audit.sh full > logs/audit_day0.json
   ```

4. **Establish baseline metrics**
   ```bash
   ./scripts/system-status.sh > logs/status_day0.txt
   ```

5. **Create training data** (20 expenses)
   ```bash
   bash scripts/full-training-and-7-cycles.sh
   ```

6. **Document initial state**
   - Record start time
   - Note service versions
   - Save initial log snapshot

### Day 1-3: Monitoring

**Daily Checks (2x per day - morning and evening):**

1. **Check system status**
   ```bash
   ./scripts/system-status.sh | tee -a logs/status_history.txt
   ```

2. **Run audit checks**
   ```bash
   ./scripts/run-audit.sh quick
   ```

3. **Check token budget**
   ```bash
   ./scripts/check-budget.sh
   ```

4. **Review recent logs for errors**
   ```bash
   docker logs oggy-payments-service --tail 100 | grep -i "error\|fail"
   docker logs oggy-memory-service --tail 100 | grep -i "error\|fail"
   ```

5. **Verify background event processing**
   ```bash
   # Should show events being processed periodically
   docker logs oggy-payments-service --tail 50 | grep "Background event processing"
   ```

**What to Monitor:**

- ❌ Service crashes or restarts
- ❌ Memory leaks (increasing memory usage)
- ❌ Circuit breakers stuck OPEN
- ❌ Unprocessed event backlog growing
- ❌ Database connection errors
- ❌ OpenAI API errors (rate limits, timeouts)
- ⚠️  Token budget approaching limit
- ⚠️  Audit warnings accumulating

### Day 3: Final Validation

1. **Run comprehensive audit**
   ```bash
   ./scripts/run-audit.sh full > logs/audit_day3.json
   ```

2. **Compare metrics to baseline**
   ```bash
   diff logs/status_day0.txt logs/status_day3.txt
   ```

3. **Verify continuous learning still works**
   ```bash
   # Create a few test expenses and verify categorization
   # Check memory cards are being created/updated
   docker exec oggy-postgres psql -U oggy -d oggy_db -c \
     "SELECT COUNT(*) FROM memory_cards WHERE created_at > NOW() - INTERVAL '3 days';"
   ```

4. **Verify log integrity**
   ```bash
   # Check logs are structured and parseable
   docker logs oggy-payments-service --tail 1000 | grep "\\[info\\]" | wc -l
   docker logs oggy-payments-service --tail 1000 | grep "\\[error\\]" | wc -l
   ```

5. **Generate final report**
   ```bash
   ./scripts/system-status.sh > logs/final_report.txt
   ```

---

## Success Criteria

### Must Pass (Exit Criteria)

✅ **No Manual Interventions**
- No service restarts required
- No manual event processing needed
- No database fixes needed

✅ **Services Remain Healthy**
- All health checks passing consistently
- Circuit breakers functioning correctly
- Graceful handling of transient errors

✅ **Logs Are Trustworthy**
- Structured JSON logs with timestamps
- Request IDs for traceability
- No missing log entries
- Error logs include context and stack traces

✅ **Audit Integrity**
- All events processed within SLA (< 2 minutes)
- Memory cards have proper evidence pointers
- No orphaned data
- Audit checks pass or show acceptable warnings

### Should Pass (Quality Goals)

⚠️  **Performance Stable**
- Response times consistent
- Memory usage stable (no leaks)
- CPU usage reasonable

⚠️  **Cost Control Working**
- Token budget tracking accurate
- Budget warnings trigger correctly
- No runaway costs

⚠️  **Resilience Features Active**
- Retries occurring for transient failures
- Circuit breakers opening/closing appropriately
- Graceful degradation when memory service slow

---

## Common Issues and Solutions

### Issue: Unprocessed Events Accumulating

**Symptoms:**
```bash
./scripts/run-audit.sh
# Shows: "200 events are unprocessed - processing lag detected"
```

**Investigation:**
```bash
# Check background processor logs
docker logs oggy-payments-service | grep "Background event processing"

# Check for processing errors
docker exec oggy-postgres psql -U oggy -d oggy_db -c \
  "SELECT COUNT(*), processing_errors FROM app_events WHERE processing_errors IS NOT NULL GROUP BY processing_errors;"
```

**Solutions:**
- If memory service is down, restart it
- If processing errors, check error details and fix root cause
- Manually trigger processing: `./scripts/process-events.sh 200`

---

### Issue: Token Budget Exceeded

**Symptoms:**
```bash
./scripts/check-budget.sh
# Shows: "⚠️ WARNING: Token budget is at 95%!"
```

**Investigation:**
```bash
# Check what's using tokens
docker logs oggy-payments-service | grep "token_usage"
```

**Solutions:**
- Increase budget: Set `DAILY_TOKEN_BUDGET=5000000` in docker-compose.yml
- Reduce evaluation frequency
- Optimize prompts to use fewer tokens

---

### Issue: Memory Service Circuit Breaker Open

**Symptoms:**
```bash
docker logs oggy-payments-service | grep "circuit breaker open"
```

**Investigation:**
```bash
# Check memory service health
curl http://localhost:3000/health

# Check memory service logs
docker logs oggy-memory-service --tail 50
```

**Solutions:**
- Restart memory service if crashed
- Check database connections
- Wait for circuit breaker to auto-recover (60 seconds)

---

### Issue: Service Crashed

**Symptoms:**
```bash
./scripts/check-health.sh
# Shows: "❌ Payments service is down"
```

**Investigation:**
```bash
# Check if container exited
docker ps -a | grep oggy

# Check exit logs
docker logs oggy-payments-service --tail 100
```

**Solutions:**
- Review crash logs for root cause
- Restart service: `docker-compose restart payments-service`
- **IMPORTANT:** If service crashed, stability test has FAILED
  - Document the failure
  - Fix root cause
  - Restart test from Day 0

---

## Test Report Template

```markdown
# Stability Test Report

**Test Period:** [Start Date/Time] to [End Date/Time]
**Duration:** X days, Y hours

## Results Summary

- [ ] No manual interventions required
- [ ] All services remained healthy
- [ ] Logs are structured and complete
- [ ] Audit checks passed

## Metrics

| Metric | Day 0 | Day 3 | Status |
|--------|-------|-------|--------|
| Unprocessed Events | X | Y | ✅/❌ |
| Memory Cards | X | Y | ✅/❌ |
| Token Usage | X% | Y% | ✅/❌ |
| Audit Status | PASS/WARN | PASS/WARN | ✅/❌ |

## Issues Encountered

1. **Issue:** [Description]
   - **Severity:** Critical/Warning/Info
   - **Resolution:** [How it was resolved]
   - **Required Intervention:** Yes/No

## Continuous Learning Verification

- Memory cards created: X
- Memory cards updated: Y
- Successful categorizations: Z
- Learning improvement: +X%

## Conclusion

[PASS/FAIL]: The system [did/did not] meet exit criteria for Week 7.

**Next Steps:**
- [ ] Fix identified issues
- [ ] Rerun stability test
- [ ] Proceed to Week 8
```

---

## Automated Monitoring (Optional)

For true hands-off testing, set up automated monitoring:

### Cron Job for Daily Checks

```bash
# Add to crontab -e
0 9 * * * cd /path/to/Oggy && ./scripts/system-status.sh >> logs/daily_status.log 2>&1
0 21 * * * cd /path/to/Oggy && ./scripts/run-audit.sh quick >> logs/daily_audit.log 2>&1
```

### Alert on Failures

```bash
# Create alerting script
#!/bin/bash
STATUS=$(./scripts/system-status.sh)
if echo "$STATUS" | grep -q "❌"; then
    # Send alert (email, Slack, etc.)
    echo "$STATUS" | mail -s "Oggy System Alert" your-email@example.com
fi
```

---

## Exit Criteria Validation Checklist

After 3-day test completion:

- [ ] System ran for full duration without manual intervention
- [ ] All services remained healthy (no crashes)
- [ ] Logs are structured, complete, and trustworthy
- [ ] Audit checks show PASS or acceptable WARN status
- [ ] Background event processor functioned correctly
- [ ] Circuit breakers and retry logic worked as designed
- [ ] Token budget tracking prevented runaway costs
- [ ] Graceful shutdown/restart works correctly
- [ ] Memory cards created and updated properly
- [ ] Continuous learning still functioning after 3 days

**Final Verdict:** [ ] PASS / [ ] FAIL

---

## Next Steps After Successful Test

1. Document lessons learned
2. Update operational runbook
3. Train team on monitoring scripts
4. Set up production monitoring
5. Proceed to Week 8 development

---

**Status:** Ready for multi-day stability testing ✅
