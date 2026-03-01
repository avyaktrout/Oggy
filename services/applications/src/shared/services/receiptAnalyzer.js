/**
 * Receipt Analyzer — Extracts payment and food data from receipt images/PDFs via vision LLM.
 */

const providerResolver = require('../providers/providerResolver');
const { costGovernor } = require('../middleware/costGovernor');
const logger = require('../utils/logger');

const SYSTEM_PROMPT = `You are a receipt analysis assistant. Extract structured data from receipt images with high accuracy.

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
    {
      "name": "Detailed food description",
      "quantity": 1,
      "unit": "piece",
      "estimated_calories": 500,
      "meal_type_guess": "lunch",
      "is_liquid": false,
      "confidence": "high"
    }
  ],
  "category_suggestion": "dining"
}

Rules:
- "items" lists every line item on the receipt with price and quantity
- "total_amount" is the final total (after tax/tip if shown)
- "is_food_receipt" is true if the receipt is from a restaurant, cafe, grocery store, or food vendor
- "food_items" is only populated when is_food_receipt is true
- For each food_item:
  - "name": full descriptive name — expand abbreviations, include size/ingredients/modifications if visible (e.g. "LG CHKN WRAP" → "Large Chicken Wrap")
  - "quantity": numeric count from receipt (e.g. "2x Hot Dog" → quantity: 2). Default to 1 if not shown
  - "unit": appropriate unit — "piece", "oz", "g", "ml", "cup", "serving", "slice", "bottle", "can". Use "serving" when unclear
  - "estimated_calories": total for the stated quantity
  - "meal_type_guess": one of breakfast, lunch, dinner, snack (infer from time on receipt or food type)
  - "is_liquid": true for any drink, beverage, coffee, tea, juice, soda, smoothie, milkshake, alcohol, water, soup; false for solid food
  - "confidence": "high" if item name is clearly readable, "medium" if partially readable or abbreviated, "low" if guessed
- Combo/meal handling: decompose combo meals into individual components if listed on receipt (e.g. "#1 Combo" with burger, fries, drink listed separately). If not decomposed on receipt, list as one item with all components in the name
- Common receipt abbreviations: LG/LRG=large, SM/SML=small, MD/MED=medium, XL=extra large, CHKN/CKN=chicken, DBL=double, REG=regular, ADD=added topping, W/=with, W/O=without, CRISPY=crispy, GRLD=grilled, FF/FRY=fries, BEV=beverage, DK/DRK=drink, JR=junior, SR=senior/large, ORIG=original, SPCY=spicy, CHZ=cheese, BF=beef, VEG=vegetable
- "category_suggestion" should be one of: dining, groceries, coffee, entertainment, shopping, transportation, utilities, health, other
- If the image is not a receipt or is unreadable, return: { "error": "Could not read receipt", "merchant": null, "total_amount": null, "items": [], "is_food_receipt": false, "food_items": [], "category_suggestion": "other" }
- transaction_date must be in YYYY-MM-DD format. If only partial date visible, infer the full date

ACCURACY — READ CAREFULLY:
- DOUBLE-CHECK every number you extract. Re-read prices character by character. Common OCR mistakes: $11.50 misread as $1.50 or $115.0, $8.99 misread as $899, 1 misread as 7, 5 misread as 6
- Re-read the merchant name letter by letter if it is partially obscured or stylized
- The total_amount MUST equal or closely match the sum of item prices (plus tax/tip). If they don't match, re-examine the items
- For item quantities: look for "x", "×", or a leading number (e.g. "2 Hot Dog"). Do not confuse item codes or SKUs with quantities
- If a price seems implausibly high or low for the item (e.g. $85 for a coffee), re-examine — you likely misread a digit`;

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
                image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' }
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
            max_tokens: 2500,
            timeout: 60000
        });

        costGovernor.recordUsage(r.tokens_used || 2000);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'receiptAnalysis', r.tokens_used, r.latency_ms, true, null);

        // Parse JSON response
        const parsed = this._parseResponse(r.text);

        // Cross-check: verify item prices sum roughly to total
        if (parsed.items && parsed.items.length > 0 && parsed.total_amount) {
            const itemSum = parsed.items.reduce((sum, it) => sum + ((it.price || 0) * (it.quantity || 1)), 0);
            const ratio = itemSum / parsed.total_amount;
            // If items sum is wildly off from total (excluding tax/tip which adds ~5-25%),
            // log a warning — the total from the receipt is more likely correct
            if (ratio < 0.5 || ratio > 1.5) {
                logger.warn('Receipt analyzer: item sum vs total mismatch', {
                    itemSum: itemSum.toFixed(2),
                    total: parsed.total_amount,
                    ratio: ratio.toFixed(2)
                });
            }
        }

        return parsed;
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
