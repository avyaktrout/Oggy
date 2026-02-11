/**
 * Expenses API Routes
 * Stage 0, Week 5: Payments App Minimal Surface
 */

const express = require('express');
const router = express.Router();
const { query, transaction } = require('../../../shared/utils/db');
const {
    emitExpenseCreated,
    emitExpenseUpdated,
    emitExpenseCategorizedByUser
} = require('../../../shared/utils/eventEmitter');

/**
 * POST /expenses
 * Create a new expense
 */
router.post('/', async (req, res) => {
    try {
        const {
            user_id,
            amount,
            currency = 'USD',
            description,
            merchant,
            transaction_date,
            category: rawCategory = null,
            tags = [],
            notes = null
        } = req.body;
        const category = rawCategory || null; // Normalize empty string to null

        // Validation
        if (!user_id || !amount || !description || !transaction_date) {
            return res.status(400).json({
                error: 'Missing required fields: user_id, amount, description, transaction_date'
            });
        }

        if (amount < 0) {
            return res.status(400).json({
                error: 'Amount must be non-negative'
            });
        }

        // Insert expense
        const result = await query(
            `INSERT INTO expenses (
                user_id, amount, currency, description, merchant,
                transaction_date, category, tags, notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [user_id, amount, currency, description, merchant, transaction_date, category, tags, notes]
        );

        const expense = result.rows[0];

        // Emit event for training pipeline
        const event_id = await emitExpenseCreated(expense);

        res.status(201).json({
            expense_id: expense.expense_id,
            ...expense,
            event_id
        });
    } catch (error) {
        console.error('[Expenses] Create error:', error);
        res.status(500).json({ error: 'Failed to create expense' });
    }
});

/**
 * GET /expenses/:expense_id
 * Get a single expense by ID
 */
router.get('/:expense_id', async (req, res) => {
    try {
        const { expense_id } = req.params;

        const result = await query(
            `SELECT * FROM expenses WHERE expense_id = $1 AND status = 'active'`,
            [expense_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Expense not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('[Expenses] Get error:', error);
        res.status(500).json({ error: 'Failed to retrieve expense' });
    }
});

/**
 * PUT /expenses/:expense_id
 * Update an existing expense
 */
router.put('/:expense_id', async (req, res) => {
    try {
        const { expense_id } = req.params;
        const updates = req.body;

        // Get current expense
        const current = await query(
            `SELECT * FROM expenses WHERE expense_id = $1 AND status = 'active'`,
            [expense_id]
        );

        if (current.rows.length === 0) {
            return res.status(404).json({ error: 'Expense not found' });
        }

        const currentExpense = current.rows[0];

        // Build update query dynamically
        const allowedFields = ['amount', 'currency', 'description', 'merchant',
                              'category', 'transaction_date', 'tags', 'notes'];
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        for (const field of allowedFields) {
            if (field in updates) {
                updateFields.push(`${field} = $${paramIndex}`);
                updateValues.push(updates[field]);
                paramIndex++;
            }
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        // Add updated_at and version
        updateFields.push(`updated_at = now()`);
        updateFields.push(`version = version + 1`);
        updateValues.push(expense_id);

        const updateQuery = `
            UPDATE expenses
            SET ${updateFields.join(', ')}
            WHERE expense_id = $${paramIndex}
            RETURNING *
        `;

        const result = await query(updateQuery, updateValues);
        const updatedExpense = result.rows[0];

        // Emit event (different event if category changed)
        const categoryChanged = 'category' in updates && updates.category !== currentExpense.category;
        if (categoryChanged) {
            await emitExpenseCategorizedByUser(updatedExpense, currentExpense.category);
        } else {
            await emitExpenseUpdated(updatedExpense, currentExpense);
        }

        res.json({
            ...updatedExpense,
            previous_version: currentExpense.version
        });
    } catch (error) {
        console.error('[Expenses] Update error:', error);
        res.status(500).json({ error: 'Failed to update expense' });
    }
});

/**
 * DELETE /expenses/:expense_id
 * Soft-delete an expense
 */
router.delete('/:expense_id', async (req, res) => {
    try {
        const { expense_id } = req.params;

        const result = await query(
            `UPDATE expenses
             SET status = 'deleted', updated_at = now()
             WHERE expense_id = $1 AND status = 'active'
             RETURNING expense_id, status`,
            [expense_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Expense not found' });
        }

        res.json({
            expense_id: result.rows[0].expense_id,
            status: 'deleted'
        });
    } catch (error) {
        console.error('[Expenses] Delete error:', error);
        res.status(500).json({ error: 'Failed to delete expense' });
    }
});

/**
 * POST /expenses/:expense_id/categorize
 * Categorize or recategorize an expense
 * (Can be user-initiated or accepting Oggy's suggestion)
 */
router.post('/:expense_id/categorize', async (req, res) => {
    try {
        const { expense_id } = req.params;
        const { category, source = 'user', suggestion_data = null } = req.body;

        if (!category) {
            return res.status(400).json({ error: 'Missing required field: category' });
        }

        // Get current expense
        const current = await query(
            `SELECT * FROM expenses WHERE expense_id = $1 AND status = 'active'`,
            [expense_id]
        );

        if (current.rows.length === 0) {
            return res.status(404).json({ error: 'Expense not found' });
        }

        const currentExpense = current.rows[0];
        const previousCategory = currentExpense.category;

        // Update category
        const result = await query(
            `UPDATE expenses
             SET category = $1, updated_at = now(), version = version + 1
             WHERE expense_id = $2
             RETURNING *`,
            [category, expense_id]
        );

        const updatedExpense = result.rows[0];

        // Emit appropriate event based on source
        let event_id;
        if (source === 'oggy_accepted' && suggestion_data) {
            // User accepted Oggy's suggestion
            const { emitExpenseCategorizedByOggy } = require('../../../shared/utils/eventEmitter');
            event_id = await emitExpenseCategorizedByOggy(updatedExpense, suggestion_data);
        } else if (source === 'oggy_rejected' && suggestion_data) {
            // User rejected Oggy's suggestion and chose different category
            const { emitCategorySuggestionRejected } = require('../../../shared/utils/eventEmitter');
            event_id = await emitCategorySuggestionRejected(updatedExpense, suggestion_data, category);
        } else {
            // User manually categorized
            event_id = await emitExpenseCategorizedByUser(updatedExpense, previousCategory);
        }

        res.json({
            expense_id: updatedExpense.expense_id,
            category: updatedExpense.category,
            previous_category: previousCategory,
            event_id
        });
    } catch (error) {
        console.error('[Expenses] Categorize error:', error);
        res.status(500).json({ error: 'Failed to categorize expense' });
    }
});

module.exports = router;
