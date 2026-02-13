// Harmony Map — Leaflet map with node markers, drilldown, and overlays
let map;
let markers = [];
let selectedNodeId = null;

// H-score color gradient: red (0) → yellow (0.5) → green (1)
function hScoreColor(h) {
    if (h == null) return '#94a3b8';
    const clamped = Math.max(0, Math.min(1, h));
    if (clamped < 0.5) {
        const t = clamped * 2;
        const r = 220;
        const g = Math.round(50 + t * 170);
        const b = 50;
        return `rgb(${r},${g},${b})`;
    } else {
        const t = (clamped - 0.5) * 2;
        const r = Math.round(220 - t * 180);
        const g = 200;
        const b = 50;
        return `rgb(${r},${g},${b})`;
    }
}

function initMap() {
    map = L.map('harmony-map').setView([39.8, -98.6], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 18,
    }).addTo(map);

    loadNodes();

    document.getElementById('scope-select').addEventListener('change', loadNodes);
}

async function loadNodes() {
    const scope = document.getElementById('scope-select').value;

    try {
        const data = await apiCall('GET', `/v0/harmony/nodes?scope=${scope}`);
        renderMarkers(data.nodes || []);
    } catch (err) {
        showToast('Failed to load nodes: ' + err.message, 'error');
    }
}

function renderMarkers(nodes) {
    // Clear existing markers
    markers.forEach(m => map.removeLayer(m));
    markers = [];

    for (const node of nodes) {
        if (!node.geometry) continue;
        const coords = node.geometry.coordinates;
        if (!coords || coords.length < 2) continue;

        const h = node.harmony != null ? parseFloat(node.harmony) : null;
        const color = hScoreColor(h);
        const hDisplay = h != null ? (h * 100).toFixed(0) + '%' : '—';

        const marker = L.circleMarker([coords[1], coords[0]], {
            radius: 12,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.85,
        }).addTo(map);

        marker.bindTooltip(`<strong>${node.name}</strong><br>H: ${hDisplay}`, {
            direction: 'top', offset: [0, -10],
        });

        marker.on('click', () => selectNode(node.node_id));
        markers.push(marker);
    }
}

async function selectNode(nodeId) {
    selectedNodeId = nodeId;

    try {
        const data = await apiCall('GET', `/v0/harmony/node/${nodeId}`);
        const node = data.node;
        const alerts = data.alerts || [];

        document.getElementById('node-name').textContent = node.name;
        const pop = node.population ? Number(node.population).toLocaleString() : '—';
        document.getElementById('node-meta').textContent = `${node.scope} | Pop: ${pop}`;

        // Render score cards
        const scoreFields = [
            { key: 'harmony', label: 'Harmony (H)', color: '#6366f1' },
            { key: 'e_scaled', label: 'Equilibrium (E)', color: '#8b5cf6' },
            { key: 'intent_coherence', label: 'Intent (S)', color: '#a78bfa' },
            { key: 'balance', label: 'Balance', color: '#3b82f6' },
            { key: 'flow', label: 'Flow', color: '#22c55e' },
            { key: 'care', label: 'Care (C)', color: '#ec4899' },
            { key: 'compassion', label: 'Compassion', color: '#f472b6' },
            { key: 'discernment', label: 'Discernment', color: '#f59e0b' },
        ];

        const grid = document.getElementById('score-grid');
        grid.innerHTML = scoreFields.map(sf => {
            const val = node[sf.key] != null ? parseFloat(node[sf.key]) : null;
            const display = val != null ? (val * 100).toFixed(1) + '%' : '—';
            const width = val != null ? (val * 100).toFixed(0) : 0;
            return `<div class="score-card">
                <div class="score-label">${sf.label}</div>
                <div class="score-value" style="color:${sf.color}">${display}</div>
                <div class="score-bar"><div class="score-bar-fill" style="width:${width}%;background:${sf.color}"></div></div>
            </div>`;
        }).join('');

        // Render alerts
        const alertsDiv = document.getElementById('alerts-section');
        if (alerts.length > 0) {
            alertsDiv.innerHTML = '<h3 style="font-size:14px;margin:0 0 8px">Alerts</h3>' +
                alerts.map(a => `<div class="alert-card alert-${a.severity}">${a.message}</div>`).join('');
        } else {
            alertsDiv.innerHTML = '';
        }

        // Hide explain section when switching nodes
        document.getElementById('explain-section').style.display = 'none';

        // Show panel
        document.getElementById('node-panel').classList.add('visible');
    } catch (err) {
        showToast('Failed to load node: ' + err.message, 'error');
    }
}

async function showExplainability() {
    if (!selectedNodeId) return;

    try {
        const data = await apiCall('GET', `/v0/harmony/node/${selectedNodeId}/explain`);
        const tbody = document.getElementById('indicator-tbody');

        const dimClass = { balance: 'dim-balance', flow: 'dim-flow', compassion: 'dim-compassion', discernment: 'dim-discernment', awareness: 'dim-awareness', expression: 'dim-expression' };

        tbody.innerHTML = (data.indicators || []).map(ind => {
            const norm = ind.normalized_value != null ? (ind.normalized_value * 100).toFixed(1) + '%' : '—';
            const cls = dimClass[ind.dimension] || '';
            return `<tr>
                <td title="${ind.description || ''}">${ind.name} ${ind.unit ? '<span style="color:var(--text-muted);font-size:11px">(' + ind.unit + ')</span>' : ''}</td>
                <td><span class="dim-badge ${cls}">${ind.dimension}</span></td>
                <td>${ind.raw_value}</td>
                <td>${norm}</td>
                <td>${ind.weight}</td>
            </tr>`;
        }).join('');

        document.getElementById('explain-section').style.display = 'block';
    } catch (err) {
        showToast('Failed to load explainability: ' + err.message, 'error');
    }
}

function closeNodePanel() {
    document.getElementById('node-panel').classList.remove('visible');
    selectedNodeId = null;
}

async function computeAllNodes() {
    const scope = document.getElementById('scope-select').value;
    const statusEl = document.getElementById('compute-status');
    statusEl.textContent = 'Computing...';

    try {
        const data = await apiCall('POST', '/v0/harmony/compute-all', { scope });
        statusEl.textContent = `Computed ${data.computed} nodes`;
        showToast(`Scores computed for ${data.computed} nodes`, 'success');
        // Reload markers with new scores
        await loadNodes();
    } catch (err) {
        statusEl.textContent = 'Failed';
        showToast('Computation failed: ' + err.message, 'error');
    }
}

// Init on page load
document.addEventListener('DOMContentLoaded', async () => {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('harmony', 'map');
    startInquiryPolling();
    initMap();
});
