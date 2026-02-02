const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = (pool, redisClient) => {
  const router = express.Router();

  // Constants from contracts v1.0.0 (FROZEN Week 2)
  const REASON_CODES_STAGE0 = new Set([
    'RETRIEVED_USED',
    'RETRIEVED_NOT_USED',
    'OUTCOME_SUCCESS',
    'OUTCOME_FAILURE',
    'USER_CONFIRMED',
    'USER_CORRECTED',
    'BENCHMARK_DELTA_POS',
    'BENCHMARK_DELTA_NEG',
    'DEDUP_MERGE',
    'PRUNE_LOW_UTILITY',
    'TIER_PROMOTION',
    'TIER_DEMOTION',
  ]);

  const EVIDENCE_POINTER_KEYS = new Set([
    'trace_id',
    'benchmark_id',
    'assessment_id',
    'user_event_id',
  ]);

  /**
   * Check if evidence contains at least one valid pointer
   */
  function hasEvidencePointer(evidence) {
    if (!evidence || typeof evidence !== 'object') return false;

    for (const key of EVIDENCE_POINTER_KEYS) {
      if (evidence[key]) return true;
    }
    return false;
  }

  /**
   * Infer reason_code from context.intent
   */
  function inferReasonCode(context) {
    const intent = context.intent || {};
    const event_type = intent.event_type;

    if (event_type === 'retrieval') {
      if (intent.used === true) return 'RETRIEVED_USED';
      if (intent.used === false) return 'RETRIEVED_NOT_USED';
      throw new Error("retrieval intent requires boolean 'used'");
    }

    if (event_type === 'outcome') {
      if (intent.outcome === 'success') return 'OUTCOME_SUCCESS';
      if (intent.outcome === 'failure') return 'OUTCOME_FAILURE';
      throw new Error("outcome intent requires {'success','failure'}");
    }

    if (event_type === 'user_feedback') {
      if (intent.feedback === 'confirmed') return 'USER_CONFIRMED';
      if (intent.feedback === 'corrected') return 'USER_CORRECTED';
      throw new Error("user_feedback intent requires feedback: {'confirmed','corrected'}");
    }

    if (event_type === 'benchmark') {
      if (intent.delta > 0) return 'BENCHMARK_DELTA_POS';
      if (intent.delta < 0) return 'BENCHMARK_DELTA_NEG';
      throw new Error("benchmark intent requires numeric delta");
    }

    if (event_type === 'hygiene') {
      if (intent.action === 'dedup') return 'DEDUP_MERGE';
      if (intent.action === 'prune') return 'PRUNE_LOW_UTILITY';
      if (intent.action === 'promote') return 'TIER_PROMOTION';
      if (intent.action === 'demote') return 'TIER_DEMOTION';
      throw new Error("hygiene intent requires action: {'dedup','prune','promote','demote'}");
    }

    throw new Error(
      "intent.event_type must be one of {retrieval,outcome,user_feedback,benchmark,hygiene}"
    );
  }

  /**
   * Validate context and patch before update
   */
  function validateAndFillReasonCode(card_id, patch, context) {
    const ctx = context || {};
    const intent = ctx.intent || {};

    // 0) Required fields
    if (!intent.event_type) {
      return {
        error: {
          code: 'INVALID_INTENT',
          message: 'Intent object missing event_type or malformed',
          details: {
            card_id,
            provided_intent: intent
          },
        },
      };
    }

    // 1) Evidence Gate
    const evidence = ctx.evidence || {};
    if (!hasEvidencePointer(evidence)) {
      return {
        error: {
          code: 'MISSING_EVIDENCE',
          message: 'Memory updates require at least one evidence pointer (trace_id, assessment_id, benchmark_id, or user_event_id)',
          details: {
            card_id,
            provided_evidence: evidence
          },
        },
      };
    }

    // 2) Reason Code Gate
    let inferred;
    try {
      inferred = inferReasonCode(ctx);
    } catch (e) {
      return {
        error: {
          code: 'INVALID_INTENT',
          message: `Intent object missing event_type or malformed: ${e.message}`,
          details: {
            card_id,
            intent,
            inference_error: e.message
          },
        },
      };
    }

    if (!REASON_CODES_STAGE0.has(inferred)) {
      return {
        error: {
          code: 'INVALID_INTENT',
          message: 'Inferred reason_code not valid for current contracts version',
          details: {
            card_id,
            inferred_reason_code: inferred,
            valid_codes: Array.from(REASON_CODES_STAGE0).sort()
          },
        },
      };
    }

    // Fill for downstream audit write consistency
    ctx.reason_code = inferred;
    return null; // No error
  }

  /**
   * POST /utility/update
   * Update a memory card with full validation and audit logging
   */
  router.post('/update', async (req, res, next) => {
    const client = await pool.connect();

    try {
      const { card_id, context, patch } = req.body;

      // Validation
      if (!card_id) {
        return res.status(400).json({
          error: {
            code: 'INVALID_CARD_ID',
            message: 'Card ID format is invalid or card doesn\'t exist',
            details: {
              provided: card_id
            },
          },
        });
      }

      if (!context) {
        return res.status(400).json({
          error: {
            code: 'INVALID_CONTEXT',
            message: 'Context object missing required fields',
            details: {
              required_fields: ['agent', 'program', 'action', 'evidence', 'intent']
            },
          },
        });
      }

      // Validate and infer reason_code
      const validationError = validateAndFillReasonCode(card_id, patch, context);
      if (validationError) {
        return res.status(400).json(validationError);
      }

      const ctx = context || {};
      const intent = ctx.intent || {};
      const event_type = intent.event_type;
      const reason_code = ctx.reason_code;

      // Begin transaction
      await client.query('BEGIN');

      // Lock and fetch current card state
      const cardResult = await client.query(
        'SELECT * FROM memory_cards WHERE card_id = $1 FOR UPDATE',
        [card_id]
      );

      if (cardResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: {
            code: 'CARD_NOT_FOUND',
            message: 'Card ID does not exist',
            details: { card_id },
          },
        });
      }

      const before_state = cardResult.rows[0];

      // Apply patch (simple version for Week 1)
      const utility_delta = (patch || {}).utility_delta || 0;
      const new_utility_weight = before_state.utility_weight + utility_delta;
      const new_version = before_state.version + 1;

      // Update card
      const updateResult = await client.query(
        `UPDATE memory_cards
         SET utility_weight = $1,
             updated_at = NOW(),
             version = $2
         WHERE card_id = $3
         RETURNING *`,
        [new_utility_weight, new_version, card_id]
      );

      const after_state = updateResult.rows[0];

      // Build delta (only changed fields)
      const before_delta = {
        utility_weight: before_state.utility_weight,
        version: before_state.version,
      };

      const after_delta = {
        utility_weight: after_state.utility_weight,
        version: after_state.version,
      };

      // Week 4: Dual-write to both old table and new unified audit_log
      // Insert audit event to old memory_audit_events table (for backward compatibility)
      const auditResult = await client.query(
        `INSERT INTO memory_audit_events (
          agent, program, action, card_id,
          event_type, intent, reason_code, reason_text,
          before, after, evidence, delta_score
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)
        RETURNING event_id`,
        [
          ctx.agent || 'unknown',
          ctx.program || 'unknown',
          ctx.action || 'UPDATE_CARD',
          card_id,
          event_type,
          JSON.stringify(intent),
          reason_code,
          ctx.reason_text || '',
          JSON.stringify(before_delta),
          JSON.stringify(after_delta),
          JSON.stringify(ctx.evidence || {}),
          ctx.delta_score || null,
        ]
      );

      const event_id = auditResult.rows[0].event_id;

      // Insert to new unified audit_log table
      const correlationId = ctx.evidence?.trace_id || null;
      await client.query(
        `INSERT INTO audit_log (event_type, service, payload, correlation_id, user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'card_update',
          'memory',
          JSON.stringify({
            card_id,
            action: ctx.action || 'UPDATE_CARD',
            agent: ctx.agent || 'unknown',
            program: ctx.program || 'unknown',
            event_type,
            intent,
            reason_code,
            reason_text: ctx.reason_text || '',
            evidence: ctx.evidence || {},
            delta_score: ctx.delta_score || null,
            old_utility: before_state.utility_weight,
            new_utility: after_state.utility_weight,
            utility_delta: utility_delta,
            before: before_delta,
            after: after_delta
          }),
          correlationId,
          before_state.owner_id
        ]
      );

      // Commit transaction
      await client.query('COMMIT');

      res.json({
        event_id,
        card_id,
        new_version: after_state.version,
        utility_weight: after_state.utility_weight,
        reason_code,
      });

    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  });

  return router;
};
