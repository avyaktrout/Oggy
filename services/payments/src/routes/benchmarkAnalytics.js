/**
 * Benchmark Analytics Routes
 * Compiles Oggy's benchmark performance data for dashboard visualization
 * Includes audit chat (LLM-powered Q&A) and weakness data endpoints
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const weaknessAnalyzer = require('../services/weaknessAnalyzer');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const { costGovernor } = require('../middleware/costGovernor');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api', {
    failureThreshold: 3,
    timeout: 30000
});

/**
 * Extract level from benchmark name.
 * Handles: auto_benchmark_S2L5_... → S2L5
 *          auto_benchmark_L3_...  → S1L3 (old format, assume Scale 1)
 */
function _extractLevel(benchmarkName) {
    const newFmt = benchmarkName.match(/_(S\dL\d)_/);
    if (newFmt) return newFmt[1];
    const oldFmt = benchmarkName.match(/_L(\d)_/);
    if (oldFmt) return `S1L${oldFmt[1]}`;
    return 'unknown';
}

/**
 * GET /v0/benchmark-analytics
 * Returns compiled benchmark performance data for charting
 */
router.get('/', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 200;
        const userId = req.query.user_id || 'oggy';

        // Get benchmark results for this user
        const results = await query(`
            SELECT r.result_id, r.tested_at, r.total_scenarios,
                   r.oggy_correct, r.oggy_accuracy, r.base_correct, r.base_accuracy,
                   r.advantage_delta, r.advantage_percent, r.training_state,
                   b.benchmark_name, b.difficulty_mix
            FROM sealed_benchmark_results r
            JOIN sealed_benchmarks b ON r.benchmark_id = b.benchmark_id
            WHERE r.user_id = $2
              AND r.oggy_accuracy != 'NaN' AND r.base_accuracy != 'NaN'
            ORDER BY r.tested_at ASC
            LIMIT $1
        `, [limit, userId]);

        if (results.rows.length === 0) {
            return res.json({
                total_benchmarks: 0,
                message: 'No benchmark results found. Run training to generate benchmarks.'
            });
        }

        // Build time series data
        const timeSeries = results.rows.map((r, i) => {
            const level = _extractLevel(r.benchmark_name);
            const ts = typeof r.training_state === 'string'
                ? JSON.parse(r.training_state) : (r.training_state || {});
            return {
                index: i + 1,
                tested_at: r.tested_at,
                oggy_accuracy: parseFloat(r.oggy_accuracy),
                base_accuracy: parseFloat(r.base_accuracy),
                advantage_delta: parseFloat(r.advantage_delta),
                advantage_percent: parseFloat(r.advantage_percent),
                level,
                difficulty_mix: r.difficulty_mix,
                total_scenarios: r.total_scenarios,
                oggy_correct: r.oggy_correct,
                base_correct: r.base_correct,
                memory_cards: ts.memory_card_count || 0,
                domain_knowledge: ts.domain_knowledge_count || 0
            };
        });

        // Aggregate stats
        const totalBenchmarks = timeSeries.length;
        const oggyWins = timeSeries.filter(r => r.advantage_delta > 0).length;
        const ties = timeSeries.filter(r => r.advantage_delta === 0).length;
        const baseMins = timeSeries.filter(r => r.advantage_delta < 0).length;
        const avgOggyAccuracy = timeSeries.reduce((s, r) => s + r.oggy_accuracy, 0) / totalBenchmarks;
        const avgBaseAccuracy = timeSeries.reduce((s, r) => s + r.base_accuracy, 0) / totalBenchmarks;
        const avgAdvantage = timeSeries.reduce((s, r) => s + r.advantage_delta, 0) / totalBenchmarks;

        // Best and worst benchmarks
        const best = timeSeries.reduce((a, b) => a.advantage_delta > b.advantage_delta ? a : b);
        const worst = timeSeries.reduce((a, b) => a.advantage_delta < b.advantage_delta ? a : b);

        // Level progression
        const levelTimeline = [];
        let currentLevel = null;
        for (const r of timeSeries) {
            if (r.level !== currentLevel) {
                levelTimeline.push({
                    level: r.level,
                    started_at: r.tested_at,
                    benchmark_index: r.index
                });
                currentLevel = r.level;
            }
        }

        // Per-level stats
        const byLevel = {};
        for (const r of timeSeries) {
            if (!byLevel[r.level]) {
                byLevel[r.level] = { count: 0, oggy_sum: 0, base_sum: 0, wins: 0 };
            }
            byLevel[r.level].count++;
            byLevel[r.level].oggy_sum += r.oggy_accuracy;
            byLevel[r.level].base_sum += r.base_accuracy;
            if (r.advantage_delta > 0) byLevel[r.level].wins++;
        }
        const perLevel = Object.entries(byLevel).map(([level, s]) => ({
            level,
            benchmarks: s.count,
            avg_oggy_accuracy: (s.oggy_sum / s.count).toFixed(4),
            avg_base_accuracy: (s.base_sum / s.count).toFixed(4),
            win_rate: (s.wins / s.count).toFixed(4),
            oggy_wins: s.wins
        }));

        // Rolling average (window of 5)
        const windowSize = 5;
        const rollingAvg = timeSeries.map((r, i) => {
            const start = Math.max(0, i - windowSize + 1);
            const window = timeSeries.slice(start, i + 1);
            return {
                index: r.index,
                tested_at: r.tested_at,
                rolling_oggy: window.reduce((s, w) => s + w.oggy_accuracy, 0) / window.length,
                rolling_base: window.reduce((s, w) => s + w.base_accuracy, 0) / window.length,
                rolling_advantage: window.reduce((s, w) => s + w.advantage_delta, 0) / window.length
            };
        });

        // Latest state from time series
        const latest = timeSeries[timeSeries.length - 1];

        // Get the ACTUAL current level from DB (benchmark names reflect pre-benchmark level)
        let actualLevel = latest.level;
        try {
            const stateResult = await query(
                `SELECT scale, difficulty_level FROM continuous_learning_state WHERE user_id = $1 LIMIT 1`,
                [userId]
            );
            if (stateResult.rows.length > 0) {
                const s = stateResult.rows[0];
                actualLevel = `S${s.scale}L${s.difficulty_level}`;
            }
        } catch (e) {
            // Fall back to benchmark name
        }

        res.json({
            total_benchmarks: totalBenchmarks,
            summary: {
                oggy_wins: oggyWins,
                ties,
                base_wins: baseMins,
                win_rate: (oggyWins / totalBenchmarks).toFixed(4),
                avg_oggy_accuracy: avgOggyAccuracy.toFixed(4),
                avg_base_accuracy: avgBaseAccuracy.toFixed(4),
                avg_advantage: avgAdvantage.toFixed(4),
                best_result: {
                    advantage: best.advantage_delta.toFixed(4),
                    oggy: best.oggy_accuracy.toFixed(4),
                    base: best.base_accuracy.toFixed(4),
                    level: best.level,
                    tested_at: best.tested_at
                },
                worst_result: {
                    advantage: worst.advantage_delta.toFixed(4),
                    oggy: worst.oggy_accuracy.toFixed(4),
                    base: worst.base_accuracy.toFixed(4),
                    level: worst.level,
                    tested_at: worst.tested_at
                }
            },
            current_state: {
                level: actualLevel,
                latest_oggy_accuracy: latest.oggy_accuracy,
                latest_base_accuracy: latest.base_accuracy,
                memory_cards: latest.memory_cards,
                domain_knowledge: latest.domain_knowledge
            },
            level_progression: levelTimeline,
            per_level_stats: perLevel,
            time_series: timeSeries,
            rolling_averages: rollingAvg
        });

    } catch (error) {
        logger.logError(error, { operation: 'benchmark-analytics' });
        res.status(500).json({ error: 'Failed to compile analytics', message: error.message });
    }
});

/**
 * GET /v0/benchmark-analytics/prometheus
 * Returns Prometheus-formatted metrics for direct scraping
 */
router.get('/prometheus', async (req, res) => {
    try {
        const userId = req.query.user_id || 'oggy';
        const results = await query(`
            SELECT r.oggy_accuracy, r.base_accuracy, r.advantage_delta,
                   r.training_state, b.benchmark_name, b.difficulty_mix,
                   r.tested_at
            FROM sealed_benchmark_results r
            JOIN sealed_benchmarks b ON r.benchmark_id = b.benchmark_id
            WHERE r.user_id = $1
            ORDER BY r.tested_at DESC
            LIMIT 1
        `, [userId]);

        let metrics = '';
        metrics += '# HELP oggy_benchmark_total Total benchmarks run\n';
        metrics += '# TYPE oggy_benchmark_total counter\n';

        const countResult = await query('SELECT COUNT(*) as cnt FROM sealed_benchmark_results WHERE user_id = $1', [userId]);
        metrics += `oggy_benchmark_total ${countResult.rows[0].cnt}\n\n`;

        if (results.rows.length > 0) {
            const r = results.rows[0];
            const ts = typeof r.training_state === 'string'
                ? JSON.parse(r.training_state) : (r.training_state || {});
            const level = _extractLevel(r.benchmark_name);

            metrics += '# HELP oggy_benchmark_oggy_accuracy Oggy accuracy on latest benchmark\n';
            metrics += '# TYPE oggy_benchmark_oggy_accuracy gauge\n';
            metrics += `oggy_benchmark_oggy_accuracy{level="${level}"} ${r.oggy_accuracy}\n\n`;

            metrics += '# HELP oggy_benchmark_base_accuracy Base model accuracy on latest benchmark\n';
            metrics += '# TYPE oggy_benchmark_base_accuracy gauge\n';
            metrics += `oggy_benchmark_base_accuracy{level="${level}"} ${r.base_accuracy}\n\n`;

            metrics += '# HELP oggy_benchmark_advantage_delta Oggy advantage over base\n';
            metrics += '# TYPE oggy_benchmark_advantage_delta gauge\n';
            metrics += `oggy_benchmark_advantage_delta{level="${level}"} ${r.advantage_delta}\n\n`;

            metrics += '# HELP oggy_memory_card_count Memory cards accumulated\n';
            metrics += '# TYPE oggy_memory_card_count gauge\n';
            metrics += `oggy_memory_card_count ${ts.memory_card_count || 0}\n\n`;

            metrics += '# HELP oggy_domain_knowledge_count Domain knowledge entries\n';
            metrics += '# TYPE oggy_domain_knowledge_count gauge\n';
            metrics += `oggy_domain_knowledge_count ${ts.domain_knowledge_count || 0}\n\n`;

            // Win rate
            const winResult = await query(`
                SELECT
                    COUNT(*) FILTER (WHERE advantage_delta > 0) as wins,
                    COUNT(*) as total
                FROM sealed_benchmark_results
                WHERE user_id = $1
            `, [userId]);
            const winRate = winResult.rows[0].total > 0
                ? (winResult.rows[0].wins / winResult.rows[0].total) : 0;
            metrics += '# HELP oggy_benchmark_win_rate Fraction of benchmarks where Oggy beats Base\n';
            metrics += '# TYPE oggy_benchmark_win_rate gauge\n';
            metrics += `oggy_benchmark_win_rate ${winRate.toFixed(4)}\n`;
        }

        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(metrics);

    } catch (error) {
        logger.logError(error, { operation: 'benchmark-analytics-prometheus' });
        res.status(500).send('# Error generating metrics\n');
    }
});

/**
 * Aggregate per-category accuracy and confusion pairs across multiple benchmark results
 */
function _aggregateConfusionAcrossBenchmarks(rows) {
    const categoryStats = {}; // { category: { correct: N, total: N } }
    const confusionCounts = {}; // { "actual->predicted": N }

    for (const row of rows) {
        const detailed = row.detailed_results;
        const scenarios = detailed?.oggy || [];

        for (const s of scenarios) {
            const cat = s.correct_category;
            if (!cat) continue;

            if (!categoryStats[cat]) categoryStats[cat] = { correct: 0, total: 0 };
            categoryStats[cat].total++;
            if (s.correct) {
                categoryStats[cat].correct++;
            } else if (s.predicted_category && s.predicted_category !== cat) {
                const pair = `${cat}->${s.predicted_category}`;
                confusionCounts[pair] = (confusionCounts[pair] || 0) + 1;
            }
        }
    }

    const categoryAccuracy = Object.entries(categoryStats)
        .map(([category, s]) => ({
            category,
            accuracy: s.total > 0 ? (s.correct / s.total * 100).toFixed(1) : '0.0',
            correct: s.correct,
            total: s.total
        }))
        .sort((a, b) => parseFloat(a.accuracy) - parseFloat(b.accuracy));

    const confusionPairs = Object.entries(confusionCounts)
        .map(([pair, count]) => ({ pair, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);

    const totalCorrect = Object.values(categoryStats).reduce((s, c) => s + c.correct, 0);
    const totalScenarios = Object.values(categoryStats).reduce((s, c) => s + c.total, 0);

    return {
        categoryAccuracy,
        confusionPairs,
        totalScenarios,
        overallAccuracy: totalScenarios > 0 ? (totalCorrect / totalScenarios * 100).toFixed(1) : '0.0'
    };
}

/**
 * Build context string for the audit chat LLM prompt
 */
function _buildAuditContext(benchmarkRows, aggregated) {
    let ctx = `=== Oggy Performance Audit Data ===\n`;
    ctx += `Benchmarks analyzed: ${benchmarkRows.length}\n`;
    ctx += `Overall accuracy: ${aggregated.overallAccuracy}% across ${aggregated.totalScenarios} scenarios\n\n`;

    ctx += `--- Per-Category Accuracy (sorted weakest first) ---\n`;
    for (const c of aggregated.categoryAccuracy) {
        const bar = parseFloat(c.accuracy) < 60 ? '[WEAK]' : parseFloat(c.accuracy) < 80 ? '[OK]' : '[STRONG]';
        ctx += `${c.category}: ${c.accuracy}% (${c.correct}/${c.total}) ${bar}\n`;
    }

    if (aggregated.confusionPairs.length > 0) {
        ctx += `\n--- Top Confusion Pairs ---\n`;
        for (const p of aggregated.confusionPairs.slice(0, 10)) {
            ctx += `${p.pair}: ${p.count} times\n`;
        }
    }

    ctx += `\n--- Recent Benchmark Trend ---\n`;
    for (const r of benchmarkRows.slice(-10)) {
        const ts = new Date(r.tested_at).toLocaleDateString();
        ctx += `${ts}: Oggy ${parseFloat(r.oggy_accuracy * 100).toFixed(1)}% vs Base ${parseFloat(r.base_accuracy * 100).toFixed(1)}% (delta: ${(r.advantage_delta * 100).toFixed(1)}pp)\n`;
    }

    return ctx;
}

/**
 * GET /v0/benchmark-analytics/weakness-data
 * Returns aggregated per-category accuracy and confusion pairs across last N benchmarks
 */
router.get('/weakness-data', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 15;
        const userId = req.query.user_id || 'oggy';

        const results = await query(`
            SELECT r.detailed_results, r.oggy_accuracy, r.base_accuracy,
                   r.advantage_delta, r.tested_at
            FROM sealed_benchmark_results r
            WHERE r.user_id = $2
              AND r.oggy_accuracy != 'NaN' AND r.base_accuracy != 'NaN'
            ORDER BY r.tested_at DESC
            LIMIT $1
        `, [limit, userId]);

        if (results.rows.length === 0) {
            return res.json({
                categoryAccuracy: [],
                confusionPairs: [],
                benchmarksAnalyzed: 0,
                totalScenarios: 0,
                overallAccuracy: '0.0'
            });
        }

        const aggregated = _aggregateConfusionAcrossBenchmarks(results.rows);

        res.json({
            ...aggregated,
            benchmarksAnalyzed: results.rows.length
        });
    } catch (error) {
        logger.logError(error, { operation: 'benchmark-analytics-weakness-data' });
        res.status(500).json({ error: 'Failed to compile weakness data', message: error.message });
    }
});

/**
 * POST /v0/benchmark-analytics/audit-chat
 * LLM-powered Q&A about Oggy's benchmark performance
 * Body: { question: "What are Oggy's weakest categories?" }
 */
router.post('/audit-chat', async (req, res) => {
    try {
        const { question } = req.body;
        if (!question || question.trim().length === 0) {
            return res.status(400).json({ error: 'question is required' });
        }

        // Budget check (~1200 tokens for context + response)
        await costGovernor.checkBudget(8000);

        // Get last 15 benchmarks with detailed_results for this user
        const userId = req.body.user_id || 'oggy';
        const benchmarkRows = await query(`
            SELECT r.result_id, r.detailed_results, r.oggy_accuracy, r.base_accuracy,
                   r.advantage_delta, r.tested_at, r.total_scenarios,
                   b.benchmark_name, b.difficulty_mix
            FROM sealed_benchmark_results r
            JOIN sealed_benchmarks b ON r.benchmark_id = b.benchmark_id
            WHERE r.user_id = $1
              AND r.oggy_accuracy != 'NaN' AND r.base_accuracy != 'NaN'
            ORDER BY r.tested_at DESC
            LIMIT 15
        `, [userId]);

        if (benchmarkRows.rows.length === 0) {
            return res.json({
                answer: 'No benchmark data available yet. Run a training session with benchmarks first to generate performance data.',
                sources: []
            });
        }

        // Aggregate confusion data across benchmarks
        const aggregated = _aggregateConfusionAcrossBenchmarks(benchmarkRows.rows);

        // Build context for the LLM
        const auditContext = _buildAuditContext(benchmarkRows.rows, aggregated);

        const systemPrompt = `You are Oggy's performance analyst. You analyze benchmark results to answer questions about Oggy's categorization accuracy, weaknesses, strengths, and trends.

You have access to the following performance data:
${auditContext}

Rules:
- Answer concisely and specifically based on the data above
- Use exact numbers and percentages from the data
- If asked about weaknesses, focus on categories with <60% accuracy
- If asked about trends, describe whether accuracy is improving or declining
- If asked about confusion, explain which categories get mixed up and why
- Keep answers under 200 words
- Don't make up data not present in the context`;

        const response = await openaiBreaker.execute(() =>
            axios.post('https://api.openai.com/v1/chat/completions', {
                model: OPENAI_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: question }
                ],
                temperature: 0.3,
                max_tokens: 800
            }, {
                headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                timeout: 15000
            })
        );

        costGovernor.recordUsage(6000);

        const answer = response.data.choices[0].message.content.trim();

        res.json({
            answer,
            sources: {
                benchmarks_analyzed: benchmarkRows.rows.length,
                overall_accuracy: aggregated.overallAccuracy,
                total_scenarios: aggregated.totalScenarios
            }
        });

    } catch (error) {
        if (error.budgetExceeded) {
            return res.status(429).json({ error: 'Daily token budget exceeded. Try again tomorrow.' });
        }
        logger.logError(error, { operation: 'audit-chat' });
        res.status(500).json({ error: 'Audit chat failed', message: error.message });
    }
});

/**
 * POST /v0/benchmark-analytics/sync-to-remote
 * Reads all benchmarks for the authenticated user from local DB,
 * then pushes them to the remote Oggy instance's /receive-sync endpoint.
 * Body: { remote_url } (e.g. "https://oggy-v1.com")
 * Uses SYNC_API_KEY env var for auth on the remote side.
 */
router.post('/sync-to-remote', async (req, res) => {
    try {
        // user_id for the REMOTE side (who the data belongs to on production)
        const targetUserId = req.body.user_id || req.query.user_id || 'oggy';
        const remoteUrl = (req.body.remote_url || process.env.REMOTE_OGGY_URL || '').replace(/\/+$/, '');
        const syncKey = process.env.SYNC_API_KEY;

        if (!remoteUrl) {
            return res.status(400).json({ error: 'remote_url is required (or set REMOTE_OGGY_URL env var)' });
        }
        if (!syncKey) {
            return res.status(400).json({ error: 'SYNC_API_KEY env var is not set' });
        }

        // 1. Read ALL local benchmark results (regardless of local user_id)
        //    Local machines may store benchmarks under 'oggy' or any user_id.
        //    We push everything and assign it to the authenticated user on the remote.
        const results = await query(`
            SELECT b.benchmark_id, b.benchmark_name, b.difficulty_mix,
                   b.scenario_count, b.description, b.metadata,
                   r.result_id, r.user_id, r.tested_at, r.total_scenarios,
                   r.oggy_correct, r.oggy_accuracy, r.base_correct, r.base_accuracy,
                   r.advantage_delta, r.advantage_percent, r.training_state,
                   r.detailed_results
            FROM sealed_benchmark_results r
            JOIN sealed_benchmarks b ON r.benchmark_id = b.benchmark_id
            WHERE r.oggy_accuracy != 'NaN' AND r.base_accuracy != 'NaN'
            ORDER BY r.tested_at ASC
        `);

        if (results.rows.length === 0) {
            return res.json({ success: true, message: 'No benchmarks to sync.', results_sent: 0 });
        }

        // 2. Build payload — benchmarks + scenarios + results
        const benchmarksMap = {};
        const benchmarkResults = [];

        for (const row of results.rows) {
            if (!benchmarksMap[row.benchmark_id]) {
                benchmarksMap[row.benchmark_id] = {
                    benchmark_id: row.benchmark_id,
                    benchmark_name: row.benchmark_name,
                    difficulty_mix: row.difficulty_mix,
                    scenario_count: row.scenario_count,
                    description: row.description,
                    metadata: row.metadata
                };
            }
            benchmarkResults.push({
                benchmark_id: row.benchmark_id,
                tested_at: row.tested_at,
                total_scenarios: row.total_scenarios,
                oggy_correct: row.oggy_correct,
                oggy_accuracy: row.oggy_accuracy,
                base_correct: row.base_correct,
                base_accuracy: row.base_accuracy,
                advantage_delta: row.advantage_delta,
                advantage_percent: row.advantage_percent,
                training_state: row.training_state,
                detailed_results: row.detailed_results
            });
        }

        // Get scenarios
        const benchmarkIds = Object.keys(benchmarksMap);
        const scenariosResult = await query(`
            SELECT benchmark_id, order_index, merchant, amount, description,
                   correct_category, reasoning, generator, model
            FROM sealed_benchmark_scenarios
            WHERE benchmark_id = ANY($1)
            ORDER BY benchmark_id, order_index
        `, [benchmarkIds]);

        for (const s of scenariosResult.rows) {
            const b = benchmarksMap[s.benchmark_id];
            if (!b.scenarios) b.scenarios = [];
            b.scenarios.push({
                order_index: s.order_index,
                merchant: s.merchant,
                amount: parseFloat(s.amount),
                description: s.description,
                correct_category: s.correct_category,
                reasoning: s.reasoning,
                generator: s.generator,
                model: s.model
            });
        }

        // 3. POST to remote — assign all results to the authenticated user
        const payload = {
            user_id: targetUserId,
            benchmarks: Object.values(benchmarksMap),
            results: benchmarkResults
        };

        const response = await axios.post(
            `${remoteUrl}/v0/benchmark-analytics/receive-sync`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Sync-Key': syncKey
                },
                timeout: 60000,
                maxContentLength: 100 * 1024 * 1024
            }
        );

        res.json({
            success: true,
            local_results: benchmarkResults.length,
            local_benchmarks: benchmarkIds.length,
            remote_response: response.data
        });

    } catch (error) {
        const msg = error.response?.data?.error || error.message;
        logger.logError(error, { operation: 'sync-to-remote' });
        res.status(500).json({ error: 'Sync failed', message: msg });
    }
});

/**
 * POST /v0/benchmark-analytics/receive-sync
 * Receives benchmark data from another Oggy instance.
 * Auth: X-Sync-Key header must match SYNC_API_KEY env var.
 * Skips duplicates automatically.
 */
/**
 * Standalone receive-sync handler (exported separately for pre-auth mounting)
 */
async function receiveSyncHandler(req, res) {
    try {
        // Auth via sync key (bypasses session auth)
        const syncKey = req.headers['x-sync-key'];
        const expectedKey = process.env.SYNC_API_KEY;
        if (!expectedKey || syncKey !== expectedKey) {
            return res.status(403).json({ error: 'Invalid sync key' });
        }

        const { user_id, benchmarks, results: resultRows } = req.body;
        if (!user_id || !benchmarks || !resultRows) {
            return res.status(400).json({ error: 'user_id, benchmarks, and results are required' });
        }

        let benchmarksInserted = 0, benchmarksSkipped = 0;
        let scenariosInserted = 0;
        let resultsInserted = 0, resultsSkipped = 0;

        // 1. Insert benchmarks + scenarios
        for (const b of benchmarks) {
            const existing = await query(
                'SELECT benchmark_id FROM sealed_benchmarks WHERE benchmark_id = $1',
                [b.benchmark_id]
            );
            if (existing.rows.length > 0) {
                benchmarksSkipped++;
                continue;
            }
            try {
                await query(
                    `INSERT INTO sealed_benchmarks (benchmark_id, benchmark_name, difficulty_mix, scenario_count, description, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [b.benchmark_id, b.benchmark_name, b.difficulty_mix,
                     b.scenario_count || (b.scenarios ? b.scenarios.length : 0),
                     b.description || null,
                     b.metadata ? (typeof b.metadata === 'string' ? b.metadata : JSON.stringify(b.metadata)) : null]
                );
                benchmarksInserted++;

                if (b.scenarios && b.scenarios.length > 0) {
                    for (const s of b.scenarios) {
                        await query(
                            `INSERT INTO sealed_benchmark_scenarios
                             (benchmark_id, order_index, merchant, amount, description, correct_category, reasoning, generator, model)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                            [b.benchmark_id, s.order_index, s.merchant, s.amount,
                             s.description, s.correct_category, s.reasoning,
                             s.generator || null, s.model || null]
                        );
                        scenariosInserted++;
                    }
                }
            } catch (e) {
                benchmarksSkipped++;
            }
        }

        // 2. Insert results (skip duplicates within 1s window)
        for (const r of resultRows) {
            const existing = await query(
                `SELECT result_id FROM sealed_benchmark_results
                 WHERE benchmark_id = $1 AND user_id = $2
                   AND tested_at BETWEEN $3::timestamptz - interval '1 second'
                                     AND $3::timestamptz + interval '1 second'`,
                [r.benchmark_id, user_id, r.tested_at]
            );
            if (existing.rows.length > 0) {
                resultsSkipped++;
                continue;
            }
            try {
                await query(
                    `INSERT INTO sealed_benchmark_results
                     (benchmark_id, user_id, tested_at, total_scenarios,
                      oggy_correct, oggy_accuracy, base_correct, base_accuracy,
                      advantage_delta, advantage_percent, training_state, detailed_results)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [r.benchmark_id, user_id, r.tested_at, r.total_scenarios,
                     r.oggy_correct, r.oggy_accuracy, r.base_correct, r.base_accuracy,
                     r.advantage_delta, r.advantage_percent,
                     typeof r.training_state === 'string' ? r.training_state : JSON.stringify(r.training_state),
                     typeof r.detailed_results === 'string' ? r.detailed_results : JSON.stringify(r.detailed_results)]
                );
                resultsInserted++;
            } catch (e) {
                resultsSkipped++;
            }
        }

        res.json({
            success: true,
            user_id,
            benchmarks: { inserted: benchmarksInserted, skipped: benchmarksSkipped, scenarios: scenariosInserted },
            results: { inserted: resultsInserted, skipped: resultsSkipped }
        });

    } catch (error) {
        logger.logError(error, { operation: 'receive-sync' });
        res.status(500).json({ error: 'Receive sync failed', message: error.message });
    }
}

router.post('/receive-sync', receiveSyncHandler);

router.receiveSyncHandler = receiveSyncHandler;
module.exports = router;
