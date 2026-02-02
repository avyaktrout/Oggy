/**
 * Categorization Routes
 * Oggy-powered expense categorization
 * Stage 0, Week 5
 */

const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');
const OggyCategorizer = require('../services/oggyCategorizer');

const categorizer = new OggyCategorizer();

/**
 * POST /categorization/suggest
 * Ask Oggy to suggest a category for an expense
 */
router.post('/suggest', async (req, res) => {
    try {
        const {
            user_id,
            expense_id,
            amount,
            merchant,
            description,
            transaction_date
        } = req.body;

        if (!user_id || !amount || !description) {
            return res.status(400).json({
                error: 'Missing required fields: user_id, amount, description'
            });
        }

        // Call Oggy categorizer
        const suggestion = await categorizer.suggestCategory(user_id, {
            expense_id,
            amount,
            merchant,
            description,
            transaction_date
        });

        res.json(suggestion);
    } catch (error) {
        console.error('[Categorization] Suggest error:', error);
        res.status(500).json({
            error: 'Failed to suggest category',
            details: error.message
        });
    }
});

/**
 * POST /categorization/batch-suggest
 * Suggest categories for multiple expenses
 */
router.post('/batch-suggest', async (req, res) => {
    try {
        const { user_id, expenses } = req.body;

        if (!user_id || !Array.isArray(expenses)) {
            return res.status(400).json({
                error: 'Missing required fields: user_id, expenses (array)'
            });
        }

        // Process each expense
        const suggestions = [];
        for (const expense of expenses) {
            try {
                const suggestion = await categorizer.suggestCategory(user_id, expense);
                suggestions.push({
                    expense_id: expense.expense_id,
                    ...suggestion
                });
            } catch (error) {
                suggestions.push({
                    expense_id: expense.expense_id,
                    error: error.message
                });
            }
        }

        res.json({ suggestions });
    } catch (error) {
        console.error('[Categorization] Batch suggest error:', error);
        res.status(500).json({ error: 'Failed to process batch suggestions' });
    }
});

module.exports = router;
