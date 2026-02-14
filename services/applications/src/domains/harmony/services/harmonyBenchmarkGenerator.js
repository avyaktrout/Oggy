/**
 * Harmony Benchmark Generator
 *
 * Generates sealed benchmarks that test model knowledge of:
 * - Indicator identification and classification
 * - Score prediction under hypothetical changes
 * - Data quality assessment
 * - Cross-city comparison reasoning
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const providerResolver = require('../../../shared/providers/providerResolver');

const COMPLEXITY_TIERS = {
    1: { label: 'Foundation', scenarios: 10, types: ['indicator_classification'] },
    2: { label: 'Developing', scenarios: 12, types: ['indicator_classification', 'score_prediction'] },
    3: { label: 'Intermediate', scenarios: 15, types: ['indicator_classification', 'score_prediction', 'data_quality'] },
    4: { label: 'Advanced', scenarios: 18, types: ['indicator_classification', 'score_prediction', 'data_quality', 'cross_city'] },
    5: { label: 'Master', scenarios: 20, types: ['indicator_classification', 'score_prediction', 'data_quality', 'cross_city', 'model_critique'] },
};

async function createBenchmark(options = {}) {
    const { scale = 1, userId, name } = options;
    const tier = COMPLEXITY_TIERS[Math.min(scale, 5)] || COMPLEXITY_TIERS[1];
    const benchmarkId = uuidv4();
    const benchmarkName = name || `harmony-benchmark-${Date.now()}`;

    logger.info('Generating harmony benchmark', { benchmarkId, scale, tier: tier.label, scenarios: tier.scenarios });

    // Load context
    const [nodesResult, indicatorsResult] = await Promise.all([
        query(`
            SELECT n.node_id, n.name, n.scope, s.harmony, s.e_scaled, s.intent_coherence,
                   s.balance, s.flow, s.care, s.awareness, s.expression, s.e_raw
            FROM harmony_nodes n
            LEFT JOIN harmony_scores s ON s.node_id = n.node_id
            WHERE n.scope = 'city'
        `),
        query(`SELECT key, name, dimension, unit, direction, description FROM harmony_indicators`),
    ]);

    const nodes = nodesResult.rows;
    const indicators = indicatorsResult.rows;
    const scenarios = [];
    let errors = 0;

    // Generate scenarios per type, distributed across tier types
    const scenariosPerType = Math.ceil(tier.scenarios / tier.types.length);

    for (const type of tier.types) {
        for (let i = 0; i < scenariosPerType && scenarios.length < tier.scenarios; i++) {
            try {
                const scenario = await _generateScenario(type, scale, nodes, indicators, userId);
                if (scenario) {
                    scenario.scenario_id = uuidv4();
                    scenario.benchmark_id = benchmarkId;
                    scenario.order_index = scenarios.length;
                    scenarios.push(scenario);
                }
            } catch (err) {
                errors++;
                logger.error('Harmony benchmark scenario generation failed', { type, error: err.message });
            }
        }
    }

    // Store benchmark (reuse existing schema: domain in metadata, scale in metadata)
    await query(`
        INSERT INTO sealed_benchmarks (benchmark_id, benchmark_name, description, scenario_count, use_ood, difficulty_mix, created_at, metadata, domain)
        VALUES ($1, $2, $3, $4, false, $5, NOW(), $6, 'harmony')
    `, [
        benchmarkId,
        benchmarkName,
        `Harmony benchmark (${tier.label}, scale ${scale})`,
        scenarios.length,
        'mixed',
        JSON.stringify({ domain: 'harmony', scale, tier: tier.label, errors })
    ]);

    // Store scenarios (reuse existing columns: merchant=type, amount=scale, description=question, correct_category=answer)
    for (const s of scenarios) {
        try {
            await query(`
                INSERT INTO sealed_benchmark_scenarios
                (scenario_id, benchmark_id, order_index, merchant, amount, description, correct_category, reasoning, generator, model, domain)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'harmony')
            `, [s.scenario_id, benchmarkId, s.order_index, s.type, scale, s.question, s.correct_answer, s.reasoning || '', 'claude', 'harmony-gen']);
        } catch (err) {
            logger.warn('Failed to insert harmony benchmark scenario', { scenario_id: s.scenario_id, error: err.message });
        }
    }

    const result = {
        benchmark_id: benchmarkId,
        benchmark_name: benchmarkName,
        scenarios_count: scenarios.length,
        errors_count: errors,
        scale,
        message: `Generated ${scenarios.length} harmony benchmark scenarios (${tier.label})`,
    };

    logger.info('Harmony benchmark generated', result);
    return result;
}

async function _generateScenario(type, scale, nodes, indicators, userId) {
    const city = nodes[Math.floor(Math.random() * nodes.length)];
    const cityName = city?.name || 'San Francisco';
    const indicatorList = indicators.map(i => `${i.key} (${i.dimension})`).join(', ');

    const prompts = {
        indicator_classification: {
            system: 'Generate a harmony map benchmark question about classifying an indicator into the correct dimension. The Equilibrium Canon dimensions are: Balance (safety/economic), Flow (mobility/access), Compassion (health/housing/food), Discernment (education/civic), Awareness (education/engagement), Expression (arts/freedom).',
            user: `Create a question that asks which dimension a given indicator belongs to. Scale difficulty: ${scale}/5. City context: ${cityName}. Existing indicators: ${indicatorList}. Return JSON: { "question": "...", "correct_answer": "...", "reasoning": "...", "options": ["Balance", "Flow", "Compassion", "Discernment", "Awareness", "Expression"] }`,
        },
        score_prediction: {
            system: 'Generate a benchmark question about predicting score changes in the Harmony Map. H = sqrt(E*S), E = (B*F*C)^(1/3), S = sqrt(A*X), C = Compassion*Discernment.',
            user: `Create a question where a specific indicator changes and the model must predict the directional and approximate magnitude change in the composite scores (B, F, C, E, S, H). City: ${cityName} with scores H=${city?.harmony || 0.5}, E=${city?.e_scaled || 0.4}, S=${city?.intent_coherence || 0.6}. Scale: ${scale}/5. Return JSON: { "question": "...", "correct_answer": "...", "reasoning": "..." }`,
        },
        data_quality: {
            system: 'Generate a benchmark question about assessing data quality for harmony map indicators.',
            user: `Create a question about identifying data quality issues (staleness, coverage gaps, unreliable sources) for ${cityName}. Scale: ${scale}/5. Return JSON: { "question": "...", "correct_answer": "...", "reasoning": "..." }`,
        },
        cross_city: {
            system: 'Generate a benchmark question about comparing cities in the Harmony Map framework.',
            user: `Create a question comparing two cities and asking which policy change would most improve the lower-scoring city. Cities: ${nodes.slice(0, 2).map(n => `${n.name}: H=${n.harmony || '?'}`).join(', ')}. Scale: ${scale}/5. Return JSON: { "question": "...", "correct_answer": "...", "reasoning": "..." }`,
        },
        model_critique: {
            system: 'Generate a benchmark question about critiquing or improving the Equilibrium Canon model itself.',
            user: `Create a question that asks the model to identify a weakness or limitation in the Equilibrium Canon formula (H = sqrt(E*S)) and suggest an improvement. Scale: ${scale}/5. Return JSON: { "question": "...", "correct_answer": "...", "reasoning": "..." }`,
        },
    };

    const prompt = prompts[type];
    if (!prompt) return null;

    try {
        const resolved = await providerResolver.getAdapter(userId || 'system', 'base');
        const messages = [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
        ];
        const response = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages,
            temperature: 0.7,
            max_tokens: 600,
        });
        const text = response.text || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                type,
                question: parsed.question,
                correct_answer: parsed.correct_answer,
                reasoning: parsed.reasoning || '',
                options: parsed.options || null,
            };
        }
    } catch (err) {
        logger.error('Harmony scenario generation LLM call failed', { type, error: err.message });
    }
    return null;
}

async function getBenchmark(identifier, userId) {
    // Try by name first, then by ID
    let result = await query(
        `SELECT * FROM sealed_benchmarks WHERE benchmark_name = $1 AND domain = 'harmony'`,
        [identifier]
    );
    if (result.rows.length === 0) {
        // Only try UUID lookup if identifier looks like a UUID
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(identifier)) {
            result = await query(
                `SELECT * FROM sealed_benchmarks WHERE benchmark_id = $1 AND domain = 'harmony'`,
                [identifier]
            );
        }
    }
    if (result.rows.length === 0) return null;

    const benchmark = result.rows[0];
    const scenariosResult = await query(
        `SELECT scenario_id, benchmark_id, order_index,
                merchant AS scenario_type, amount AS scale,
                description AS question, correct_category AS correct_answer,
                reasoning, generator, model
         FROM sealed_benchmark_scenarios WHERE benchmark_id = $1 ORDER BY order_index`,
        [benchmark.benchmark_id]
    );
    benchmark.scenarios = scenariosResult.rows;
    return benchmark;
}

module.exports = { createBenchmark, getBenchmark };
