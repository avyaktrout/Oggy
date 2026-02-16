/**
 * Receipt Analyzer — Extracts payment and food data from receipt images/PDFs via vision LLM.
 */

const providerResolver = require('../providers/providerResolver');
const { costGovernor } = require('../middleware/costGovernor');
const logger = require('../utils/logger');

const SYSTEM_PROMPT = `You are a receipt analysis assistant. Extract structured data from receipt images.

Return ONLY valid JSON (no markdown, no explanation) with this exact schema:
{
  "merchant": "Store/restaurant name",
  "total_amount": 12.50,
  "transaction_date": "YYYY-MM-DD or null if not visible",
  "items": [
    { "name": "Item name", "price": 3.50, "quantity": 1 }
  ],
  "is_food_receipt": true,
  "food_items": [
    { "name": "Detailed food description (include ingredients/toppings if visible)", "estimated_calories": 500, "meal_type_guess": "lunch" }
  ],
  "category_suggestion": "dining"
}

Rules:
- "items" lists every line item on the receipt with price and quantity
- "total_amount" is the final total (after tax/tip if shown)
- "is_food_receipt" is true if the receipt is from a restaurant, cafe, grocery store, or food vendor
- "food_items" is only populated when is_food_receipt is true — describe each food/drink item in enough detail for nutritional estimation
- "meal_type_guess" should be one of: breakfast, lunch, dinner, snack (guess from time on receipt or food type)
- "category_suggestion" should be one of: dining, groceries, coffee, entertainment, shopping, transportation, utilities, health, other
- If the image is not a receipt or is unreadable, return: { "error": "Could not read receipt", "merchant": null, "total_amount": null, "items": [], "is_food_receipt": false, "food_items": [], "category_suggestion": "other" }
- transaction_date must be in YYYY-MM-DD format. If only partial date visible, infer the full date.`;

class ReceiptAnalyzer {
    async analyzeReceipt(userId, imageBase64, mimeType) {
        if (!imageBase64 || !mimeType) {
            throw new Error('image_base64 and mime_type are required');
        }

        // Size guard: ~10MB decoded
        if (imageBase64.length > 14_000_000) {
            throw new Error('Image too large (max ~10MB)');
        }

        await costGovernor.checkBudget(5000);

        const resolved = await providerResolver.getAdapter(userId, 'oggy');

        const userContent = [
            {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'low' }
            },
            {
                type: 'text',
                text: 'Extract all data from this receipt. Return JSON only.'
            }
        ];

        const r = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userContent }
            ],
            temperature: 0.2,
            max_tokens: 2000,
            timeout: 60000
        });

        costGovernor.recordUsage(r.tokens_used || 2000);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'receiptAnalysis', r.tokens_used, r.latency_ms, true, null);

        // Parse JSON response
        return this._parseResponse(r.text);
    }

    _parseResponse(text) {
        const trimmed = (text || '').trim();

        // Try direct parse
        try {
            if (trimmed.startsWith('{')) return JSON.parse(trimmed);
        } catch (_) {}

        // Try extracting from markdown code block
        try {
            const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (match) return JSON.parse(match[1].trim());
        } catch (_) {}

        // Try finding JSON object in text
        try {
            const objMatch = trimmed.match(/\{[\s\S]*\}/);
            if (objMatch) return JSON.parse(objMatch[0]);
        } catch (_) {}

        logger.warn('Receipt analyzer: failed to parse LLM response', { response: trimmed.substring(0, 200) });
        return {
            error: 'Failed to parse receipt data',
            merchant: null,
            total_amount: null,
            items: [],
            is_food_receipt: false,
            food_items: [],
            category_suggestion: 'other'
        };
    }
}

module.exports = new ReceiptAnalyzer();
