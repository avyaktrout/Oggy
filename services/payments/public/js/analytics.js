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
    let currentRange = 15;

    window.setRange = function(range) {
        currentRange = range;
        // Update active button
        document.querySelectorAll('.range-btn').forEach(btn => {
            btn.classList.remove('range-btn-active');
            const btnRange = btn.textContent === 'All' ? 0 : parseInt(btn.textContent.replace('Last ', ''));
            if (btnRange === range) btn.classList.add('range-btn-active');
        });
        loadAnalytics();
    };

    window.loadAnalytics = async function() {
        try {
            const limit = currentRange || 200;
            const [data, weaknessData] = await Promise.all([
                apiCall('GET', `/v0/benchmark-analytics?limit=${limit}`),
                apiCall('GET', `/v0/benchmark-analytics/weakness-data?limit=${limit}`)
            ]);

            if (!data.total_benchmarks) {
                document.getElementById('total-benchmarks').textContent = '0';
                return;
            }
            renderSummaryCards(data);
            renderWeaknessChart(weaknessData);
            renderConfusionChart(weaknessData);
            renderAccuracyChart(data);
            renderWinLossChart(data);
            renderAdvantageChart(data);
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

    function renderWeaknessChart(data) {
        const el = document.getElementById('chart-weakness');
        if (!el) return;
        const ctx = el.getContext('2d');
        if (charts.weakness) charts.weakness.destroy();

        if (!data.categoryAccuracy || data.categoryAccuracy.length === 0) {
            charts.weakness = null;
            ctx.font = '14px sans-serif';
            ctx.fillStyle = '#64748b';
            ctx.textAlign = 'center';
            ctx.fillText('No category data available', ctx.canvas.width / 2, ctx.canvas.height / 2);
            return;
        }

        const categories = data.categoryAccuracy;
        const labels = categories.map(c => c.category);
        const accuracies = categories.map(c => parseFloat(c.accuracy));
        const barColors = accuracies.map(acc =>
            acc < 60 ? 'rgba(239,68,68,0.75)' :
            acc < 80 ? 'rgba(245,158,11,0.75)' :
            'rgba(34,197,94,0.75)'
        );

        charts.weakness = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Accuracy %',
                    data: accuracies,
                    backgroundColor: barColors,
                    borderRadius: 4,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                const cat = categories[ctx.dataIndex];
                                return ` ${cat.accuracy}% (${cat.correct}/${cat.total})`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        min: 0,
                        max: 100,
                        ticks: { callback: v => v + '%', font: { size: 12 } },
                        grid: { color: '#f1f5f9' }
                    },
                    y: {
                        ticks: { font: { size: 13, weight: '500' } },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    function renderConfusionChart(data) {
        const el = document.getElementById('chart-confusion');
        if (!el) return;
        const ctx = el.getContext('2d');
        if (charts.confusion) charts.confusion.destroy();

        if (!data.confusionPairs || data.confusionPairs.length === 0) {
            charts.confusion = null;
            ctx.font = '14px sans-serif';
            ctx.fillStyle = '#64748b';
            ctx.textAlign = 'center';
            ctx.fillText('No confusion pairs detected', ctx.canvas.width / 2, ctx.canvas.height / 2);
            return;
        }

        const pairs = data.confusionPairs.slice(0, 8);
        const labels = pairs.map(p => p.pair.replace('->', ' \u2192 '));
        const counts = pairs.map(p => p.count);

        charts.confusion = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Confusion Count',
                    data: counts,
                    backgroundColor: 'rgba(239,68,68,0.6)',
                    borderRadius: 4,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                return ` Confused ${ctx.parsed.x} times`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { font: { size: 12 }, stepSize: 1 },
                        grid: { color: '#f1f5f9' },
                        title: { display: true, text: 'Times Confused', font: { size: 12, weight: '600' } }
                    },
                    y: {
                        ticks: { font: { size: 12, weight: '500' } },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    function renderAccuracyChart(data) {
        const el = document.getElementById('chart-accuracy');
        if (!el) return;
        const ctx = el.getContext('2d');
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
        const el = document.getElementById('chart-winloss');
        if (!el) return;
        const ctx = el.getContext('2d');
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
        const el = document.getElementById('chart-advantage');
        if (!el) return;
        const ctx = el.getContext('2d');
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

    function renderByLevelChart(data) {
        const el = document.getElementById('chart-by-level');
        if (!el) return;
        const ctx = el.getContext('2d');
        if (charts.byLevel) charts.byLevel.destroy();

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

        const progression = data.level_progression.filter(lp => lp.level !== 'unknown');

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
