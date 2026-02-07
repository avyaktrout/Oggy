/**
 * Training Reporter - Sends email reports during and after training sessions
 * Supports: after each benchmark, timed intervals, or end-of-session only
 */

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

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
     */
    configure(email, interval, durationMinutes) {
        this.stop(); // Clear any previous session
        if (!email) return;

        this.config = { email, interval, duration_minutes: durationMinutes };
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
        const html = this._buildReportHtml(subject, stats, benchmarkResult);
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

    _buildReportHtml(title, stats, benchmarkResult) {
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
