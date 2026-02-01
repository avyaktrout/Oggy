/**
 * Embedding utilities for smart retrieval
 * Uses OpenAI text-embedding-3-small model
 */

const axios = require('axios');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Generate embedding for text using OpenAI API
 *
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} - Embedding vector
 */
async function generateEmbedding(text) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set');
  }

  if (!text || text.trim().length === 0) {
    throw new Error('Text cannot be empty');
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      {
        model: EMBEDDING_MODEL,
        input: text,
        encoding_format: 'float',
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const embedding = response.data.data[0].embedding;
    return embedding;
  } catch (error) {
    console.error('Error generating embedding:', error.message);
    throw new Error(`Embedding generation failed: ${error.message}`);
  }
}

/**
 * Generate embedding from memory card content
 *
 * @param {object} card - Memory card object
 * @returns {Promise<number[]>} - Embedding vector
 */
async function generateCardEmbedding(card) {
  // Combine relevant fields into text for embedding
  const textParts = [];

  // Add card kind
  if (card.kind) {
    textParts.push(`Type: ${card.kind}`);
  }

  // Add content (stringify JSONB)
  if (card.content) {
    const contentStr = typeof card.content === 'string'
      ? card.content
      : JSON.stringify(card.content);
    textParts.push(`Content: ${contentStr}`);
  }

  // Add tags
  if (card.tags && card.tags.length > 0) {
    textParts.push(`Tags: ${card.tags.join(', ')}`);
  }

  const text = textParts.join('. ');
  return await generateEmbedding(text);
}

/**
 * Calculate cosine similarity between two embeddings
 *
 * @param {number[]} embedding1 - First embedding vector
 * @param {number[]} embedding2 - Second embedding vector
 * @returns {number} - Cosine similarity (0 to 1)
 */
function cosineSimilarity(embedding1, embedding2) {
  if (!embedding1 || !embedding2) {
    return 0;
  }

  if (embedding1.length !== embedding2.length) {
    throw new Error('Embeddings must have same dimension');
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    norm1 += embedding1[i] * embedding1[i];
    norm2 += embedding2[i] * embedding2[i];
  }

  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

module.exports = {
  generateEmbedding,
  generateCardEmbedding,
  cosineSimilarity,
  EMBEDDING_MODEL,
};
