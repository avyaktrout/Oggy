/**
 * V3: Diet Agent Routes
 */
const express = require('express');
const router = express.Router();
const dietService = require('../services/dietService');
const logger = require('../../../shared/utils/logger');

// Diet entries
router.post('/entries', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const entry = await dietService.addEntry(userId, req.body);
        res.json(entry);
    } catch (err) {
        logger.logError(err, { operation: 'v3-add-entry' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/entries', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const date = req.query.date;
        const entry_type = req.query.entry_type;
        const entries = await dietService.getEntries(userId, date, { entry_type });
        res.json({ entries });
    } catch (err) {
        logger.logError(err, { operation: 'v3-get-entries' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/nutrition', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const date = req.query.date;
        const summary = await dietService.getNutritionSummary(userId, date);
        res.json(summary);
    } catch (err) {
        logger.logError(err, { operation: 'v3-nutrition' });
        res.status(500).json({ error: err.message });
    }
});

// Diet rules
router.get('/rules', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const rules = await dietService.getRules(userId);
        res.json({ rules });
    } catch (err) {
        logger.logError(err, { operation: 'v3-get-rules' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/rules', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const rule = await dietService.addRule(userId, req.body);
        res.json(rule);
    } catch (err) {
        logger.logError(err, { operation: 'v3-add-rule' });
        res.status(500).json({ error: err.message });
    }
});

router.delete('/rules/:id', async (req, res) => {
    try {
        const userId = req.query.user_id || req.body.user_id;
        await dietService.deleteRule(userId, req.params.id);
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'v3-delete-rule' });
        res.status(500).json({ error: err.message });
    }
});

// Update nutrition on a diet entry
router.put('/entries/:id/nutrition', async (req, res) => {
    try {
        const userId = req.userId || req.query.user_id || req.body.user_id;
        const item = await dietService.updateNutrition(userId, req.params.id, req.body);
        res.json({ success: true, item });
    } catch (err) {
        logger.logError(err, { operation: 'v3-update-nutrition' });
        res.status(500).json({ error: err.message });
    }
});

// Delete a diet entry
router.delete('/entries/:id', async (req, res) => {
    try {
        const userId = req.userId || req.query.user_id;
        await dietService.deleteEntry(userId, req.params.id);
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'v3-delete-entry' });
        res.status(500).json({ error: err.message });
    }
});

// ─── Goals ──────────────────────────────────────────
router.get('/goals', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const goals = await dietService.getGoals(userId);
        res.json({ goals });
    } catch (err) {
        logger.logError(err, { operation: 'v3-get-goals' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/goals', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { nutrient, value } = req.body;
        if (!nutrient || value == null) return res.status(400).json({ error: 'nutrient and value required' });
        const goal = await dietService.upsertGoal(userId, nutrient, value);
        res.json(goal);
    } catch (err) {
        logger.logError(err, { operation: 'v3-upsert-goal' });
        res.status(500).json({ error: err.message });
    }
});

// ─── Food Search ────────────────────────────────────
router.get('/search', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const q = (req.query.q || '').trim();
        if (!q) return res.json({ results: [] });
        const results = await dietService.searchFoods(userId, q);
        res.json({ results });
    } catch (err) {
        logger.logError(err, { operation: 'v3-food-search' });
        res.status(500).json({ error: err.message });
    }
});

// ─── Recent Foods ───────────────────────────────────
router.get('/recent', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const limit = parseInt(req.query.limit) || 10;
        const foods = await dietService.getRecentFoods(userId, limit);
        res.json({ foods });
    } catch (err) {
        logger.logError(err, { operation: 'v3-recent-foods' });
        res.status(500).json({ error: err.message });
    }
});

// ─── Barcode Scanning ───────────────────────────────
router.get('/barcode/:code', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const result = await dietService.lookupBarcode(userId, req.params.code);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'v3-barcode-lookup' });
        res.status(500).json({ error: err.message });
    }
});

// ─── Saved Meals ────────────────────────────────────
router.get('/meals', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const meals = await dietService.getSavedMeals(userId);
        res.json({ meals });
    } catch (err) {
        logger.logError(err, { operation: 'v3-get-meals' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/meals', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const meal = await dietService.saveMeal(userId, req.body);
        res.json(meal);
    } catch (err) {
        logger.logError(err, { operation: 'v3-save-meal' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/meals/save-current', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { name, meal_type, date } = req.body;
        if (!name || !meal_type) return res.status(400).json({ error: 'name and meal_type required' });
        const meal = await dietService.saveCurrentMeal(userId, name, meal_type, date);
        res.json(meal);
    } catch (err) {
        logger.logError(err, { operation: 'v3-save-current-meal' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/meals/:id/log', async (req, res) => {
    try {
        const userId = req.body.user_id || req.query.user_id;
        const date = req.body.date;
        const result = await dietService.logSavedMeal(userId, req.params.id, date);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'v3-log-meal' });
        res.status(500).json({ error: err.message });
    }
});

router.delete('/meals/:id', async (req, res) => {
    try {
        const userId = req.query.user_id || req.body.user_id;
        await dietService.deleteSavedMeal(userId, req.params.id);
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'v3-delete-meal' });
        res.status(500).json({ error: err.message });
    }
});

// Diet chat
router.post('/chat', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { message, conversation_history, learn_from_chat, client_date } = req.body;
        if (!message) return res.status(400).json({ error: 'message is required' });

        const result = await dietService.chat(userId, message, {
            conversation_history, learn_from_chat, client_date
        });
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'v3-chat' });
        res.status(500).json({ error: 'Chat failed', message: err.message });
    }
});

module.exports = router;
