// Harmony Analytics — Chart.js trend visualization
let trendChart = null;

const COLORS = [
    '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
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
        renderChart(data.snapshots || [], metric);
    } catch (err) {
        showToast('Failed to load snapshots: ' + err.message, 'error');
    }
}

function renderChart(snapshots, metric) {
    // Group by node
    const byNode = {};
    for (const s of snapshots) {
        const name = s.node_name || s.node_id;
        if (!byNode[name]) byNode[name] = [];
        byNode[name].push({ date: s.snapshot_date, value: s[metric] });
    }

    const nodeNames = Object.keys(byNode).sort();
    const datasets = nodeNames.map((name, i) => {
        const sorted = byNode[name].sort((a, b) => a.date.localeCompare(b.date));
        return {
            label: name,
            data: sorted.map(p => ({ x: p.date, y: p.value != null ? (parseFloat(p.value) * 100).toFixed(1) : null })),
            borderColor: COLORS[i % COLORS.length],
            backgroundColor: COLORS[i % COLORS.length] + '20',
            tension: 0.3,
            pointRadius: 3,
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
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}%`
                    }
                }
            },
            scales: {
                x: {
                    type: 'category',
                    title: { display: true, text: 'Date' },
                    ticks: { maxTicksLimit: 15 }
                },
                y: {
                    title: { display: true, text: metricLabel + ' (%)' },
                    min: 0,
                    max: 100,
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
        // Reload chart
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

    document.getElementById('city-select').addEventListener('change', loadSnapshots);
    document.getElementById('metric-select').addEventListener('change', loadSnapshots);
    document.getElementById('days-select').addEventListener('change', loadSnapshots);
});
