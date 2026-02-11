/**
 * Correction Validator
 * Centralized validation for memory card corrections.
 * Prevents contradictory reasoning from being stored or displayed.
 *
 * A contradiction occurs when the reasoning/key_distinction text
 * argues for a DIFFERENT category than the stated correct_category.
 */

const logger = require('./logger');

const ALL_CATEGORIES = [
    'dining', 'business_meal', 'groceries', 'shopping',
    'entertainment', 'transportation', 'utilities', 'health',
    'personal_care', 'other'
];

// Phrases that, when combined with a category name, indicate the text
// is arguing IN FAVOR of that category.
// Must cover articles (a/an/the) and varied phrasing from LLM outputs.
const SUPPORT_PHRASES = [
    '{cat} takes precedence',
    '{cat} is correct',
    '{cat} is the correct',
    'should be {cat}',
    'should be a {cat}',
    'should be an {cat}',
    'categorized as {cat}',
    'categorized as a {cat}',
    'categorized as an {cat}',
    'categorization is {cat}',
    '{cat} wins',
    'this is a {cat}',
    'this is an {cat}',
    'making this a {cat}',
    'making this an {cat}',
    'making it a {cat}',
    'making it an {cat}',
    'belongs in {cat}',
    'classified as {cat}',
    'classified as a {cat}',
    'classified as an {cat}',
    '{cat} is the primary',
    'falls under {cat}',
    'falls into {cat}',
    'aligns more with {cat}',
    'aligns with the {cat}',
    'aligns more closely with {cat}',
    'more closely with the {cat}',
    'categorize it as {cat}',
    'categorize this as {cat}',
    'category is {cat}',
    'category of {cat}',
    'qualifies as {cat}',
    'qualifies as a {cat}',
    'qualifies as an {cat}',
    'classified under {cat}',
    'filed under {cat}',
    'considered {cat}',
    'considered a {cat}',
    'considered an {cat}',
    'appropriate category is {cat}',
    'correct categorization is {cat}',
    'the correct category is {cat}',
    '{cat} is the appropriate',
    '{cat} is the correct category',
    '{cat} is the right category',
    'correctly categorized as {cat}',
    'categorize as {cat}'
];

/**
 * Check if reasoning text is consistent with the stated correct category.
 * Returns true if consistent (safe to use), false if contradictory.
 *
 * @param {string} reasoning - The reasoning/distinction text to check
 * @param {string} correctCategory - The category the correction claims is correct
 * @returns {boolean} true if consistent, false if reasoning argues for a different category
 */
function isReasoningConsistent(reasoning, correctCategory) {
    if (!reasoning || !correctCategory) return true;

    // Strip quotes so "category is 'groceries'" matches "category is groceries"
    const reasoningLower = reasoning.toLowerCase().replace(/['"]/g, '');
    const otherCategories = ALL_CATEGORIES.filter(c => c !== correctCategory);

    for (const otherCat of otherCategories) {
        const variants = [otherCat, otherCat.replace('_', ' ')];

        for (const catName of variants) {
            for (const template of SUPPORT_PHRASES) {
                const phrase = template.replace('{cat}', catName);
                if (reasoningLower.includes(phrase)) {
                    logger.debug('Correction contradiction detected', {
                        correctCategory,
                        contradicts_with: otherCat,
                        phrase_found: phrase
                    });
                    return false;
                }
            }
        }
    }

    return true;
}

/**
 * Sanitize a key_distinction / reasoning text for safe use in memory cards.
 * Returns the text as-is if consistent, or empty string if contradictory.
 *
 * @param {string} text - The distinction/reasoning text
 * @param {string} correctCategory - The category the correction claims is correct
 * @returns {string} The original text if safe, empty string if contradictory
 */
function sanitizeKeyDistinction(text, correctCategory) {
    if (!text || !correctCategory) return '';

    if (isReasoningConsistent(text, correctCategory)) {
        return text;
    }

    logger.warn('Stripped contradictory key_distinction', {
        correctCategory,
        text_preview: text.substring(0, 80)
    });
    return '';
}

module.exports = {
    isReasoningConsistent,
    sanitizeKeyDistinction,
    ALL_CATEGORIES
};
