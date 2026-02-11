/**
 * xAI Grok Provider Adapter
 * Grok uses an OpenAI-compatible API at api.x.ai.
 */

const axios = require('axios');
const ProviderAdapter = require('./providerAdapter');

class GrokAdapter extends ProviderAdapter {
    constructor(apiKey) {
        super(apiKey, 'grok');
        this.baseUrl = 'https://api.x.ai/v1';
    }

    async chatCompletion({ model, messages, temperature = 0.7, max_tokens = 1000, timeout = 30000 }) {
        const start = Date.now();
        const response = await axios.post(`${this.baseUrl}/chat/completions`, {
            model,
            messages,
            temperature,
            max_tokens
        }, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` },
            timeout
        });

        const choice = response.data.choices[0];
        const usage = response.data.usage || {};

        return {
            text: choice.message.content.trim(),
            tokens_used: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
            latency_ms: Date.now() - start
        };
    }

    async validateKey() {
        try {
            await axios.get(`${this.baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                timeout: 10000
            });
            return { valid: true };
        } catch (err) {
            const status = err.response?.status;
            if (status === 401) return { valid: false, error: 'Invalid API key' };
            if (status === 429) return { valid: true, error: 'Rate limited but key is valid' };
            return { valid: false, error: err.message };
        }
    }

    async listModels() {
        return [
            { model_id: 'grok-2', display_name: 'Grok 2' },
            { model_id: 'grok-2-mini', display_name: 'Grok 2 Mini' }
        ];
    }
}

module.exports = GrokAdapter;
