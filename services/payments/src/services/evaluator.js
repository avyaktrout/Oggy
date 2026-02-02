/**
 * Agent Evaluation Framework
 * Week 6: Compare Oggy (with memory) vs Base (without memory)
 */

const axios = require('axios');
const OggyCategorizer = require('./oggyCategorizer');
const TessaAssessments = require('./tessaAssessments');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

class AgentEvaluator {
    constructor() {
        this.oggyCategorizer = new OggyCategorizer();
        this.tessa = new TessaAssessments();
    }

    /**
     * Run comparison: Oggy vs Base on sealed benchmarks
     */
    async runComparison(userId, benchmarkCount = 20) {
        console.log('\n='.repeat(60));
        console.log('🔬 AGENT COMPARISON: Oggy vs Base');
        console.log('='.repeat(60));

        // Generate sealed benchmark from Tessa
        const benchmark = await this.tessa.generateSealedBenchmark(benchmarkCount);
        console.log(`\n📊 Generated ${benchmark.count} sealed benchmark assessments`);
        console.log(`   Benchmark ID: ${benchmark.benchmark_id}`);

        // Run Oggy (with memory)
        console.log('\n🤖 Running Oggy (WITH memory/learning)...');
        const oggyResults = await this._runAgent('oggy', userId, benchmark.assessments);

        // Run Base (without memory)
        console.log('\n🤖 Running Base (WITHOUT memory/learning)...');
        const baseResults = await this._runAgent('base', userId, benchmark.assessments);

        // Compare results
        const comparison = this._compareResults(oggyResults, baseResults, benchmark);

        // Generate report
        const report = this._generateReport(comparison, benchmark);

        console.log('\n' + report);

        return {
            benchmark_id: benchmark.benchmark_id,
            oggy: oggyResults.summary,
            base: baseResults.summary,
            comparison,
            report,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Run a single agent on all assessments
     */
    async _runAgent(agentType, userId, assessments) {
        const results = [];
        let totalScore = 0;
        let correctCount = 0;

        for (const assessment of assessments) {
            try {
                const response = await this._runSingleAssessment(
                    agentType,
                    userId,
                    assessment
                );

                const scored = this.tessa.scoreResponse(assessment, response.answer);

                results.push({
                    assessment_id: assessment.assessment_id,
                    assessment_type: assessment.type,
                    expected: assessment.expected_answer,
                    actual: response.answer,
                    score: scored.score,
                    feedback: scored.feedback,
                    used_memory: response.used_memory,
                    trace_id: response.trace_id,
                    latency_ms: response.latency_ms
                });

                totalScore += scored.score;
                if (scored.score === 1.0) correctCount++;

            } catch (error) {
                console.error(`[Evaluator] Error on assessment ${assessment.assessment_id}:`, error.message);
                results.push({
                    assessment_id: assessment.assessment_id,
                    error: error.message,
                    score: 0.0
                });
            }
        }

        return {
            agent_type: agentType,
            results,
            summary: {
                total_assessments: assessments.length,
                total_score: totalScore,
                average_score: totalScore / assessments.length,
                correct_count: correctCount,
                accuracy: correctCount / assessments.length,
                average_latency_ms: this._calculateAverageLatency(results)
            }
        };
    }

    /**
     * Run a single assessment on an agent
     */
    async _runSingleAssessment(agentType, userId, assessment) {
        const startTime = Date.now();

        if (agentType === 'oggy') {
            // Oggy uses memory retrieval
            const suggestion = await this.oggyCategorizer.suggestCategory(userId, {
                expense_id: null,
                merchant: assessment.input.merchant,
                amount: assessment.input.amount,
                description: assessment.input.description,
                transaction_date: new Date().toISOString().split('T')[0]
            });

            return {
                answer: suggestion.suggested_category,
                used_memory: suggestion.trace_id !== null,
                trace_id: suggestion.trace_id,
                confidence: suggestion.confidence,
                latency_ms: Date.now() - startTime
            };

        } else {
            // Base agent: no memory, direct API call
            const answer = await this._callBaseAgent(assessment);

            return {
                answer,
                used_memory: false,
                trace_id: null,
                confidence: null,
                latency_ms: Date.now() - startTime
            };
        }
    }

    /**
     * Call base agent (no memory retrieval)
     */
    async _callBaseAgent(assessment) {
        if (!OPENAI_API_KEY) {
            // Fallback to simple rules
            return this._fallbackCategorization(assessment.input);
        }

        const prompt = assessment.prompt;

        try {
            const response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: OPENAI_MODEL,
                    messages: [
                        { role: 'system', content: 'You are a financial categorization assistant. Answer concisely with just the category name.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.3,
                    max_tokens: 50
                },
                {
                    headers: {
                        'Authorization': `Bearer ${OPENAI_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            const completion = response.data.choices[0].message.content.trim();
            // Extract category from response
            return this._extractCategory(completion);

        } catch (error) {
            console.error('[Evaluator] Base agent API call failed:', error.message);
            return this._fallbackCategorization(assessment.input);
        }
    }

    /**
     * Extract category name from AI response
     */
    _extractCategory(response) {
        const categories = ['dining', 'groceries', 'transportation', 'utilities',
                          'entertainment', 'business_meal', 'shopping', 'health', 'personal_care', 'other'];

        const lower = response.toLowerCase();

        for (const cat of categories) {
            if (lower.includes(cat)) {
                return cat;
            }
        }

        return 'other';
    }

    /**
     * Fallback categorization (rule-based)
     */
    _fallbackCategorization(input) {
        const text = `${input.merchant} ${input.description}`.toLowerCase();

        if (text.match(/restaurant|cafe|coffee|pizza|food|dine|lunch|dinner/)) return 'dining';
        if (text.match(/grocery|supermarket|whole foods|safeway/)) return 'groceries';
        if (text.match(/gas|fuel|chevron|shell|uber|lyft|transit/)) return 'transportation';
        if (text.match(/electric|utility|internet|phone|comcast|att/)) return 'utilities';
        if (text.match(/movie|theater|concert|netflix|spotify/)) return 'entertainment';
        if (text.match(/client|business|meeting/)) return 'business_meal';

        return 'other';
    }

    /**
     * Compare Oggy vs Base results
     */
    _compareResults(oggyResults, baseResults, benchmark) {
        const oggyScore = oggyResults.summary.average_score;
        const baseScore = baseResults.summary.average_score;
        const delta = oggyScore - baseScore;
        const deltaPercent = (delta / Math.max(baseScore, 0.01)) * 100;

        const oggyAccuracy = oggyResults.summary.accuracy;
        const baseAccuracy = baseResults.summary.accuracy;
        const accuracyDelta = oggyAccuracy - baseAccuracy;
        const accuracyDeltaPercent = (accuracyDelta / Math.max(baseAccuracy, 0.01)) * 100;

        // Count memory usage
        const memoryUsedCount = oggyResults.results.filter(r => r.used_memory).length;

        return {
            benchmark_id: benchmark.benchmark_id,
            benchmark_count: benchmark.count,
            oggy: {
                average_score: oggyScore,
                accuracy: oggyAccuracy,
                correct_count: oggyResults.summary.correct_count,
                memory_usage: {
                    used_count: memoryUsedCount,
                    percentage: (memoryUsedCount / benchmark.count) * 100
                }
            },
            base: {
                average_score: baseScore,
                accuracy: baseAccuracy,
                correct_count: baseResults.summary.correct_count
            },
            delta: {
                score_delta: delta,
                score_delta_percent: deltaPercent,
                accuracy_delta: accuracyDelta,
                accuracy_delta_percent: accuracyDeltaPercent,
                additional_correct: oggyResults.summary.correct_count - baseResults.summary.correct_count
            },
            verdict: delta > 0 ? 'OGGY_BETTER' :
                    delta < 0 ? 'BASE_BETTER' :
                    'TIE'
        };
    }

    /**
     * Generate human-readable report
     */
    _generateReport(comparison, benchmark) {
        const lines = [];

        lines.push('='.repeat(60));
        lines.push('📊 EVALUATION REPORT');
        lines.push('='.repeat(60));
        lines.push('');
        lines.push(`Benchmark: ${comparison.benchmark_id}`);
        lines.push(`Assessments: ${comparison.benchmark_count}`);
        lines.push('');
        lines.push('RESULTS:');
        lines.push('-'.repeat(60));
        lines.push('');

        // Oggy results
        lines.push('🤖 OGGY (with memory/learning):');
        lines.push(`   Average Score:    ${(comparison.oggy.average_score * 100).toFixed(1)}%`);
        lines.push(`   Accuracy:         ${(comparison.oggy.accuracy * 100).toFixed(1)}% (${comparison.oggy.correct_count}/${comparison.benchmark_count} correct)`);
        lines.push(`   Memory Usage:     ${comparison.oggy.memory_usage.percentage.toFixed(1)}% of requests`);
        lines.push('');

        // Base results
        lines.push('🔹 BASE (no memory/learning):');
        lines.push(`   Average Score:    ${(comparison.base.average_score * 100).toFixed(1)}%`);
        lines.push(`   Accuracy:         ${(comparison.base.accuracy * 100).toFixed(1)}% (${comparison.base.correct_count}/${comparison.benchmark_count} correct)`);
        lines.push('');

        // Delta
        lines.push('📈 COMPARISON:');
        lines.push(`   Score Delta:      ${comparison.delta.score_delta >= 0 ? '+' : ''}${(comparison.delta.score_delta * 100).toFixed(1)}% (${comparison.delta.score_delta_percent >= 0 ? '+' : ''}${comparison.delta.score_delta_percent.toFixed(1)}%)`);
        lines.push(`   Accuracy Delta:   ${comparison.delta.accuracy_delta >= 0 ? '+' : ''}${(comparison.delta.accuracy_delta * 100).toFixed(1)}% (${comparison.delta.accuracy_delta_percent >= 0 ? '+' : ''}${comparison.delta.accuracy_delta_percent.toFixed(1)}%)`);
        lines.push(`   Additional Correct: ${comparison.delta.additional_correct >= 0 ? '+' : ''}${comparison.delta.additional_correct}`);
        lines.push('');

        // Verdict
        lines.push('🏆 VERDICT:');
        if (comparison.verdict === 'OGGY_BETTER') {
            lines.push(`   ✅ OGGY outperforms BASE by ${Math.abs(comparison.delta.score_delta_percent).toFixed(1)}%`);
            lines.push('   Memory and continuous learning provide measurable improvement!');
        } else if (comparison.verdict === 'BASE_BETTER') {
            lines.push(`   ⚠️  BASE outperforms OGGY by ${Math.abs(comparison.delta.score_delta_percent).toFixed(1)}%`);
            lines.push('   Review: Memory may be introducing noise or needs more training data');
        } else {
            lines.push('   🤝 TIE: Both agents perform equally');
            lines.push('   Consider: More training data or sealed benchmarks needed');
        }

        lines.push('');
        lines.push('='.repeat(60));

        return lines.join('\n');
    }

    /**
     * Calculate average latency
     */
    _calculateAverageLatency(results) {
        const latencies = results
            .filter(r => r.latency_ms)
            .map(r => r.latency_ms);

        if (latencies.length === 0) return 0;

        return latencies.reduce((a, b) => a + b, 0) / latencies.length;
    }
}

module.exports = AgentEvaluator;
