/**
 * Benchmark Analytics Routes
 * Compiles Oggy's benchmark performance data for dashboard visualization
 */

const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');
const logger = require('../utils/logger');

/**
 * GET /v0/benchmark-analytics
 * Returns compiled benchmark performance data for charting
 */
router.get('/', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 200;

        // Get all benchmark results with benchmark info
        const results = await query(`
            SELECT r.result_id, r.tested_at, r.total_scenarios,
                   r.oggy_correct, r.oggy_accuracy, r.base_correct, r.base_accuracy,
                   r.advantage_delta, r.advantage_percent, r.training_state,
                   b.benchmark_name, b.difficulty_mix
            FROM sealed_benchmark_results r
            JOIN sealed_benchmarks b ON r.benchmark_id = b.benchmark_id
            WHERE r.oggy_accuracy != 'NaN' AND r.base_accuracy != 'NaN'
            ORDER BY r.tested_at ASC
            LIMIT $1
        `, [limit]);

        if (results.rows.length === 0) {
            return res.json({
                total_benchmarks: 0,
                message: 'No benchmark results found. Run training to generate benchmarks.'
            });
        }

        // Build time series data
        const timeSeries = results.rows.map((r, i) => {
            const levelMatch = r.benchmark_name.match(/_(S\dL\d)_/);
            const ts = typeof r.training_state === 'string'
                ? JSON.parse(r.training_state) : (r.training_state || {});
            return {
                index: i + 1,
                tested_at: r.tested_at,
                oggy_accuracy: parseFloat(r.oggy_accuracy),
                base_accuracy: parseFloat(r.base_accuracy),
                advantage_delta: parseFloat(r.advantage_delta),
                advantage_percent: parseFloat(r.advantage_percent),
                level: levelMatch ? levelMatch[1] : 'unknown',
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
                `SELECT scale, difficulty_level FROM continuous_learning_state WHERE user_id = 'oggy' LIMIT 1`
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
        const results = await query(`
            SELECT r.oggy_accuracy, r.base_accuracy, r.advantage_delta,
                   r.training_state, b.benchmark_name, b.difficulty_mix,
                   r.tested_at
            FROM sealed_benchmark_results r
            JOIN sealed_benchmarks b ON r.benchmark_id = b.benchmark_id
            ORDER BY r.tested_at DESC
            LIMIT 1
        `);

        let metrics = '';
        metrics += '# HELP oggy_benchmark_total Total benchmarks run\n';
        metrics += '# TYPE oggy_benchmark_total counter\n';

        const countResult = await query('SELECT COUNT(*) as cnt FROM sealed_benchmark_results');
        metrics += `oggy_benchmark_total ${countResult.rows[0].cnt}\n\n`;

        if (results.rows.length > 0) {
            const r = results.rows[0];
            const ts = typeof r.training_state === 'string'
                ? JSON.parse(r.training_state) : (r.training_state || {});
            const levelMatch = r.benchmark_name.match(/_(S\dL\d)_/);
            const level = levelMatch ? levelMatch[1] : 'unknown';

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
            `);
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

module.exports = router;
