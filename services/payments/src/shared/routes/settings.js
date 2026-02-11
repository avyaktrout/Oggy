/**
 * Settings Routes - BYO-Model configuration
 * All routes require authentication (applied at mount point).
 */

const express = require('express');
const router = express.Router();
const modelSettingsService = require('../services/modelSettingsService');
const logger = require('../utils/logger');

// GET /v0/settings/model — Get user's model config + key hints
router.get('/model', async (req, res) => {
    try {
        const data = await modelSettingsService.getSettings(req.userId);
        res.json(data);
    } catch (error) {
        logger.logError(error, { operation: 'get-model-settings', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get settings' });
    }
});

// PUT /v0/settings/model — Update provider/model selections
router.put('/model', async (req, res) => {
    try {
        const { oggy_provider, oggy_model, base_provider, base_model } = req.body;
        await modelSettingsService.updateSettings(req.userId, {
            oggy_provider, oggy_model, base_provider, base_model
        });
        res.json({ success: true });
    } catch (error) {
        logger.logError(error, { operation: 'update-model-settings', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// POST /v0/settings/provider-key — Save encrypted API key
router.post('/provider-key', async (req, res) => {
    try {
        const { provider, api_key } = req.body;
        if (!provider || !api_key) {
            return res.status(400).json({ error: 'provider and api_key are required' });
        }

        const validProviders = ['openai', 'anthropic', 'gemini', 'grok'];
        if (!validProviders.includes(provider)) {
            return res.status(400).json({ error: 'Invalid provider' });
        }

        const result = await modelSettingsService.saveProviderKey(req.userId, provider, api_key);
        res.json({ success: true, hint: result.hint });
    } catch (error) {
        logger.logError(error, { operation: 'save-provider-key', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to save key' });
    }
});

// DELETE /v0/settings/provider-key — Remove provider key
router.delete('/provider-key', async (req, res) => {
    try {
        const { provider } = req.body;
        if (!provider) {
            return res.status(400).json({ error: 'provider is required' });
        }

        const removed = await modelSettingsService.removeProviderKey(req.userId, provider);
        if (!removed) {
            return res.status(404).json({ error: 'No key found for this provider' });
        }
        res.json({ success: true });
    } catch (error) {
        logger.logError(error, { operation: 'remove-provider-key', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to remove key' });
    }
});

// POST /v0/settings/validate-key — Test key validity
router.post('/validate-key', async (req, res) => {
    try {
        const { provider } = req.body;
        if (!provider) {
            return res.status(400).json({ error: 'provider is required' });
        }

        const result = await modelSettingsService.validateKey(req.userId, provider);
        res.json(result);
    } catch (error) {
        logger.logError(error, { operation: 'validate-key', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to validate key' });
    }
});

// GET /v0/settings/providers — List providers + models for dropdowns
router.get('/providers', async (req, res) => {
    try {
        const providers = await modelSettingsService.getProviders();
        res.json({ providers });
    } catch (error) {
        logger.logError(error, { operation: 'get-providers', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get providers' });
    }
});

module.exports = router;
