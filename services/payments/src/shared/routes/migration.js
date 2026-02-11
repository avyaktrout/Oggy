/**
 * Migration Routes - Export/import tenant data for Oggy migration
 * Enables moving a trained Oggy from one instance to another
 */

const express = require('express');
const exportRouter = express.Router();
const importRouter = express.Router();
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const authService = require('../services/authService');
const { parseCookies } = require('../middleware/auth');

/**
 * GET /v0/migration/export?user_id=X
 * Export all of a user's trained Oggy data as JSON bundle.
 * Mounted before auth middleware so local instances can export without login.
 * If a valid session exists, uses the session user_id for security.
 */
exportRouter.get('/export', async (req, res) => {
    // Try to resolve user_id from session first (secure), fall back to query param (local)
    let user_id = req.query.user_id;
    try {
        const cookies = parseCookies(req);
        if (cookies['oggy_session']) {
            const session = await authService.validateSession(cookies['oggy_session']);
            if (session) user_id = session.user_id;
        }
    } catch (_) { /* no session — use query param */ }
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        // 1. Domain knowledge (learned patterns, rules)
        const knowledgeResult = await query(
            `SELECT domain, topic, subtopic, content_text, content_structured,
                    source_type, source_ref, visibility, difficulty_band, tags, content_hash
             FROM domain_knowledge WHERE user_id = $1`,
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

        // 4. Memory cards (query shared DB directly — memory-service has no list endpoint)
        const cardsResult = await query(
            `SELECT tier, kind, content, tags, utility_weight, reliability
             FROM memory_cards WHERE owner_id = $1 AND status = 'active'`,
            [user_id]
        );
        const memoryCards = cardsResult.rows;

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
importRouter.post('/import', async (req, res) => {
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
                        knowledge_id, domain, topic, subtopic, content_text, content_structured,
                        source_type, source_ref, visibility, difficulty_band, tags, content_hash, user_id
                    ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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

        // 4. Import memory cards (direct DB insert — shared PostgreSQL)
        for (const card of (bundle.memory_cards || [])) {
            try {
                // tags is text[] in PostgreSQL — pass as JS array for pg driver to handle
                const tags = Array.isArray(card.tags) ? card.tags : ['payments', 'categorization'];
                await query(
                    `INSERT INTO memory_cards (owner_type, owner_id, tier, kind, content, tags, utility_weight, reliability)
                     VALUES ('user', $1, $2, $3, $4, $5, $6, $7)`,
                    [
                        user_id,
                        card.tier || 2,
                        card.kind || 'migrated',
                        JSON.stringify(card.content),
                        tags,
                        card.utility_weight || 0.5,
                        card.reliability || 0.7
                    ]
                );
                results.memory_cards++;
            } catch (err) {
                if (err.code !== '23505') {
                    results.errors.push(`memory_card: ${err.message}`);
                }
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

module.exports = { migrationExportRouter: exportRouter, migrationImportRouter: importRouter };
