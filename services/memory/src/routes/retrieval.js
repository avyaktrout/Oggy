const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { generateEmbedding, cosineSimilarity } = require('../utils/embeddings');

module.exports = (pool, redisClient) => {
  const router = express.Router();

  /**
   * POST /retrieve
   * Retrieve top-k memory cards based on query
   * Creates a retrieval trace for auditability
   */
  router.post('/', async (req, res, next) => {
    try {
      const {
        agent,
        owner_type,
        owner_id,
        query,
        top_k = 10,
        tier_scope,
        tag_filter,
        include_scores = false,
      } = req.body;

      // Validation
      if (!agent) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'agent is required',
            details: { field: 'agent' },
          },
        });
      }

      if (!owner_type || !owner_id) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'owner_type and owner_id are required',
            details: { fields: ['owner_type', 'owner_id'] },
          },
        });
      }

      // Build query - fetch candidates (more than top_k for better ranking)
      let queryText = `
        SELECT
          card_id, owner_type, owner_id, tier, status, kind,
          content, tags, utility_weight, reliability,
          usage_count, success_count, failure_count,
          created_at, updated_at, last_accessed_at,
          embedding, embedding_model, embedding_generated_at
        FROM memory_cards
        WHERE owner_type = $1 AND owner_id = $2 AND status = 'active'
      `;

      const queryParams = [owner_type, owner_id];
      let paramIndex = 3;

      // Apply tier filter if provided
      if (tier_scope && Array.isArray(tier_scope)) {
        queryText += ` AND tier = ANY($${paramIndex})`;
        queryParams.push(tier_scope);
        paramIndex++;
      }

      // Apply tag filter if provided
      if (tag_filter && Array.isArray(tag_filter)) {
        queryText += ` AND tags && $${paramIndex}`;
        queryParams.push(tag_filter);
        paramIndex++;
      }

      // Fetch more candidates for better ranking (3x top_k or at least 50)
      const candidateLimit = Math.max(top_k * 3, 50);
      queryText += ` ORDER BY utility_weight DESC, created_at DESC LIMIT $${paramIndex}`;
      queryParams.push(candidateLimit);

      const result = await pool.query(queryText, queryParams);
      let candidates = result.rows;

      // Smart retrieval with embeddings
      let queryEmbedding = null;
      if (query && query.trim().length > 0) {
        try {
          queryEmbedding = await generateEmbedding(query);
        } catch (embeddingError) {
          console.error('Failed to generate query embedding:', embeddingError.message);
          // Fall back to utility-only ranking
        }
      }

      // Calculate final scores
      candidates = candidates.map(card => {
        let similarity = 0;

        // Calculate semantic similarity if both query and card have embeddings
        if (queryEmbedding && card.embedding) {
          try {
            // Handle both pre-parsed (from pg) and stringified embeddings
            let cardEmbedding = card.embedding;

            // If it's a string, parse it; if already an array, use it
            if (typeof cardEmbedding === 'string') {
              cardEmbedding = JSON.parse(cardEmbedding);
            }

            similarity = cosineSimilarity(queryEmbedding, cardEmbedding);
          } catch (err) {
            console.error('Failed to calculate similarity for card:', card.card_id, err.message);
          }
        }

        // Normalize utility_weight to 0-1 range (assuming max is 1.0)
        const normalizedUtility = Math.max(0, Math.min(1, card.utility_weight));

        // Combine: 70% semantic similarity + 30% utility weight
        // If no query embedding, use 100% utility weight
        const final_score = queryEmbedding
          ? (0.7 * similarity) + (0.3 * normalizedUtility)
          : normalizedUtility;

        return {
          ...card,
          similarity_score: similarity,
          final_score,
        };
      });

      // Sort by final score and take top_k
      candidates.sort((a, b) => b.final_score - a.final_score);
      const selected = candidates.slice(0, top_k);

      // Remove embedding field from response (it's large and not needed)
      selected.forEach(card => {
        delete card.embedding;
      });

      // Create retrieval trace for auditability
      const trace_id = uuidv4();
      const selected_card_ids = selected.map(card => card.card_id);

      // Build score map with embedding-based scores
      const score_map = {};
      selected.forEach(card => {
        score_map[card.card_id] = {
          final_score: card.final_score,
          similarity_score: card.similarity_score,
          utility_weight: card.utility_weight,
          reliability: card.reliability,
        };
      });

      await pool.query(
        `INSERT INTO retrieval_traces (
          trace_id, agent, owner_type, owner_id, query,
          selected_card_ids, top_k, score_map
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          trace_id,
          agent,
          owner_type,
          owner_id,
          query || null,
          selected_card_ids,
          top_k,
          JSON.stringify(score_map),
        ]
      );

      // Update last_accessed_at for retrieved cards
      if (selected_card_ids.length > 0) {
        await pool.query(
          `UPDATE memory_cards
           SET last_accessed_at = NOW()
           WHERE card_id = ANY($1)`,
          [selected_card_ids]
        );
      }

      res.json({
        trace_id,
        selected,
        top_k,
        count: selected.length,
        scores: include_scores ? score_map : undefined,
      });

    } catch (error) {
      next(error);
    }
  });

  return router;
};
