/**
 * Base Provider Adapter — unified interface for all LLM providers.
 * All adapters return { text, tokens_used, latency_ms } from chatCompletion().
 */

class ProviderAdapter {
    constructor(apiKey, providerName) {
        this.apiKey = apiKey;
        this.providerName = providerName;
    }

    /**
     * Send a chat completion request.
     * @param {Object} opts
     * @param {string} opts.model - Model ID
     * @param {Array} opts.messages - [{role, content}]
     * @param {number} opts.temperature
     * @param {number} opts.max_tokens
     * @param {number} opts.timeout - ms
     * @returns {{ text: string, tokens_used: number, latency_ms: number }}
     */
    async chatCompletion(opts) {
        throw new Error('chatCompletion() not implemented');
    }

    /**
     * Validate that the API key is working.
     * @returns {{ valid: boolean, error?: string }}
     */
    async validateKey() {
        throw new Error('validateKey() not implemented');
    }

    /**
     * List available models for this provider.
     * @returns {Array<{model_id, display_name}>}
     */
    async listModels() {
        throw new Error('listModels() not implemented');
    }
}

module.exports = ProviderAdapter;
