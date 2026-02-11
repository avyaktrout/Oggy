/**
 * Expense Query and Analysis Routes
 * Stage 0, Week 5
 */

const express = require('express');
const router = express.Router();
const { query } = require('../../../shared/utils/db');
const { emitExpensesQueried } = require('../../../shared/utils/eventEmitter');

/**
 * POST /query
 * Query expenses with filters
 */
router.post('/', async (req, res) => {
    try {
        const {
            user_id,
            start_date,
            end_date,
            category,
            merchant,
            min_amount,
            max_amount,
            tags,
            limit = 50,
            offset = 0
        } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'Missing required field: user_id' });
        }

        // Build query dynamically
        const conditions = ['user_id = $1', 'status = \'active\''];
        const values = [user_id];
        let paramIndex = 2;

        if (start_date) {
            conditions.push(`transaction_date >= $${paramIndex}`);
            values.push(start_date);
            paramIndex++;
        }

        if (end_date) {
            conditions.push(`transaction_date <= $${paramIndex}`);
            values.push(end_date);
            paramIndex++;
        }

        if (category) {
            conditions.push(`category = $${paramIndex}`);
            values.push(category);
            paramIndex++;
        }

        if (merchant) {
            conditions.push(`merchant ILIKE $${paramIndex}`);
            values.push(`%${merchant}%`);
            paramIndex++;
        }

        if (min_amount !== undefined) {
            conditions.push(`amount >= $${paramIndex}`);
            values.push(min_amount);
            paramIndex++;
        }

        if (max_amount !== undefined) {
            conditions.push(`amount <= $${paramIndex}`);
            values.push(max_amount);
            paramIndex++;
        }

        if (tags && Array.isArray(tags) && tags.length > 0) {
            conditions.push(`tags && $${paramIndex}`);
            values.push(tags);
            paramIndex++;
        }

        const whereClause = conditions.join(' AND ');

        // Get total count
        const countQuery = `SELECT COUNT(*) as total, COALESCE(SUM(amount), 0) as total_amount
                           FROM expenses WHERE ${whereClause}`;
        const countResult = await query(countQuery, values);
        const { total, total_amount } = countResult.rows[0];

        // Get expenses
        const expensesQuery = `
            SELECT * FROM expenses
            WHERE ${whereClause}
            ORDER BY transaction_date DESC, created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        values.push(limit, offset);

        const expensesResult = await query(expensesQuery, values);

        // Emit query event
        const event_id = await emitExpensesQueried(
            user_id,
            { start_date, end_date, category, merchant, min_amount, max_amount, tags },
            parseInt(total),
            parseFloat(total_amount)
        );

        res.json({
            expenses: expensesResult.rows,
            total_count: parseInt(total),
            total_amount: parseFloat(total_amount),
            limit,
            offset,
            event_id
        });
    } catch (error) {
        console.error('[Query] Error:', error);
        res.status(500).json({ error: 'Failed to query expenses' });
    }
});

/**
 * GET /categories
 * Get category statistics for a user
 */
router.get('/categories', async (req, res) => {
    try {
        const { user_id } = req.query;

        if (!user_id) {
            return res.status(400).json({ error: 'Missing required parameter: user_id' });
        }

        const result = await query(
            `SELECT * FROM user_category_stats
             WHERE user_id = $1
             ORDER BY total_amount DESC`,
            [user_id]
        );

        res.json({
            categories: result.rows
        });
    } catch (error) {
        console.error('[Query] Categories error:', error);
        res.status(500).json({ error: 'Failed to get categories' });
    }
});

/**
 * GET /merchants
 * Get merchant statistics for a user
 */
router.get('/merchants', async (req, res) => {
    try {
        const { user_id } = req.query;

        if (!user_id) {
            return res.status(400).json({ error: 'Missing required parameter: user_id' });
        }

        const result = await query(
            `SELECT * FROM user_merchant_patterns
             WHERE user_id = $1
             ORDER BY visit_count DESC, avg_amount DESC
             LIMIT 50`,
            [user_id]
        );

        res.json({
            merchants: result.rows
        });
    } catch (error) {
        console.error('[Query] Merchants error:', error);
        res.status(500).json({ error: 'Failed to get merchants' });
    }
});

/**
 * GET /summary
 * Get spending summary for a user
 */
router.get('/summary', async (req, res) => {
    try {
        const { user_id } = req.query;

        if (!user_id) {
            return res.status(400).json({ error: 'Missing required parameter: user_id' });
        }

        const result = await query(
            `SELECT * FROM user_spending_summary WHERE user_id = $1`,
            [user_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No expenses found for user' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('[Query] Summary error:', error);
        res.status(500).json({ error: 'Failed to get summary' });
    }
});

module.exports = router;
