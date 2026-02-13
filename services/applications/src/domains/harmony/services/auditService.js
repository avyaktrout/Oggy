/**
 * Audit Service — Immutable audit trail for Harmony Map
 */

const { query } = require('../../../shared/utils/db');
const crypto = require('crypto');

class AuditService {

    /**
     * Log an action to the immutable audit trail
     */
    async logAction(userId, action, entityType, entityId, beforeState, afterState, computationHash) {
        const hash = computationHash || this.computeHash({ action, entityType, entityId, beforeState, afterState });

        await query(`
            INSERT INTO harmony_audit_log (user_id, action, entity_type, entity_id, before_state, after_state, computation_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [userId, action, entityType, entityId,
            beforeState ? JSON.stringify(beforeState) : null,
            afterState ? JSON.stringify(afterState) : null,
            hash]);
    }

    /**
     * Get full audit trail for an entity
     */
    async getAuditTrail(entityId) {
        const result = await query(`
            SELECT * FROM harmony_audit_log
            WHERE entity_id = $1
            ORDER BY ts DESC
        `, [entityId]);
        return result.rows;
    }

    /**
     * Get audit trail by hash
     */
    async getByHash(hash) {
        const result = await query(`
            SELECT * FROM harmony_audit_log
            WHERE computation_hash = $1
        `, [hash]);
        return result.rows;
    }

    /**
     * Compute a SHA-256 hash of the input data
     */
    computeHash(data) {
        return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').substring(0, 16);
    }

    /**
     * Verify a computation hash by re-computing from stored data
     */
    async verifyHash(hash) {
        const records = await this.getByHash(hash);
        if (!records.length) return { valid: false, reason: 'Hash not found' };

        const record = records[0];
        const recomputed = this.computeHash({
            action: record.action,
            entityType: record.entity_type,
            entityId: record.entity_id,
            beforeState: record.before_state,
            afterState: record.after_state,
        });

        return {
            valid: recomputed === hash,
            original_hash: hash,
            recomputed_hash: recomputed,
            record,
        };
    }
}

module.exports = new AuditService();
