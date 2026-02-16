/**
 * Anthropic (Claude) Provider Adapter
 * Different API format: system prompt is separate, messages use different structure.
 * Supports vision via content arrays with image blocks.
 */

const axios = require('axios');
const ProviderAdapter = require('./providerAdapter');

class AnthropicAdapter extends ProviderAdapter {
    constructor(apiKey) {
        super(apiKey, 'anthropic');
        this.baseUrl = 'https://api.anthropic.com/v1';
    }

    /**
     * Convert OpenAI-style content array to Anthropic format.
     * Handles both string content and array content (for vision).
     */
    _convertContent(content) {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return String(content || '');

        return content.map(part => {
            if (part.type === 'text') {
                return { type: 'text', text: part.text };
            }
            if (part.type === 'image_url' && part.image_url?.url) {
                // Parse data URL: "data:image/jpeg;base64,/9j/4AAQ..."
                const url = part.image_url.url;
                const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/s);
                if (dataMatch) {
                    return {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: dataMatch[1],
                            data: dataMatch[2]
                        }
                    };
                }
                // URL-based image (not base64)
                return { type: 'image', source: { type: 'url', url } };
            }
            // Fallback: treat as text
            return { type: 'text', text: JSON.stringify(part) };
        });
    }

    async chatCompletion({ model, messages, temperature = 0.7, max_tokens = 1000, timeout = 30000 }) {
        const start = Date.now();

        // Extract system prompt from messages (Anthropic keeps it separate)
        let system = '';
        const chatMessages = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                // Only extract text from system messages
                if (typeof msg.content === 'string') {
                    system += (system ? '\n' : '') + msg.content;
                }
            } else {
                chatMessages.push({
                    role: msg.role,
                    content: this._convertContent(msg.content)
                });
            }
        }

        // Ensure messages alternate user/assistant (Anthropic requirement)
        const cleaned = this._ensureAlternating(chatMessages);

        const body = {
            model,
            max_tokens,
            temperature,
            messages: cleaned
        };
        if (system) body.system = system;

        const response = await axios.post(`${this.baseUrl}/messages`, body, {
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            timeout
        });

        const text = response.data.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');

        const usage = response.data.usage || {};

        return {
            text: text.trim(),
            tokens_used: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            latency_ms: Date.now() - start
        };
    }

    /**
     * Ensure messages alternate between user and assistant.
     * Merge consecutive same-role messages. Handles both string and array content.
     */
    _ensureAlternating(messages) {
        if (messages.length === 0) return [{ role: 'user', content: '' }];

        const result = [];
        for (const msg of messages) {
            if (result.length > 0 && result[result.length - 1].role === msg.role) {
                const prev = result[result.length - 1];
                // Normalize both to arrays and concatenate
                const prevArr = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content }];
                const currArr = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
                prev.content = [...prevArr, ...currArr];
            } else {
                result.push({ ...msg });
            }
        }

        // Must start with user
        if (result[0].role !== 'user') {
            result.unshift({ role: 'user', content: '(continued conversation)' });
        }

        return result;
    }

    async validateKey() {
        try {
            // Minimal request to check key validity
            await axios.post(`${this.baseUrl}/messages`, {
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }]
            }, {
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                },
                timeout: 15000
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
        // Anthropic doesn't have a list models endpoint; return from registry
        return [
            { model_id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5' },
            { model_id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
            { model_id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' }
        ];
    }
}

module.exports = AnthropicAdapter;
