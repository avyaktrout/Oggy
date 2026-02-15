// Harmony Agent - Chat & Training Page
const shell = new AgentShell({
    domain: 'harmony',
    label: 'Harmony Agent',
    chatEndpoint: '/v0/harmony/chat',
    trainingEndpoint: '/v0/continuous-learning',
    analyticsPage: '/harmony-analytics.html',
    chatPlaceholder: 'Ask about city metrics, suggest improvements...',
    welcomeMessage: "Hi! I'm Oggy, your Harmony Map assistant. Ask about city metrics, compare cities, suggest new data sources, or explore what drives well-being scores!",
    baseWelcome: "Hi! I'm the base model without memory. Compare my answers with Oggy's to see the difference learning makes.",
    contextProvider: async () => ({}),
    capabilities: {
        training: true,
        comparison: true,
        inquiries: false,
        observer: true,
        audit: false
    },
    observerBasePath: '/v0/harmony/observer'
});

shell.init();

// ──────────────────────────────────────────────────
// Suggestion Loop Controls
// ──────────────────────────────────────────────────

let suggestionPollInterval = null;

async function startSuggestionLoop() {
    const interval = parseInt(document.getElementById('suggestion-interval').value);
    try {
        const data = await apiCall('POST', '/v0/harmony/suggestions/auto/start', { interval_minutes: interval });
        if (data.status === 'started' || data.status === 'already_running') {
            document.getElementById('btn-start-suggestions').style.display = 'none';
            document.getElementById('btn-stop-suggestions').style.display = '';
            document.getElementById('suggestion-interval').disabled = true;
            document.getElementById('suggestion-status-row').style.display = '';
            if (!suggestionPollInterval) {
                suggestionPollInterval = setInterval(pollSuggestionStatus, 10000);
            }
        }
    } catch (err) {
        console.error('Failed to start suggestion loop', err);
    }
}

async function stopSuggestionLoop() {
    try {
        await apiCall('POST', '/v0/harmony/suggestions/auto/stop', {});
        document.getElementById('btn-start-suggestions').style.display = '';
        document.getElementById('btn-stop-suggestions').style.display = 'none';
        document.getElementById('suggestion-interval').disabled = false;
        if (suggestionPollInterval) {
            clearInterval(suggestionPollInterval);
            suggestionPollInterval = null;
        }
    } catch (err) {
        console.error('Failed to stop suggestion loop', err);
    }
}

async function pollSuggestionStatus() {
    try {
        const data = await apiCall('GET', '/v0/harmony/suggestions/auto/status');
        document.getElementById('sug-total').textContent = data.total_generated || 0;
        document.getElementById('sug-cycles').textContent = data.cycles || 0;
        document.getElementById('sug-errors').textContent = data.errors || 0;
        document.getElementById('sug-last').textContent = data.last_run
            ? new Date(data.last_run).toLocaleTimeString()
            : '—';
        if (!data.is_running) {
            document.getElementById('btn-start-suggestions').style.display = '';
            document.getElementById('btn-stop-suggestions').style.display = 'none';
            document.getElementById('suggestion-interval').disabled = false;
            if (suggestionPollInterval) {
                clearInterval(suggestionPollInterval);
                suggestionPollInterval = null;
            }
        }
    } catch (err) {
        console.error('Failed to poll suggestion status', err);
    }
}

// Also refresh suggestions list when polling status
const _origPollStatus = pollSuggestionStatus;
pollSuggestionStatus = async function() {
    await _origPollStatus();
    await refreshSuggestions();
};

// Check suggestion loop status on page load
(async function checkSuggestionStatus() {
    try {
        const data = await apiCall('GET', '/v0/harmony/suggestions/auto/status');
        if (data.is_running) {
            document.getElementById('btn-start-suggestions').style.display = 'none';
            document.getElementById('btn-stop-suggestions').style.display = '';
            document.getElementById('suggestion-interval').disabled = true;
            document.getElementById('suggestion-status-row').style.display = '';
            document.getElementById('sug-total').textContent = data.total_generated || 0;
            document.getElementById('sug-cycles').textContent = data.cycles || 0;
            document.getElementById('sug-errors').textContent = data.errors || 0;
            document.getElementById('sug-last').textContent = data.last_run
                ? new Date(data.last_run).toLocaleTimeString()
                : '—';
            suggestionPollInterval = setInterval(pollSuggestionStatus, 10000);
        }
    } catch (err) { /* ignore on load */ }
})();

// ──────────────────────────────────────────────────
// Pending Suggestions List
// ──────────────────────────────────────────────────

let suggestionListPollInterval = null;

async function refreshSuggestions() {
    try {
        const data = await apiCall('GET', '/v0/harmony/suggestions?status=pending');
        const suggestions = data.suggestions || data || [];
        const list = document.getElementById('suggestions-list');
        const countEl = document.getElementById('sug-pending-count');

        if (!Array.isArray(suggestions) || suggestions.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No pending suggestions yet.</p>';
            countEl.textContent = '(0)';
            return;
        }

        countEl.textContent = `(${suggestions.length})`;
        list.innerHTML = suggestions.map(renderSuggestionCard).join('');
    } catch (err) {
        console.error('Failed to refresh suggestions', err);
    }
}

function renderSuggestionCard(s) {
    const typeColors = {
        new_city: '#8b5cf6',
        new_indicator: '#3b82f6',
        new_data_point: '#06b6d4',
        weight_adjustment: '#f59e0b',
        model_update: '#10b981'
    };
    const color = typeColors[s.suggestion_type] || '#64748b';
    const typeLabel = (s.suggestion_type || 'unknown').replace(/_/g, ' ');
    const sourceBadge = s.source ? `<span style="display:inline-block;background:#f1f5f9;color:#64748b;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:6px">${s.source}</span>` : '';

    let payloadSummary = '';
    if (s.payload) {
        const p = typeof s.payload === 'string' ? JSON.parse(s.payload) : s.payload;
        const cityName = p.city_name || p.name;
        if (s.suggestion_type === 'new_city' && cityName) {
            let details = cityName;
            if (p.population) details += ` — Pop: ${Number(p.population).toLocaleString()}`;
            if (p.lat) details += `, Lat: ${p.lat}`;
            if (p.lng) details += `, Lng: ${p.lng}`;
            if (p.initial_scores) {
                const sc = p.initial_scores;
                details += `<br>Scores: B=${sc.balance||'?'} F=${sc.flow||'?'} C=${sc.compassion||'?'} D=${sc.discernment||'?'} A=${sc.awareness||'?'} X=${sc.expression||'?'}`;
            }
            if (p.data_sources && p.data_sources.length) {
                details += `<br>Sources: ${p.data_sources.slice(0, 3).join(', ')}`;
            }
            payloadSummary = `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${details}</div>`;
        } else if (s.suggestion_type === 'new_indicator' && p.key) {
            let details = `${p.key} → ${p.dimension || '?'}`;
            if (p.direction) details += ` (${p.direction})`;
            if (p.unit) details += `, ${p.unit}`;
            if (p.source_rationale) details += `<br>${p.source_rationale}`;
            const scope = p.applies_to === 'all' ? 'All nodes' : p.applies_to === 'subset' ? 'Subset of nodes' : 'Single node';
            details += `<br>Applies to: ${scope}`;
            payloadSummary = `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${details}</div>`;
        } else if (s.suggestion_type === 'new_data_point' && p.indicator_key) {
            let details = `${p.indicator_key}: ${p.raw_value != null ? p.raw_value : '?'}`;
            if (p.source_dataset) details += ` — ${p.source_dataset}`;
            if (p.source_name) details += ` — ${p.source_name}`;
            const scope = p.applies_to === 'all' ? 'All nodes' : p.applies_to === 'subset' ? 'Subset of nodes' : 'Single node';
            details += `<br>Applies to: ${scope}`;
            payloadSummary = `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${details}</div>`;
        } else if (s.suggestion_type === 'weight_adjustment') {
            const current = p.current_weight != null ? p.current_weight : '?';
            const proposed = p.proposed_weight != null ? p.proposed_weight : (p.suggested_weight != null ? p.suggested_weight : '?');
            let details = `${p.indicator_key || '?'}: ${current} → ${proposed}`;
            if (p.rationale || p.reason) details += `<br>${p.rationale || p.reason}`;
            details += '<br>Applies to: All nodes';
            payloadSummary = `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${details}</div>`;
        } else if (s.suggestion_type === 'model_update') {
            let details = p.change_description || '';
            if (p.rationale) details += `<br>${p.rationale}`;
            payloadSummary = details ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${details}</div>` : '';
        } else if (p.indicator_key) {
            payloadSummary = `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${p.indicator_key}${p.dimension ? ' (' + p.dimension + ')' : ''}${p.source_name ? ' — ' + p.source_name : ''}</div>`;
        }
    }

    return `
        <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;background:var(--bg)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                <div>
                    <span style="display:inline-block;background:${color};color:white;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600">${typeLabel}</span>
                    ${sourceBadge}
                </div>
                <div style="display:flex;gap:6px">
                    <button class="btn btn-success btn-sm" onclick="acceptSuggestion('${s.suggestion_id}')" style="padding:2px 10px;font-size:12px">Accept</button>
                    <button class="btn btn-danger btn-sm" onclick="rejectSuggestion('${s.suggestion_id}')" style="padding:2px 10px;font-size:12px">Reject</button>
                </div>
            </div>
            <div style="font-weight:600;font-size:13px">${s.title || 'Untitled'}</div>
            ${s.description ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${s.description}</div>` : ''}
            ${payloadSummary}
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${new Date(s.created_at).toLocaleString()}</div>
        </div>`;
}

async function acceptSuggestion(id) {
    try {
        await apiCall('POST', `/v0/harmony/suggestions/${id}/accept`, {});
        await refreshSuggestions();
    } catch (err) {
        console.error('Failed to accept suggestion', err);
        alert('Failed to accept suggestion: ' + (err.message || err));
    }
}

async function rejectSuggestion(id) {
    try {
        await apiCall('POST', `/v0/harmony/suggestions/${id}/reject`, {});
        await refreshSuggestions();
    } catch (err) {
        console.error('Failed to reject suggestion', err);
        alert('Failed to reject suggestion: ' + (err.message || err));
    }
}

// ──────────────────────────────────────────────────
// SDL-Driven Suggestion Controls
// ──────────────────────────────────────────────────

let sdlSugPollInterval = null;

async function startSdlSuggestions() {
    try {
        const data = await apiCall('POST', '/v0/harmony/suggestions/sdl/start', {});
        if (data.status === 'started' || data.status === 'already_running') {
            document.getElementById('btn-start-sdl-sug').style.display = 'none';
            document.getElementById('btn-stop-sdl-sug').style.display = '';
            document.getElementById('sdl-sug-status-row').style.display = '';
            if (!sdlSugPollInterval) {
                sdlSugPollInterval = setInterval(pollSdlSuggestionStatus, 10000);
            }
        }
    } catch (err) {
        console.error('Failed to start SDL suggestions', err);
        alert('Failed to start SDL suggestions: ' + (err.message || err));
    }
}
window.startSdlSuggestions = startSdlSuggestions;

async function stopSdlSuggestions() {
    try {
        await apiCall('POST', '/v0/harmony/suggestions/sdl/stop', {});
        document.getElementById('btn-start-sdl-sug').style.display = '';
        document.getElementById('btn-stop-sdl-sug').style.display = 'none';
        if (sdlSugPollInterval) {
            clearInterval(sdlSugPollInterval);
            sdlSugPollInterval = null;
        }
    } catch (err) {
        console.error('Failed to stop SDL suggestions', err);
    }
}
window.stopSdlSuggestions = stopSdlSuggestions;

async function pollSdlSuggestionStatus() {
    try {
        const data = await apiCall('GET', '/v0/harmony/suggestions/sdl/status');
        document.getElementById('sdl-sug-total').textContent = data.total_attempts || 0;
        document.getElementById('sdl-sug-correct').textContent = data.correct || 0;
        document.getElementById('sdl-sug-accuracy').textContent = data.accuracy || '0%';
        if (!data.is_running) {
            document.getElementById('btn-start-sdl-sug').style.display = '';
            document.getElementById('btn-stop-sdl-sug').style.display = 'none';
            if (sdlSugPollInterval) {
                clearInterval(sdlSugPollInterval);
                sdlSugPollInterval = null;
            }
        }
        await refreshSuggestions();
    } catch (err) {
        console.error('Failed to poll SDL suggestion status', err);
    }
}

// Check SDL suggestion status on page load
(async function checkSdlSuggestionStatus() {
    try {
        const data = await apiCall('GET', '/v0/harmony/suggestions/sdl/status');
        if (data.is_running) {
            document.getElementById('btn-start-sdl-sug').style.display = 'none';
            document.getElementById('btn-stop-sdl-sug').style.display = '';
            document.getElementById('sdl-sug-status-row').style.display = '';
            document.getElementById('sdl-sug-total').textContent = data.total_attempts || 0;
            document.getElementById('sdl-sug-correct').textContent = data.correct || 0;
            document.getElementById('sdl-sug-accuracy').textContent = data.accuracy || '0%';
            sdlSugPollInterval = setInterval(pollSdlSuggestionStatus, 10000);
        }
    } catch (err) { /* ignore on load */ }
})();

// Load pending suggestions on page load
refreshSuggestions();
