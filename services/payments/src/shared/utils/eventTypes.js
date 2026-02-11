/**
 * Event Type Definitions for Payments Application
 * Stage 0, Week 5
 *
 * These event types control how app events flow through the training pipeline:
 * - feeds_domain_knowledge: Should this event create/update domain_knowledge entries?
 * - feeds_memory_substrate: Should this event update memory cards for Oggy?
 */

const APP_EVENT_TYPES = {
    // =====================================================
    // Expense lifecycle events
    // =====================================================
    EXPENSE_CREATED: {
        description: 'User created a new expense',
        feeds_domain_knowledge: true,
        feeds_memory_substrate: false, // creation alone doesn't update memory
        entity_type: 'expense',
        action: 'create'
    },

    EXPENSE_UPDATED: {
        description: 'User updated an existing expense',
        feeds_domain_knowledge: true,
        feeds_memory_substrate: false,
        entity_type: 'expense',
        action: 'update'
    },

    EXPENSE_DELETED: {
        description: 'User deleted an expense',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false,
        entity_type: 'expense',
        action: 'delete'
    },

    // =====================================================
    // Categorization events (KEY for training)
    // =====================================================
    EXPENSE_CATEGORIZED_BY_USER: {
        description: 'User manually set/changed category',
        feeds_domain_knowledge: true,
        feeds_memory_substrate: true, // user corrections are learning signals
        memory_intent: {
            event_type: 'user_feedback',
            user_feedback: 'corrected'
        },
        entity_type: 'expense',
        action: 'categorize'
    },

    EXPENSE_CATEGORIZED_BY_OGGY: {
        description: 'Oggy suggested category, user accepted',
        feeds_domain_knowledge: true,
        feeds_memory_substrate: true,
        memory_intent: {
            event_type: 'user_feedback',
            user_feedback: 'confirmed'
        },
        entity_type: 'expense',
        action: 'categorize'
    },

    CATEGORY_SUGGESTION_REJECTED: {
        description: 'User rejected Oggy\'s category suggestion',
        feeds_domain_knowledge: true,
        feeds_memory_substrate: true,
        memory_intent: {
            event_type: 'user_feedback',
            user_feedback: 'corrected'
        },
        entity_type: 'expense',
        action: 'categorize'
    },

    // =====================================================
    // Query events
    // =====================================================
    EXPENSES_QUERIED: {
        description: 'User queried expenses with filters',
        feeds_domain_knowledge: true,
        feeds_memory_substrate: false,
        entity_type: 'query',
        action: 'query'
    },

    // =====================================================
    // Pattern detection (system-generated)
    // =====================================================
    SPENDING_PATTERN_DETECTED: {
        description: 'System detected recurring spending pattern',
        feeds_domain_knowledge: true,
        feeds_memory_substrate: false,
        entity_type: 'pattern',
        action: 'create'
    },

    CATEGORY_SUGGESTION_REQUESTED: {
        description: 'User or system requested category suggestion from Oggy',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false, // just a request, not a learning signal
        entity_type: 'expense',
        action: 'suggest'
    },

    // =====================================================
    // Self-driven learning events
    // =====================================================
    OGGY_SELF_PRACTICE: {
        description: 'Oggy autonomously practiced categorization (self-driven learning)',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false, // already processed by self-learning service
        memory_intent: {
            event_type: 'autonomous_learning',
            learning_mode: 'self_driven'
        },
        entity_type: 'practice',
        action: 'self_learn'
    },

    // =====================================================
    // System/training events (no processing needed)
    // =====================================================
    DIFFICULTY_SCALE_ADJUSTED: {
        description: 'Difficulty scale was adjusted during training',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false,
        entity_type: 'training',
        action: 'adjust'
    },

    // =====================================================
    // Inquiry events (self-driven questions)
    // =====================================================
    INQUIRY_GENERATED: {
        description: 'Oggy generated a self-driven inquiry for the user',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false,
        entity_type: 'inquiry',
        action: 'generate'
    },

    INQUIRY_ANSWERED: {
        description: 'User answered an Oggy inquiry',
        feeds_domain_knowledge: true,
        feeds_memory_substrate: true,
        memory_intent: {
            event_type: 'user_feedback',
            user_feedback: 'inquiry_response'
        },
        entity_type: 'inquiry',
        action: 'answer'
    },

    // =====================================================
    // Suggestion events (Behavior Design v0.2)
    // =====================================================
    SUGGESTION_EMITTED: {
        description: 'Oggy emitted a proactive suggestion to the user',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false,
        entity_type: 'suggestion',
        action: 'emit'
    },

    SUGGESTION_SUPPRESSED: {
        description: 'A suggestion was suppressed due to rate limiting or opt-out',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false,
        entity_type: 'suggestion',
        action: 'suppress'
    },

    SUGGESTION_SETTINGS_CHANGED: {
        description: 'User changed suggestion settings (opt-in/interval)',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false,
        entity_type: 'suggestion',
        action: 'settings'
    },

    // =====================================================
    // Observer events (Federated Learning v0.1)
    // =====================================================
    OBSERVER_JOB_COMPLETED: {
        description: 'Observer federated learning job completed',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false,
        entity_type: 'observer',
        action: 'job_complete'
    },

    OBSERVER_PACK_APPLIED: {
        description: 'User applied an observer rule pack',
        feeds_domain_knowledge: true,
        feeds_memory_substrate: false,
        entity_type: 'observer',
        action: 'pack_apply'
    },

    OBSERVER_PACK_ROLLED_BACK: {
        description: 'User rolled back an observer rule pack',
        feeds_domain_knowledge: false,
        feeds_memory_substrate: false,
        entity_type: 'observer',
        action: 'pack_rollback'
    }
};

/**
 * Evidence pointer keys (what constitutes valid evidence)
 */
const EVIDENCE_POINTER_KEYS = {
    trace_id: 'Memory retrieval trace ID',
    benchmark_id: 'Tessa benchmark ID',
    assessment_id: 'Practice assessment ID',
    user_event_id: 'App event ID (user action)',
    knowledge_id: 'Domain knowledge reference ID'
};

/**
 * Event data schemas by event type
 */
const EVENT_DATA_SCHEMAS = {
    EXPENSE_CREATED: {
        required: ['expense_id', 'amount', 'currency', 'merchant', 'description', 'transaction_date'],
        optional: ['category', 'tags', 'notes']
    },

    EXPENSE_CATEGORIZED_BY_USER: {
        required: ['expense_id', 'new_category', 'merchant', 'amount', 'description'],
        optional: ['previous_category', 'tags']
    },

    CATEGORY_SUGGESTION_REJECTED: {
        required: ['expense_id', 'suggested_category', 'user_chosen_category', 'merchant', 'amount'],
        optional: ['trace_id', 'suggestion_confidence', 'rejection_reason']
    },

    EXPENSE_CATEGORIZED_BY_OGGY: {
        required: ['expense_id', 'suggested_category', 'merchant', 'amount', 'trace_id'],
        optional: ['confidence', 'reasoning', 'alternatives']
    },

    EXPENSES_QUERIED: {
        required: ['query_filters', 'result_count'],
        optional: ['result_total_amount', 'query_type']
    }
};

/**
 * Validate event type
 */
function isValidEventType(eventType) {
    return eventType in APP_EVENT_TYPES;
}

/**
 * Get event type configuration
 */
function getEventTypeConfig(eventType) {
    return APP_EVENT_TYPES[eventType] || null;
}

/**
 * Check if event type feeds domain knowledge
 */
function feedsDomainKnowledge(eventType) {
    const config = getEventTypeConfig(eventType);
    return config ? config.feeds_domain_knowledge : false;
}

/**
 * Check if event type feeds memory substrate
 */
function feedsMemorySubstrate(eventType) {
    const config = getEventTypeConfig(eventType);
    return config ? config.feeds_memory_substrate : false;
}

/**
 * Validate event data against schema
 */
function validateEventData(eventType, eventData) {
    const schema = EVENT_DATA_SCHEMAS[eventType];
    if (!schema) {
        return { valid: true, errors: [] }; // No schema defined, accept
    }

    const errors = [];
    const data = eventData || {};

    // Check required fields
    for (const field of schema.required) {
        if (!(field in data) || data[field] === null || data[field] === undefined) {
            errors.push(`Missing required field: ${field}`);
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Check if event has valid evidence pointers
 */
function hasValidEvidence(evidence) {
    if (!evidence || typeof evidence !== 'object') {
        return false;
    }

    // At least one evidence pointer key must be present and non-empty
    for (const key of Object.keys(EVIDENCE_POINTER_KEYS)) {
        if (evidence[key] && evidence[key] !== '') {
            return true;
        }
    }

    return false;
}

module.exports = {
    APP_EVENT_TYPES,
    EVIDENCE_POINTER_KEYS,
    EVENT_DATA_SCHEMAS,
    isValidEventType,
    getEventTypeConfig,
    feedsDomainKnowledge,
    feedsMemorySubstrate,
    validateEventData,
    hasValidEvidence
};
