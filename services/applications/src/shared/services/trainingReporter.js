/**
 * Training Reporter - Sends email reports during and after training sessions
 * Supports: after each benchmark, timed intervals, or end-of-session only
 * Includes weakness analysis, confusion pairs, and recommendations
 */

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { query } = require('../utils/db');
const weaknessAnalyzer = require('./weaknessAnalyzer');

class TrainingReporter {
    constructor() {
        this.config = null;       // { email, interval, duration_minutes }
        this.intervalTimer = null;
        this.lastReportTime = null;
        this.transporter = null;
    }

    /**
     * Configure reporting for a training session
     * @param {string} email - Recipient email
     * @param {string} interval - 'end_only', 'benchmark', or minute interval ('5','10','15')
     * @param {number} durationMinutes - Training duration for context
     * @param {string} userId - User ID for scoped weakness queries
     */
    configure(email, interval, durationMinutes, userId) {
        this.stop(); // Clear any previous session
        if (!email) return;

        this.config = { email, interval, duration_minutes: durationMinutes, userId: userId || 'oggy' };
        this.lastReportTime = Date.now();
        this._initTransporter();

        // Set up timed interval if numeric
        const minutes = parseInt(interval);
        if (!isNaN(minutes) && minutes > 0) {
            this.intervalTimer = setInterval(() => {
                this._sendTimedReport();
            }, minutes * 60 * 1000);
        }

        logger.info('Training reporter configured', { email, interval, duration_minutes: durationMinutes });
    }

    _initTransporter() {
        const host = process.env.SMTP_HOST;
        const port = parseInt(process.env.SMTP_PORT || '587');
        const user = process.env.SMTP_USER;
        const pass = process.env.SMTP_PASS;

        if (host && user && pass) {
            this.transporter = nodemailer.createTransport({
                host,
                port,
                secure: port === 465,
                auth: { user, pass }
            });
        } else {
            // Fallback: log-only mode when SMTP not configured
            this.transporter = null;
            logger.warn('SMTP not configured - email reports will be logged only. Set SMTP_HOST, SMTP_USER, SMTP_PASS env vars.');
        }
    }

    /**
     * Called after each benchmark completes
     */
    async onBenchmarkComplete(stats, benchmarkResult) {
        if (!this.config) return;
        if (this.config.interval !== 'benchmark') return;

        await this._sendReport('Benchmark Report', stats, benchmarkResult);
    }

    /**
     * Called when training session ends
     */
    async onSessionEnd(stats) {
        if (!this.config) return;

        await this._sendReport('Final Training Report', stats, null);
        this.stop();
    }

    /**
     * Called when an error stops the training session
     */
    async onError(stats, error) {
        if (!this.config) return;

        const errorMsg = error?.message || String(error) || 'Unknown error';
        const errorStats = { ...stats, status: `Error: ${errorMsg}` };
        await this._sendReport('Training Stopped — Error', errorStats, null);
        this.stop();
    }

    /**
     * Timed interval report
     */
    async _sendTimedReport() {
        if (!this.config) return;
        // getStats will be called by the caller and passed in
        // For timed reports, we use a callback pattern
        if (this._getStatsFn) {
            const stats = this._getStatsFn();
            await this._sendReport('Training Progress Report', stats, null);
        }
    }

    /**
     * Set a function to retrieve current stats (used by timed interval)
     */
    setStatsProvider(fn) {
        this._getStatsFn = fn;
    }

    async _sendReport(subject, stats, benchmarkResult) {
        const html = await this._buildReportHtml(subject, stats, benchmarkResult);
        const fullSubject = `Oggy Training: ${subject}`;

        if (this.transporter) {
            try {
                await this.transporter.sendMail({
                    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'oggy@localhost',
                    to: this.config.email,
                    subject: fullSubject,
                    html
                });
                logger.info('Training report email sent', { to: this.config.email, subject: fullSubject });
            } catch (err) {
                logger.warn('Failed to send training report email', { error: err.message, to: this.config.email });
            }
        } else {
            // Log-only mode
            logger.info('Training report (SMTP not configured)', {
                to: this.config.email,
                subject: fullSubject,
                stats_summary: {
                    level: stats.scale_level_display,
                    accuracy: stats.overall_accuracy,
                    questions: `${stats.correct_answers}/${stats.total_questions}`,
                    benchmarks: `${stats.benchmarks_passed}/${stats.benchmarks_generated}`
                }
            });
        }

        this.lastReportTime = Date.now();
    }

    /**
     * Get weakness analysis data for a benchmark result
     */
    async _getWeaknessData(benchmarkResult) {
        try {
            if (!benchmarkResult || !benchmarkResult.benchmark_id) return null;

            // Look up result_id from sealed_benchmark_results (scoped by userId)
            const userId = this.config?.userId;
            const resultRow = await query(
                `SELECT result_id FROM sealed_benchmark_results
                 WHERE benchmark_id = $1${userId ? ' AND user_id = $2' : ''} ORDER BY tested_at DESC LIMIT 1`,
                userId ? [benchmarkResult.benchmark_id, userId] : [benchmarkResult.benchmark_id]
            );
            if (resultRow.rows.length === 0) return null;

            const analysis = await weaknessAnalyzer.analyzeWeaknesses({
                result_id: resultRow.rows[0].result_id
            });
            return analysis;
        } catch (err) {
            logger.warn('Weakness analysis for report failed (non-blocking)', { error: err.message });
            return null;
        }
    }

    /**
     * Harmony-specific benchmark analysis — replaces weakness analyzer for harmony domain
     */
    async _getHarmonyAnalysis(benchmarkResult) {
        try {
            if (!benchmarkResult || !benchmarkResult.benchmark_id) return null;

            const userId = this.config?.userId;
            const resultRow = await query(
                `SELECT detailed_results FROM sealed_benchmark_results
                 WHERE benchmark_id = $1${userId ? ' AND user_id = $2' : ''} ORDER BY tested_at DESC LIMIT 1`,
                userId ? [benchmarkResult.benchmark_id, userId] : [benchmarkResult.benchmark_id]
            );
            if (resultRow.rows.length === 0) return null;

            const details = resultRow.rows[0].detailed_results;
            if (!details || !details.oggy || !details.oggy.scenario_results) return null;

            const oggyResults = details.oggy.scenario_results;
            const baseResults = details.base?.scenario_results || [];

            // Group by scenario_type
            const byType = {};
            for (const r of oggyResults) {
                const type = r.scenario_type || 'unknown';
                if (!byType[type]) byType[type] = { correct: 0, total: 0, wrong: [] };
                byType[type].total++;
                if (r.correct) {
                    byType[type].correct++;
                } else {
                    byType[type].wrong.push({ expected: r.expected, answer: r.answer });
                }
            }

            // Compute per-type accuracy
            const typePerformance = {};
            for (const [type, data] of Object.entries(byType)) {
                typePerformance[type] = {
                    accuracy: data.total > 0 ? data.correct / data.total : 0,
                    correct: data.correct,
                    total: data.total,
                    wrong_examples: data.wrong.slice(0, 3)
                };
            }

            // Dimension accuracy for classification scenarios
            const dimensionPerf = {};
            for (const r of oggyResults) {
                if (r.scenario_type === 'indicator_classification' && r.expected) {
                    const dim = r.expected.toLowerCase();
                    if (!dimensionPerf[dim]) dimensionPerf[dim] = { correct: 0, total: 0 };
                    dimensionPerf[dim].total++;
                    if (r.correct) dimensionPerf[dim].correct++;
                }
            }

            // Weak areas (< 70%)
            const weakTypes = Object.entries(typePerformance)
                .filter(([_, p]) => p.accuracy < 0.70 && p.total >= 2)
                .map(([type]) => type);

            return { typePerformance, dimensionPerf, weakTypes, oggyTotal: oggyResults.length };
        } catch (err) {
            logger.warn('Harmony analysis for report failed (non-blocking)', { error: err.message });
            return null;
        }
    }

    /**
     * General conversation benchmark analysis — scenario types + criteria scores + feedback
     */
    async _getGeneralAnalysis(benchmarkResult) {
        try {
            if (!benchmarkResult || !benchmarkResult.benchmark_id) return null;

            const userId = this.config?.userId;
            const resultRow = await query(
                `SELECT detailed_results FROM sealed_benchmark_results
                 WHERE benchmark_id = $1${userId ? ' AND user_id = $2' : ''} ORDER BY tested_at DESC LIMIT 1`,
                userId ? [benchmarkResult.benchmark_id, userId] : [benchmarkResult.benchmark_id]
            );
            if (resultRow.rows.length === 0) return null;

            const details = resultRow.rows[0].detailed_results;
            const scenarios = details?.scenarios || [];
            if (scenarios.length === 0) return null;

            // Per scenario type performance
            const byType = {};
            // Per criteria averages
            const criteriaAgg = { context_awareness: [], preference_alignment: [], helpfulness: [], domain_accuracy: [] };

            const wrongExamples = [];

            for (const s of scenarios) {
                const oggy = s.oggy || {};
                const base = s.base || {};
                const type = s.scenario_type || 'unknown';

                // Aggregate by type
                if (!byType[type]) byType[type] = { oggy_correct: 0, base_correct: 0, total: 0, oggy_scores: [], base_scores: [] };
                byType[type].total++;
                if (oggy.correct) byType[type].oggy_correct++;
                if (base.correct) byType[type].base_correct++;
                if (oggy.avg_score) byType[type].oggy_scores.push(oggy.avg_score);
                if (base.avg_score) byType[type].base_scores.push(base.avg_score);

                // Aggregate criteria scores
                if (oggy.scores) {
                    for (const [key, val] of Object.entries(oggy.scores)) {
                        if (criteriaAgg[key]) criteriaAgg[key].push(val);
                    }
                }

                // Collect wrong scenarios with feedback
                if (!oggy.correct && oggy.feedback) {
                    wrongExamples.push({
                        type,
                        prompt: s.prompt?.substring(0, 120),
                        oggy_score: oggy.avg_score,
                        base_score: base.avg_score,
                        feedback: oggy.feedback,
                        scores: oggy.scores
                    });
                }
            }

            // Compute type performance
            const typePerformance = {};
            for (const [type, data] of Object.entries(byType)) {
                const oggyAvg = data.oggy_scores.length > 0
                    ? data.oggy_scores.reduce((a, b) => a + b, 0) / data.oggy_scores.length : 0;
                const baseAvg = data.base_scores.length > 0
                    ? data.base_scores.reduce((a, b) => a + b, 0) / data.base_scores.length : 0;
                typePerformance[type] = {
                    oggy_accuracy: data.total > 0 ? data.oggy_correct / data.total : 0,
                    base_accuracy: data.total > 0 ? data.base_correct / data.total : 0,
                    oggy_avg_score: parseFloat(oggyAvg.toFixed(2)),
                    base_avg_score: parseFloat(baseAvg.toFixed(2)),
                    correct: data.oggy_correct,
                    total: data.total
                };
            }

            // Compute criteria averages
            const criteriaAvg = {};
            for (const [key, values] of Object.entries(criteriaAgg)) {
                if (values.length > 0) {
                    criteriaAvg[key] = parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
                }
            }

            // Weak types (< 70%)
            const weakTypes = Object.entries(typePerformance)
                .filter(([_, p]) => p.oggy_accuracy < 0.70 && p.total >= 2)
                .map(([type]) => type);

            return { typePerformance, criteriaAvg, weakTypes, wrongExamples: wrongExamples.slice(0, 5), totalScenarios: scenarios.length };
        } catch (err) {
            logger.warn('General analysis for report failed (non-blocking)', { error: err.message });
            return null;
        }
    }

    _buildGeneralSection(analysis) {
        if (!analysis) return '';

        let html = '';
        const typeLabels = {
            context_retention: 'Context Retention',
            preference_adherence: 'Preference Adherence',
            general_helpfulness: 'General Helpfulness',
            domain_knowledge_recall: 'Domain Knowledge Recall',
            domain_knowledge_application: 'Domain Knowledge Application'
        };

        // Scenario Type Accuracy — Oggy vs Base bars
        const typeEntries = Object.entries(analysis.typePerformance)
            .sort((a, b) => a[1].oggy_accuracy - b[1].oggy_accuracy);

        if (typeEntries.length > 0) {
            const typeRows = typeEntries.map(([type, perf]) => {
                const oggyPct = (perf.oggy_accuracy * 100).toFixed(0);
                const basePct = (perf.base_accuracy * 100).toFixed(0);
                const oggyColor = perf.oggy_accuracy < 0.50 ? '#ef4444' :
                                  perf.oggy_accuracy < 0.70 ? '#f59e0b' : '#22c55e';
                const label = typeLabels[type] || type.replace(/_/g, ' ');
                const better = perf.oggy_accuracy > perf.base_accuracy ? '+' :
                               perf.oggy_accuracy < perf.base_accuracy ? '-' : '=';
                return `
                    <tr>
                        <td style="padding:6px 8px;font-size:13px;font-weight:500;white-space:nowrap">${label}</td>
                        <td style="padding:6px 8px;width:50%">
                            <div style="background:#f1f5f9;border-radius:4px;height:18px;position:relative;overflow:hidden">
                                <div style="background:${oggyColor};height:100%;width:${Math.max(oggyPct, 5)}%;border-radius:4px;min-width:20px"></div>
                            </div>
                        </td>
                        <td style="padding:6px 8px;font-size:12px;white-space:nowrap">
                            <span style="color:#4f46e5;font-weight:600">Oggy ${oggyPct}%</span>
                            <span style="color:#94a3b8;margin:0 4px">vs</span>
                            <span style="color:#64748b">Base ${basePct}%</span>
                        </td>
                        <td style="padding:6px 8px;font-size:11px;color:var(--text-muted)">(${perf.correct}/${perf.total})</td>
                    </tr>`;
            }).join('');

            html += `
                <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Scenario Type Performance</h3>
                <table style="width:100%;border-collapse:collapse">${typeRows}</table>`;
        }

        // Criteria Score Breakdown (context_awareness, preference_alignment, helpfulness, domain_accuracy)
        const criteriaLabels = {
            context_awareness: 'Context Awareness',
            preference_alignment: 'Preference Alignment',
            helpfulness: 'Helpfulness',
            domain_accuracy: 'Domain Accuracy'
        };

        const criteriaEntries = Object.entries(analysis.criteriaAvg)
            .filter(([_, v]) => v > 0)
            .sort((a, b) => a[1] - b[1]);

        if (criteriaEntries.length > 0) {
            const criteriaRows = criteriaEntries.map(([key, score]) => {
                const pct = (score / 5 * 100).toFixed(0);
                const barColor = score < 2.5 ? '#ef4444' : score < 3.5 ? '#f59e0b' : '#22c55e';
                const label = criteriaLabels[key] || key.replace(/_/g, ' ');
                return `
                    <tr>
                        <td style="padding:4px 8px;font-size:13px;font-weight:500;white-space:nowrap">${label}</td>
                        <td style="padding:4px 8px;width:100%">
                            <div style="background:#f1f5f9;border-radius:4px;height:18px;position:relative;overflow:hidden">
                                <div style="background:${barColor};height:100%;width:${Math.max(pct, 5)}%;border-radius:4px;min-width:20px"></div>
                            </div>
                        </td>
                        <td style="padding:4px 8px;font-size:13px;color:#64748b;white-space:nowrap">${score}/5</td>
                    </tr>`;
            }).join('');

            html += `
                <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Criteria Scores (Oggy Avg)</h3>
                <table style="width:100%;border-collapse:collapse">${criteriaRows}</table>`;
        }

        // Wrong Scenarios — show judge feedback
        if (analysis.wrongExamples.length > 0) {
            const wrongRows = analysis.wrongExamples.map(w => {
                const typeLabel = typeLabels[w.type] || w.type.replace(/_/g, ' ');
                const scoreDetail = w.scores
                    ? `ctx:${w.scores.context_awareness} pref:${w.scores.preference_alignment} help:${w.scores.helpfulness}${w.scores.domain_accuracy ? ' dom:' + w.scores.domain_accuracy : ''}`
                    : '';
                return `
                    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px;margin-bottom:8px;font-size:12px">
                        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                            <span style="font-weight:600;color:#991b1b">${typeLabel}</span>
                            <span style="color:#64748b">${scoreDetail} (avg ${w.oggy_score}/5)</span>
                        </div>
                        <div style="color:#1e293b;margin-bottom:4px">"${w.prompt}..."</div>
                        <div style="color:#64748b;font-style:italic">${w.feedback}</div>
                    </div>`;
            }).join('');

            html += `
                <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Areas to Improve (${analysis.wrongExamples.length} weak scenarios)</h3>
                ${wrongRows}`;
        }

        // Recommendations
        if (analysis.weakTypes.length > 0) {
            const focusAreas = analysis.weakTypes.map(t => typeLabels[t] || t.replace(/_/g, ' ')).join(', ');
            html += `
                <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:14px;margin-top:16px">
                    <strong style="color:#92400e;font-size:13px">Recommendation</strong>
                    <p style="margin:6px 0 0;font-size:13px;color:#78350f">
                        Focus training on: <strong>${focusAreas}</strong>.
                        These scenario types are below 70% accuracy. Chat more in these areas to build stronger memories.
                    </p>
                </div>`;
        }

        // Strong types (>= 80%)
        const strongTypes = typeEntries.filter(([_, p]) => p.oggy_accuracy >= 0.80);
        if (strongTypes.length > 0) {
            const strongList = strongTypes.reverse().map(([type, perf]) => {
                const label = typeLabels[type] || type.replace(/_/g, ' ');
                return `<span style="display:inline-block;background:#dcfce7;color:#166534;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;margin:2px">${label} ${(perf.oggy_accuracy * 100).toFixed(0)}%</span>`;
            }).join(' ');
            html += `
                <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Strong Areas</h3>
                <div>${strongList}</div>`;
        }

        return html;
    }

    _buildHarmonySection(analysis) {
        if (!analysis) return '';

        let html = '';
        const typeLabels = {
            indicator_classification: 'Indicator Classification',
            score_prediction: 'Score Prediction',
            city_wellness_assessment: 'City Wellness Assessment',
            metric_identification: 'Metric Identification',
            city_expansion: 'City Expansion',
            data_source_recommendation: 'Data Source Recommendation',
            missing_indicator: 'Missing Indicator',
            weight_suggestion: 'Weight Suggestion'
        };

        // Scenario Type Accuracy bars
        const typeEntries = Object.entries(analysis.typePerformance)
            .sort((a, b) => a[1].accuracy - b[1].accuracy);

        if (typeEntries.length > 0) {
            const typeRows = typeEntries.map(([type, perf]) => {
                const pct = (perf.accuracy * 100).toFixed(0);
                const barColor = perf.accuracy < 0.50 ? '#ef4444' :
                                 perf.accuracy < 0.70 ? '#f59e0b' : '#22c55e';
                const barWidth = Math.max(pct, 5);
                const label = typeLabels[type] || type.replace(/_/g, ' ');
                return `
                    <tr>
                        <td style="padding:4px 8px;font-size:13px;font-weight:500;white-space:nowrap">${label}</td>
                        <td style="padding:4px 8px;width:100%">
                            <div style="background:#f1f5f9;border-radius:4px;height:18px;position:relative;overflow:hidden">
                                <div style="background:${barColor};height:100%;width:${barWidth}%;border-radius:4px;min-width:20px"></div>
                            </div>
                        </td>
                        <td style="padding:4px 8px;font-size:13px;color:#64748b;white-space:nowrap">${pct}% (${perf.correct}/${perf.total})</td>
                    </tr>`;
            }).join('');

            html += `
                <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Scenario Type Accuracy</h3>
                <table style="width:100%;border-collapse:collapse">${typeRows}</table>`;
        }

        // Dimension Performance (from classification scenarios)
        const dimEntries = Object.entries(analysis.dimensionPerf)
            .sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total);

        if (dimEntries.length > 0) {
            const dimRows = dimEntries.map(([dim, perf]) => {
                const acc = perf.total > 0 ? perf.correct / perf.total : 0;
                const pct = (acc * 100).toFixed(0);
                const barColor = acc < 0.50 ? '#ef4444' : acc < 0.70 ? '#f59e0b' : '#22c55e';
                const label = dim.charAt(0).toUpperCase() + dim.slice(1);
                return `
                    <tr>
                        <td style="padding:4px 8px;font-size:13px;font-weight:500;white-space:nowrap">${label}</td>
                        <td style="padding:4px 8px;width:100%">
                            <div style="background:#f1f5f9;border-radius:4px;height:18px;position:relative;overflow:hidden">
                                <div style="background:${barColor};height:100%;width:${Math.max(pct, 5)}%;border-radius:4px;min-width:20px"></div>
                            </div>
                        </td>
                        <td style="padding:4px 8px;font-size:13px;color:#64748b;white-space:nowrap">${pct}% (${perf.correct}/${perf.total})</td>
                    </tr>`;
            }).join('');

            html += `
                <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Dimension Performance</h3>
                <table style="width:100%;border-collapse:collapse">${dimRows}</table>`;
        }

        // Weak areas recommendation
        if (analysis.weakTypes.length > 0) {
            const focusAreas = analysis.weakTypes.map(t => typeLabels[t] || t.replace(/_/g, ' ')).join(', ');
            html += `
                <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:14px;margin-top:16px">
                    <strong style="color:#92400e;font-size:13px">Recommendation</strong>
                    <p style="margin:6px 0 0;font-size:13px;color:#78350f">
                        Focus training on weaker scenario types: <strong>${focusAreas}</strong>.
                        These areas are below 70% accuracy and need more practice.
                    </p>
                </div>`;
        }

        // Strong types (>= 80%)
        const strongTypes = typeEntries.filter(([_, p]) => p.accuracy >= 0.80);
        if (strongTypes.length > 0) {
            const strongList = strongTypes.reverse().map(([type, perf]) => {
                const label = typeLabels[type] || type.replace(/_/g, ' ');
                return `<span style="display:inline-block;background:#dcfce7;color:#166534;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;margin:2px">${label} ${(perf.accuracy * 100).toFixed(0)}%</span>`;
            }).join(' ');
            html += `
                <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Strong Scenario Types</h3>
                <div>${strongList}</div>`;
        }

        return html;
    }

    async _buildReportHtml(title, stats, benchmarkResult) {
        const bmRows = (stats.benchmark_results || []).map((bm, i) => `
            <tr>
                <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${i + 1}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${bm.scale_level_display || ''}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${(bm.oggy_accuracy * 100).toFixed(0)}%</td>
                <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${(bm.base_accuracy * 100).toFixed(0)}%</td>
                <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${bm.oggy_passed ? 'Passed' : 'Failed'}</td>
            </tr>
        `).join('');

        const latestBm = benchmarkResult || (stats.benchmark_results || []).slice(-1)[0];
        const latestSection = latestBm ? `
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:16px">
                <strong>Latest Benchmark: ${latestBm.scale_level_display || ''}</strong><br>
                Oggy: ${(latestBm.oggy_accuracy * 100).toFixed(0)}% vs Base: ${(latestBm.base_accuracy * 100).toFixed(0)}%
                &mdash; ${latestBm.oggy_passed ? 'PASSED' : 'NEEDS IMPROVEMENT'}
            </div>
        ` : '';

        // Get domain-specific analysis for the latest benchmark
        const domain = stats.domain || latestBm?.domain || '';
        const isHarmony = domain === 'harmony';
        const isGeneral = domain === 'general';
        let weaknessSection = '';

        if (isHarmony) {
            const harmonyAnalysis = await this._getHarmonyAnalysis(latestBm);
            weaknessSection = this._buildHarmonySection(harmonyAnalysis);
        } else if (isGeneral) {
            const generalAnalysis = await this._getGeneralAnalysis(latestBm);
            weaknessSection = this._buildGeneralSection(generalAnalysis);
        } else {
            const analysis = await this._getWeaknessData(latestBm);

            if (analysis && analysis.category_performance) {
                // Category accuracy bars
                const catEntries = Object.entries(analysis.category_performance)
                    .sort((a, b) => a[1].accuracy - b[1].accuracy);

                if (catEntries.length > 0) {
                    const catRows = catEntries.map(([cat, perf]) => {
                        const pct = (perf.accuracy * 100).toFixed(0);
                        const barColor = perf.accuracy < 0.60 ? '#ef4444' :
                                         perf.accuracy < 0.80 ? '#f59e0b' : '#22c55e';
                        const barWidth = Math.max(pct, 5);
                        return `
                            <tr>
                                <td style="padding:4px 8px;font-size:13px;font-weight:500;white-space:nowrap">${cat}</td>
                                <td style="padding:4px 8px;width:100%">
                                    <div style="background:#f1f5f9;border-radius:4px;height:18px;position:relative;overflow:hidden">
                                        <div style="background:${barColor};height:100%;width:${barWidth}%;border-radius:4px;min-width:20px"></div>
                                    </div>
                                </td>
                                <td style="padding:4px 8px;font-size:13px;color:#64748b;white-space:nowrap">${pct}% (${perf.correct}/${perf.total})</td>
                            </tr>`;
                    }).join('');

                    weaknessSection += `
                        <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Category Accuracy</h3>
                        <table style="width:100%;border-collapse:collapse">${catRows}</table>`;
                }

                // Confusion pairs
                if (analysis.confusion_patterns && analysis.confusion_patterns.length > 0) {
                    const confusionRows = analysis.confusion_patterns.slice(0, 5).map(p => `
                        <tr>
                            <td style="padding:4px 8px;font-size:13px">
                                <span style="color:#ef4444;font-weight:600">${p.actual}</span>
                                <span style="color:#94a3b8"> misclassified as </span>
                                <span style="font-weight:600">${p.predicted}</span>
                            </td>
                            <td style="padding:4px 8px;font-size:13px;color:#64748b;text-align:right">${p.count} times</td>
                        </tr>
                    `).join('');

                    weaknessSection += `
                        <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Top Confusion Pairs</h3>
                        <table style="width:100%;border-collapse:collapse">${confusionRows}</table>`;
                }

                // Recommendations
                if (analysis.recommendations && analysis.recommendations.priority === 'targeted') {
                    const focusCats = analysis.recommendations.focus_categories.join(', ');
                    weaknessSection += `
                        <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:14px;margin-top:16px">
                            <strong style="color:#92400e;font-size:13px">Recommendation</strong>
                            <p style="margin:6px 0 0;font-size:13px;color:#78350f">
                                ${analysis.recommendations.message}. Focus categories: <strong>${focusCats}</strong>
                            </p>
                        </div>`;
                }

                // Strengths (categories >80%)
                const strengths = catEntries.filter(([_, perf]) => perf.accuracy >= 0.80);
                if (strengths.length > 0) {
                    const strongList = strengths.reverse().map(([cat, perf]) =>
                        `<span style="display:inline-block;background:#dcfce7;color:#166534;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;margin:2px">${cat} ${(perf.accuracy * 100).toFixed(0)}%</span>`
                    ).join(' ');
                    weaknessSection += `
                        <h3 style="font-size:14px;color:#64748b;margin:20px 0 8px">Strong Categories</h3>
                        <div>${strongList}</div>`;
                }
            }
        }

        return `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
            <div style="background:#4f46e5;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
                <h2 style="margin:0;font-size:18px">${title}</h2>
            </div>
            <div style="background:white;border:1px solid #e2e8f0;border-top:none;padding:24px;border-radius:0 0 8px 8px">
                <table style="width:100%;margin-bottom:16px">
                    <tr>
                        <td style="padding:8px 0"><strong>Level:</strong></td>
                        <td style="padding:8px 0">${stats.scale_level_display || '-'}</td>
                        <td style="padding:8px 0"><strong>Accuracy:</strong></td>
                        <td style="padding:8px 0">${stats.overall_accuracy || '-'}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px 0"><strong>Questions:</strong></td>
                        <td style="padding:8px 0">${stats.correct_answers || 0} / ${stats.total_questions || 0}</td>
                        <td style="padding:8px 0"><strong>Benchmarks:</strong></td>
                        <td style="padding:8px 0">${stats.benchmarks_passed || 0} / ${stats.benchmarks_generated || 0} passed</td>
                    </tr>
                    <tr>
                        <td style="padding:8px 0"><strong>Training Time:</strong></td>
                        <td style="padding:8px 0">${stats.training_time_readable || '-'}</td>
                        <td style="padding:8px 0"><strong>Status:</strong></td>
                        <td style="padding:8px 0">${stats.status || '-'}</td>
                    </tr>
                </table>

                ${latestSection}

                ${weaknessSection}

                ${bmRows ? `
                <h3 style="font-size:14px;color:#64748b;margin:16px 0 8px">Benchmark History</h3>
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                    <thead>
                        <tr style="background:#f8fafc">
                            <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #e2e8f0">#</th>
                            <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Level</th>
                            <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Oggy</th>
                            <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Base</th>
                            <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Result</th>
                        </tr>
                    </thead>
                    <tbody>${bmRows}</tbody>
                </table>
                ` : '<p style="color:#64748b">No benchmarks run yet.</p>'}

                <p style="color:#94a3b8;font-size:12px;margin-top:16px">
                    Duration: ${this.config?.duration_minutes ? this.config.duration_minutes + ' min' : 'Indefinite'} &bull;
                    Report type: ${this.config?.interval || '-'}
                </p>
            </div>
        </div>`;
    }

    stop() {
        if (this.intervalTimer) {
            clearInterval(this.intervalTimer);
            this.intervalTimer = null;
        }
        this.config = null;
        this._getStatsFn = null;
    }
}

// Per-user reporter registry (fixes multi-tenant singleton bug)
const reporters = new Map();

function getReporter(userId) {
    if (!userId) throw new Error('userId required for training reporter');
    if (!reporters.has(userId)) {
        reporters.set(userId, new TrainingReporter());
    }
    return reporters.get(userId);
}

function removeReporter(userId) {
    const reporter = reporters.get(userId);
    if (reporter) {
        reporter.stop();
        reporters.delete(userId);
    }
}

module.exports = { getReporter, removeReporter, TrainingReporter };
