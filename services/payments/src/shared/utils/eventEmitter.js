/**
 * App Event Emitter
 * Emits events to app_events table for training pipeline
 */

const { query } = require('./db');
const { isValidEventType, validateEventData } = require('./eventTypes');
const { v4: uuidv4 } = require('uuid');

/**
 * Emit an application event
 * @param {Object} eventSpec - Event specification
 * @param {string} eventSpec.event_type - Event type (from APP_EVENT_TYPES)
 * @param {string} eventSpec.user_id - User ID
 * @param {string} eventSpec.entity_type - Entity type ('expense', 'category', 'query', etc.)
 * @param {string} [eventSpec.entity_id] - Entity ID (optional, e.g., expense_id)
 * @param {string} eventSpec.action - Action performed
 * @param {Object} eventSpec.event_data - Event data payload
 * @param {string} [eventSpec.session_id] - Optional session ID
 * @returns {Promise<string>} event_id
 */
async function emitEvent({
    event_type,
    user_id,
    entity_type,
    entity_id = null,
    action,
    event_data,
    session_id = null
}) {
    // Validate event type
    if (!isValidEventType(event_type)) {
        throw new Error(`Invalid event type: ${event_type}`);
    }

    // Validate event data
    const validation = validateEventData(event_type, event_data);
    if (!validation.valid) {
        throw new Error(`Invalid event data for ${event_type}: ${validation.errors.join(', ')}`);
    }

    // Insert event
    const result = await query(
        `INSERT INTO app_events (
            event_type,
            app_domain,
            user_id,
            session_id,
            entity_type,
            entity_id,
            action,
            event_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING event_id, ts`,
        [
            event_type,
            'payments',
            user_id,
            session_id,
            entity_type,
            entity_id,
            action,
            JSON.stringify(event_data)
        ]
    );

    const event = result.rows[0];
    console.log('[EventEmitter] Emitted event', {
        event_id: event.event_id,
        event_type,
        user_id,
        entity_type,
        entity_id
    });

    return event.event_id;
}

/**
 * Emit EXPENSE_CREATED event
 */
async function emitExpenseCreated(expense) {
    return await emitEvent({
        event_type: 'EXPENSE_CREATED',
        user_id: expense.user_id,
        entity_type: 'expense',
        entity_id: expense.expense_id,
        action: 'create',
        event_data: {
            expense_id: expense.expense_id,
            amount: expense.amount,
            currency: expense.currency,
            merchant: expense.merchant,
            description: expense.description,
            category: expense.category,
            transaction_date: expense.transaction_date,
            tags: expense.tags
        }
    });
}

/**
 * Emit EXPENSE_UPDATED event
 */
async function emitExpenseUpdated(expense, previousValues) {
    return await emitEvent({
        event_type: 'EXPENSE_UPDATED',
        user_id: expense.user_id,
        entity_type: 'expense',
        entity_id: expense.expense_id,
        action: 'update',
        event_data: {
            expense_id: expense.expense_id,
            changes: previousValues,
            new_values: {
                amount: expense.amount,
                merchant: expense.merchant,
                description: expense.description,
                category: expense.category,
                tags: expense.tags
            }
        }
    });
}

/**
 * Emit EXPENSE_CATEGORIZED_BY_USER event
 */
async function emitExpenseCategorizedByUser(expense, previousCategory) {
    return await emitEvent({
        event_type: 'EXPENSE_CATEGORIZED_BY_USER',
        user_id: expense.user_id,
        entity_type: 'expense',
        entity_id: expense.expense_id,
        action: 'categorize',
        event_data: {
            expense_id: expense.expense_id,
            previous_category: previousCategory,
            new_category: expense.category,
            merchant: expense.merchant,
            amount: expense.amount,
            description: expense.description
        }
    });
}

/**
 * Emit EXPENSE_CATEGORIZED_BY_OGGY event (user accepted suggestion)
 */
async function emitExpenseCategorizedByOggy(expense, suggestionData) {
    return await emitEvent({
        event_type: 'EXPENSE_CATEGORIZED_BY_OGGY',
        user_id: expense.user_id,
        entity_type: 'expense',
        entity_id: expense.expense_id,
        action: 'categorize',
        event_data: {
            expense_id: expense.expense_id,
            suggested_category: suggestionData.suggested_category,
            merchant: expense.merchant,
            amount: expense.amount,
            description: expense.description,
            trace_id: suggestionData.trace_id,
            confidence: suggestionData.confidence,
            reasoning: suggestionData.reasoning
        }
    });
}

/**
 * Emit CATEGORY_SUGGESTION_REJECTED event
 */
async function emitCategorySuggestionRejected(expense, suggestionData, userChosenCategory) {
    return await emitEvent({
        event_type: 'CATEGORY_SUGGESTION_REJECTED',
        user_id: expense.user_id,
        entity_type: 'expense',
        entity_id: expense.expense_id,
        action: 'categorize',
        event_data: {
            expense_id: expense.expense_id,
            suggested_category: suggestionData.suggested_category,
            user_chosen_category: userChosenCategory,
            merchant: expense.merchant,
            amount: expense.amount,
            description: expense.description,
            trace_id: suggestionData.trace_id,
            suggestion_confidence: suggestionData.confidence
        }
    });
}

/**
 * Emit EXPENSES_QUERIED event
 */
async function emitExpensesQueried(userId, queryFilters, resultCount, resultTotalAmount) {
    return await emitEvent({
        event_type: 'EXPENSES_QUERIED',
        user_id: userId,
        entity_type: 'query',
        entity_id: null,
        action: 'query',
        event_data: {
            query_filters: queryFilters,
            result_count: resultCount,
            result_total_amount: resultTotalAmount
        }
    });
}

module.exports = {
    emitEvent,
    emitExpenseCreated,
    emitExpenseUpdated,
    emitExpenseCategorizedByUser,
    emitExpenseCategorizedByOggy,
    emitCategorySuggestionRejected,
    emitExpensesQueried
};
