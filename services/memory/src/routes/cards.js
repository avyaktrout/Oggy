const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { generateCardEmbedding, EMBEDDING_MODEL } = require('../utils/embeddings');

module.exports = (pool, redisClient) => {
  const router = express.Router();

  /**
   * POST /cards
   * Create a new memory card
   */
  router.post('/', async (req, res, next) => {
    try {
      const {
        owner_type = 'user',
        owner_id,
        tier = 1,
        kind = 'fact',
        content,
        tags = [],
        utility_weight = 0.0,
        reliability = 1.0,
      } = req.body;

      // Validation
      if (!owner_id) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'owner_id is required',
            details: { field: 'owner_id' },
          },
        });
      }

      if (!content) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'content is required',
            details: { field: 'content' },
          },
        });
      }

      const query = `
        INSERT INTO memory_cards (
          owner_type, owner_id, tier, kind, content, tags,
          utility_weight, reliability
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING
          card_id, owner_type, owner_id, tier, status, kind,
          content, tags, utility_weight, reliability, created_at
      `;

      const normalizedTags = Array.isArray(tags) ? [...tags] : [];
      let normalizedContent = content;

      // Safeguard: correction cards should always be retrievable for categorization
      if (kind === 'expense_category_correction') {
        if (!normalizedTags.includes('categorization')) normalizedTags.push('categorization');
        if (!normalizedTags.includes('payments')) normalizedTags.push('payments');
        if (normalizedContent && typeof normalizedContent === 'object' && !normalizedContent.type) {
          normalizedContent = { ...normalizedContent, type: 'BENCHMARK_CORRECTION' };
        }
      }

      const values = [
        owner_type,
        owner_id,
        tier,
        kind,
        JSON.stringify(normalizedContent),
        normalizedTags,
        utility_weight,
        reliability,
      ];

      const result = await pool.query(query, values);
      let card = result.rows[0];

      // Generate embedding for the card
      try {
        const embedding = await generateCardEmbedding(card);

        // Update card with embedding
        const updateQuery = `
          UPDATE memory_cards
          SET embedding = $1,
              embedding_model = $2,
              embedding_generated_at = NOW()
          WHERE card_id = $3
          RETURNING *
        `;

        const updateResult = await pool.query(updateQuery, [
          JSON.stringify(embedding),
          EMBEDDING_MODEL,
          card.card_id,
        ]);

        card = updateResult.rows[0];
      } catch (embeddingError) {
        // Log error but don't fail card creation
        console.error('Failed to generate embedding for card:', card.card_id, embeddingError.message);
      }

      res.status(201).json({
        card_id: card.card_id,
        created_at: card.created_at,
        card,
      });

    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /cards/:card_id
   * Get a specific card by ID
   */
  router.get('/:card_id', async (req, res, next) => {
    try {
      const { card_id } = req.params;

      const query = `
        SELECT * FROM memory_cards WHERE card_id = $1
      `;

      const result = await pool.query(query, [card_id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Card not found',
            details: { card_id },
          },
        });
      }

      res.json(result.rows[0]);

    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /cards/:card_id/audits
   * Get audit history for a specific card
   */
  router.get('/:card_id/audits', async (req, res, next) => {
    try {
      const { card_id } = req.params;
      const limit = parseInt(req.query.limit) || 50;

      const query = `
        SELECT * FROM memory_audit_events
        WHERE card_id = $1
        ORDER BY ts DESC
        LIMIT $2
      `;

      const result = await pool.query(query, [card_id, limit]);

      res.json({
        card_id,
        audit_count: result.rows.length,
        audits: result.rows,
      });

    } catch (error) {
      next(error);
    }
  });

  return router;
};
