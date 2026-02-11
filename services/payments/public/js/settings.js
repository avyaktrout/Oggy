// Settings Page — BYO-Model configuration
let providersData = [];
let userSettings = {};
let userKeys = {};

(async function init() {
    const authed = await initAuth();
    if (!authed) return;
    renderNav('settings');
    startInquiryPolling();
    await loadSettings();
})();

async function loadSettings() {
    try {
        const [settingsRes, providersRes] = await Promise.all([
            apiCall('GET', '/v0/settings/model'),
            apiCall('GET', '/v0/settings/providers')
        ]);

        userSettings = settingsRes.settings || {};
        userKeys = settingsRes.keys || {};
        providersData = providersRes.providers || [];

        renderProviderDropdowns();
        renderKeysSections();
    } catch (err) {
        showToast('Failed to load settings: ' + err.message, 'error');
    }
}

function renderProviderDropdowns() {
    const oggyProv = document.getElementById('oggy-provider');
    const baseProv = document.getElementById('base-provider');

    // Build provider options
    const provOptions = providersData.map(p =>
        `<option value="${p.provider}">${p.display_name}${p.has_system_key ? '' : ' (key required)'}</option>`
    ).join('');

    oggyProv.innerHTML = `<option value="">Default (OpenAI)</option>${provOptions}`;
    baseProv.innerHTML = `<option value="">Default (OpenAI)</option>${provOptions}`;

    // Set current selections
    oggyProv.value = userSettings.oggy_provider || '';
    baseProv.value = userSettings.base_provider || '';

    // Populate model dropdowns
    onProviderChange('oggy');
    onProviderChange('base');
}

function onProviderChange(role) {
    const provSelect = document.getElementById(`${role}-provider`);
    const modelSelect = document.getElementById(`${role}-model`);
    const provider = provSelect.value;

    const provData = providersData.find(p => p.provider === provider);
    if (!provData) {
        // Default (OpenAI)
        const openai = providersData.find(p => p.provider === 'openai');
        modelSelect.innerHTML = (openai?.models || []).map(m =>
            `<option value="${m.model_id}" ${m.is_default ? 'selected' : ''}>${m.display_name}</option>`
        ).join('');
    } else {
        modelSelect.innerHTML = provData.models.map(m =>
            `<option value="${m.model_id}" ${m.is_default ? 'selected' : ''}>${m.display_name}</option>`
        ).join('');
    }

    // Restore saved model if same provider
    const savedModel = role === 'oggy' ? userSettings.oggy_model : userSettings.base_model;
    if (savedModel) {
        const opt = modelSelect.querySelector(`option[value="${savedModel}"]`);
        if (opt) modelSelect.value = savedModel;
    }
}

async function saveModelSettings() {
    const btn = document.getElementById('save-models-btn');
    const status = document.getElementById('save-models-status');
    btn.disabled = true;
    status.textContent = 'Saving...';

    try {
        await apiCall('PUT', '/v0/settings/model', {
            oggy_provider: document.getElementById('oggy-provider').value || null,
            oggy_model: document.getElementById('oggy-model').value || null,
            base_provider: document.getElementById('base-provider').value || null,
            base_model: document.getElementById('base-model').value || null
        });
        status.textContent = 'Saved!';
        status.style.color = 'var(--success)';
        showToast('Model settings saved');
        setTimeout(() => { status.textContent = ''; }, 3000);
    } catch (err) {
        status.textContent = 'Failed to save';
        status.style.color = 'var(--danger)';
        showToast('Failed to save: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

function renderKeysSections() {
    const container = document.getElementById('provider-keys-container');
    container.innerHTML = '';

    for (const prov of providersData) {
        const key = userKeys[prov.provider];
        const hasKey = key?.has_key;
        const statusClass = hasKey ? (key.is_valid === true ? 'status-valid' : key.is_valid === false ? 'status-invalid' : 'status-unknown') : (prov.has_system_key ? 'status-system' : 'status-unknown');
        const statusText = hasKey ? (key.is_valid === true ? 'Valid' : key.is_valid === false ? 'Invalid' : 'Not validated') : (prov.has_system_key ? 'Using system key' : 'No key');
        const validatedAt = key?.validated_at ? new Date(key.validated_at).toLocaleString() : '';

        container.innerHTML += `
        <div class="provider-section">
            <div class="provider-header">
                <div>
                    <span class="provider-name">${prov.display_name}</span>
                    <span class="status-badge ${statusClass}" style="margin-left:8px">${statusText}</span>
                    ${hasKey ? `<span class="key-hint" style="margin-left:8px">${key.key_hint}</span>` : ''}
                    ${validatedAt ? `<span class="key-hint" style="margin-left:8px">Last checked: ${validatedAt}</span>` : ''}
                </div>
                <div class="btn-group">
                    ${hasKey ? `<button class="btn btn-sm btn-outline" onclick="validateKey('${prov.provider}')">Validate</button>` : ''}
                    ${hasKey ? `<button class="btn btn-sm btn-danger" onclick="removeKey('${prov.provider}')">Remove</button>` : ''}
                </div>
            </div>
            <div class="key-row">
                <input type="password" id="key-input-${prov.provider}" placeholder="Paste your ${prov.display_name} API key..." value="">
                <button class="btn btn-sm btn-primary" onclick="saveKey('${prov.provider}')">Save Key</button>
            </div>
        </div>`;
    }
}

async function saveKey(provider) {
    const input = document.getElementById(`key-input-${provider}`);
    const apiKey = input.value.trim();
    if (!apiKey) {
        showToast('Please enter an API key', 'error');
        return;
    }

    try {
        const result = await apiCall('POST', '/v0/settings/provider-key', { provider, api_key: apiKey });
        showToast(`Key saved (${result.hint})`);
        input.value = '';
        await loadSettings(); // Refresh
    } catch (err) {
        showToast('Failed to save key: ' + err.message, 'error');
    }
}

async function validateKey(provider) {
    showToast('Validating key...');
    try {
        const result = await apiCall('POST', '/v0/settings/validate-key', { provider });
        if (result.valid) {
            showToast(`${provider} key is valid!`);
        } else {
            showToast(`${provider} key is invalid: ${result.error || 'unknown error'}`, 'error');
        }
        await loadSettings(); // Refresh status
    } catch (err) {
        showToast('Validation failed: ' + err.message, 'error');
    }
}

async function removeKey(provider) {
    if (!confirm(`Remove your ${provider} API key?`)) return;

    try {
        await apiCall('DELETE', '/v0/settings/provider-key', { provider });
        showToast('Key removed');
        await loadSettings(); // Refresh
    } catch (err) {
        showToast('Failed to remove key: ' + err.message, 'error');
    }
}
