/**
 * Model Settings Service - CRUD for BYO-Model configuration
 * Handles provider secrets, model selection, and key validation.
 */

const { query } = require('../utils/db');
const logger = require('../utils/logger');
const { encrypt, decrypt, keyHint } = require('../utils/encryption');
const providerResolver = require('../providers/providerResolver');

class ModelSettingsService {
    /**
     * Get user's current model settings + key hints + connection status.
     */
    async getSettings(userId) {
        // Model selections
        const settingsResult = await query(
            'SELECT oggy_provider, oggy_model, base_provider, base_model, updated_at FROM user_model_settings WHERE user_id = $1',
            [userId]
        );
        const settings = settingsResult.rows[0] || {
            oggy_provider: null,
            oggy_model: null,
            base_provider: null,
            base_model: null
        };

        // Provider keys (hints only, never expose actual keys)
        const keysResult = await query(
            'SELECT provider, key_hint, is_valid, validated_at FROM user_provider_secrets WHERE user_id = $1',
            [userId]
        );
        const keys = {};
        for (const row of keysResult.rows) {
            keys[row.provider] = {
                has_key: true,
                key_hint: row.key_hint,
                is_valid: row.is_valid,
                validated_at: row.validated_at
            };
        }

        return { settings, keys };
    }

    /**
     * Update provider/model selections for Oggy and/or Base.
     */
    async updateSettings(userId, { oggy_provider, oggy_model, base_provider, base_model }) {
        await query(
            `INSERT INTO user_model_settings (user_id, oggy_provider, oggy_model, base_provider, base_model, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (user_id) DO UPDATE SET
               oggy_provider = COALESCE($2, user_model_settings.oggy_provider),
               oggy_model = COALESCE($3, user_model_settings.oggy_model),
               base_provider = COALESCE($4, user_model_settings.base_provider),
               base_model = COALESCE($5, user_model_settings.base_model),
               updated_at = now()`,
            [userId, oggy_provider, oggy_model, base_provider, base_model]
        );

        // Invalidate cached settings
        providerResolver.invalidateCache(userId);

        logger.info('Model settings updated', { userId, oggy_provider, oggy_model, base_provider, base_model });
    }

    /**
     * Save (encrypt) an API key for a provider.
     */
    async saveProviderKey(userId, provider, apiKey) {
        const encryptedKey = encrypt(apiKey);
        const hint = keyHint(apiKey);

        await query(
            `INSERT INTO user_provider_secrets (user_id, provider, encrypted_key, key_hint, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (user_id, provider) DO UPDATE SET
               encrypted_key = $3,
               key_hint = $4,
               is_valid = NULL,
               validated_at = NULL,
               updated_at = now()`,
            [userId, provider, encryptedKey, hint]
        );

        // Invalidate cached settings
        providerResolver.invalidateCache(userId);

        logger.info('Provider key saved', { userId, provider, hint });
        return { hint };
    }

    /**
     * Remove a provider key.
     */
    async removeProviderKey(userId, provider) {
        const result = await query(
            'DELETE FROM user_provider_secrets WHERE user_id = $1 AND provider = $2 RETURNING provider',
            [userId, provider]
        );

        providerResolver.invalidateCache(userId);

        return result.rows.length > 0;
    }

    /**
     * Validate a provider key by making a test API call.
     */
    async validateKey(userId, provider) {
        // Get the key
        const keyResult = await query(
            'SELECT encrypted_key FROM user_provider_secrets WHERE user_id = $1 AND provider = $2',
            [userId, provider]
        );
        if (keyResult.rows.length === 0) {
            return { valid: false, error: 'No key found for this provider' };
        }

        const apiKey = decrypt(keyResult.rows[0].encrypted_key);
        const adapter = providerResolver.createAdapter(provider, apiKey);
        const result = await adapter.validateKey();

        // Update validation status
        await query(
            'UPDATE user_provider_secrets SET is_valid = $3, validated_at = now() WHERE user_id = $1 AND provider = $2',
            [userId, provider, result.valid]
        );

        return result;
    }

    /**
     * List all available providers and their models from the registry.
     */
    async getProviders() {
        const result = await query(
            `SELECT provider, model_id, display_name, is_default, max_tokens
             FROM provider_model_registry
             ORDER BY provider, is_default DESC, display_name`
        );

        // Group by provider
        const providers = {};
        for (const row of result.rows) {
            if (!providers[row.provider]) {
                providers[row.provider] = {
                    provider: row.provider,
                    display_name: this._providerDisplayName(row.provider),
                    models: [],
                    has_system_key: this._hasSystemKey(row.provider)
                };
            }
            providers[row.provider].models.push({
                model_id: row.model_id,
                display_name: row.display_name,
                is_default: row.is_default,
                max_tokens: row.max_tokens
            });
        }

        return Object.values(providers);
    }

    _providerDisplayName(provider) {
        const map = { openai: 'OpenAI', anthropic: 'Anthropic (Claude)', gemini: 'Google Gemini', grok: 'xAI (Grok)' };
        return map[provider] || provider;
    }

    _hasSystemKey(provider) {
        const envMap = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GOOGLE_AI_KEY', grok: 'XAI_API_KEY' };
        return !!process.env[envMap[provider]];
    }
}

module.exports = new ModelSettingsService();
