/**
 * Response Auditor - Internal audit trail for response selection
 * Behavior Design Doc Section 3.3
 *
 * Writes audit records with:
 * - request_id, user_id, session_id
 * - candidate count and hashes (privacy-safe)
 * - scores per axis for each candidate
 * - winning candidate hash and reason summary
 * - humor gate status
 * - memory items used
 */

const { query } = require('../utils/db');
const logger = require('../utils/logger');

class ResponseAuditor {
    /**
     * Write an audit trace for a response selection (Section 3.3)
     */
    async writeAudit(auditData) {
        try {
            const result = await query(
                `INSERT INTO response_audits
                 (request_id, user_id, session_id, candidate_count, candidates, winner_index, winner_reason, humor_gate_active, memory_card_ids, scoring_axes)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb)
                 RETURNING audit_id`,
                [
                    auditData.request_id,
                    auditData.user_id,
                    auditData.session_id,
                    auditData.candidate_count,
                    JSON.stringify(auditData.candidates),
                    auditData.winner_index,
                    auditData.winner_reason,
                    auditData.humor_gate_active,
                    auditData.memory_card_ids,
                    JSON.stringify({
                        weights: {
                            function_relevance: 0.35,
                            preference_fit: 0.20,
                            safety: 0.20,
                            tone_fit: 0.15,
                            uncertainty_penalty: 0.10
                        }
                    })
                ]
            );

            logger.info('Response audit written', {
                audit_id: result.rows[0].audit_id,
                request_id: auditData.request_id,
                candidate_count: auditData.candidate_count,
                winner_index: auditData.winner_index,
                humor_gate: auditData.humor_gate_active
            });

            return result.rows[0].audit_id;
        } catch (err) {
            logger.error('Failed to write response audit', {
                error: err.message,
                request_id: auditData.request_id
            });
            // Non-fatal: don't block response delivery
            return null;
        }
    }

    /**
     * Retrieve audit records for a user (for review/debugging)
     */
    async getAudits(userId, limit = 20) {
        const result = await query(
            `SELECT * FROM response_audits
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );
        return result.rows;
    }

    /**
     * Retrieve a specific audit by request_id
     */
    async getAuditByRequest(requestId) {
        const result = await query(
            `SELECT * FROM response_audits WHERE request_id = $1`,
            [requestId]
        );
        return result.rows[0] || null;
    }

    /**
     * Get audit statistics for a user
     */
    async getAuditStats(userId) {
        const result = await query(
            `SELECT
                COUNT(*) as total_audits,
                AVG(candidate_count) as avg_candidates,
                SUM(CASE WHEN humor_gate_active THEN 1 ELSE 0 END) as humor_gated_count,
                AVG((candidates->0->'scores'->>'total')::float) as avg_winning_score
             FROM response_audits
             WHERE user_id = $1`,
            [userId]
        );
        return result.rows[0];
    }
}

module.exports = ResponseAuditor;
