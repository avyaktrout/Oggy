/**
 * Tessa Assessment Generation for Payments Domain
 * Week 6: Generate practice and sealed benchmark assessments
 */

const { query } = require('../../../shared/utils/db');
const crypto = require('crypto');

class TessaAssessments {
    constructor() {
        this.assessmentTemplates = this._loadTemplates();
    }

    /**
     * Generate practice assessments (trainable)
     * Uses domain_knowledge and real expense patterns
     */
    async generatePracticeAssessment(userId, count = 10) {
        console.log(`[Tessa] Generating ${count} practice assessments for ${userId}`);

        // Get user's expense patterns from domain_knowledge
        const knowledge = await query(
            `SELECT * FROM domain_knowledge
             WHERE domain = 'payments'
               AND visibility = 'shareable'
             ORDER BY created_at DESC
             LIMIT 20`
        );

        // Get actual merchant patterns
        const merchants = await query(
            `SELECT merchant, category, AVG(amount) as avg_amount, COUNT(*) as frequency
             FROM expenses
             WHERE user_id = $1 AND status = 'active' AND merchant IS NOT NULL
             GROUP BY merchant, category
             ORDER BY frequency DESC
             LIMIT 20`,
            [userId]
        );

        const assessments = [];

        for (let i = 0; i < count; i++) {
            const assessment = this._generateSingleAssessment(
                merchants.rows,
                knowledge.rows,
                'practice'
            );
            assessments.push(assessment);
        }

        return {
            type: 'practice',
            count: assessments.length,
            assessments,
            generated_at: new Date().toISOString()
        };
    }

    /**
     * Generate sealed benchmark assessments (held out for evaluation)
     * These should NOT be visible to Oggy during training
     */
    async generateSealedBenchmark(count = 20) {
        console.log(`[Tessa] Generating ${count} sealed benchmark assessments`);

        // Use tessa_only knowledge for sealed benchmarks
        const knowledge = await query(
            `SELECT * FROM domain_knowledge
             WHERE domain = 'payments'
               AND visibility = 'tessa_only'
             ORDER BY created_at DESC
             LIMIT 10`
        );

        // Use base categorization rules (not user-specific)
        const basePatterns = this._getBaseCategorizationPatterns();

        const assessments = [];

        for (let i = 0; i < count; i++) {
            const assessment = this._generateSingleAssessment(
                basePatterns,
                knowledge.rows,
                'sealed'
            );
            assessments.push(assessment);
        }

        // Store sealed benchmark
        const benchmarkId = crypto.randomUUID();
        await this._storeSealedBenchmark(benchmarkId, assessments);

        return {
            benchmark_id: benchmarkId,
            type: 'sealed',
            count: assessments.length,
            generated_at: new Date().toISOString(),
            assessments // Return for immediate use, but stored securely
        };
    }

    /**
     * Generate a single assessment
     */
    _generateSingleAssessment(merchantPatterns, knowledgeItems, type) {
        const templates = [
            'merchant_categorization',
            'amount_pattern',
            'description_inference',
            'recurring_detection'
        ];

        const template = templates[Math.floor(Math.random() * templates.length)];

        switch (template) {
            case 'merchant_categorization':
                return this._generateMerchantCategorizationTask(merchantPatterns, type);

            case 'amount_pattern':
                return this._generateAmountPatternTask(type);

            case 'description_inference':
                return this._generateDescriptionInferenceTask(merchantPatterns, type);

            case 'recurring_detection':
                return this._generateRecurringDetectionTask(type);

            default:
                return this._generateMerchantCategorizationTask(merchantPatterns, type);
        }
    }

    /**
     * Merchant categorization task
     */
    _generateMerchantCategorizationTask(merchantPatterns, type) {
        const categories = ['dining', 'groceries', 'transportation', 'utilities',
                          'entertainment', 'business_meal', 'shopping', 'health', 'personal_care'];

        let merchant, amount, description, correctCategory;

        if (merchantPatterns.length > 0 && Math.random() > 0.3) {
            // Use real pattern
            const pattern = merchantPatterns[Math.floor(Math.random() * merchantPatterns.length)];
            merchant = pattern.merchant;
            amount = parseFloat(pattern.avg_amount || pattern.amount || 50);
            correctCategory = pattern.category;
            description = this._generateDescription(merchant, correctCategory);
        } else {
            // Generate synthetic
            const synthetic = this._generateSyntheticExpense();
            merchant = synthetic.merchant;
            amount = synthetic.amount;
            correctCategory = synthetic.category;
            description = synthetic.description;
        }

        return {
            assessment_id: crypto.randomUUID(),
            type: 'merchant_categorization',
            difficulty: type === 'sealed' ? 3 : 2,
            prompt: `Categorize this expense:\n` +
                   `Merchant: ${merchant}\n` +
                   `Amount: $${amount.toFixed(2)}\n` +
                   `Description: ${description}\n\n` +
                   `Available categories: ${categories.join(', ')}\n\n` +
                   `What category should this expense be assigned to?`,
            input: {
                merchant,
                amount,
                description
            },
            expected_answer: correctCategory,
            rubric: {
                exact_match: 1.0,
                category_family_match: 0.5, // e.g., dining vs business_meal
                wrong_category: 0.0
            }
        };
    }

    /**
     * Amount pattern recognition task
     */
    _generateAmountPatternTask(type) {
        const scenarios = [
            {
                merchant: 'Netflix',
                amounts: [15.99, 15.99, 15.99],
                category: 'entertainment',
                question: 'Is this a recurring expense?'
            },
            {
                merchant: 'Starbucks',
                amounts: [5.50, 6.75, 5.25, 7.00],
                category: 'dining',
                question: 'Is this a recurring expense?'
            },
            {
                merchant: 'Electric Company',
                amounts: [120.50, 115.30, 125.00],
                category: 'utilities',
                question: 'Is this a recurring expense?'
            }
        ];

        const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
        const isRecurring = scenario.amounts.every((amt, idx, arr) =>
            idx === 0 || Math.abs(amt - arr[idx-1]) < arr[idx-1] * 0.2
        );

        return {
            assessment_id: crypto.randomUUID(),
            type: 'recurring_detection',
            difficulty: 2,
            prompt: `Analyze this spending pattern:\n` +
                   `Merchant: ${scenario.merchant}\n` +
                   `Recent amounts: ${scenario.amounts.map(a => `$${a.toFixed(2)}`).join(', ')}\n\n` +
                   `${scenario.question} (yes/no)`,
            input: {
                merchant: scenario.merchant,
                amounts: scenario.amounts
            },
            expected_answer: isRecurring ? 'yes' : 'no',
            rubric: {
                correct: 1.0,
                incorrect: 0.0
            }
        };
    }

    /**
     * Description inference task
     */
    _generateDescriptionInferenceTask(merchantPatterns, type) {
        const scenarios = [
            { description: 'client dinner meeting', keywords: ['client', 'meeting'], category: 'business_meal' },
            { description: 'weekly grocery shopping', keywords: ['grocery', 'weekly'], category: 'groceries' },
            { description: 'gas fillup for commute', keywords: ['gas', 'commute'], category: 'transportation' },
            { description: 'movie tickets', keywords: ['movie'], category: 'entertainment' }
        ];

        const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];

        return {
            assessment_id: crypto.randomUUID(),
            type: 'description_inference',
            difficulty: 3,
            prompt: `Based on this expense description, suggest the most appropriate category:\n` +
                   `Description: "${scenario.description}"\n` +
                   `Amount: $45.00\n\n` +
                   `What category does this belong to?`,
            input: {
                description: scenario.description,
                amount: 45.00
            },
            expected_answer: scenario.category,
            rubric: {
                exact_match: 1.0,
                reasonable_alternative: 0.7,
                wrong_category: 0.0
            }
        };
    }

    /**
     * Recurring detection task
     */
    _generateRecurringDetectionTask(type) {
        const recurringExpenses = [
            { merchant: 'Netflix', amount: 15.99, description: 'Monthly subscription', pattern: 'monthly' },
            { merchant: 'Spotify', amount: 9.99, description: 'Music streaming', pattern: 'monthly' },
            { merchant: 'Electric Company', amount: 125.00, description: 'Monthly utility bill', pattern: 'monthly' },
            { merchant: 'Gym Membership', amount: 49.99, description: 'Fitness subscription', pattern: 'monthly' }
        ];

        const expense = recurringExpenses[Math.floor(Math.random() * recurringExpenses.length)];

        return {
            assessment_id: crypto.randomUUID(),
            type: 'recurring_detection',
            difficulty: 2,
            prompt: `Is this expense likely to be a recurring charge?\n` +
                   `Merchant: ${expense.merchant}\n` +
                   `Amount: $${expense.amount}\n` +
                   `Description: ${expense.description}\n\n` +
                   `Answer: Yes or No`,
            input: {
                merchant: expense.merchant,
                amount: expense.amount,
                description: expense.description
            },
            expected_answer: 'Yes',
            rubric: {
                correct_detection: 1.0,
                wrong_detection: 0.0
            }
        };
    }

    /**
     * Generate synthetic expense for testing
     */
    _generateSyntheticExpense() {
        const syntheticExpenses = [
            { merchant: 'Pizza Palace', category: 'dining', amount: 35.50, description: 'Friday night dinner' },
            { merchant: 'Whole Foods', category: 'groceries', amount: 85.00, description: 'Weekly grocery shopping' },
            { merchant: 'Shell Gas Station', category: 'transportation', amount: 45.00, description: 'Gas fillup' },
            { merchant: 'AMC Theaters', category: 'entertainment', amount: 28.00, description: 'Movie tickets' },
            { merchant: 'CVS Pharmacy', category: 'health', amount: 15.50, description: 'Prescription pickup' },
            { merchant: 'Comcast', category: 'utilities', amount: 89.99, description: 'Monthly internet bill' },
            { merchant: 'Amazon', category: 'shopping', amount: 67.00, description: 'Online purchase' },
            { merchant: 'The Steakhouse', category: 'business_meal', amount: 120.00, description: 'Client dinner' }
        ];

        return syntheticExpenses[Math.floor(Math.random() * syntheticExpenses.length)];
    }

    /**
     * Generate description from merchant and category
     */
    _generateDescription(merchant, category) {
        const descriptions = {
            dining: ['lunch', 'dinner', 'meal', 'eating out'],
            groceries: ['weekly shopping', 'grocery run', 'food shopping'],
            transportation: ['gas', 'fuel', 'commute', 'parking'],
            utilities: ['monthly bill', 'service payment'],
            entertainment: ['movie', 'show', 'tickets', 'streaming'],
            business_meal: ['client dinner', 'business lunch', 'team meeting'],
            shopping: ['purchase', 'retail', 'online order'],
            health: ['pharmacy', 'medical', 'prescription'],
            personal_care: ['haircut', 'salon', 'grooming']
        };

        const options = descriptions[category] || ['expense'];
        return options[Math.floor(Math.random() * options.length)];
    }

    /**
     * Get base categorization patterns (not user-specific)
     */
    _getBaseCategorizationPatterns() {
        return [
            { merchant: 'Starbucks', category: 'dining', amount: 6.50 },
            { merchant: 'Safeway', category: 'groceries', amount: 75.00 },
            { merchant: 'Chevron', category: 'transportation', amount: 50.00 },
            { merchant: 'PG&E', category: 'utilities', amount: 100.00 },
            { merchant: 'Netflix', category: 'entertainment', amount: 15.99 }
        ];
    }

    /**
     * Store sealed benchmark securely
     */
    async _storeSealedBenchmark(benchmarkId, assessments) {
        // Store metadata in domain_knowledge with tessa_only visibility
        await query(
            `INSERT INTO domain_knowledge (
                domain, topic, subtopic, content_text, content_structured,
                source_type, source_ref, visibility, difficulty_band, tags
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                'payments',
                'sealed_benchmark',
                'categorization',
                `Sealed benchmark set: ${benchmarkId}`,
                JSON.stringify({ benchmark_id: benchmarkId, count: assessments.length }),
                'system_spec',
                `benchmark:${benchmarkId}`,
                'tessa_only',
                3,
                JSON.stringify(['sealed', 'benchmark', 'evaluation'])
            ]
        );

        console.log(`[Tessa] Stored sealed benchmark: ${benchmarkId}`);
    }

    /**
     * Load assessment templates
     */
    _loadTemplates() {
        return {
            merchant_categorization: {
                name: 'Merchant Categorization',
                description: 'Categorize expense based on merchant and context'
            },
            amount_pattern: {
                name: 'Amount Pattern Recognition',
                description: 'Detect recurring patterns in spending'
            },
            description_inference: {
                name: 'Description Inference',
                description: 'Infer category from description keywords'
            }
        };
    }

    /**
     * Score an assessment response
     */
    scoreResponse(assessment, agentResponse) {
        const expected = assessment.expected_answer.toLowerCase().trim();
        const actual = agentResponse.toLowerCase().trim();

        if (expected === actual) {
            return { score: 1.0, feedback: 'Correct answer' };
        }

        // Check for category family matches (e.g., dining vs business_meal)
        const categoryFamilies = {
            food: ['dining', 'groceries', 'business_meal'],
            transport: ['transportation'],
            bills: ['utilities'],
            leisure: ['entertainment', 'personal_care']
        };

        for (const family of Object.values(categoryFamilies)) {
            if (family.includes(expected) && family.includes(actual)) {
                return { score: 0.5, feedback: 'Reasonable category family match' };
            }
        }

        return { score: 0.0, feedback: 'Incorrect category' };
    }
}

module.exports = TessaAssessments;
