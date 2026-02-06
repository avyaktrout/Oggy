/**
 * App Event Processor
 * Processes app_events and feeds them to:
 * 1. domain_knowledge table (for Tessa assessment generation)
 * 2. memory substrate (for Oggy continuous learning)
 * Stage 0, Week 7: Enhanced with resilience and structured logging
 */

const { query, transaction } = require('../utils/db');
const { getEventTypeConfig, hasValidEvidence } = require('../utils/eventTypes');
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const retryHandler = require('../utils/retry');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';

class AppEventProcessor {
    constructor() {
        // Use registry to get shared circuit breaker instance
        this.memoryCircuitBreaker = circuitBreakerRegistry.getOrCreate('memory-service-events', {
            failureThreshold: 5,
            timeout: 60000
        });
    }

    /**
     * Process a single app event
     */
    async processEvent(event) {
        const startTime = Date.now();

        logger.info('Processing app event', {
            event_id: event.event_id,
            event_type: event.event_type,
            user_id: event.user_id,
            timestamp: event.ts
        });

        const config = getEventTypeConfig(event.event_type);
        if (!config) {
            logger.error('Unknown event type', {
                event_id: event.event_id,
                event_type: event.event_type
            });
            await this._recordError(event.event_id, 'unknown_event_type', 'Event type not in configuration');
            return;
        }

        try {
            // Process for domain knowledge if configured
            if (config.feeds_domain_knowledge && !event.processed_for_domain_knowledge) {
                await this._feedToDomainKnowledge(event);
            }

            // Process for memory substrate if configured
            if (config.feeds_memory_substrate && !event.processed_for_memory_substrate) {
                await this._feedToMemorySubstrate(event, config);
            }

            const duration = Date.now() - startTime;
            logger.info('Successfully processed event', {
                event_id: event.event_id,
                event_type: event.event_type,
                duration_ms: duration
            });
        } catch (error) {
            logger.logError(error, {
                operation: 'processEvent',
                event_id: event.event_id,
                event_type: event.event_type
            });
            await this._recordError(event.event_id, 'processing_error', error.message);
        }
    }

    /**
     * Feed event to domain_knowledge table
     * This creates knowledge entries that Tessa can use for assessment generation
     */
    async _feedToDomainKnowledge(event) {
        logger.info('Feeding event to domain_knowledge', {
            event_id: event.event_id,
            event_type: event.event_type
        });

        const knowledgeEntry = this._buildKnowledgeEntry(event);
        if (!knowledgeEntry) {
            logger.debug('No knowledge entry generated', {
                event_id: event.event_id,
                event_type: event.event_type
            });
            await query(
                `UPDATE app_events SET processed_for_domain_knowledge = TRUE WHERE event_id = $1`,
                [event.event_id]
            );
            return;
        }

        // Insert into domain_knowledge
        await query(
            `INSERT INTO domain_knowledge (
                domain, topic, subtopic, content_text, content_structured,
                source_type, source_ref, visibility, difficulty_band, tags, content_hash
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                knowledgeEntry.domain,
                knowledgeEntry.topic,
                knowledgeEntry.subtopic,
                knowledgeEntry.content_text,
                JSON.stringify(knowledgeEntry.content_structured),
                'app_event',
                `app_event:${event.event_id}`,
                knowledgeEntry.visibility,
                knowledgeEntry.difficulty_band,
                JSON.stringify(knowledgeEntry.tags),
                knowledgeEntry.content_hash
            ]
        );

        // Mark as processed
        await query(
            `UPDATE app_events SET processed_for_domain_knowledge = TRUE WHERE event_id = $1`,
            [event.event_id]
        );

        logger.info('Created domain knowledge entry', {
            event_id: event.event_id,
            domain: knowledgeEntry.domain,
            topic: knowledgeEntry.topic,
            subtopic: knowledgeEntry.subtopic
        });
    }

    /**
     * Build domain knowledge entry from event
     */
    _buildKnowledgeEntry(event) {
        const eventData = event.event_data;

        switch (event.event_type) {
            case 'EXPENSE_CATEGORIZED_BY_USER':
            case 'EXPENSE_CATEGORIZED_BY_OGGY':
                // User's categorization decisions are valuable training data
                return {
                    domain: 'payments',
                    topic: 'categorization',
                    subtopic: 'user_patterns',
                    content_text: this._formatCategorizationKnowledge(eventData),
                    content_structured: {
                        merchant: eventData.merchant,
                        category: eventData.new_category || eventData.suggested_category,
                        amount: eventData.amount,
                        description: eventData.description
                    },
                    visibility: 'shareable',  // Can be used for practice
                    difficulty_band: 2,
                    tags: ['categorization', 'user_feedback', eventData.new_category || eventData.suggested_category],
                    content_hash: this._computeHash(eventData)
                };

            case 'CATEGORY_SUGGESTION_REJECTED':
                // Rejections are especially valuable - they show what NOT to do
                return {
                    domain: 'payments',
                    topic: 'categorization',
                    subtopic: 'negative_examples',
                    content_text: this._formatRejectionKnowledge(eventData),
                    content_structured: {
                        merchant: eventData.merchant,
                        wrong_category: eventData.suggested_category,
                        correct_category: eventData.user_chosen_category,
                        amount: eventData.amount
                    },
                    visibility: 'shareable',
                    difficulty_band: 3,  // More complex learning signal
                    tags: ['categorization', 'rejection', 'correction'],
                    content_hash: this._computeHash(eventData)
                };

            case 'EXPENSES_QUERIED':
                // Query patterns show what users care about
                return {
                    domain: 'payments',
                    topic: 'user_behavior',
                    subtopic: 'query_patterns',
                    content_text: this._formatQueryKnowledge(eventData),
                    content_structured: eventData.query_filters,
                    visibility: 'tessa_only',  // More sensitive
                    difficulty_band: 2,
                    tags: ['queries', 'behavior'],
                    content_hash: this._computeHash(eventData)
                };

            default:
                return null;
        }
    }

    /**
     * Format categorization knowledge as text
     */
    _formatCategorizationKnowledge(eventData) {
        const merchant = eventData.merchant || 'Unknown merchant';
        const category = eventData.new_category || eventData.suggested_category;
        const amount = eventData.amount;
        const desc = eventData.description;

        return `**Merchant categorization pattern:**\n` +
               `- Merchant: ${merchant}\n` +
               `- Category: ${category}\n` +
               `- Typical amount: $${amount}\n` +
               `- Description: ${desc}\n` +
               `\nUser confirmed this categorization is correct.`;
    }

    /**
     * Format rejection knowledge as text
     */
    _formatRejectionKnowledge(eventData) {
        return `**Categorization mistake to avoid:**\n` +
               `- Merchant: ${eventData.merchant}\n` +
               `- WRONG category: ${eventData.suggested_category}\n` +
               `- CORRECT category: ${eventData.user_chosen_category}\n` +
               `- Amount: $${eventData.amount}\n` +
               `\nUser rejected the suggested category and chose a different one.`;
    }

    /**
     * Format query knowledge as text
     */
    _formatQueryKnowledge(eventData) {
        const filters = eventData.query_filters;
        const parts = [];

        if (filters.category) parts.push(`category: ${filters.category}`);
        if (filters.merchant) parts.push(`merchant: ${filters.merchant}`);
        if (filters.start_date) parts.push(`date range: ${filters.start_date} to ${filters.end_date}`);

        return `**User query pattern:**\nUser frequently queries expenses with filters: ${parts.join(', ')}`;
    }

    /**
     * Feed event to memory substrate (via memory service)
     * This updates memory cards for Oggy's continuous learning
     */
    async _feedToMemorySubstrate(event, config) {
        logger.info('Feeding event to memory substrate', {
            event_id: event.event_id,
            event_type: event.event_type,
            has_trace_id: !!event.event_data.trace_id
        });

        const eventData = event.event_data;

        // Build context for memory update
        const intentTemplate = config.memory_intent || {};
        const context = {
            agent: 'payments_app',
            program: 'app_feedback',
            action: 'UPDATE_CARD',
            evidence: {
                user_event_id: event.event_id,
                trace_id: eventData.trace_id || null
            },
            intent: {
                ...intentTemplate,
                app_event_type: event.event_type,
                timestamp: event.ts
            }
        };

        // If trace_id exists, update the cards that were used
        if (eventData.trace_id) {
            await this._updateMemoryCardsFromTrace(eventData.trace_id, event, context);
        } else {
            logger.debug('No trace_id for event, skipping memory card update', {
                event_id: event.event_id,
                event_type: event.event_type
            });
        }

        // Mark as processed
        await query(
            `UPDATE app_events SET processed_for_memory_substrate = TRUE WHERE event_id = $1`,
            [event.event_id]
        );
    }

    /**
     * Update memory cards based on retrieval trace and feedback
     */
    async _updateMemoryCardsFromTrace(trace_id, event, context) {
        try {
            // Get retrieval trace from database
            const traceResult = await query(
                `SELECT selected_card_ids FROM retrieval_traces WHERE trace_id = $1`,
                [trace_id]
            );

            if (traceResult.rows.length === 0) {
                logger.warn('Retrieval trace not found', {
                    trace_id,
                    event_id: event.event_id
                });
                return;
            }

            const cardIds = traceResult.rows[0].selected_card_ids || [];

            if (cardIds.length === 0) {
                logger.info('No cards in trace, creating new memory card', {
                    trace_id,
                    event_id: event.event_id
                });
                await this._createMemoryCardFromEvent(event, context);
                return;
            }

            logger.info('Updating memory cards from trace', {
                trace_id,
                card_count: cardIds.length,
                event_id: event.event_id
            });

            // Determine weight adjustment based on event type
            const patch = this._computeFeedbackPatch(event);

            // Update each card with retry and circuit breaker
            let successCount = 0;
            let failCount = 0;

            for (const card_id of cardIds) {
                try {
                    await this.memoryCircuitBreaker.execute(async () => {
                        return await retryHandler.withRetry(
                            async () => {
                                return await axios.post(
                                    `${MEMORY_SERVICE_URL}/utility/update`,
                                    {
                                        card_id,
                                        context,
                                        patch
                                    },
                                    {
                                        timeout: 5000,
                                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                                    }
                                );
                            },
                            {
                                maxRetries: 2,
                                baseDelay: 500,
                                operationName: 'memory-card-update',
                                shouldRetry: retryHandler.constructor.retryableHttpErrors
                            }
                        );
                    });

                    successCount++;
                    logger.debug('Updated memory card', {
                        card_id,
                        trace_id,
                        patch
                    });
                } catch (error) {
                    failCount++;
                    if (error.circuitBreakerOpen) {
                        logger.error('Memory service circuit breaker open', {
                            card_id,
                            trace_id
                        });
                        // Don't try remaining cards if circuit is open
                        break;
                    } else {
                        logger.warn('Failed to update memory card', {
                            card_id,
                            trace_id,
                            error: error.message
                        });
                    }
                }
            }

            logger.info('Memory card updates completed', {
                trace_id,
                total: cardIds.length,
                succeeded: successCount,
                failed: failCount
            });
        } catch (error) {
            logger.logError(error, {
                operation: 'updateMemoryCardsFromTrace',
                trace_id
            });
            throw error;
        }
    }

    /**
     * Compute memory weight adjustments based on feedback
     */
    _computeFeedbackPatch(event) {
        switch (event.event_type) {
            case 'EXPENSE_CATEGORIZED_BY_OGGY':
                // User confirmed suggestion → promote
                return {
                    utility_weight_delta: +0.1,
                    success_count_delta: +1
                };

            case 'CATEGORY_SUGGESTION_REJECTED':
                // User rejected suggestion → demote
                return {
                    utility_weight_delta: -0.15,
                    failure_count_delta: +1
                };

            case 'EXPENSE_CATEGORIZED_BY_USER':
                // User manually categorized (no AI involved)
                // Small positive signal if memory was retrieved
                return {
                    utility_weight_delta: +0.05,
                    usage_count_delta: +1
                };

            default:
                return {
                    usage_count_delta: +1
                };
        }
    }

    /**
     * Create new memory card from categorization event
     */
    async _createMemoryCardFromEvent(event, context) {
        try {
            const eventData = event.event_data;
            const { merchant, category, description, amount } = eventData;

            // Create memory card content
            const cardContent = {
                text: `Merchant "${merchant}" with description "${description}" should be categorized as "${category}". Amount: $${amount}.`,
                pattern: {
                    merchant,
                    category,
                    description_keywords: description.split(' ').filter(w => w.length > 3),
                    amount_range: this._getAmountRange(amount)
                },
                evidence: {
                    source: 'user_feedback',
                    confidence: event.event_type === 'EXPENSE_CATEGORIZED_BY_OGGY' ? 'high' : 'medium',
                    event_id: event.event_id
                }
            };

            // Create card via memory service with retry and circuit breaker
            const response = await this.memoryCircuitBreaker.execute(async () => {
                return await retryHandler.withRetry(
                    async () => {
                        return await axios.post(
                            `${MEMORY_SERVICE_URL}/cards`,
                            {
                                owner_type: 'user',
                                owner_id: event.user_id,
                                tier: 2, // short-term memory initially
                                kind: 'expense_category_pattern',
                                content: cardContent,
                                tags: ['payments', 'categorization', category, merchant.toLowerCase().replace(/\s+/g, '_')],
                                utility_weight: 0.7, // initial weight
                                reliability: 0.8
                            },
                            {
                                timeout: 5000,
                                headers: {
                                    'x-api-key': process.env.INTERNAL_API_KEY || ''
                                }
                            }
                        );
                    },
                    {
                        maxRetries: 2,
                        baseDelay: 500,
                        operationName: 'memory-card-creation',
                        shouldRetry: retryHandler.constructor.retryableHttpErrors
                    }
                );
            });

            const card_id = response.data.card_id;
            logger.info('Created memory card', {
                card_id,
                merchant,
                category,
                event_id: event.event_id,
                user_id: event.user_id
            });

            return card_id;
        } catch (error) {
            logger.logError(error, {
                operation: 'createMemoryCard',
                event_id: event.event_id,
                merchant: eventData.merchant,
                category: eventData.category
            });
            throw error;
        }
    }

    /**
     * Get amount range bucket for pattern matching
     */
    _getAmountRange(amount) {
        if (amount < 20) return 'small';
        if (amount < 100) return 'medium';
        if (amount < 500) return 'large';
        return 'very_large';
    }

    /**
     * Record processing error
     */
    async _recordError(event_id, errorType, errorMessage) {
        await query(
            `UPDATE app_events
             SET processing_errors = jsonb_build_object(
                 'error_type', $2::text,
                 'error_message', $3::text,
                 'timestamp', now()::text
             )
             WHERE event_id = $1`,
            [event_id, errorType, errorMessage]
        );
    }

    /**
     * Compute content hash for deduplication
     */
    _computeHash(data) {
        const str = JSON.stringify(data);
        return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
    }

    /**
     * Process all unprocessed events (batch)
     */
    async processUnprocessedEvents(limit = 100) {
        const startTime = Date.now();

        const result = await query(
            `SELECT * FROM app_events
             WHERE (NOT processed_for_domain_knowledge OR NOT processed_for_memory_substrate)
               AND processing_errors IS NULL
             ORDER BY ts ASC
             LIMIT $1`,
            [limit]
        );

        const events = result.rows;

        if (events.length === 0) {
            return 0;
        }

        logger.info('Starting batch event processing', {
            unprocessed_count: events.length,
            limit
        });

        let successCount = 0;
        let errorCount = 0;

        for (const event of events) {
            try {
                await this.processEvent(event);
                successCount++;
            } catch (error) {
                errorCount++;
                logger.warn('Event processing failed', {
                    event_id: event.event_id,
                    event_type: event.event_type,
                    error: error.message
                });
            }
        }

        const duration = Date.now() - startTime;
        logger.info('Batch event processing completed', {
            total: events.length,
            succeeded: successCount,
            failed: errorCount,
            duration_ms: duration
        });

        return events.length;
    }
}

module.exports = AppEventProcessor;
