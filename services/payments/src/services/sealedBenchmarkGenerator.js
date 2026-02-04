/**
 * Sealed Benchmark Generator
 * Creates fixed, out-of-distribution test sets using Claude (not GPT)
 * Prevents overfitting to Tessa's GPT-4o-mini generation patterns
 *
 * Week 8: Scientific Evaluation with OOD Testing
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const CircuitBreaker = require('../utils/circuitBreaker');
const retryHandler = require('../utils/retry');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-3-haiku-20240307'; // Claude 3 Haiku - fast and affordable
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'gpt-4o-mini';

/**
 * Out-of-Distribution Sealed Benchmark Generator
 * Uses Claude instead of GPT to create truly independent test sets
 */
class SealedBenchmarkGenerator {
    constructor() {
        this.claudeCircuitBreaker = new CircuitBreaker({
            name: 'sealed-benchmark-claude',
            failureThreshold: 3,
            timeout: 30000
        });

        this.openaiCircuitBreaker = new CircuitBreaker({
            name: 'sealed-benchmark-openai',
            failureThreshold: 3,
            timeout: 30000
        });

        this.categories = [
            'business_meal',
            'groceries',
            'transportation',
            'utilities',
            'entertainment',
            'health',
            'dining',
            'shopping'
        ];

        // Scale complexity definitions - higher scales require more complex understanding
        this.scaleComplexity = {
            1: {
                name: 'Foundation',
                description: 'Basic payment categorization with clear indicators',
                requirements: [
                    'Single clear category indicator',
                    'Common merchant names',
                    'Standard transaction amounts',
                    'Obvious category signals in description'
                ],
                example_scenarios: 'Starbucks coffee purchase, Amazon book order, Uber ride'
            },
            2: {
                name: 'Intermediate',
                description: 'Multi-factor scenarios requiring context analysis',
                requirements: [
                    'Category depends on context clues',
                    'Amount-based category hints',
                    'Time-sensitive categorization',
                    'Merchant name alone is insufficient'
                ],
                example_scenarios: 'Restaurant receipt requiring dining vs business_meal distinction, store purchase needing groceries vs shopping analysis'
            },
            3: {
                name: 'Advanced',
                description: 'Complex real-world payment patterns',
                requirements: [
                    'Multi-category potential transactions',
                    'Subscription service categorization',
                    'Business vs personal expense blur',
                    'International payment patterns',
                    'Partial refunds and adjustments'
                ],
                example_scenarios: 'Costco membership (groceries vs shopping), WeWork payment (utilities vs business), international conference registration'
            },
            4: {
                name: 'Expert',
                description: 'Edge cases requiring deep contextual understanding',
                requirements: [
                    'Tax-relevant distinctions',
                    'Regulatory-sensitive categories',
                    'Unusual merchant types',
                    'Compound transactions',
                    'Reimbursement scenarios'
                ],
                example_scenarios: 'Medical spa service (health vs personal_care), home office equipment (shopping vs business), charity dinner auction'
            },
            5: {
                name: 'Master',
                description: 'Ambiguous scenarios with multiple valid interpretations',
                requirements: [
                    'Transactions with genuinely ambiguous categories',
                    'Temporal context affecting category',
                    'User intent inference required',
                    'Chained transaction analysis',
                    'Split-bill scenarios'
                ],
                example_scenarios: 'Birthday party at restaurant (dining vs entertainment), gym cafe purchase (health vs dining), airport lounge access'
            }
        };
    }

    /**
     * Create a sealed benchmark set
     * @param {object} options - Benchmark creation options
     * @returns {object} Created benchmark with ID and scenarios
     */
    async createSealedBenchmark(options = {}) {
        const {
            count = 100,              // Number of assessments
            name = null,              // Optional name for the benchmark
            description = null,       // Optional description
            difficulty_mix = 'balanced', // balanced, easy, hard, mixed
            use_ood = true,           // Use out-of-distribution (Claude) generation
            scale = 1,                // Scale level S1-S10 (higher = more complex scenarios)
            level = 3,                // Difficulty level within scale (1-5)
            complexity_factors = [],  // Additional complexity requirements
            require_context = false,  // Require contextual understanding
            require_reasoning = false, // Require multi-step reasoning
            multi_step = false        // Require chained analysis
        } = options;

        const benchmark_id = uuidv4();
        const benchmark_name = name || `sealed_benchmark_${Date.now()}`;

        // Get scale complexity config
        const scaleConfig = this.scaleComplexity[Math.min(scale, 5)] || this.scaleComplexity[5];

        logger.info('Creating sealed benchmark', {
            benchmark_id,
            benchmark_name,
            count,
            use_ood,
            scale,
            level,
            scale_name: scaleConfig.name,
            complexity_factors
        });

        // Generate scenarios
        const scenarios = [];
        const errors = [];

        for (let i = 0; i < count; i++) {
            try {
                const category = this._randomCategory();
                const difficulty = this._selectDifficulty(difficulty_mix, i, count);

                // Pass scale context to generation
                const scaleContext = {
                    scale,
                    level,
                    scaleConfig,
                    complexity_factors,
                    require_context,
                    require_reasoning,
                    multi_step
                };

                const scenario = use_ood
                    ? await this._generateOODScenario(category, difficulty, scaleContext)
                    : await this._generateInDistributionScenario(category, difficulty, scaleContext);

                if (scenario) {
                    scenarios.push({
                        scenario_id: uuidv4(),
                        ...scenario,
                        order_index: i,
                        scale,
                        level
                    });
                }

                // Small delay to avoid rate limits
                await this._sleep(200);
            } catch (error) {
                errors.push({
                    index: i,
                    error: error.message
                });
                logger.warn('Failed to generate sealed benchmark scenario', {
                    index: i,
                    error: error.message
                });
            }
        }

        // Store sealed benchmark in database
        await this._storeSealedBenchmark({
            benchmark_id,
            benchmark_name,
            description,
            scenarios,
            count,
            use_ood,
            difficulty_mix,
            errors
        });

        logger.info('Sealed benchmark created', {
            benchmark_id,
            benchmark_name,
            scenarios_count: scenarios.length,
            errors_count: errors.length
        });

        return {
            benchmark_id,
            benchmark_name,
            scenarios_count: scenarios.length,
            errors_count: errors.length,
            use_ood,
            message: `Sealed benchmark created with ${scenarios.length} scenarios`
        };
    }

    /**
     * Generate out-of-distribution scenario using Claude
     * This is different from Tessa's GPT-4o-mini generation patterns
     */
    async _generateOODScenario(category, difficulty, scaleContext = null) {
        const prompt = this._buildClaudePrompt(category, difficulty, scaleContext);

        return await this.claudeCircuitBreaker.execute(async () => {
            return await retryHandler.withRetry(
                async () => await this._callClaude(prompt),
                {
                    maxRetries: 2,
                    baseDelay: 1000,
                    operationName: 'sealed-benchmark-ood-generation'
                }
            );
        });
    }

    /**
     * Generate in-distribution scenario (for control benchmarks)
     * Uses similar style to Tessa but not stored for training
     */
    async _generateInDistributionScenario(category, difficulty, scaleContext = null) {
        // Use similar GPT prompt style as Tessa but mark as sealed
        // This is for control/comparison benchmarks
        const prompt = this._buildGPTLikePrompt(category, difficulty, scaleContext);

        return await this.openaiCircuitBreaker.execute(async () => {
            return await retryHandler.withRetry(
                async () => await this._callOpenAI(prompt, category),
                {
                    maxRetries: 2,
                    baseDelay: 1000,
                    operationName: 'sealed-benchmark-id-generation'
                }
            );
        });
    }

    /**
     * Call OpenAI API for in-distribution scenario generation
     */
    async _callOpenAI(prompt, category) {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: OPENAI_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert at generating realistic expense categorization scenarios. Return only valid JSON.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.9,
                max_tokens: 300
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const content = response.data.choices[0].message.content.trim();
        const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        return {
            merchant: parsed.merchant,
            amount: parsed.amount,
            description: parsed.description,
            category: category,
            reasoning: parsed.reasoning || '',
            generator: 'gpt-style',
            model: OPENAI_MODEL
        };
    }

    /**
     * Build Claude prompt for OOD generation
     * Intentionally different style from Tessa's GPT prompts
     * Designed to create CHALLENGING scenarios that test true understanding
     */
    _buildClaudePrompt(category, difficulty, scaleContext = null) {
        // All difficulties are now harder - even "easy" requires thought
        const difficultyInstructions = {
            'easy': 'requires reading the full description to determine category',
            'medium': 'has elements that could suggest multiple categories',
            'hard': 'deliberately misleading surface details that resolve correctly on analysis',
            'very_hard': 'genuinely tricky with subtle contextual clues being decisive'
        };

        // Ambiguous category pairs that we want to emphasize
        const ambiguousPairs = {
            'dining': ['business_meal', 'entertainment', 'groceries'],
            'business_meal': ['dining', 'entertainment'],
            'groceries': ['shopping', 'dining'],
            'shopping': ['groceries', 'entertainment', 'health'],
            'entertainment': ['dining', 'shopping', 'health'],
            'health': ['shopping', 'entertainment'],
            'transportation': ['shopping', 'entertainment'],
            'utilities': ['shopping', 'entertainment']
        };

        const confusableWith = ambiguousPairs[category] || [];

        // Build scale-specific complexity instructions
        let scaleInstructions = '';
        if (scaleContext) {
            const { scale, level, scaleConfig } = scaleContext;
            scaleInstructions = `
## SCALE: S${scale} L${level} - ${scaleConfig.name}
Complexity factors to incorporate: ${scaleConfig.requirements.slice(0, 3).join(', ')}
`;
        }

        return `Create AMBIGUOUS expense scenarios where MULTIPLE categories are plausible, but ${category} is correct BY CONVENTION.
${scaleInstructions}
Target category: ${category}
Difficulty: ${difficulty} - ${difficultyInstructions[difficulty]}

## GOAL: GENUINE AMBIGUITY WITH A CONVENTIONAL ANSWER

Create a scenario where BOTH ${category} AND ${confusableWith[0] || 'another category'} seem like reasonable answers, but ${category} is the CONVENTIONAL choice based on standard expense categorization rules.

### AMBIGUITY REQUIREMENTS:

1. **INCLUDE SIGNALS FOR BOTH CATEGORIES**
   - Add elements that suggest ${category}
   - AND elements that suggest ${confusableWith[0] || 'another category'}
   - The scenario should make a reader pause and think

2. **${category.toUpperCase()} WINS BY THE "PRIMARY PURPOSE" RULE**
   - When in doubt, categorize by the PRIMARY purpose of the transaction
   - Even if secondary activities are present, PRIMARY determines category
   - Make ${category} the PRIMARY purpose (but don't make it obvious)

3. **MERCHANT NAMES: Neutral and varied**
   - Names should NOT favor either category
   - Use unique names each time: Crossroads, Summit Place, Chen's Corner, etc.
   - NEVER: ${this._getMerchantBannedWords(category)}

### THE ${category.toUpperCase()} RULE:
${this._getCategorySubtleties(category)}

### THE DISTINCTION TO TEST:
${this._getDistinctionRule(category, confusableWith[0])}

### TRICKY SCENARIO PATTERNS - USE THESE:

**${category === 'business_meal' ? 'USE THIS PATTERN:' : 'business_meal pattern:'}**
"Coffee with Sam at Pine Street. Talked about his vacation, the weather, his dog. At the end he slipped me the contract revisions to review."
TRICK: 95% personal, 5% business at the end = business_meal. Most AI says dining.

**${category === 'dining' ? 'USE THIS PATTERN:' : 'dining pattern:'}**
"Lunch with my project lead. She mentioned she's stressed about deadlines but we didn't discuss any work - just her upcoming wedding plans."
TRICK: "project lead" screams business, but no business conducted = dining.

**${category === 'groceries' ? 'USE THIS PATTERN:' : 'groceries pattern:'}**
"Target trip. New bath towels, a lamp, cleaning supplies. Oh and chicken, rice, and veggies for meal prep this week."
TRICK: More non-food items, but food for home prep is the deciding factor = groceries.

**${category === 'shopping' ? 'USE THIS PATTERN:' : 'shopping pattern:'}**
"Went to get milk and bread but they had PlayStation 5 in stock finally. Grabbed that plus the usual groceries."
TRICK: Went for groceries but main purchase was electronics = shopping.

**${category === 'transportation' ? 'USE THIS PATTERN:' : 'transportation pattern:'}**
"Stopped at QuickMart. Monster energy, chips, magazine, gum. Filled up too since I was already there."
TRICK: Lots of purchases mentioned first, fuel almost incidental = transportation.

**${category === 'entertainment' ? 'USE THIS PATTERN:' : 'entertainment pattern:'}**
"Dinner and a show at City Hall venue. The prix fixe menu was $85. Amazing jazz performance."
TRICK: Expensive dinner is prominent, but show is primary purpose = entertainment.

**${category === 'health' ? 'USE THIS PATTERN:' : 'health pattern:'}**
"Dropped by the wellness store. Protein powder, vitamins, new running shoes. Also picked up my prescription refill."
TRICK: Lots of retail wellness items, but prescription = health.

**${category === 'utilities' ? 'USE THIS PATTERN:' : 'utilities pattern:'}**
"Set up the new streaming package through Verizon. It includes live TV, faster internet, and the sports tier."
TRICK: Sounds like entertainment, but bundled with internet = utilities.

### DIFFICULTY CALIBRATION - TARGET: 70% ACCURACY FOR GENERIC AI

The scenario should be hard enough that a generic AI model would get it WRONG 30% of the time.

**MAKE IT HARDER BY:**
1. Use language that STRONGLY suggests ${confusableWith[0]}
2. Put the ${category} signal at the very END, almost as an afterthought
3. Make the ${confusableWith[0]} signals more numerous and prominent
4. The ${category} signal should be just ONE brief phrase that tips the balance

**EXAMPLE OF 70% DIFFICULTY:**
For business_meal: "Grabbed lunch with Alex at Pine Street. Talked about the game, his kids, the traffic. Oh, and he gave me the contract draft to look over."
(99% personal chat, 1% business = business_meal, but most AI would say dining)

### RETURN JSON:

{
  "merchant": "Unique neutral name",
  "amount": number,
  "description": "2-3 sentences with signals for BOTH categories, but ${category} is primary",
  "category": "${category}",
  "reasoning": "Why ${category} wins as the PRIMARY purpose despite the ${confusableWith[0]} signals"
}`;
    }

    /**
     * Get subtle category definitions that highlight edge cases
     */
    _getCategorySubtleties(category) {
        const subtleties = {
            'business_meal': `A meal where BUSINESS IS CONDUCTED - not just eating near work or with coworkers.
MUST HAVE: discussion of work matters, deals, projects, budgets, client relationships, formal meetings.
NOT business_meal: casual lunch with a coworker talking about personal life, eating at a work cafeteria.
CRITICAL: The meal's PRIMARY PURPOSE must be business, not incidental work chat.`,

            'dining': `Personal eating out - restaurants, cafes, takeout for non-work purposes.
MUST HAVE: personal context (friends, family, solo, date, celebration) OR absence of any work context.
NOT dining: any meal where business is conducted, even if it feels casual.
CRITICAL: If work topics come up but aren't the PURPOSE, it's still dining. If business is conducted, it's business_meal.`,

            'groceries': `Buying food/ingredients for home preparation.
MUST HAVE: purchasing food items to cook/consume at home, weekly shopping, stocking up.
NOT groceries: buying a prepared meal to eat now (dining), buying non-food items (shopping).
CRITICAL: Focus on WHAT is being purchased (food for home) not WHERE (grocery stores sell non-food too).`,

            'shopping': `Purchasing non-food retail goods.
MUST HAVE: clothing, electronics, home goods, household items, online orders for products.
NOT shopping: food purchases (groceries/dining), entertainment subscriptions, services.
CRITICAL: Physical or digital PRODUCTS that aren't food.`,

            'entertainment': `Leisure activities, experiences, and entertainment services.
MUST HAVE: movies, concerts, events, streaming subscriptions, games, hobbies, recreational activities.
NOT entertainment: purchasing hobby equipment (shopping), eating at entertainment venues without the entertainment.
CRITICAL: Paying for an EXPERIENCE or entertainment service, not a product.`,

            'health': `Medical, wellness, and fitness expenses.
MUST HAVE: medical services, prescriptions, gym/fitness memberships, therapy, health treatments.
NOT health: buying general supplements at a store (shopping), eating healthy food (groceries/dining).
CRITICAL: Medical services, fitness memberships, or prescribed treatments.`,

            'transportation': `Vehicle and travel expenses.
MUST HAVE: fuel, parking, rideshare, public transit, vehicle maintenance, tolls.
NOT transportation: buying snacks at a gas station (if no fuel), buying car accessories (shopping).
CRITICAL: The PRIMARY purpose is travel/vehicle operation, not incidental purchases.`,

            'utilities': `Home service bills and payments.
MUST HAVE: electricity, water, internet, phone, gas utility, trash services.
NOT utilities: buying equipment for utilities (shopping), paying for mobile apps (entertainment).
CRITICAL: Recurring home service payments.`
        };

        return subtleties[category] || `Standard ${category} transaction with clear indicators.`;
    }

    /**
     * Get banned phrases that make categorization too obvious
     */
    _getBannedPhrases(category) {
        const banned = {
            'business_meal': 'client, meeting, conference, proposal, business lunch, networking event, work dinner, colleague lunch',
            'dining': 'restaurant, dinner, lunch out, brunch, cafe meal, eating out',
            'groceries': 'grocery store, supermarket, food shopping, weekly groceries, produce section',
            'shopping': 'bought clothes, purchased items, retail store, shopping mall, ordered online',
            'entertainment': 'movie theater, concert tickets, streaming subscription, video games, amusement park',
            'health': 'doctor visit, pharmacy, medical appointment, gym membership, clinic',
            'transportation': 'gas station, filled up tank, uber ride, parking meter, toll road, transit pass',
            'utilities': 'electric bill, water bill, internet service, phone plan, utility payment'
        };
        return banned[category] || 'obvious category indicators';
    }

    /**
     * Get the key distinction rule between this category and its confusable pair
     */
    _getDistinctionRule(category, confusableWith) {
        const rules = {
            'business_meal': {
                'dining': 'business_meal = business is CONDUCTED (deals, planning, work assignments). dining = just eating with people, even coworkers, with NO business conducted.',
                'entertainment': 'business_meal = eating + business. entertainment = activities/experiences without business.'
            },
            'dining': {
                'business_meal': 'dining = personal meal with NO business conducted. Even mentioning work stress is still dining. business_meal = actual work discussion/decisions.',
                'entertainment': 'dining = eating is the main event. entertainment = activity (movie, concert) is primary.',
                'groceries': 'dining = eating prepared food NOW at a venue. groceries = buying food to prepare AT HOME.'
            },
            'groceries': {
                'shopping': 'groceries = PRIMARY purchase is food for home prep. shopping = PRIMARY purchase is non-food items.',
                'dining': 'groceries = buying ingredients for home cooking. dining = buying prepared food to eat now.'
            },
            'shopping': {
                'groceries': 'shopping = PRIMARY purchase is non-food retail (clothes, electronics, home goods). Even at a grocery store, if main item is non-food = shopping.',
                'entertainment': 'shopping = buying PRODUCTS. entertainment = paying for EXPERIENCES/services.',
                'health': 'shopping = general retail items. health = medical services, prescriptions, or fitness memberships.'
            },
            'entertainment': {
                'dining': 'entertainment = activity/experience is primary (concert, movie, streaming). dining = food is the main event.',
                'shopping': 'entertainment = paying for experiences/subscriptions. shopping = paying for products.',
                'health': 'entertainment = recreational activities. health = wellness services or medical.'
            },
            'health': {
                'shopping': 'health = medical services, prescriptions, professional treatments. shopping = buying products even if wellness-related (unless prescription).',
                'entertainment': 'health = medical/wellness services. entertainment = recreational activities.'
            },
            'transportation': {
                'shopping': 'transportation = fuel/parking/transit is PRIMARY purpose. shopping = buying products is primary (even at a gas station).',
                'entertainment': 'transportation = getting somewhere. entertainment = the activity at the destination.'
            },
            'utilities': {
                'shopping': 'utilities = recurring home service bills (electric, water, internet). shopping = one-time product purchases.',
                'entertainment': 'utilities = home services. entertainment = streaming/gaming subscriptions (entertainment, not utility).'
            }
        };

        const categoryRules = rules[category] || {};
        return categoryRules[confusableWith] || `${category} has specific characteristics that distinguish it from ${confusableWith}.`;
    }

    /**
     * Get banned words for merchant names that reveal the category
     */
    _getMerchantBannedWords(category) {
        const banned = {
            'business_meal': 'Boardroom, Corporate, Executive, Business, Conference, Office, Professional',
            'dining': 'Restaurant, Diner, Cafe, Bistro, Grill, Kitchen, Eatery, Food',
            'groceries': 'Grocery, Market, Supermarket, Foods, Fresh, Produce, Mart',
            'shopping': 'Mall, Outlet, Shop, Store, Retail, Goods, Depot',
            'entertainment': 'Theater, Cinema, Games, Fun, Entertainment, Play, Arcade',
            'health': 'Health, Medical, Clinic, Wellness, Fitness, Gym, Pharmacy, Care',
            'transportation': 'Gas, Fuel, Auto, Car, Transit, Transport, Parking, Station',
            'utilities': 'Electric, Power, Energy, Water, Utility, Service, Telecom'
        };
        return banned[category] || 'obvious category words';
    }

    /**
     * Build GPT-like prompt for in-distribution control benchmarks
     */
    _buildGPTLikePrompt(category, difficulty, scaleContext = null) {
        const difficultyNotes = {
            'easy': 'Make it obvious and typical',
            'medium': 'Make it realistic and common',
            'hard': 'Include some ambiguity or edge case elements',
            'very_hard': 'Make it highly ambiguous with multiple plausible categories'
        };

        let scaleNote = '';
        if (scaleContext && scaleContext.scale >= 2) {
            const { scale, scaleConfig } = scaleContext;
            scaleNote = `
Scale: S${scale} (${scaleConfig.name})
Complexity Requirements: ${scaleConfig.requirements.slice(0, 2).join(', ')}
The scenario should reflect this complexity level.
`;
        }

        return `Generate a realistic expense categorization scenario.

Target category: ${category}
Difficulty: ${difficulty}
Note: ${difficultyNotes[difficulty]}
${scaleNote}
Create a JSON object with:
{
  "merchant": "realistic merchant name",
  "amount": numerical amount,
  "description": "transaction description",
  "category": "${category}",
  "reasoning": "why this belongs in ${category}"
}

Return only the JSON object.`;
    }

    /**
     * Call Claude API for OOD generation
     */
    async _callClaude(prompt) {
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: ANTHROPIC_MODEL,
                max_tokens: 500,
                temperature: 0.8, // Moderate creativity
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            },
            {
                headers: {
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                },
                timeout: 15000
            }
        );

        const completion = response.data.content[0].text.trim();

        // Parse JSON from response
        const jsonStr = completion.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        return {
            merchant: parsed.merchant,
            amount: parsed.amount,
            description: parsed.description,
            category: parsed.category,
            reasoning: parsed.reasoning || '',
            generator: 'claude',
            model: ANTHROPIC_MODEL
        };
    }

    /**
     * Store sealed benchmark in database
     */
    async _storeSealedBenchmark(benchmarkData) {
        const {
            benchmark_id,
            benchmark_name,
            description,
            scenarios,
            count,
            use_ood,
            difficulty_mix,
            errors
        } = benchmarkData;

        // Store benchmark metadata
        await query(`
            INSERT INTO sealed_benchmarks (
                benchmark_id,
                benchmark_name,
                description,
                scenario_count,
                use_ood,
                difficulty_mix,
                created_at,
                metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
        `, [
            benchmark_id,
            benchmark_name,
            description,
            scenarios.length,
            use_ood,
            difficulty_mix,
            JSON.stringify({
                total_requested: count,
                successful: scenarios.length,
                errors: errors.length,
                generator: use_ood ? 'claude' : 'gpt-style',
                model: ANTHROPIC_MODEL
            })
        ]);

        // Store individual scenarios
        let scenariosStored = 0;
        for (const scenario of scenarios) {
            try {
                await query(`
                    INSERT INTO sealed_benchmark_scenarios (
                        scenario_id,
                        benchmark_id,
                        order_index,
                        merchant,
                        amount,
                        description,
                        correct_category,
                        reasoning,
                        generator,
                        model
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `, [
                    scenario.scenario_id,
                    benchmark_id,
                    scenario.order_index,
                    scenario.merchant,
                    scenario.amount,
                    scenario.description,
                    scenario.category,
                    scenario.reasoning,
                    scenario.generator || 'claude',
                    scenario.model || ANTHROPIC_MODEL
                ]);
                scenariosStored++;
            } catch (insertError) {
                logger.warn('Failed to insert scenario', {
                    benchmark_id,
                    scenario_id: scenario.scenario_id,
                    category: scenario.category,
                    error: insertError.message
                });
            }
        }

        // Update scenario_count with actual stored count
        if (scenariosStored !== scenarios.length) {
            await query(`
                UPDATE sealed_benchmarks
                SET scenario_count = $1
                WHERE benchmark_id = $2
            `, [scenariosStored, benchmark_id]);
        }

        logger.info('Sealed benchmark stored in database', {
            benchmark_id,
            scenarios_generated: scenarios.length,
            scenarios_stored: scenariosStored
        });
    }

    /**
     * Get sealed benchmark by ID or name
     */
    async getSealedBenchmark(identifier) {
        // Check if identifier is UUID or name
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

        const benchmarkQuery = isUUID
            ? 'SELECT * FROM sealed_benchmarks WHERE benchmark_id = $1'
            : 'SELECT * FROM sealed_benchmarks WHERE benchmark_name = $1';

        const benchmarkResult = await query(benchmarkQuery, [identifier]);

        if (benchmarkResult.rows.length === 0) {
            throw new Error(`Sealed benchmark not found: ${identifier}`);
        }

        const benchmark = benchmarkResult.rows[0];

        // Get scenarios
        const scenariosResult = await query(`
            SELECT * FROM sealed_benchmark_scenarios
            WHERE benchmark_id = $1
            ORDER BY order_index
        `, [benchmark.benchmark_id]);

        return {
            ...benchmark,
            scenarios: scenariosResult.rows
        };
    }

    /**
     * List all sealed benchmarks
     */
    async listSealedBenchmarks() {
        const result = await query(`
            SELECT
                benchmark_id,
                benchmark_name,
                description,
                scenario_count,
                use_ood,
                difficulty_mix,
                created_at,
                metadata
            FROM sealed_benchmarks
            ORDER BY created_at DESC
        `);

        return result.rows;
    }

    /**
     * Select difficulty based on mix strategy
     */
    _selectDifficulty(difficulty_mix, index, total) {
        switch (difficulty_mix) {
            case 'easy':
                return 'easy';
            case 'hard':
                return Math.random() > 0.5 ? 'hard' : 'very_hard';
            case 'balanced':
                const rand = Math.random();
                if (rand < 0.25) return 'easy';
                if (rand < 0.50) return 'medium';
                if (rand < 0.75) return 'hard';
                return 'very_hard';
            case 'mixed':
                // Progressive difficulty
                const progress = index / total;
                if (progress < 0.25) return 'easy';
                if (progress < 0.50) return 'medium';
                if (progress < 0.75) return 'hard';
                return 'very_hard';
            default:
                return 'medium';
        }
    }

    _randomCategory() {
        return this.categories[Math.floor(Math.random() * this.categories.length)];
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Singleton instance
const sealedBenchmarkGenerator = new SealedBenchmarkGenerator();

module.exports = sealedBenchmarkGenerator;
