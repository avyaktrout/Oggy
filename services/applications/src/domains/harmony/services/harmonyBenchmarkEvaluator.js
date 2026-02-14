/**
 * Harmony Benchmark Evaluator
 *
 * Runs Oggy (with memory) and Base (without) against sealed benchmark
 * scenarios, comparing accuracy and generating suggestions from results.
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const providerResolver = require('../../../shared/providers/providerResolver');
const harmonySuggestionService = require('./harmonySuggestionService');

const HARMONY_DIMENSIONS = 'Balance (safety/economic stability), Flow (mobility/infrastructure access), Compassion (health/housing/food security), Discernment (education/civic engagement), Awareness (environmental/community engagement), Expression (arts/cultural freedom)';
const DIMENSION_NAMES = ['balance', 'flow', 'compassion', 'discernment', 'awareness', 'expression'];

async function testOnBenchmark({ benchmark_identifier, user_id }) {
    const benchmarkGenerator = require('./harmonyBenchmarkGenerator');
    const benchmark = await benchmarkGenerator.getBenchmark(benchmark_identifier, user_id);
    if (!benchmark) throw new Error(`Benchmark not found: ${benchmark_identifier}`);

    const scenarios = benchmark.scenarios || [];
    if (scenarios.length === 0) throw new Error('Benchmark has no scenarios');

    // Enrich classification questions with available dimension choices
    for (const scenario of scenarios) {
        if (scenario.scenario_type === 'indicator_classification' && !scenario.question.includes('Balance, Flow')) {
            scenario.question += '\nChoose from: Balance, Flow, Compassion, Discernment, Awareness, Expression.';
        }
    }

    const resultId = uuidv4();
    const oggyResults = [];
    const baseResults = [];

    logger.info('Starting harmony benchmark evaluation', {
        resultId, benchmarkId: benchmark.benchmark_id, scenarios: scenarios.length, userId: user_id,
    });

    const trainingState = await _captureTrainingState(user_id);
    const baseStartTime = Date.now();

    // Run Base first (control)
    for (const scenario of scenarios) {
        try {
            const result = await _testBase(scenario);
            baseResults.push(result);
        } catch (err) {
            baseResults.push({ correct: false, error: err.message });
        }
    }

    const baseDuration = Date.now() - baseStartTime;
    const oggyTimeout = baseDuration * 2.5; // Generous timeout for memory overhead
    const oggyStartTime = Date.now();

    // Run Oggy in waves of 5
    const WAVE_SIZE = 5;
    for (let i = 0; i < scenarios.length; i += WAVE_SIZE) {
        if (Date.now() - oggyStartTime > oggyTimeout) {
            // Timeout remaining
            for (let j = i; j < scenarios.length; j++) {
                oggyResults.push({ correct: false, error: 'TIMEOUT' });
            }
            break;
        }

        const wave = scenarios.slice(i, i + WAVE_SIZE);
        const waveResults = await Promise.all(
            wave.map(s => _testOggy(s, user_id).catch(err => ({ correct: false, error: err.message })))
        );
        oggyResults.push(...waveResults);
    }

    const oggyDuration = Date.now() - oggyStartTime;

    // Tally results
    const oggyCorrect = oggyResults.filter(r => r.correct).length;
    const baseCorrect = baseResults.filter(r => r.correct).length;
    const oggyAccuracy = oggyCorrect / scenarios.length;
    const baseAccuracy = baseCorrect / scenarios.length;
    const delta = oggyAccuracy - baseAccuracy;

    let verdict = 'tie';
    if (delta > 0.05) verdict = 'oggy_wins';
    else if (delta < -0.05) verdict = 'base_wins';

    // Check for difficulty advancement
    const upgrade = await _maybeAdvance(user_id, oggyAccuracy);

    const testResult = {
        result_id: resultId,
        benchmark_id: benchmark.benchmark_id,
        domain: 'harmony',
        oggy: {
            correct: oggyCorrect, total: scenarios.length, accuracy: oggyAccuracy,
            scenario_results: oggyResults.map((r, i) => ({
                index: i, correct: r.correct, scenario_type: scenarios[i].scenario_type,
                expected: scenarios[i].correct_answer, answer: (r.answer || r.error || '').substring(0, 200)
            }))
        },
        base: {
            correct: baseCorrect, total: scenarios.length, accuracy: baseAccuracy,
            scenario_results: baseResults.map((r, i) => ({
                index: i, correct: r.correct, scenario_type: scenarios[i].scenario_type,
                answer: (r.answer || r.error || '').substring(0, 200)
            }))
        },
        comparison: { advantage_delta: delta, advantage_percent: (delta * 100).toFixed(1) + '%', verdict },
        training_state: trainingState,
        timing: { base_duration_ms: baseDuration, oggy_duration_ms: oggyDuration, oggy_timed_out: oggyDuration >= oggyTimeout },
        upgrade,
    };

    // Store result (reuse existing sealed_benchmark_results schema)
    await query(`
        INSERT INTO sealed_benchmark_results (
            result_id, benchmark_id, user_id, total_scenarios,
            oggy_correct, oggy_accuracy, base_correct, base_accuracy,
            advantage_delta, advantage_percent, training_state, detailed_results
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
        resultId, benchmark.benchmark_id, user_id, scenarios.length,
        oggyCorrect, oggyAccuracy, baseCorrect, baseAccuracy,
        delta, parseFloat((delta * 100).toFixed(1)),
        JSON.stringify(trainingState),
        JSON.stringify(testResult)
    ]);

    logger.info('Harmony benchmark evaluation complete', {
        resultId, oggyAccuracy, baseAccuracy, verdict, upgrade: upgrade?.upgraded,
    });

    return testResult;
}

async function _testBase(scenario) {
    try {
        const resolved = await providerResolver.getAdapter('system', 'base');
        const messages = [
            { role: 'system', content: `You are answering questions about a city wellbeing framework called the Harmony Map. The Equilibrium Canon: H = sqrt(E*S), E = (B*F*C)^(1/3), S = sqrt(A*X). The six dimensions are: ${HARMONY_DIMENSIONS}. C = Compassion * Discernment. Answer concisely using the exact dimension names.` },
            { role: 'user', content: scenario.question },
        ];
        const response = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages,
            temperature: 0.2,
            max_tokens: 400,
        });
        const answer = response.text || '';
        const correct = _evaluateMatch(answer, scenario.correct_answer, scenario.scenario_type);
        return { correct, answer };
    } catch (err) {
        return { correct: false, error: err.message };
    }
}

async function _testOggy(scenario, userId) {
    try {
        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const messages = [
            { role: 'system', content: `You are Oggy, an expert on the Harmony Map wellbeing framework. The Equilibrium Canon: H = sqrt(E*S), E = (B*F*C)^(1/3), S = sqrt(A*X). The six dimensions are: ${HARMONY_DIMENSIONS}. C = Compassion * Discernment. You have memory of past training. Answer precisely using the exact dimension names.` },
            { role: 'user', content: scenario.question },
        ];
        const response = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages,
            temperature: 0.3,
            max_tokens: 400,
        });
        const answer = response.text || '';
        const correct = _evaluateMatch(answer, scenario.correct_answer, scenario.scenario_type);
        return { correct, answer };
    } catch (err) {
        return { correct: false, error: err.message };
    }
}

function _evaluateMatch(answer, correctAnswer, scenarioType) {
    if (!answer || !correctAnswer) return false;
    const answerLower = answer.toLowerCase();
    const correctLower = correctAnswer.toLowerCase();

    // For classification questions, extract the dimension name and check presence
    if (scenarioType === 'indicator_classification') {
        const correctDimension = DIMENSION_NAMES.find(d => correctLower.includes(d));
        if (correctDimension) {
            return answerLower.includes(correctDimension);
        }
        // Fallback: check full string
        return answerLower.includes(correctLower);
    }

    // For other types, check key terms overlap
    const correctTerms = correctLower.split(/\s+/).filter(w => w.length > 4);
    if (correctTerms.length === 0) return answerLower.includes(correctLower);
    const matchCount = correctTerms.filter(t => answerLower.includes(t)).length;
    return matchCount >= Math.ceil(correctTerms.length * 0.4);
}

async function _captureTrainingState(userId) {
    try {
        const stateResult = await query(
            `SELECT scale, difficulty_level FROM continuous_learning_state WHERE user_id = $1 AND domain = 'harmony'`,
            [userId]
        );
        const state = stateResult.rows[0] || { scale: 1, difficulty_level: 1 };

        const memoryHost = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
        let cardCount = 0;
        try {
            const resp = await fetch(`${memoryHost}/cards/count?user_id=${userId}&domain=harmony`);
            if (resp.ok) {
                const data = await resp.json();
                cardCount = data.count || 0;
            }
        } catch (_) {}

        return {
            scale: state.scale,
            difficulty_level: state.difficulty_level,
            memory_card_count: cardCount,
        };
    } catch (_) {
        return { scale: 1, difficulty_level: 1, memory_card_count: 0 };
    }
}

async function _maybeAdvance(userId, accuracy) {
    if (accuracy < 0.9) return { upgraded: false };

    try {
        const stateResult = await query(
            `SELECT scale, difficulty_level FROM continuous_learning_state WHERE user_id = $1 AND domain = 'harmony'`,
            [userId]
        );
        const state = stateResult.rows[0];
        if (!state) return { upgraded: false };

        let newScale = state.scale;
        let newLevel = state.difficulty_level;

        if (newLevel < 5) {
            newLevel++;
        } else if (newScale < 10) {
            newScale++;
            newLevel = 1;
        } else {
            return { upgraded: false, reason: 'max_level' };
        }

        await query(
            `UPDATE continuous_learning_state SET scale = $1, difficulty_level = $2, updated_at = NOW() WHERE user_id = $3 AND domain = 'harmony'`,
            [newScale, newLevel, userId]
        );

        return {
            upgraded: true,
            reason: 'benchmark_accuracy_above_90',
            old_scale: state.scale,
            old_level: state.difficulty_level,
            new_scale: newScale,
            new_level: newLevel,
        };
    } catch (err) {
        logger.error('Harmony benchmark advancement failed', { error: err.message });
        return { upgraded: false };
    }
}

module.exports = { testOnBenchmark };
