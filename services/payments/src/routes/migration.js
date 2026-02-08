/**
 * Migration Routes - Export/import tenant data for Oggy migration
 * Enables moving a trained Oggy from one instance to another
 */

const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');
const axios = require('axios');
const logger = require('../utils/logger');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';

/**
 * GET /v0/migration/export?user_id=X
 * Export all of a user's trained Oggy data as JSON bundle
 */
router.get('/export', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        // 1. Domain knowledge (learned patterns, rules)
        const knowledgeResult = await query(
            `SELECT domain, topic, subtopic, content_text, content_structured,
                    source_type, source_ref, visibility, difficulty_band, tags, content_hash
             FROM domain_knowledge WHERE user_id = $1 AND retired_at IS NULL`,
            [user_id]
        );

        // 2. Learning state (current level)
        const stateResult = await query(
            `SELECT scale, difficulty_level, baseline_scale FROM continuous_learning_state WHERE user_id = $1`,
            [user_id]
        );

        // 3. Expenses
        const expensesResult = await query(
            `SELECT amount, currency, description, merchant, category,
                    transaction_date, tags, notes, status
             FROM expenses WHERE user_id = $1 AND status = 'active'
             ORDER BY transaction_date DESC`,
            [user_id]
        );

        // 4. Memory cards from memory-service
        let memoryCards = [];
        try {
            const cardsResponse = await axios.get(`${MEMORY_SERVICE_URL}/cards`, {
                params: { owner_id: user_id, limit: 500 },
                timeout: 10000,
                headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
            });
            memoryCards = (cardsResponse.data?.cards || []).map(c => ({
                tier: c.tier,
                kind: c.kind,
                content: c.content,
                tags: c.tags,
                utility_weight: c.utility_weight,
                reliability: c.reliability
            }));
        } catch (err) {
            logger.warn('Migration: failed to export memory cards', { error: err.message });
        }

        // 5. Inquiry preferences
        const prefsResult = await query(
            `SELECT enabled, max_questions_per_day, receive_suggestions,
                    suggestion_interval_seconds
             FROM oggy_inquiry_preferences WHERE user_id = $1`,
            [user_id]
        );

        // 6. Category rules (stored in domain_knowledge with subtopic='category_distinction_rules')
        // Already included in knowledgeResult above

        const bundle = {
            version: 1,
            exported_at: new Date().toISOString(),
            source_user_id: user_id,
            domain_knowledge: knowledgeResult.rows,
            learning_state: stateResult.rows[0] || { scale: 1, difficulty_level: 1, baseline_scale: null },
            expenses: expensesResult.rows,
            memory_cards: memoryCards,
            inquiry_preferences: prefsResult.rows[0] || null,
            stats: {
                domain_knowledge_count: knowledgeResult.rows.length,
                expenses_count: expensesResult.rows.length,
                memory_cards_count: memoryCards.length
            }
        };

        res.json(bundle);
    } catch (error) {
        logger.logError(error, { operation: 'migration-export', requestId: req.requestId });
        res.status(500).json({ error: 'Export failed' });
    }
});

/**
 * POST /v0/migration/import
 * Import a previously exported Oggy bundle under the current user's ID
 * Body: { bundle: <exported JSON> }
 */
router.post('/import', async (req, res) => {
    const { user_id } = req.body;
    const bundle = req.body.bundle;

    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!bundle || bundle.version !== 1) {
        return res.status(400).json({ error: 'Invalid or missing bundle (expected version 1)' });
    }

    const results = {
        domain_knowledge: 0,
        expenses: 0,
        memory_cards: 0,
        learning_state: false,
        errors: []
    };

    try {
        // 1. Import domain knowledge
        for (const dk of (bundle.domain_knowledge || [])) {
            try {
                await query(
                    `INSERT INTO domain_knowledge (
                        domain, topic, subtopic, content_text, content_structured,
                        source_type, source_ref, visibility, difficulty_band, tags, content_hash, user_id
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [
                        dk.domain, dk.topic, dk.subtopic, dk.content_text,
                        JSON.stringify(dk.content_structured),
                        dk.source_type, dk.source_ref, dk.visibility,
                        dk.difficulty_band, JSON.stringify(dk.tags),
                        dk.content_hash, user_id
                    ]
                );
                results.domain_knowledge++;
            } catch (err) {
                if (err.code !== '23505') { // skip duplicate key violations
                    results.errors.push(`dk: ${err.message}`);
                }
            }
        }

        // 2. Import learning state
        if (bundle.learning_state) {
            try {
                const ls = bundle.learning_state;
                await query(
                    `INSERT INTO continuous_learning_state (user_id, scale, difficulty_level, baseline_scale, updated_at)
                     VALUES ($1, $2, $3, $4, now())
                     ON CONFLICT (user_id) DO UPDATE SET
                         scale = $2, difficulty_level = $3, baseline_scale = COALESCE($4, continuous_learning_state.baseline_scale),
                         updated_at = now()`,
                    [user_id, ls.scale || 1, ls.difficulty_level || 1, ls.baseline_scale]
                );
                results.learning_state = true;
            } catch (err) {
                results.errors.push(`learning_state: ${err.message}`);
            }
        }

        // 3. Import expenses
        for (const exp of (bundle.expenses || [])) {
            try {
                await query(
                    `INSERT INTO expenses (user_id, amount, currency, description, merchant, category,
                                          transaction_date, tags, notes, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                        user_id, exp.amount, exp.currency, exp.description,
                        exp.merchant, exp.category, exp.transaction_date,
                        exp.tags || '{}', exp.notes, exp.status || 'active'
                    ]
                );
                results.expenses++;
            } catch (err) {
                if (err.code !== '23505') {
                    results.errors.push(`expense: ${err.message}`);
                }
            }
        }

        // 4. Import memory cards
        for (const card of (bundle.memory_cards || [])) {
            try {
                await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                    owner_type: 'user',
                    owner_id: user_id,
                    tier: card.tier || 2,
                    kind: card.kind || 'migrated',
                    content: card.content,
                    tags: card.tags || ['payments', 'categorization'],
                    utility_weight: card.utility_weight || 0.5,
                    reliability: card.reliability || 0.7
                }, {
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                });
                results.memory_cards++;
            } catch (err) {
                results.errors.push(`memory_card: ${err.message}`);
            }
        }

        // 5. Import inquiry preferences
        if (bundle.inquiry_preferences) {
            try {
                const prefs = bundle.inquiry_preferences;
                await query(
                    `INSERT INTO oggy_inquiry_preferences (user_id, enabled, max_questions_per_day,
                         receive_suggestions, suggestion_interval_seconds)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (user_id) DO UPDATE SET
                         enabled = $2, max_questions_per_day = $3,
                         receive_suggestions = $4, suggestion_interval_seconds = $5`,
                    [user_id, prefs.enabled ?? true, prefs.max_questions_per_day ?? 5,
                     prefs.receive_suggestions ?? false, prefs.suggestion_interval_seconds ?? 900]
                );
            } catch (err) {
                results.errors.push(`prefs: ${err.message}`);
            }
        }

        logger.info('Migration import completed', { user_id, results });

        res.json({
            success: true,
            imported: results,
            message: `Imported ${results.domain_knowledge} knowledge entries, ${results.expenses} expenses, ${results.memory_cards} memory cards. Level: S${bundle.learning_state?.scale || 1} L${bundle.learning_state?.difficulty_level || 1}`
        });
    } catch (error) {
        logger.logError(error, { operation: 'migration-import', requestId: req.requestId });
        res.status(500).json({ error: 'Import failed', partial_results: results });
    }
});

module.exports = router;
