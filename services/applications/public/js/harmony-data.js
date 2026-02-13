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

document.addEventListener('DOMContentLoaded', async () => {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('harmony', 'data');
    startInquiryPolling();
    loadDatasets();
});
