// Diet Agent - Enter Food
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('diet', 'enter');
    document.getElementById('diet-date').value = todayStr();
    loadDietData();
})();

window.addDietEntry = async function() {
    const description = document.getElementById('diet-description').value.trim();
    if (!description) return;
    const entry = {
        user_id: USER_ID,
        entry_type: document.getElementById('diet-entry-type').value,
        description,
        quantity: parseFloat(document.getElementById('diet-quantity').value) || null,
        unit: document.getElementById('diet-unit').value || null,
        meal_type: document.getElementById('diet-meal-type').value,
        entry_date: document.getElementById('diet-date').value
    };
    try {
        await apiCall('POST', '/v0/diet/entries', entry);
        document.getElementById('diet-description').value = '';
        document.getElementById('diet-quantity').value = '';
        showToast('Entry added! Analyzing nutrition...');
        loadDietData();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};

window.loadDietData = async function() {
    const date = document.getElementById('diet-date').value;
    await Promise.all([loadNutritionSummary(date), loadEntries(date)]);
};

async function loadNutritionSummary(date) {
    try {
        const data = await apiCall('GET', '/v0/diet/nutrition?user_id=' + USER_ID + '&date=' + date);
        document.getElementById('nc-calories').textContent = Math.round(data.total_calories || 0);
        document.getElementById('nc-protein').textContent = Math.round(data.total_protein || 0) + 'g';
        document.getElementById('nc-carbs').textContent = Math.round(data.total_carbs || 0) + 'g';
        document.getElementById('nc-fat').textContent = Math.round(data.total_fat || 0) + 'g';
        document.getElementById('nc-fiber').textContent = Math.round(data.total_fiber || 0) + 'g';
        document.getElementById('nc-entries').textContent = data.total_entries || 0;
    } catch (e) { /* ignore */ }
}

async function loadEntries(date) {
    const container = document.getElementById('diet-entries-list');
    try {
        const data = await apiCall('GET', '/v0/diet/entries?user_id=' + USER_ID + '&date=' + date);
        if (!data.entries || data.entries.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0">No entries yet today.</div>';
            return;
        }
        container.innerHTML = data.entries.map(e => {
            const items = e.items && e.items[0] ? e.items : [];
            const cal = items.length > 0 ? Math.round(items[0].calories || 0) : '?';
            return '<div class="diet-entry-card">' +
                '<div class="diet-entry-info">' +
                    '<span class="diet-entry-type-badge">' + e.entry_type + '</span>' +
                    '<span class="diet-entry-desc">' + e.description + '</span>' +
                    (e.quantity ? '<span class="diet-entry-qty">' + e.quantity + ' ' + (e.unit || '') + '</span>' : '') +
                '</div>' +
                '<div class="diet-entry-nutrition">' +
                    '<span class="diet-entry-cal">' + cal + ' kcal</span>' +
                    '<span class="diet-entry-meal">' + (e.meal_type || '') + '</span>' +
                '</div>' +
            '</div>';
        }).join('');
    } catch (e) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Failed to load entries</div>';
    }
}