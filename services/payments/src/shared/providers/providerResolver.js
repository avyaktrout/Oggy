/**
 * Provider Resolver — Central resolver for getting the right adapter + model.
 *
 * getAdapter(userId, role) returns { adapter, model, provider, isUserKey }
 *   role = 'oggy' or 'base'
 *
 * Resolution order:
 *   1. User's chosen provider/model from user_model_settings
 *   2. User's API key for that provider (decrypted from user_provider_secrets)
 *   3. Fall back to system env var key if user has no key for that provider
 *   4. Fall back to default provider (openai) with system key if nothing configured
 */

const { query } = require('../utils/db');
const { decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');

const OpenAIAdapter = require('./openaiAdapter');
const AnthropicAdapter = require('./anthropicAdapter');
const GeminiAdapter = require('./geminiAdapter');
const GrokAdapter = require('./grokAdapter');

// In-memory cache for user settings (5 min TTL)
const settingsCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Map provider name → { AdapterClass, envKeyName, defaultModel }
const PROVIDER_MAP = {
    openai: {
        AdapterClass: OpenAIAdapter,
        envKey: 'OPENAI_API_KEY',
        defaultModel: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    },
    anthropic: {
        AdapterClass: AnthropicAdapter,
        envKey: 'ANTHROPIC_API_KEY',
        defaultModel: 'claude-sonnet-4-5-20250929'
    },
    gemini: {
        AdapterClass: GeminiAdapter,
        envKey: 'GOOGLE_AI_KEY',
        defaultModel: 'gemini-2.0-flash'
    },
    grok: {
        AdapterClass: GrokAdapter,
        envKey: 'XAI_API_KEY',
        defaultModel: 'grok-2'
    }
};

/**
 * Get adapter + model for a user/role combination.
 * @param {string} userId
 * @param {'oggy'|'base'} role
 * @returns {{ adapter: ProviderAdapter, model: string, provider: string, isUserKey: boolean }}
 */
async function getAdapter(userId, role = 'oggy') {
    // 1. Load user settings (cached)
    const settings = await _getUserSettings(userId);

    // 2. Determine provider and model
    let provider, model;
    if (role === 'oggy') {
        provider = settings?.oggy_provider || 'openai';
        model = settings?.oggy_model || null;
    } else {
        provider = settings?.base_provider || 'openai';
        model = settings?.base_model || null;
    }

    const providerConfig = PROVIDER_MAP[provider];
    if (!providerConfig) {
        // Unknown provider, fall back to openai
        logger.warn('Unknown provider, falling back to openai', { provider, userId, role });
        return _buildFallback(role);
    }

    // Use default model if none specified
    if (!model) model = providerConfig.defaultModel;

    // 3. Try user's own key first
    const userKey = await _getUserKey(userId, provider);
    if (userKey) {
        return {
            adapter: new providerConfig.AdapterClass(userKey),
            model,
            provider,
            isUserKey: true
        };
    }

    // 4. Fall back to system env var key
    const systemKey = process.env[providerConfig.envKey];
    if (systemKey) {
        return {
            adapter: new providerConfig.AdapterClass(systemKey),
            model,
            provider,
            isUserKey: false
        };
    }

    // 5. Provider has no key at all — fall back to openai system key
    logger.warn('No key for provider, falling back to openai', { provider, userId, role });
    return _buildFallback(role);
}

function _buildFallback(role) {
    const openaiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    return {
        adapter: new OpenAIAdapter(openaiKey),
        model,
        provider: 'openai',
        isUserKey: false
    };
}

async function _getUserSettings(userId) {
    const cached = settingsCache.get(userId);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return cached.data;
    }

    try {
        const result = await query(
            'SELECT oggy_provider, oggy_model, base_provider, base_model FROM user_model_settings WHERE user_id = $1',
            [userId]
        );
        const data = result.rows[0] || null;
        settingsCache.set(userId, { data, ts: Date.now() });
        return data;
    } catch (err) {
        logger.debug('Failed to load user model settings', { userId, error: err.message });
        return null;
    }
}

async function _getUserKey(userId, provider) {
    try {
        const result = await query(
            'SELECT encrypted_key FROM user_provider_secrets WHERE user_id = $1 AND provider = $2',
            [userId, provider]
        );
        if (result.rows.length === 0) return null;
        return decrypt(result.rows[0].encrypted_key);
    } catch (err) {
        logger.debug('Failed to decrypt user key', { userId, provider, error: err.message });
        return null;
    }
}

/**
 * Create an adapter for a specific provider with a given key.
 * Used for key validation (no user context needed).
 */
function createAdapter(provider, apiKey) {
    const config = PROVIDER_MAP[provider];
    if (!config) throw new Error(`Unknown provider: ${provider}`);
    return new config.AdapterClass(apiKey);
}

/**
 * Invalidate cached settings for a user (call after settings change).
 */
function invalidateCache(userId) {
    settingsCache.delete(userId);
}

/**
 * Log an API request to the audit table (non-blocking).
 */
async function logRequest(userId, provider, model, role, service, tokensUsed, latencyMs, success, errorMessage) {
    try {
        await query(
            `INSERT INTO model_request_audit (user_id, provider, model, role, service, tokens_used, latency_ms, success, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [userId, provider, model, role, service, tokensUsed, latencyMs, success, errorMessage || null]
        );
    } catch (err) {
        // Non-critical
        logger.debug('Audit log failed', { error: err.message });
    }
}

module.exports = { getAdapter, createAdapter, invalidateCache, logRequest, PROVIDER_MAP };
