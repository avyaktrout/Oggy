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

// ──────────────────────────────────────────────────
// What-If Chat
// ──────────────────────────────────────────────────
function populateWhatIfNodes(nodes) {
    const select = document.getElementById('whatif-node');
    if (!select) return;
    select.innerHTML = '<option value="">Select city...</option>';
    for (const node of nodes) {
        const opt = document.createElement('option');
        opt.value = node.node_id;
        opt.textContent = node.name;
        select.appendChild(opt);
    }
}

async function sendWhatIf() {
    const input = document.getElementById('whatif-input');
    const msg = input.value.trim();
    if (!msg) return;

    const nodeId = document.getElementById('whatif-node').value;
    if (!nodeId) {
        showToast('Select a city first', 'error');
        return;
    }

    input.value = '';
    const msgArea = document.getElementById('whatif-messages');

    msgArea.innerHTML += `<div class="whatif-msg whatif-msg-user">${esc(msg)}</div>`;

    const loadingId = 'wif-loading-' + Date.now();
    msgArea.innerHTML += `<div class="whatif-msg whatif-msg-bot" id="${loadingId}">Thinking...</div>`;
    msgArea.scrollTop = msgArea.scrollHeight;

    const sendBtn = document.getElementById('whatif-send-btn');
    sendBtn.disabled = true;

    try {
        const data = await apiCall('POST', '/v0/harmony/whatif-chat', {
            message: msg,
            node_id: nodeId,
        });

        const loadEl = document.getElementById(loadingId);
        if (loadEl) loadEl.remove();

        if (data.oggy_response) {
            msgArea.innerHTML += `<div class="whatif-msg whatif-msg-bot"><strong>Oggy:</strong><br>${formatWhatIfResponse(data.oggy_response)}</div>`;
        }
        if (data.base_response) {
            msgArea.innerHTML += `<div class="whatif-msg whatif-msg-base"><strong>Base:</strong><br>${formatWhatIfResponse(data.base_response)}</div>`;
        }
        if (data.suggestions && data.suggestions.length > 0) {
            for (const sug of data.suggestions) {
                msgArea.innerHTML += renderSuggestionCard(sug);
            }
        }
        msgArea.scrollTop = msgArea.scrollHeight;
    } catch (err) {
        const loadEl = document.getElementById(loadingId);
        if (loadEl) loadEl.innerHTML = `Error: ${err.message}`;
        showToast('What-If chat failed: ' + err.message, 'error');
    } finally {
        sendBtn.disabled = false;
    }
}

function formatWhatIfResponse(text) {
    return esc(text)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
}

function renderSuggestionCard(sug) {
    const typeLabel = (sug.suggestion_type || 'suggestion').replace(/_/g, ' ');
    return `<div class="suggestion-card" id="sug-${sug.suggestion_id}">
        <div class="sug-type">${typeLabel}</div>
        <div class="sug-title">${esc(sug.title)}</div>
        <div class="sug-desc">${esc(sug.description || '')}</div>
        <div class="sug-actions">
            <button class="sug-accept" onclick="acceptSuggestion('${sug.suggestion_id}')">Accept</button>
            <button class="sug-reject" onclick="rejectSuggestion('${sug.suggestion_id}')">Reject</button>
        </div>
    </div>`;
}

// ──────────────────────────────────────────────────
// Suggestions (accept / reject / generate)
// ──────────────────────────────────────────────────
async function acceptSuggestion(id) {
    try {
        await apiCall('POST', `/v0/harmony/suggestions/${id}/accept`);
        const card = document.getElementById('sug-' + id);
        if (card) {
            card.style.borderColor = '#22c55e';
            card.querySelector('.sug-actions').innerHTML = '<span style="color:#22c55e;font-weight:600;font-size:12px">Accepted</span>';
        }
        showToast('Suggestion accepted and applied', 'success');
        loadPendingSuggestions();
    } catch (err) {
        showToast('Failed to accept: ' + err.message, 'error');
    }
}

async function rejectSuggestion(id) {
    try {
        await apiCall('POST', `/v0/harmony/suggestions/${id}/reject`);
        const card = document.getElementById('sug-' + id);
        if (card) {
            card.style.opacity = '0.5';
            card.querySelector('.sug-actions').innerHTML = '<span style="color:var(--text-muted);font-size:12px">Rejected</span>';
        }
        loadPendingSuggestions();
    } catch (err) {
        showToast('Failed to reject: ' + err.message, 'error');
    }
}

async function generateSuggestions() {
    const countEl = document.getElementById('pending-sug-count');
    countEl.textContent = 'Generating...';
    try {
        const data = await apiCall('POST', '/v0/harmony/generate-suggestions', { count: 10, focus: 'all' });
        countEl.textContent = `${data.generated || 0} generated`;
        showToast(`Generated ${data.generated || 0} suggestions`, 'success');
        loadPendingSuggestions();
    } catch (err) {
        countEl.textContent = 'Failed';
        showToast('Failed to generate: ' + err.message, 'error');
    }
}

async function loadPendingSuggestions() {
    try {
        const data = await apiCall('GET', '/v0/harmony/suggestions?status=pending');
        const suggestions = data.suggestions || [];
        const countEl = document.getElementById('pending-sug-count');
        countEl.textContent = suggestions.length > 0 ? `${suggestions.length} pending` : '';

        const container = document.getElementById('whatif-suggestions');
        if (container && suggestions.length > 0) {
            container.innerHTML = suggestions.map(s => renderSuggestionCard(s)).join('');
        } else if (container) {
            container.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No pending suggestions. Click Generate to create some.</div>';
        }
    } catch (_) {}
}

// ──────────────────────────────────────────────────
// Observer
// ──────────────────────────────────────────────────
async function loadObserverConfig() {
    try {
        const data = await apiCall('GET', '/v0/harmony/observer/config');
        const config = data.config || {};
        document.getElementById('obs-share').checked = !!config.share_changes;
        document.getElementById('obs-receive').checked = !!config.receive_harmony_packs;
        updateObserverDot(config);
        loadObserverPacks();
    } catch (_) {
        updateObserverDot({});
    }
}

function updateObserverDot(config) {
    const dot = document.getElementById('observer-dot');
    if (!dot) return;
    if (config.share_changes || config.receive_harmony_packs) {
        dot.className = 'observer-status-dot observer-status-ready';
    } else {
        dot.className = 'observer-status-dot observer-status-unavailable';
    }
}

async function updateObserverConfig() {
    const share = document.getElementById('obs-share').checked;
    const receive = document.getElementById('obs-receive').checked;
    try {
        await apiCall('PUT', '/v0/harmony/observer/config', {
            share_changes: share,
            receive_harmony_packs: receive,
        });
        updateObserverDot({ share_changes: share, receive_harmony_packs: receive });
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
        container.innerHTML = packs.map(p => {
            const changes = Array.isArray(p.changes) ? p.changes.length : 0;
            const impactCls = `impact-${p.impact_level || 'low'}`;
            const actions = p.status === 'applied'
                ? `<button onclick="rollbackPack('${p.pack_id}')">Rollback</button>`
                : `<button onclick="applyPack('${p.pack_id}')" style="background:var(--accent);color:#fff;border-color:var(--accent)">Apply</button>`;
            return `<div class="pack-card">
                <div class="pack-name">${esc(p.name)}</div>
                <div class="pack-meta">v${p.version} &middot; ${changes} changes &middot; <span class="${impactCls}">${p.impact_level || 'low'} impact</span></div>
                <div class="pack-actions">${actions}</div>
            </div>`;
        }).join('');
    } catch (_) {
        container.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Failed to load packs</div>';
    }
}

async function applyPack(packId) {
    try {
        await apiCall('POST', '/v0/harmony/observer/import-pack', { pack_id: packId });
        showToast('Pack applied successfully', 'success');
        loadObserverPacks();
    } catch (err) {
        showToast('Failed to apply pack: ' + err.message, 'error');
    }
}

async function rollbackPack(packId) {
    try {
        await apiCall('POST', '/v0/harmony/observer/rollback-pack', { pack_id: packId });
        showToast('Pack rolled back', 'success');
        loadObserverPacks();
    } catch (err) {
        showToast('Failed to rollback: ' + err.message, 'error');
    }
}

// ──────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('harmony', 'scenarios');
    startInquiryPolling();
    loadNodes();
    loadScenarios();

    // Load What-If node dropdown + suggestions + observer
    try {
        const data = await apiCall('GET', '/v0/harmony/nodes?scope=city');
        populateWhatIfNodes(data.nodes || []);
    } catch (_) {}
    loadPendingSuggestions();
    loadObserverConfig();
});
