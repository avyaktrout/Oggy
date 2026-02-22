// Harmony Analytics — Chart.js trend visualization
let trendChart = null;

// 20 distinct colors for cities
const COLORS = [
    '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
    '#a855f7', '#f43f5e', '#0ea5e9', '#d946ef', '#10b981',
    '#e11d48', '#7c3aed', '#0891b2', '#ca8a04', '#64748b',
];

async function loadCities() {
    try {
        const data = await apiCall('GET', '/v0/harmony/nodes?scope=city');
        const select = document.getElementById('city-select');
        (data.nodes || []).forEach(n => {
            const opt = document.createElement('option');
            opt.value = n.node_id;
            opt.textContent = n.name;
            select.appendChild(opt);
        });
    } catch (err) {
        showToast('Failed to load cities: ' + err.message, 'error');
    }
}

async function loadSnapshots() {
    const nodeId = document.getElementById('city-select').value;
    const days = document.getElementById('days-select').value;
    const metric = document.getElementById('metric-select').value;

    try {
        let url = `/v0/harmony/analytics/snapshots?days=${days}`;
        if (nodeId) url += `&node_id=${nodeId}`;

        const data = await apiCall('GET', url);
        const snapshots = data.snapshots || [];
        renderChart(snapshots, metric);
        updateStats(snapshots, metric);
        updateRankings(snapshots, metric);
    } catch (err) {
        showToast('Failed to load snapshots: ' + err.message, 'error');
    }
}

function updateStats(snapshots, metric) {
    if (!snapshots.length) return;

    // Get latest snapshot per city
    const latestByCity = {};
    for (const s of snapshots) {
        const name = s.node_name || s.node_id;
        if (!latestByCity[name] || s.snapshot_date > latestByCity[name].snapshot_date) {
            latestByCity[name] = s;
        }
    }

    const cities = Object.keys(latestByCity);
    const values = cities.map(c => ({ name: c, value: parseFloat(latestByCity[c][metric] || 0) * 100 }));
    values.sort((a, b) => b.value - a.value);

    const avg = values.reduce((s, v) => s + v.value, 0) / values.length;
    const top = values[0];
    const bottom = values[values.length - 1];

    // Unique dates
    const dates = [...new Set(snapshots.map(s => s.snapshot_date))].sort();

    document.getElementById('stat-cities').textContent = cities.length;
    document.getElementById('stat-avg').textContent = avg.toFixed(1) + '%';
    document.getElementById('stat-top').textContent = top.value.toFixed(1) + '%';
    document.getElementById('stat-top-name').textContent = top.name;
    document.getElementById('stat-bottom').textContent = bottom.value.toFixed(1) + '%';
    document.getElementById('stat-bottom-name').textContent = bottom.name;
    document.getElementById('stat-snapshots').textContent = dates.length;

    if (dates.length >= 2) {
        const first = new Date(dates[0]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const last = new Date(dates[dates.length - 1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        document.getElementById('stat-snap-range').textContent = `${first} - ${last}`;
    }
}

function updateRankings(snapshots, metric) {
    const latestByCity = {};
    for (const s of snapshots) {
        const name = s.node_name || s.node_id;
        if (!latestByCity[name] || s.snapshot_date > latestByCity[name].snapshot_date) {
            latestByCity[name] = s;
        }
    }

    const values = Object.keys(latestByCity).map(c => ({
        name: c, value: parseFloat(latestByCity[c][metric] || 0) * 100
    }));
    values.sort((a, b) => b.value - a.value);

    if (values.length < 2) {
        document.getElementById('rankings-row').style.display = 'none';
        return;
    }

    document.getElementById('rankings-row').style.display = 'grid';
    const top5 = values.slice(0, 5);
    const bottom5 = values.slice(-5).reverse();

    const renderRanking = (items, startRank) => items.map((item, i) => {
        const pct = item.value;
        const color = pct >= 60 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#ef4444';
        return `<div class="ranking-item">
            <span class="ranking-rank">${startRank + i}</span>
            <span class="ranking-name">${item.name}</span>
            <span class="ranking-value" style="color:${color}">${pct.toFixed(1)}%</span>
        </div>`;
    }).join('');

    document.getElementById('top-rankings').innerHTML = renderRanking(top5, 1);
    document.getElementById('bottom-rankings').innerHTML = renderRanking(bottom5, values.length - 4);
}

function renderChart(snapshots, metric) {
    // Group by node
    const byNode = {};
    for (const s of snapshots) {
        const name = s.node_name || s.node_id;
        if (!byNode[name]) byNode[name] = [];
        const d = new Date(s.snapshot_date);
        const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        byNode[name].push({ date: s.snapshot_date, dateLabel: dateStr, value: s[metric] });
    }

    const nodeNames = Object.keys(byNode).sort();
    const datasets = nodeNames.map((name, i) => {
        const sorted = byNode[name].sort((a, b) => a.date.localeCompare(b.date));
        return {
            label: name,
            data: sorted.map(p => ({ x: p.dateLabel, y: p.value != null ? (parseFloat(p.value) * 100).toFixed(1) : null })),
            borderColor: COLORS[i % COLORS.length],
            backgroundColor: COLORS[i % COLORS.length] + '20',
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 6,
            fill: false,
        };
    });

    // Render legend
    const legendEl = document.getElementById('chart-legend');
    legendEl.innerHTML = nodeNames.map((name, i) =>
        `<div class="legend-item"><div class="legend-dot" style="background:${COLORS[i % COLORS.length]}"></div>${name}</div>`
    ).join('');

    if (trendChart) trendChart.destroy();

    const metricLabel = document.getElementById('metric-select').selectedOptions[0].textContent;
    const ctx = document.getElementById('trend-chart').getContext('2d');
    trendChart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    titleFont: { size: 13 },
                    bodyFont: { size: 12 },
                    padding: 10,
                    cornerRadius: 6,
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}%`
                    }
                }
            },
            scales: {
                x: {
                    type: 'category',
                    title: { display: true, text: 'Date', font: { size: 12 } },
                    ticks: { maxTicksLimit: 15, font: { size: 11 } },
                    grid: { color: 'rgba(0,0,0,0.05)' }
                },
                y: {
                    title: { display: true, text: metricLabel + ' (%)', font: { size: 12 } },
                    min: 0,
                    max: 100,
                    ticks: { font: { size: 11 }, stepSize: 10 },
                    grid: { color: 'rgba(0,0,0,0.05)' }
                }
            }
        }
    });
}

async function snapshotNow() {
    const statusEl = document.getElementById('snapshot-status');
    statusEl.textContent = 'Taking snapshot...';

    try {
        const data = await apiCall('POST', '/v0/harmony/analytics/snapshot-now', { scope: 'city' });
        statusEl.textContent = `Snapshot saved (${data.snapshots} cities)`;
        showToast(`Snapshot captured for ${data.snapshots} cities`, 'success');
        await loadSnapshots();
    } catch (err) {
        statusEl.textContent = 'Failed';
        showToast('Snapshot failed: ' + err.message, 'error');
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', async () => {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('harmony', 'analytics');
    startInquiryPolling();

    await loadCities();
    await loadSnapshots();
    loadHarmonyBenchmarks();

    document.getElementById('city-select').addEventListener('change', loadSnapshots);
    document.getElementById('metric-select').addEventListener('change', loadSnapshots);
    document.getElementById('days-select').addEventListener('change', loadSnapshots);
});

async function loadHarmonyBenchmarks() {
    const section = document.getElementById('harmony-training-section');
    if (!section) return;
    try {
        const data = await apiCall('GET', '/v0/benchmark-analytics?domain=harmony&limit=15');
        if (!data.total_benchmarks) {
            section.innerHTML = '<h2 style="font-size:18px;font-weight:600;margin-bottom:12px">Training Performance</h2>' +
                '<div class="chart-container" style="text-align:center;color:var(--text-muted);padding:20px">No training data yet. Start training from the Chat page.</div>';
            return;
        }
        document.getElementById('harmony-level').textContent = data.current_state.level || '-';
        document.getElementById('harmony-winrate').textContent = (parseFloat(data.summary.win_rate) * 100).toFixed(0) + '%';
        document.getElementById('harmony-oggy-acc').textContent = (parseFloat(data.summary.avg_oggy_accuracy) * 100).toFixed(1) + '%';

        const ts = data.time_series;
        const ctx = document.getElementById('harmony-accuracy-chart');
        if (ctx && ts.length > 0) {
            new Chart(ctx, {
                type: 'line',
                data: {
                    labels: ts.map(r => '#' + r.index),
                    datasets: [
                        { label: 'Oggy', data: ts.map(r => +(r.oggy_accuracy * 100).toFixed(1)), borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)', fill: true, tension: 0.35, pointRadius: 3, borderWidth: 2.5 },
                        { label: 'Base', data: ts.map(r => +(r.base_accuracy * 100).toFixed(1)), borderColor: '#cbd5e1', backgroundColor: 'rgba(203,213,225,0.08)', fill: true, tension: 0.35, pointRadius: 3, borderWidth: 2.5, borderDash: [6, 4] }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { position: 'top' } },
                    scales: {
                        y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, grid: { color: '#f1f5f9' } },
                        x: { grid: { display: false } }
                    }
                }
            });
        }
    } catch (err) {
        console.error('Failed to load harmony benchmarks', err);
    }
}
