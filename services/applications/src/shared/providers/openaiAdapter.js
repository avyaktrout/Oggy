/**
 * OpenAI Provider Adapter
 * Compatible with: OpenAI API (api.openai.com)
 */

const axios = require('axios');
const ProviderAdapter = require('./providerAdapter');

class OpenAIAdapter extends ProviderAdapter {
    constructor(apiKey) {
        super(apiKey, 'openai');
        this.baseUrl = 'https://api.openai.com/v1';
    }

    async chatCompletion({ model, messages, temperature = 0.7, max_tokens = 1000, timeout = 15000 }) {
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
        const response = await axios.get(`${this.baseUrl}/models`, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` },
            timeout: 10000
        });
        return response.data.data
            .filter(m => m.id.startsWith('gpt-'))
            .map(m => ({ model_id: m.id, display_name: m.id }));
    }
}

module.exports = OpenAIAdapter;
