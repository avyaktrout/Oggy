// Harmony Data Catalog — display dataset metadata and provenance

async function loadDatasets() {
    const grid = document.getElementById('dataset-grid');
    try {
        const data = await apiCall('GET', '/v0/harmony/datasets');
        const datasets = data.datasets || [];

        if (!datasets.length) {
            grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No datasets registered yet.</div>';
            return;
        }

        grid.innerHTML = datasets.map(ds => {
            const fields = ds.fields || [];
            const fieldsList = fields.map(f =>
                `<li><strong>${f.field}</strong> <span style="color:var(--text-muted)">(${f.type || '—'})</span></li>`
            ).join('');

            const refreshed = ds.last_refreshed
                ? new Date(ds.last_refreshed).toLocaleDateString()
                : 'Not yet';

            return `<div class="dataset-card">
                <h3>${esc(ds.name)}</h3>
                <div class="meta">
                    ${ds.license ? `<span class="badge badge-license">${ds.license}</span>` : ''}
                    ${ds.refresh_cadence ? `<span class="badge badge-cadence">${ds.refresh_cadence}</span>` : ''}
                    <span style="margin-left:8px">Last refreshed: ${refreshed}</span>
                </div>
                ${ds.source_url ? `<a href="${ds.source_url}" target="_blank" rel="noopener" class="dataset-link">${ds.source_url}</a>` : ''}
                ${fields.length ? `<ul class="fields-list" style="margin-top:8px">${fieldsList}</ul>` : ''}
            </div>`;
        }).join('');
    } catch (err) {
        grid.innerHTML = `<div style="color:var(--text-muted)">Failed to load datasets: ${err.message}</div>`;
    }
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ──────────────────────────────────────────────────
// Check for Updates — LLM-powered suggestions
// ──────────────────────────────────────────────────

async function checkForUpdates() {
    const btn = document.getElementById('btn-check-updates');
    const panel = document.getElementById('suggestions-panel');
    const list = document.getElementById('suggestions-list');

    btn.disabled = true;
    btn.textContent = 'Checking...';
    panel.style.display = 'block';
    list.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Analyzing data catalog for gaps...</div>';

    try {
        const data = await apiCall('POST', '/v0/harmony/datasets/check-updates');
        const suggestions = data.suggestions || [];

        if (suggestions.length === 0) {
            list.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No new data sources found. The catalog is up to date.</div>';
        } else {
            renderSuggestions(suggestions);
        }
    } catch (err) {
        list.innerHTML = `<div style="font-size:12px;color:#ef4444">Failed to check: ${err.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Check for Updates';
    }
}

function renderSuggestions(suggestions) {
    const list = document.getElementById('suggestions-list');
    const dimLabels = { balance: 'Balance', flow: 'Flow', compassion: 'Compassion', discernment: 'Discernment', awareness: 'Awareness', expression: 'Expression' };

    list.innerHTML = suggestions.map(s => {
        const p = s.payload || {};
        const dim = dimLabels[p.dimension] || p.dimension || '';
        const dsName = p.dataset_name || '';
        const dsUrl = p.dataset_url || '';

        return `<div class="suggestion-card" id="sg-${s.suggestion_id}">
            <div style="display:flex;justify-content:space-between;align-items:start">
                <div>
                    <span class="sg-badge">${dim}</span>
                    <span class="sg-title" style="margin-left:6px">${esc(s.title)}</span>
                </div>
            </div>
            <div class="sg-desc">${esc(s.description || '')}</div>
            <div class="sg-meta">
                <strong>${esc(p.name || '')}</strong> (${esc(p.unit || 'index')}) &middot; ${p.direction === 'lower_is_better' ? 'Lower is better' : 'Higher is better'}
            </div>
            ${dsName ? `<div class="sg-meta" style="margin-top:2px">Source: <strong>${esc(dsName)}</strong>${dsUrl ? ` &middot; <a href="${dsUrl}" target="_blank" rel="noopener" class="dataset-link">${dsUrl}</a>` : ''}</div>` : ''}
            <div class="sg-actions">
                <button class="sg-accept" onclick="acceptCatalogSuggestion('${s.suggestion_id}')">Accept</button>
                <button class="sg-reject" onclick="rejectCatalogSuggestion('${s.suggestion_id}')">Reject</button>
            </div>
        </div>`;
    }).join('');
}

async function acceptCatalogSuggestion(suggestionId) {
    const card = document.getElementById('sg-' + suggestionId);
    if (!card) return;

    const btns = card.querySelectorAll('button');
    btns.forEach(b => b.disabled = true);
    btns[0].textContent = 'Applying...';

    try {
        await apiCall('POST', `/v0/harmony/suggestions/${suggestionId}/accept`);
        card.style.borderColor = '#22c55e';
        card.innerHTML = `<div style="font-size:12px;color:#22c55e;font-weight:600">Accepted &mdash; indicator added to Harmony Map and data catalog updated.</div>`;
        // Reload datasets to show new entry
        loadDatasets();
    } catch (err) {
        btns.forEach(b => b.disabled = false);
        btns[0].textContent = 'Accept';
        showToast('Failed to accept: ' + err.message, 'error');
    }
}

async function rejectCatalogSuggestion(suggestionId) {
    const card = document.getElementById('sg-' + suggestionId);
    if (!card) return;

    try {
        await apiCall('POST', `/v0/harmony/suggestions/${suggestionId}/reject`);
        card.style.opacity = '0.4';
        card.innerHTML = `<div style="font-size:12px;color:var(--text-muted)">Rejected</div>`;
    } catch (err) {
        showToast('Failed to reject: ' + err.message, 'error');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('harmony', 'data');
    startInquiryPolling();
    loadDatasets();
});
