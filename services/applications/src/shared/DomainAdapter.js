/**
 * Domain Adapter Registry
 *
 * Each domain (payments, diet, general) registers an adapter conforming to:
 *   {
 *     getSdl(userId)         → { start, stop, getStats, setTargetedLearning }
 *     createBenchmark(opts)  → { benchmark_id }
 *     getBenchmark(name)     → benchmark object with .scenarios
 *     runBenchmark(opts)     → { oggy: { accuracy, wrong_scenarios }, base, comparison }
 *     scaleComplexity        → { 1: { name, complexity_factors }, ... }
 *     postBenchmarkProcess?(benchmark, testResult, userId)  // optional hook
 *   }
 *
 * Lazy-loaded to avoid circular dependencies.
 */

const _registry = {};

function registerDomain(domain, adapterFactory) {
    _registry[domain] = { factory: adapterFactory, instance: null };
}

function getDomainAdapter(domain) {
    const entry = _registry[domain];
    if (!entry) throw new Error(`Domain '${domain}' not registered. Known domains: ${Object.keys(_registry).join(', ')}`);
    if (!entry.instance) entry.instance = entry.factory();
    return entry.instance;
}

function getRegisteredDomains() {
    return Object.keys(_registry);
}

module.exports = { registerDomain, getDomainAdapter, getRegisteredDomains };
