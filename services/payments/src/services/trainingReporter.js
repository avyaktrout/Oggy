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

            // Look up result_id from sealed_benchmark_results
            const resultRow = await query(
                `SELECT result_id FROM sealed_benchmark_results
                 WHERE benchmark_id = $1 ORDER BY tested_at DESC LIMIT 1`,
                [benchmarkResult.benchmark_id]
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

        // Get weakness analysis for the latest benchmark
        const analysis = await this._getWeaknessData(latestBm);
        let weaknessSection = '';

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
                    Duration: ${this.config?.duration_minutes || '-'} min &bull;
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

// Singleton
module.exports = new TrainingReporter();
