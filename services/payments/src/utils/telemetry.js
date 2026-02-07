/**
 * OpenTelemetry Instrumentation for Oggy Payments Service
 * Exports benchmark & training metrics to OTEL collector → Prometheus
 */

const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const logger = require('./logger');

let meter = null;
let instruments = {};

function initTelemetry() {
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4318';
    const serviceName = process.env.OTEL_SERVICE_NAME || 'payments-service';

    try {
        const resource = new Resource({
            'service.name': serviceName,
            'service.version': '0.2.0'
        });

        const metricExporter = new OTLPMetricExporter({
            url: `${otlpEndpoint}/v1/metrics`
        });

        const metricReader = new PeriodicExportingMetricReader({
            exporter: metricExporter,
            exportIntervalMillis: 15000  // Export every 15s
        });

        const meterProvider = new MeterProvider({
            resource,
            readers: [metricReader]
        });

        meter = meterProvider.getMeter('oggy-benchmarks');

        // --- Gauge-style metrics (use UpDownCounter for gauge behavior) ---
        instruments.oggyAccuracy = meter.createGauge('oggy.benchmark.oggy_accuracy', {
            description: 'Oggy accuracy on latest benchmark (0-1)',
            unit: 'ratio'
        });

        instruments.baseAccuracy = meter.createGauge('oggy.benchmark.base_accuracy', {
            description: 'Base model accuracy on latest benchmark (0-1)',
            unit: 'ratio'
        });

        instruments.advantageDelta = meter.createGauge('oggy.benchmark.advantage_delta', {
            description: 'Oggy advantage over base (positive = Oggy wins)',
            unit: 'ratio'
        });

        instruments.memoryCardCount = meter.createGauge('oggy.memory.card_count', {
            description: 'Total memory cards accumulated'
        });

        instruments.domainKnowledgeCount = meter.createGauge('oggy.memory.domain_knowledge_count', {
            description: 'Total domain knowledge entries'
        });

        // --- Counter metrics ---
        instruments.benchmarkTotal = meter.createCounter('oggy.benchmark.total', {
            description: 'Total benchmarks run'
        });

        instruments.benchmarkPassed = meter.createCounter('oggy.benchmark.passed', {
            description: 'Benchmarks where Oggy beat or tied Base'
        });

        instruments.benchmarkFailed = meter.createCounter('oggy.benchmark.failed', {
            description: 'Benchmarks where Base beat Oggy'
        });

        // --- Histogram for accuracy distribution ---
        instruments.accuracyHistogram = meter.createHistogram('oggy.benchmark.accuracy_distribution', {
            description: 'Distribution of Oggy benchmark accuracies',
            unit: 'ratio',
            boundaries: [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]
        });

        logger.info('OpenTelemetry metrics initialized', { endpoint: otlpEndpoint, service: serviceName });
    } catch (error) {
        logger.warn('OpenTelemetry init failed, metrics disabled', { error: error.message });
    }
}

/**
 * Record a benchmark result as OTEL metrics
 */
function recordBenchmarkMetrics(result) {
    if (!meter || !instruments.oggyAccuracy) return;

    const attrs = {
        'benchmark.level': result.level || 'unknown',
        'benchmark.difficulty': result.difficulty_mix || 'unknown'
    };

    try {
        instruments.oggyAccuracy.record(parseFloat(result.oggy_accuracy) || 0, attrs);
        instruments.baseAccuracy.record(parseFloat(result.base_accuracy) || 0, attrs);
        instruments.advantageDelta.record(parseFloat(result.advantage_delta) || 0, attrs);

        instruments.benchmarkTotal.add(1, attrs);

        if (parseFloat(result.advantage_delta) >= 0) {
            instruments.benchmarkPassed.add(1, attrs);
        } else {
            instruments.benchmarkFailed.add(1, attrs);
        }

        instruments.accuracyHistogram.record(parseFloat(result.oggy_accuracy) || 0, attrs);

        // Memory metrics from training_state
        if (result.training_state) {
            const ts = typeof result.training_state === 'string'
                ? JSON.parse(result.training_state) : result.training_state;
            if (ts.memory_card_count != null) {
                instruments.memoryCardCount.record(ts.memory_card_count, attrs);
            }
            if (ts.domain_knowledge_count != null) {
                instruments.domainKnowledgeCount.record(ts.domain_knowledge_count, attrs);
            }
        }
    } catch (error) {
        logger.warn('Failed to record OTEL benchmark metrics', { error: error.message });
    }
}

/**
 * Load historical benchmarks from DB and emit metrics for each
 * Called once on startup to seed Prometheus with historical data
 */
async function seedHistoricalMetrics(dbQuery) {
    if (!meter) return;

    try {
        const result = await dbQuery(`
            SELECT r.oggy_accuracy, r.base_accuracy, r.advantage_delta,
                   r.training_state, b.benchmark_name, b.difficulty_mix
            FROM sealed_benchmark_results r
            JOIN sealed_benchmarks b ON r.benchmark_id = b.benchmark_id
            ORDER BY r.tested_at ASC
        `);

        for (const row of result.rows) {
            // Extract level from benchmark name (e.g., auto_benchmark_S2L2_xxx → S2L2)
            const levelMatch = row.benchmark_name.match(/_(S\dL\d)_/);
            recordBenchmarkMetrics({
                oggy_accuracy: row.oggy_accuracy,
                base_accuracy: row.base_accuracy,
                advantage_delta: row.advantage_delta,
                training_state: row.training_state,
                level: levelMatch ? levelMatch[1] : 'unknown',
                difficulty_mix: row.difficulty_mix
            });
        }

        logger.info('Seeded OTEL metrics with historical benchmarks', { count: result.rows.length });
    } catch (error) {
        logger.warn('Failed to seed historical metrics', { error: error.message });
    }
}

module.exports = {
    initTelemetry,
    recordBenchmarkMetrics,
    seedHistoricalMetrics
};
