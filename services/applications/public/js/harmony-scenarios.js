// Harmony Scenarios — create, compare, and manage what-if scenarios
let indicators = [];
let currentNodeIndicators = {};

const DIMENSION_LABELS = {
    balance: 'Balance',
    flow: 'Flow',
    compassion: 'Compassion',
    discernment: 'Discernment',
    awareness: 'Awareness',
    expression: 'Expression',
};

const DIMENSION_COLORS = {
    balance: '#3b82f6',
    flow: '#22c55e',
    compassion: '#ec4899',
    discernment: '#f59e0b',
    awareness: '#8b5cf6',
    expression: '#6366f1',
};

async function loadNodes() {
    try {
        const data = await apiCall('GET', '/v0/harmony/nodes?scope=city');
        const select = document.getElementById('scenario-node');
        select.innerHTML = '<option value="">Select a city...</option>';
        for (const node of data.nodes || []) {
            const opt = document.createElement('option');
            opt.value = node.node_id;
            opt.textContent = node.name;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => loadNodeIndicators(select.value));
    } catch (err) {
        showToast('Failed to load nodes: ' + err.message, 'error');
    }
}

async function loadNodeIndicators(nodeId) {
    const grid = document.getElementById('adj-grid');
    if (!nodeId) {
        grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Select a city first</div>';
        updateAdjustmentPreview();
        return;
    }

    try {
        const data = await apiCall('GET', `/v0/harmony/node/${nodeId}/explain`);
        indicators = data.indicators || [];
        currentNodeIndicators = {};

        // Group indicators by dimension
        const grouped = {};
        for (const ind of indicators) {
            currentNodeIndicators[ind.key] = ind.raw_value;
            if (!grouped[ind.dimension]) grouped[ind.dimension] = [];
            grouped[ind.dimension].push(ind);
        }

        // Render grouped by dimension with headers
        const dimOrder = ['balance', 'flow', 'compassion', 'discernment', 'awareness', 'expression'];
        let html = '';
        for (const dim of dimOrder) {
            const items = grouped[dim];
            if (!items || !items.length) continue;
            const color = DIMENSION_COLORS[dim] || 'var(--text-muted)';
            const label = DIMENSION_LABELS[dim] || dim;
            html += `<div class="dim-section">
                <div class="dim-header" style="border-left:3px solid ${color};padding-left:8px;margin-bottom:6px;font-size:12px;font-weight:700;text-transform:uppercase;color:${color}">${label}</div>`;
            for (const ind of items) {
                html += `<div class="adj-item">
                    <label title="${esc(ind.description || '')}">${esc(ind.name)} <span style="color:var(--text-muted)">(${ind.raw_value}${ind.unit ? ' ' + ind.unit : ''})</span></label>
                    <input type="number" step="any" id="adj-${ind.key}" placeholder="${ind.raw_value}" oninput="updateAdjustmentPreview()">
                </div>`;
            }
            html += '</div>';
        }
        grid.innerHTML = html;
        updateAdjustmentPreview();
    } catch (err) {
        grid.innerHTML = '<div style="color:var(--text-muted)">Failed to load indicators</div>';
    }
}

// Show a live preview of which indicators will be adjusted
function updateAdjustmentPreview() {
    const preview = document.getElementById('adjustment-preview');
    if (!preview) return;

    const adjustments = collectAdjustments();
    const keys = Object.keys(adjustments);

    if (keys.length === 0) {
        preview.innerHTML = '<span style="color:var(--text-muted);font-size:12px">No adjustments yet. Type new values into the indicator fields above.</span>';
        return;
    }

    const items = keys.map(key => {
        const ind = indicators.find(i => i.key === key);
        const name = ind ? ind.name : key;
        const original = ind ? ind.raw_value : '?';
        const adjusted = adjustments[key];
        const delta = adjusted - original;
        const sign = delta > 0 ? '+' : '';
        const color = DIMENSION_COLORS[ind?.dimension] || 'var(--text-muted)';
        return `<span style="display:inline-block;background:var(--surface);border:1px solid var(--border);border-left:3px solid ${color};border-radius:4px;padding:3px 8px;margin:2px;font-size:12px">
            <strong>${esc(name)}</strong>: ${original} → <strong>${adjusted}</strong> <span style="color:${delta > 0 ? '#16a34a' : delta < 0 ? '#dc2626' : 'var(--text-muted)'}">(${sign}${delta.toFixed(2)})</span>
        </span>`;
    });

    preview.innerHTML = `<div style="font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text)">${keys.length} adjustment${keys.length > 1 ? 's' : ''} queued:</div>` + items.join('');
}

// Collect adjustments from the form
function collectAdjustments() {
    const adjustments = {};
    for (const ind of indicators) {
        const input = document.getElementById(`adj-${ind.key}`);
        if (input && input.value !== '') {
            const val = parseFloat(input.value);
            if (!isNaN(val)) {
                adjustments[ind.key] = val;
            }
        }
    }
    return adjustments;
}

async function createScenario() {
    const name = document.getElementById('scenario-name').value.trim();
    const nodeId = document.getElementById('scenario-node').value;
    const desc = document.getElementById('scenario-desc').value.trim();

    if (!name || !nodeId) {
        showToast('Please enter a name and select a city', 'error');
        return;
    }

    const adjustments = collectAdjustments();

    if (Object.keys(adjustments).length === 0) {
        showToast('Adjust at least one indicator — type a new value into any indicator field', 'error');
        return;
    }

    // Log for debugging
    console.log('Creating scenario with adjustments:', JSON.stringify(adjustments, null, 2));

    try {
        await apiCall('POST', '/v0/harmony/scenario', {
            name, description: desc, baseNodeId: nodeId, adjustments,
        });
        showToast(`Scenario created with ${Object.keys(adjustments).length} adjustments`, 'success');

        // Clear ALL form inputs
        document.getElementById('scenario-name').value = '';
        document.getElementById('scenario-desc').value = '';
        for (const ind of indicators) {
            const input = document.getElementById(`adj-${ind.key}`);
            if (input) input.value = '';
        }
        updateAdjustmentPreview();

        loadScenarios();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function loadScenarios() {
    const container = document.getElementById('scenarios-container');
    try {
        const data = await apiCall('GET', '/v0/harmony/scenarios');
        const scenarios = data.scenarios || [];

        if (!scenarios.length) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No scenarios yet. Create one above.</div>';
            return;
        }

        container.innerHTML = scenarios.map(s => {
            const statusClass = s.status === 'approved' ? 'status-approved' : 'status-draft';

            // Render stored adjustments
            const adj = s.adjustments || {};
            const adjKeys = Object.keys(adj);
            const adjHtml = adjKeys.length > 0
                ? `<div style="margin-top:6px;font-size:12px;color:var(--text-muted)">
                    <strong>Adjustments (${adjKeys.length}):</strong>
                    ${adjKeys.map(k => `<span style="display:inline-block;background:var(--surface);border:1px solid var(--border);border-radius:3px;padding:1px 6px;margin:1px">${k.replace(/_/g, ' ')}: ${adj[k]}</span>`).join(' ')}
                   </div>`
                : '<div style="margin-top:6px;font-size:12px;color:#dc2626">No adjustments stored</div>';

            return `<div class="scenario-card">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <h3>${esc(s.name)}</h3>
                    <span class="${statusClass}" style="font-size:12px;font-weight:600">${s.status}</span>
                </div>
                <div class="meta">${s.node_name || '—'} | ${new Date(s.created_at).toLocaleDateString()}</div>
                ${s.description ? `<p style="font-size:13px;margin:6px 0">${esc(s.description)}</p>` : ''}
                ${adjHtml}
                <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
                    <button class="btn-sm" onclick="compareScenario('${s.scenario_id}')">Compare</button>
                    ${s.status === 'draft' ? `<button class="btn-sm" onclick="approveScenario('${s.scenario_id}')">Approve</button>` : ''}
                    <button class="btn-sm" style="color:#dc2626;border-color:#dc2626" onclick="deleteScenario('${s.scenario_id}','${esc(s.name)}')">Delete</button>
                </div>
                <div id="comp-${s.scenario_id}"></div>
            </div>`;
        }).join('');
    } catch (err) {
        container.innerHTML = '<div style="color:var(--text-muted)">Failed to load scenarios</div>';
    }
}

async function compareScenario(scenarioId) {
    const compDiv = document.getElementById(`comp-${scenarioId}`);
    compDiv.innerHTML = '<div style="margin-top:8px;color:var(--text-muted);font-size:13px">Computing...</div>';

    try {
        const data = await apiCall('GET', `/v0/harmony/scenario/${scenarioId}/compare`);

        if (data.error) {
            compDiv.innerHTML = `<div style="margin-top:8px;color:var(--text-muted);font-size:13px">${data.error}</div>`;
            return;
        }

        const comp = data.comparison || {};
        const fields = Object.keys(comp);

        if (!fields.length) {
            compDiv.innerHTML = '<div style="margin-top:8px;color:var(--text-muted);font-size:13px">No baseline scores computed yet. Compute scores first from the Map page.</div>';
            return;
        }

        compDiv.innerHTML = '<div class="comparison-grid">' + fields.map(f => {
            const c = comp[f];
            const deltaSign = c.delta > 0 ? '+' : '';
            const deltaClass = c.delta > 0.001 ? 'comp-positive' : (c.delta < -0.001 ? 'comp-negative' : 'comp-neutral');
            return `<div class="comp-card">
                <div class="comp-label">${f.replace(/_/g, ' ')}</div>
                <div class="comp-delta ${deltaClass}">${deltaSign}${(c.delta * 100).toFixed(1)}%</div>
                <div style="font-size:11px;color:var(--text-muted)">${(c.baseline * 100).toFixed(1)} → ${(c.projected * 100).toFixed(1)}</div>
            </div>`;
        }).join('') + '</div>';
    } catch (err) {
        compDiv.innerHTML = `<div style="margin-top:8px;color:var(--text-muted)">Error: ${err.message}</div>`;
    }
}

async function approveScenario(scenarioId) {
    try {
        await apiCall('POST', `/v0/harmony/scenario/${scenarioId}/approve`);
        showToast('Scenario approved', 'success');
        loadScenarios();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function deleteScenario(scenarioId, name) {
    if (!confirm(`Delete scenario "${name}"?`)) return;
    try {
        await apiCall('DELETE', `/v0/harmony/scenario/${scenarioId}`);
        showToast('Scenario deleted', 'success');
        loadScenarios();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', async () => {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('harmony', 'scenarios');
    startInquiryPolling();
    loadNodes();
    loadScenarios();
});
