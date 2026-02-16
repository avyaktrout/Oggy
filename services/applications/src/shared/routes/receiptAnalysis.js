/**
 * Receipt Analysis Route — POST /v0/receipt/analyze
 * Accepts base64 image/PDF, returns structured receipt data.
 */

const express = require('express');
const router = express.Router();
const receiptAnalyzer = require('../services/receiptAnalyzer');
const logger = require('../utils/logger');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

router.post('/analyze', async (req, res) => {
    try {
        const userId = req.userId;
        const { image_base64, mime_type } = req.body;

        if (!image_base64) {
            return res.status(400).json({ error: 'image_base64 is required' });
        }
        if (!mime_type || !ALLOWED_TYPES.includes(mime_type)) {
            return res.status(400).json({ error: `mime_type must be one of: ${ALLOWED_TYPES.join(', ')}` });
        }

        const result = await receiptAnalyzer.analyzeReceipt(userId, image_base64, mime_type);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'receipt-analyze' });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
