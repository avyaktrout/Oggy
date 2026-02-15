// Harmony Map — Leaflet map with node markers, drilldown, overlays, and analytics
let map;
let markers = [];
let selectedNodeId = null;
let currentNodeData = null;   // Full node data for formulas/toggles
let currentOverlay = 'harmony';
let nodesCache = [];          // Cached node list for overlay switching

// H-score color gradient: red (0) → yellow (0.5) → green (1)
function hScoreColor(h) {
    if (h == null) return '#94a3b8';
    const clamped = Math.max(0, Math.min(1, h));
    if (clamped < 0.5) {
        const t = clamped * 2;
        return `rgb(220,${Math.round(50 + t * 170)},50)`;
    } else {
        const t = (clamped - 0.5) * 2;
        return `rgb(${Math.round(220 - t * 180)},200,50)`;
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
        nodesCache = data.nodes || [];
        renderMarkers(nodesCache);
    } catch (err) {
        showToast('Failed to load nodes: ' + err.message, 'error');
    }
}

function renderMarkers(nodes) {
    markers.forEach(m => map.removeLayer(m));
    markers = [];

    for (const node of nodes) {
        if (!node.geometry) continue;
        const coords = node.geometry.coordinates;
        if (!coords || coords.length < 2) continue;

        const color = getOverlayColor(node, currentOverlay);
        const h = node.harmony != null ? parseFloat(node.harmony) : null;
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
        marker._nodeId = node.node_id;
        markers.push(marker);
    }
}

// ──────────────────────────────────────────────────
// Overlay system
// ──────────────────────────────────────────────────
function getOverlayColor(node, overlay) {
    switch (overlay) {
        case 'crime': {
            // Lower balance = more red (balance includes crime indicators)
            const b = node.balance != null ? parseFloat(node.balance) : null;
            return hScoreColor(b);
        }
        case 'wellness': {
            // Use care score for wellness
            const c = node.care != null ? parseFloat(node.care) : null;
            return hScoreColor(c);
        }
        default: {
            const h = node.harmony != null ? parseFloat(node.harmony) : null;
            return hScoreColor(h);
        }
    }
}

function toggleOverlay(overlay) {
    currentOverlay = overlay;
    // Update button states
    document.querySelectorAll('.overlay-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.overlay === overlay);
    });
    // Re-render markers with new colors
    if (nodesCache.length > 0) renderMarkers(nodesCache);
}

// ──────────────────────────────────────────────────
// Node selection & score cards
// ──────────────────────────────────────────────────
async function selectNode(nodeId) {
    selectedNodeId = nodeId;

    try {
        const data = await apiCall('GET', `/v0/harmony/node/${nodeId}`);
        const node = data.node;
        currentNodeData = node;
        const alerts = data.alerts || [];

        document.getElementById('node-name').textContent = node.name;
        const pop = node.population ? Number(node.population).toLocaleString() : '—';
        document.getElementById('node-meta').textContent = `${node.scope} | Pop: ${pop}`;

        renderScoreCards(node, false);

        // Reset E toggle
        document.getElementById('e-toggle').checked = false;

        // Render alerts
        const alertsDiv = document.getElementById('alerts-section');
        if (alerts.length > 0) {
            alertsDiv.innerHTML = '<h3 style="font-size:14px;margin:0 0 8px">Alerts</h3>' +
                alerts.map(a => `<div class="alert-card alert-${a.severity}">${a.message}</div>`).join('');
        } else {
            alertsDiv.innerHTML = '';
        }

        // Hide explain + drivers when switching nodes
        document.getElementById('explain-section').style.display = 'none';
        document.getElementById('drivers-section').style.display = 'none';

        // Load freshness badge
        loadFreshness(nodeId);

        // Show panel
        document.getElementById('node-panel').classList.add('visible');
    } catch (err) {
        showToast('Failed to load node: ' + err.message, 'error');
    }
}

function renderScoreCards(node, showRawE) {
    // Compute H_raw = sqrt(E_raw * S) when toggle is on
    let hRaw = null;
    if (showRawE && node.e_raw != null && node.intent_coherence != null) {
        hRaw = Math.sqrt(parseFloat(node.e_raw) * parseFloat(node.intent_coherence));
    }

    const scoreFields = [
        { key: showRawE ? '_h_raw' : 'harmony', label: showRawE ? 'Harmony (H raw)' : 'Harmony (H)', color: '#6366f1' },
        { key: showRawE ? 'e_raw' : 'e_scaled', label: showRawE ? 'Equilibrium (E raw)' : 'Equilibrium (E)', color: '#8b5cf6' },
        { key: 'intent_coherence', label: 'Intent (S)', color: '#a78bfa' },
        { key: 'awareness', label: 'Awareness (A)', color: '#818cf8' },
        { key: 'expression', label: 'Expression (X)', color: '#7c3aed' },
        { key: 'balance', label: 'Balance (B)', color: '#3b82f6' },
        { key: 'flow', label: 'Flow (F)', color: '#22c55e' },
        { key: 'care', label: 'Care (C)', color: '#ec4899' },
        { key: 'compassion', label: 'Compassion', color: '#f472b6' },
        { key: 'discernment', label: 'Discernment', color: '#f59e0b' },
    ];

    const grid = document.getElementById('score-grid');
    grid.innerHTML = scoreFields.map(sf => {
        let val;
        if (sf.key === '_h_raw') {
            val = hRaw;
        } else {
            val = node[sf.key] != null ? parseFloat(node[sf.key]) : null;
        }
        const display = val != null ? (val * 100).toFixed(1) + '%' : '—';
        const width = val != null ? Math.min(100, val * 100).toFixed(0) : 0;
        return `<div class="score-card">
            <div class="score-label">${sf.label}</div>
            <div class="score-value" style="color:${sf.color}">${display}</div>
            <div class="score-bar"><div class="score-bar-fill" style="width:${width}%;background:${sf.color}"></div></div>
        </div>`;
    }).join('');
}

function toggleERaw(showRaw) {
    if (currentNodeData) renderScoreCards(currentNodeData, showRaw);
}

// ──────────────────────────────────────────────────
// Freshness badge
// ──────────────────────────────────────────────────
async function loadFreshness(nodeId) {
    try {
        const data = await apiCall('GET', `/v0/harmony/node/${nodeId}/freshness`);
        const badge = document.getElementById('freshness-badge');
        const gradeClass = `freshness-${data.grade}`;
        const daysText = data.days_since_update != null ? `${data.days_since_update}d ago` : 'no data';
        badge.innerHTML = `<span class="freshness-badge ${gradeClass}">${data.grade} &middot; ${data.coverage_pct}% coverage &middot; ${daysText}</span>`;
    } catch (err) {
        document.getElementById('freshness-badge').innerHTML = '';
    }
}

// ──────────────────────────────────────────────────
// Explainability + Drivers/Drags
// ──────────────────────────────────────────────────
async function showExplainability() {
    if (!selectedNodeId) return;

    try {
        // Load indicators and drivers in parallel
        const [explainData, driversData] = await Promise.all([
            apiCall('GET', `/v0/harmony/node/${selectedNodeId}/explain`),
            apiCall('GET', `/v0/harmony/node/${selectedNodeId}/drivers`),
        ]);

        renderIndicatorTable(explainData.indicators || []);
        renderDrivers(driversData);

        document.getElementById('explain-section').style.display = 'block';
        document.getElementById('drivers-section').style.display = 'grid';
        document.getElementById('dim-filter').value = 'all';
    } catch (err) {
        showToast('Failed to load explainability: ' + err.message, 'error');
    }
}

function renderIndicatorTable(indicators) {
    const dimClass = { balance: 'dim-balance', flow: 'dim-flow', compassion: 'dim-compassion', discernment: 'dim-discernment', awareness: 'dim-awareness', expression: 'dim-expression' };
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const tbody = document.getElementById('indicator-tbody');
    tbody.innerHTML = indicators.map(ind => {
        const norm = ind.normalized_value != null ? (ind.normalized_value * 100).toFixed(1) + '%' : '—';
        const cls = dimClass[ind.dimension] || '';
        const dirIcon = ind.direction === 'lower_is_better' ? '<span class="dir-icon" title="Lower is better">&#8595;</span>' : '<span class="dir-icon" title="Higher is better">&#8593;</span>';
        const isNew = ind.created_at && new Date(ind.created_at) > sevenDaysAgo;
        const newBadge = isNew ? ' <span class="new-badge">NEW</span>' : '';
        return `<tr data-key="${ind.key}" data-dimension="${ind.dimension}">
            <td title="${ind.description || ''}">${ind.name}${newBadge} ${ind.unit ? '<span style="color:var(--text-muted);font-size:11px">(' + ind.unit + ')</span>' : ''}</td>
            <td><span class="dim-badge ${cls}">${ind.dimension}</span></td>
            <td>${dirIcon}</td>
            <td>${ind.raw_value}</td>
            <td>${norm}</td>
            <td>${ind.weight}</td>
        </tr>`;
    }).join('');
}

function renderDrivers(data) {
    const section = document.getElementById('drivers-section');
    const drivers = data.drivers || [];
    const drags = data.drags || [];

    section.innerHTML = `
        <div class="driver-list">
            <h4>Top Drivers</h4>
            ${drivers.map(d => `<div class="driver-item positive" onclick="scrollToIndicator('${d.key}')">
                <span>${d.name}</span>
                <span style="color:#22c55e;font-weight:600">${(d.normalized_value * 100).toFixed(0)}%</span>
            </div>`).join('')}
        </div>
        <div class="driver-list">
            <h4>Top Drags</h4>
            ${drags.map(d => `<div class="driver-item negative" onclick="scrollToIndicator('${d.key}')">
                <span>${d.name}</span>
                <span style="color:#ef4444;font-weight:600">${(d.normalized_value * 100).toFixed(0)}%</span>
            </div>`).join('')}
        </div>
    `;
}

function scrollToIndicator(key) {
    const row = document.querySelector(`#indicator-tbody tr[data-key="${key}"]`);
    if (!row) return;

    // Make sure explain section is visible
    document.getElementById('explain-section').style.display = 'block';
    // Clear filter to show all
    document.getElementById('dim-filter').value = 'all';
    filterIndicatorTable('all');

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('highlight');
    setTimeout(() => row.classList.remove('highlight'), 2000);
}

function filterIndicatorTable(dimension) {
    const rows = document.querySelectorAll('#indicator-tbody tr');
    rows.forEach(row => {
        if (dimension === 'all' || row.dataset.dimension === dimension) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// ──────────────────────────────────────────────────
// Formulas modal
// ──────────────────────────────────────────────────
function showFormulas() {
    if (!currentNodeData) return;
    const n = currentNodeData;

    const fmt = v => v != null ? (parseFloat(v) * 100).toFixed(1) + '%' : '—';
    const raw = v => v != null ? parseFloat(v).toFixed(4) : '—';

    const B = raw(n.balance);
    const F = raw(n.flow);
    const comp = raw(n.compassion);
    const disc = raw(n.discernment);
    const C = raw(n.care);
    const eRaw = raw(n.e_raw);
    const eScaled = raw(n.e_scaled);
    const A = raw(n.awareness);
    const X = raw(n.expression);
    const S = raw(n.intent_coherence);
    const H = raw(n.harmony);

    document.getElementById('formulas-body').innerHTML = `
        <div class="formula-row">
            <span class="formula-label">B (Balance)</span> = weighted_mean(safety, economic indicators)<br>
            <span class="formula-val">= ${B} (${fmt(n.balance)})</span>
        </div>
        <div class="formula-row">
            <span class="formula-label">F (Flow)</span> = weighted_mean(mobility, access indicators)<br>
            <span class="formula-val">= ${F} (${fmt(n.flow)})</span>
        </div>
        <div class="formula-row">
            <span class="formula-label">Compassion</span> = weighted_mean(health, housing, food indicators)<br>
            <span class="formula-val">= ${comp} (${fmt(n.compassion)})</span>
        </div>
        <div class="formula-row">
            <span class="formula-label">Discernment</span> = weighted_mean(education, civic indicators)<br>
            <span class="formula-val">= ${disc} (${fmt(n.discernment)})</span>
        </div>
        <div class="formula-row">
            <span class="formula-label">C (Care)</span> = Compassion &times; Discernment<br>
            <span class="formula-val">= ${comp} &times; ${disc} = ${C} (${fmt(n.care)})</span>
        </div>
        <div class="formula-row">
            <span class="formula-label">E<sub>raw</sub></span> = (B &times; F) &times; C<br>
            <span class="formula-val">= (${B} &times; ${F}) &times; ${C} = ${eRaw}</span>
        </div>
        <div class="formula-row">
            <span class="formula-label">E<sub>scaled</sub></span> = (B &times; F &times; C)<sup>1/3</sup><br>
            <span class="formula-val">= (${B} &times; ${F} &times; ${C})<sup>1/3</sup> = ${eScaled} (${fmt(n.e_scaled)})</span>
        </div>
        <div class="formula-row">
            <span class="formula-label">A (Awareness)</span> = weighted_mean(education, civic engagement)<br>
            <span class="formula-val">= ${A} (${fmt(n.awareness)})</span>
        </div>
        <div class="formula-row">
            <span class="formula-label">X (Expression)</span> = weighted_mean(arts, protest freedom)<br>
            <span class="formula-val">= ${X} (${fmt(n.expression)})</span>
        </div>
        <div class="formula-row">
            <span class="formula-label">S (Intent Coherence)</span> = &radic;(A &times; X)<br>
            <span class="formula-val">= &radic;(${A} &times; ${X}) = ${S} (${fmt(n.intent_coherence)})</span>
        </div>
        <div class="formula-row" style="padding-top:12px">
            <span class="formula-label" style="font-size:15px">H (Harmony)</span> = &radic;(E<sub>scaled</sub> &times; S)<br>
            <span class="formula-val">= &radic;(${eScaled} &times; ${S}) = ${H} (${fmt(n.harmony)})</span>
        </div>
        <div class="formula-row" style="border-bottom:none">
            <span class="formula-label" style="font-size:15px">H<sub>raw</sub></span> = &radic;(E<sub>raw</sub> &times; S)<br>
            <span class="formula-val">= &radic;(${eRaw} &times; ${S}) = ${n.e_raw != null && n.intent_coherence != null ? Math.sqrt(parseFloat(n.e_raw) * parseFloat(n.intent_coherence)).toFixed(4) : '—'}</span>
        </div>
    `;

    document.getElementById('formulas-modal').classList.add('visible');
}

// ──────────────────────────────────────────────────
// Compute all with progress states
// ──────────────────────────────────────────────────
async function computeAllNodes() {
    const scope = document.getElementById('scope-select').value;
    const statusEl = document.getElementById('compute-status');
    const btn = document.getElementById('btn-compute-all');

    btn.disabled = true;
    statusEl.textContent = 'Queued...';

    try {
        statusEl.textContent = 'Computing scores...';
        const data = await apiCall('POST', '/v0/harmony/compute-all', { scope });
        statusEl.textContent = `Done — ${data.computed} nodes computed`;
        showToast(`Scores computed for ${data.computed} nodes`, 'success');
        await loadNodes();
    } catch (err) {
        statusEl.textContent = 'Failed';
        showToast('Computation failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

function closeNodePanel() {
    document.getElementById('node-panel').classList.remove('visible');
    selectedNodeId = null;
    currentNodeData = null;
}

// ──────────────────────────────────────────────────
// Observer — Share & Receive Harmony Map Packs
// ──────────────────────────────────────────────────

async function loadObserverConfig() {
    try {
        const data = await apiCall('GET', '/v0/harmony/observer/config');
        const config = data.config || {};
        document.getElementById('obs-receive').checked = !!config.receive_harmony_packs;
        updateObserverDot(config);
        if (config.receive_harmony_packs) {
            document.getElementById('observer-packs-section').style.display = 'block';
            loadObserverPacks();
        }
    } catch (_) {
        updateObserverDot({});
    }
}

function updateObserverDot(config) {
    const dot = document.getElementById('observer-dot');
    if (!dot) return;
    if (config.share_changes || config.receive_harmony_packs) {
        dot.style.background = '#22c55e';
    } else {
        dot.style.background = '#94a3b8';
    }
}

async function shareHarmonyMap() {
    const statusEl = document.getElementById('share-status');
    statusEl.textContent = 'Sharing...';
    try {
        // Enable share_changes config
        await apiCall('PUT', '/v0/harmony/observer/config', { share_changes: true });
        // Export current map snapshot (this stores the map state)
        await apiCall('POST', '/v0/harmony/observer/export-map', {});
        // Trigger observer job to process shared maps into packs
        try {
            await apiCall('POST', '/v0/harmony/observer/run-job', {});
        } catch (_) { /* job may fail if cooldown — that's ok */ }
        statusEl.textContent = 'Map shared!';
        updateObserverDot({ share_changes: true, receive_harmony_packs: document.getElementById('obs-receive').checked });
        showToast('Harmony Map shared with Observer', 'success');
        setTimeout(() => { statusEl.textContent = ''; }, 5000);
    } catch (err) {
        statusEl.textContent = 'Failed';
        showToast('Failed to share map: ' + err.message, 'error');
    }
}

async function updateObserverReceive() {
    const receive = document.getElementById('obs-receive').checked;
    try {
        await apiCall('PUT', '/v0/harmony/observer/config', { receive_harmony_packs: receive });
        updateObserverDot({ receive_harmony_packs: receive });
        if (receive) {
            document.getElementById('observer-packs-section').style.display = 'block';
            // Trigger observer job to generate packs from shared maps
            try {
                await apiCall('POST', '/v0/harmony/observer/run-job', {});
            } catch (_) {}
            loadObserverPacks();
        } else {
            document.getElementById('observer-packs-section').style.display = 'none';
        }
    } catch (err) {
        showToast('Failed to update observer: ' + err.message, 'error');
    }
}

async function loadObserverPacks() {
    const container = document.getElementById('observer-packs');
    if (!container) return;
    try {
        const data = await apiCall('GET', '/v0/harmony/observer/packs');
        const packs = data.packs || [];
        if (packs.length === 0) {
            container.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No packs available</div>';
            return;
        }
        const typeLabels = { new_city: 'New Cities', new_indicator: 'New Indicators', new_data_point: 'New Data Points', weight_adjustment: 'Weight Adjustments' };
        container.innerHTML = packs.map(p => {
            const changeCount = Array.isArray(p.changes) ? p.changes.length : 0;
            const impactColor = p.impact_level === 'high' ? '#ef4444' : p.impact_level === 'medium' ? '#f59e0b' : '#22c55e';
            const isApplied = p.status === 'applied';
            const applyBtn = '<button onclick="applyPack(\'' + p.pack_id + '\')" style="padding:6px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;border:none;background:#22c55e;color:#fff">Apply Pack</button>';
            const rollbackBtn = '<button onclick="rollbackPack(\'' + p.pack_id + '\')" style="padding:6px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;border:1px solid #ef4444;background:#fff;color:#ef4444">Rollback</button>';
            const statusLabel = isApplied
                ? '<span style="font-size:11px;font-weight:600;color:#22c55e">Applied</span>'
                : '<span style="font-size:11px;font-weight:600;color:#6366f1">Available</span>';
            const actions = isApplied ? rollbackBtn : applyBtn;
            // Group changes by type for breakdown
            const grouped = (p.changes || []).reduce((acc, c) => { (acc[c.type] = acc[c.type] || []).push(c); return acc; }, {});
            const detailsHtml = Object.entries(grouped).map(([type, items]) => {
                const label = typeLabels[type] || type;
                const list = items.map(i => '<li style="margin:2px 0">' + (i.title || i.description || type) + '</li>').join('');
                return '<div style="margin-top:6px"><span style="font-weight:600;font-size:11px;color:var(--text)">' + label + ' (' + items.length + ')</span>' +
                    '<ul style="margin:2px 0 0 16px;padding:0;font-size:11px;color:var(--text-muted);list-style:disc">' + list + '</ul></div>';
            }).join('');
            return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin:6px 0;font-size:12px">' +
                '<div style="display:flex;justify-content:space-between;align-items:center">' +
                    '<div><div style="font-weight:600;font-size:13px">' + (p.name || 'Pack') + '</div>' +
                    '<div style="color:var(--text-muted);font-size:11px;margin-top:2px">v' + p.version + ' &middot; ' + changeCount + ' changes &middot; <span style="color:' + impactColor + '">' + (p.impact_level || 'low') + ' impact</span></div></div>' +
                    statusLabel +
                '</div>' +
                (changeCount > 0 ? '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11px;color:var(--text-muted)">Show changes (' + changeCount + ')</summary>' + detailsHtml + '</details>' : '') +
                '<div style="margin-top:8px">' + actions + '</div>' +
            '</div>';
        }).join('');
    } catch (_) {
        container.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Failed to load packs</div>';
    }
}

async function applyPack(packId) {
    try {
        const result = await apiCall('POST', '/v0/harmony/observer/import-pack', { pack_id: packId });
        showToast('Pack applied: ' + (result.changes_applied || 0) + ' changes', 'success');
        loadObserverPacks();
        // Reload map to reflect new cities/indicators
        loadNodes();
    } catch (err) {
        showToast('Failed to apply pack: ' + err.message, 'error');
    }
}

async function rollbackPack(packId) {
    try {
        await apiCall('POST', '/v0/harmony/observer/rollback-pack', { pack_id: packId });
        showToast('Pack rolled back', 'success');
        loadObserverPacks();
        loadNodes();
    } catch (err) {
        showToast('Failed to rollback: ' + err.message, 'error');
    }
}

// ──────────────────────────────────────────────────
// Init on page load
// ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('harmony', 'map');
    startInquiryPolling();
    initMap();
    loadObserverConfig();
});
