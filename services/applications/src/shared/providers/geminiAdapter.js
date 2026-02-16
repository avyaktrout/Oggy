/**
 * Google Gemini Provider Adapter
 * Uses generateContent endpoint with API key in URL.
 * Supports vision via content arrays with inline_data parts.
 */

const axios = require('axios');
const ProviderAdapter = require('./providerAdapter');

class GeminiAdapter extends ProviderAdapter {
    constructor(apiKey) {
        super(apiKey, 'gemini');
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    }

    /**
     * Convert OpenAI-style content (string or array) to Gemini parts format.
     */
    _contentToParts(content) {
        if (typeof content === 'string') return [{ text: content }];
        if (!Array.isArray(content)) return [{ text: String(content || '') }];

        return content.map(part => {
            if (part.type === 'text') {
                return { text: part.text };
            }
            if (part.type === 'image_url' && part.image_url?.url) {
                const url = part.image_url.url;
                const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/s);
                if (dataMatch) {
                    return { inline_data: { mime_type: dataMatch[1], data: dataMatch[2] } };
                }
                // For URL-based images, include as text fallback
                return { text: `[Image: ${url}]` };
            }
            return { text: JSON.stringify(part) };
        });
    }

    async chatCompletion({ model, messages, temperature = 0.7, max_tokens = 1000, timeout = 30000 }) {
        const start = Date.now();

        // Convert OpenAI-style messages to Gemini format
        let systemInstruction = '';
        const contents = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                if (typeof msg.content === 'string') {
                    systemInstruction += (systemInstruction ? '\n' : '') + msg.content;
                }
            } else {
                contents.push({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: this._contentToParts(msg.content)
                });
            }
        }

        // Ensure contents is not empty and starts with user
        if (contents.length === 0) {
            contents.push({ role: 'user', parts: [{ text: '' }] });
        }

        const body = {
            contents,
            generationConfig: {
                temperature,
                maxOutputTokens: max_tokens
            }
        };

        if (systemInstruction) {
            body.systemInstruction = { parts: [{ text: systemInstruction }] };
        }

        const response = await axios.post(
            `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`,
            body,
            { timeout }
        );

        const candidate = response.data.candidates?.[0];
        const text = candidate?.content?.parts?.map(p => p.text).join('') || '';
        const usage = response.data.usageMetadata || {};

        return {
            text: text.trim(),
            tokens_used: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
            latency_ms: Date.now() - start
        };
    }

    async validateKey() {
        try {
            await axios.get(
                `${this.baseUrl}/models?key=${this.apiKey}`,
                { timeout: 10000 }
            );
            return { valid: true };
        } catch (err) {
            const status = err.response?.status;
            if (status === 400 || status === 403) return { valid: false, error: 'Invalid API key' };
            if (status === 429) return { valid: true, error: 'Rate limited but key is valid' };
            return { valid: false, error: err.message };
        }
    }

    async listModels() {
        try {
            const response = await axios.get(
                `${this.baseUrl}/models?key=${this.apiKey}`,
                { timeout: 10000 }
            );
            return (response.data.models || [])
                .filter(m => m.name.includes('gemini'))
                .map(m => ({
                    model_id: m.name.replace('models/', ''),
                    display_name: m.displayName
                }));
        } catch {
            return [
                { model_id: 'gemini-2.0-flash', display_name: 'Gemini 2.0 Flash' },
                { model_id: 'gemini-2.0-pro', display_name: 'Gemini 2.0 Pro' }
            ];
        }
    }
}

module.exports = GeminiAdapter;
