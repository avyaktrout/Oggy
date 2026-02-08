// Benchmark Analytics Dashboard
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderNav('analytics');
    startInquiryPolling();

    // Global Chart.js defaults for readability
    Chart.defaults.font.size = 13;
    Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    Chart.defaults.color = '#475569';
    Chart.defaults.plugins.legend.labels.padding = 16;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.tooltip.padding = 12;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.tooltip.titleFont = { size: 14, weight: '600' };
    Chart.defaults.plugins.tooltip.bodyFont = { size: 13 };

    let charts = {};

    window.loadAnalytics = async function() {
        try {
            const data = await apiCall('GET', '/v0/benchmark-analytics?limit=200');
            if (!data.total_benchmarks) {
                document.getElementById('total-benchmarks').textContent = '0';
                return;
            }
            renderSummaryCards(data);
            renderAccuracyChart(data);
            renderWinLossChart(data);
            renderAdvantageChart(data);
            renderMemoryChart(data);
            renderByLevelChart(data);
            renderLevelTimeline(data);
        } catch (err) {
            showToast('Failed to load analytics: ' + err.message, 'error');
        }
    };

    function renderSummaryCards(data) {
        const s = data.summary;
        const cs = data.current_state;
        document.getElementById('total-benchmarks').textContent = data.total_benchmarks;
        document.getElementById('card-level').textContent = cs.level || '-';
        document.getElementById('card-winrate').textContent =
            (parseFloat(s.win_rate) * 100).toFixed(0) + '%';
        document.getElementById('card-oggy-acc').textContent =
            (parseFloat(s.avg_oggy_accuracy) * 100).toFixed(1) + '%';
        document.getElementById('card-base-acc').textContent =
            (parseFloat(s.avg_base_accuracy) * 100).toFixed(1) + '%';
        document.getElementById('card-memory').textContent =
            cs.memory_cards.toLocaleString();
        document.getElementById('card-dk').textContent =
            cs.domain_knowledge.toLocaleString();
    }

    function renderAccuracyChart(data) {
        const ctx = document.getElementById('chart-accuracy').getContext('2d');
        if (charts.accuracy) charts.accuracy.destroy();

        const ts = data.time_series;
        const labels = ts.map(r => '#' + r.index);

        charts.accuracy = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Oggy',
                        data: ts.map(r => +(r.oggy_accuracy * 100).toFixed(1)),
                        borderColor: '#6366f1',
                        backgroundColor: 'rgba(99,102,241,0.08)',
                        fill: true,
                        tension: 0.35,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                        borderWidth: 2.5
                    },
                    {
                        label: 'Base',
                        data: ts.map(r => +(r.base_accuracy * 100).toFixed(1)),
                        borderColor: '#cbd5e1',
                        backgroundColor: 'rgba(203,213,225,0.08)',
                        fill: true,
                        tension: 0.35,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                        borderWidth: 2.5,
                        borderDash: [6, 4]
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { position: 'top', labels: { font: { size: 14 } } },
                    tooltip: {
                        callbacks: {
                            title: function(items) {
                                const r = ts[items[0].dataIndex];
                                return `Benchmark ${r.index} — ${r.level} (${r.difficulty_mix})`;
                            },
                            label: function(ctx) {
                                return ` ${ctx.dataset.label}: ${ctx.parsed.y}%`;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        min: 40,
                        max: 100,
                        ticks: { callback: v => v + '%', font: { size: 13 }, stepSize: 10 },
                        title: { display: true, text: 'Accuracy %', font: { size: 14, weight: '600' } },
                        grid: { color: '#f1f5f9' }
                    },
                    x: {
                        ticks: { font: { size: 11 }, maxTicksLimit: 20 },
                        title: { display: true, text: 'Benchmark #', font: { size: 13, weight: '600' } },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    function renderWinLossChart(data) {
        const ctx = document.getElementById('chart-winloss').getContext('2d');
        if (charts.winloss) charts.winloss.destroy();

        const s = data.summary;
        charts.winloss = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Oggy Wins', 'Ties', 'Base Wins'],
                datasets: [{
                    data: [s.oggy_wins, s.ties, s.base_wins],
                    backgroundColor: ['#22c55e', '#cbd5e1', '#ef4444'],
                    borderWidth: 3,
                    borderColor: '#fff',
                    hoverBorderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '55%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { font: { size: 14 }, padding: 20 }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                const total = data.total_benchmarks;
                                const pct = ((ctx.raw / total) * 100).toFixed(0);
                                return ` ${ctx.label}: ${ctx.raw} (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    function renderAdvantageChart(data) {
        const ctx = document.getElementById('chart-advantage').getContext('2d');
        if (charts.advantage) charts.advantage.destroy();

        const ts = data.time_series;
        const ra = data.rolling_averages;
        const labels = ts.map(r => '#' + r.index);

        const barColors = ts.map(r =>
            r.advantage_delta > 0 ? 'rgba(34,197,94,0.65)' :
            r.advantage_delta < 0 ? 'rgba(239,68,68,0.55)' :
            'rgba(203,213,225,0.6)'
        );

        charts.advantage = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Per-Benchmark Delta',
                        data: ts.map(r => +(r.advantage_delta * 100).toFixed(1)),
                        backgroundColor: barColors,
                        borderWidth: 0,
                        borderRadius: 3,
                        order: 2
                    },
                    {
                        label: 'Rolling Avg (5)',
                        data: ra.map(r => +(r.rolling_advantage * 100).toFixed(2)),
                        borderColor: '#f59e0b',
                        backgroundColor: 'transparent',
                        type: 'line',
                        tension: 0.4,
                        pointRadius: 0,
                        borderWidth: 3,
                        order: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { position: 'top', labels: { font: { size: 14 } } },
                    tooltip: {
                        callbacks: {
                            afterLabel: function(ctx) {
                                if (ctx.datasetIndex === 0) {
                                    const r = ts[ctx.dataIndex];
                                    return `Oggy ${(r.oggy_accuracy*100).toFixed(0)}% vs Base ${(r.base_accuracy*100).toFixed(0)}%`;
                                }
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        ticks: { callback: v => (v > 0 ? '+' : '') + v + '%', font: { size: 13 } },
                        title: { display: true, text: 'Advantage (Oggy - Base) %', font: { size: 14, weight: '600' } },
                        grid: { color: '#f1f5f9' }
                    },
                    x: {
                        ticks: { font: { size: 11 }, maxTicksLimit: 20 },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    function renderMemoryChart(data) {
        const ctx = document.getElementById('chart-memory').getContext('2d');
        if (charts.memory) charts.memory.destroy();

        const ts = data.time_series;
        const labels = ts.map(r => '#' + r.index);

        charts.memory = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Memory Cards',
                        data: ts.map(r => r.memory_cards),
                        borderColor: '#8b5cf6',
                        backgroundColor: 'rgba(139,92,246,0.08)',
                        fill: true,
                        tension: 0.35,
                        pointRadius: 2,
                        borderWidth: 2.5,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Domain Knowledge',
                        data: ts.map(r => r.domain_knowledge),
                        borderColor: '#06b6d4',
                        backgroundColor: 'rgba(6,182,212,0.08)',
                        fill: true,
                        tension: 0.35,
                        pointRadius: 2,
                        borderWidth: 2.5,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { position: 'top', labels: { font: { size: 14 } } } },
                scales: {
                    y: {
                        position: 'left',
                        title: { display: true, text: 'Memory Cards', font: { size: 13, weight: '600' } },
                        ticks: { font: { size: 12 } },
                        grid: { color: '#f1f5f9' }
                    },
                    y1: {
                        position: 'right',
                        title: { display: true, text: 'Domain Knowledge', font: { size: 13, weight: '600' } },
                        ticks: { font: { size: 12 } },
                        grid: { drawOnChartArea: false }
                    },
                    x: {
                        ticks: { font: { size: 11 }, maxTicksLimit: 20 },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    function renderByLevelChart(data) {
        const ctx = document.getElementById('chart-by-level').getContext('2d');
        if (charts.byLevel) charts.byLevel.destroy();

        // Filter out 'unknown' level for cleaner display
        const levels = data.per_level_stats.filter(l => l.level !== 'unknown');
        const labels = levels.map(l => l.level);

        charts.byLevel = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Oggy Avg',
                        data: levels.map(l => +(parseFloat(l.avg_oggy_accuracy) * 100).toFixed(1)),
                        backgroundColor: 'rgba(99,102,241,0.75)',
                        borderRadius: 4,
                        borderWidth: 0
                    },
                    {
                        label: 'Base Avg',
                        data: levels.map(l => +(parseFloat(l.avg_base_accuracy) * 100).toFixed(1)),
                        backgroundColor: 'rgba(203,213,225,0.65)',
                        borderRadius: 4,
                        borderWidth: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'top', labels: { font: { size: 14 } } },
                    tooltip: {
                        callbacks: {
                            afterBody: function(ctx) {
                                const l = levels[ctx[0].dataIndex];
                                return `Win rate: ${(parseFloat(l.win_rate)*100).toFixed(0)}% (${l.oggy_wins}/${l.benchmarks})`;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        min: 50,
                        max: 100,
                        ticks: { callback: v => v + '%', font: { size: 13 }, stepSize: 10 },
                        title: { display: true, text: 'Avg Accuracy %', font: { size: 14, weight: '600' } },
                        grid: { color: '#f1f5f9' }
                    },
                    x: {
                        ticks: { font: { size: 14, weight: '600' } },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    function renderLevelTimeline(data) {
        const container = document.getElementById('level-timeline');
        if (!data.level_progression || data.level_progression.length === 0) {
            container.innerHTML = '<p style="color:var(--text-muted);font-size:14px">No level changes recorded.</p>';
            return;
        }

        // Filter out 'unknown' from timeline
        const progression = data.level_progression.filter(lp => lp.level !== 'unknown');

        // Append actual current level if different from last benchmark level
        const actualLevel = data.current_state.level;
        if (progression.length > 0 && progression[progression.length - 1].level !== actualLevel) {
            progression.push({
                level: actualLevel,
                started_at: new Date().toISOString(),
                benchmark_index: data.total_benchmarks
            });
        }

        const html = progression.map((lp, i) => {
            const d = new Date(lp.started_at);
            const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const isLatest = i === progression.length - 1;
            return `
                <div class="timeline-item ${isLatest ? 'timeline-current' : ''}">
                    <div class="timeline-dot"></div>
                    <div class="timeline-content">
                        <strong>${lp.level}</strong>
                        <span class="timeline-meta">#${lp.benchmark_index} &bull; ${dateStr} ${timeStr}</span>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;
    }

    // Load immediately, auto-refresh every 30s
    loadAnalytics();
    setInterval(loadAnalytics, 30000);
})();
