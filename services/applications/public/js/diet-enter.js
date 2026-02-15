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
        const satFat = Math.round(data.total_saturated_fat || 0);
        const unsatFat = Math.round(data.total_unsaturated_fat || 0);
        const fatDetail = document.getElementById('nc-fat-detail');
        if (fatDetail) fatDetail.textContent = (satFat || unsatFat) ? 'Sat ' + satFat + 'g / Unsat ' + unsatFat + 'g' : '';
        document.getElementById('nc-fiber').textContent = Math.round(data.total_fiber || 0) + 'g';
        document.getElementById('nc-sugar').textContent = Math.round(data.total_sugar || 0) + 'g';
        document.getElementById('nc-sodium').textContent = Math.round(data.total_sodium || 0) + 'mg';
        document.getElementById('nc-caffeine').textContent = Math.round(data.total_caffeine || 0) + 'mg';
        document.getElementById('nc-entries').textContent = data.total_entries || 0;
    } catch (e) { /* ignore */ }
}

window.deleteDietEntry = async function(entryId) {
    if (!confirm('Delete this entry?')) return;
    try {
        await apiCall('DELETE', '/v0/diet/entries/' + entryId + '?user_id=' + USER_ID);
        showToast('Entry deleted');
        loadDietData();
    } catch (err) {
        showToast('Failed to delete: ' + err.message, 'error');
    }
};

window.editDietNutrition = function(entryId, currentData) {
    // Close any other open edit form
    document.querySelectorAll('.diet-edit-form').forEach(el => el.remove());

    const card = document.querySelector('[data-entry-id="' + entryId + '"]');
    if (!card) return;

    const form = document.createElement('div');
    form.className = 'diet-edit-form';
    form.innerHTML =
        '<div class="diet-edit-fields">' +
            '<label>Cal<input type="number" id="edit-cal-' + entryId + '" value="' + (currentData.calories || 0) + '"></label>' +
            '<label>Protein<input type="number" id="edit-pro-' + entryId + '" value="' + (currentData.protein_g || 0) + '"></label>' +
            '<label>Carbs<input type="number" id="edit-carb-' + entryId + '" value="' + (currentData.carbs_g || 0) + '"></label>' +
            '<label>Fat<input type="number" id="edit-fat-' + entryId + '" value="' + (currentData.fat_g || 0) + '"></label>' +
            '<label>Sat Fat<input type="number" id="edit-satfat-' + entryId + '" value="' + (currentData.saturated_fat_g || 0) + '" step="0.1"></label>' +
            '<label>Unsat Fat<input type="number" id="edit-unsatfat-' + entryId + '" value="' + (currentData.unsaturated_fat_g || 0) + '" step="0.1"></label>' +
            '<label>Fiber<input type="number" id="edit-fib-' + entryId + '" value="' + (currentData.fiber_g || 0) + '"></label>' +
            '<label>Sugar<input type="number" id="edit-sug-' + entryId + '" value="' + (currentData.sugar_g || 0) + '"></label>' +
            '<label>Sodium<input type="number" id="edit-sod-' + entryId + '" value="' + (currentData.sodium_mg || 0) + '"></label>' +
            '<label>Caffeine<input type="number" id="edit-caf-' + entryId + '" value="' + (currentData.caffeine_mg || 0) + '"></label>' +
        '</div>' +
        '<div class="diet-edit-actions">' +
            '<button class="diet-edit-save" onclick="saveDietNutrition(\'' + entryId + '\')">Save</button>' +
            '<button class="diet-edit-cancel" onclick="this.closest(\'.diet-edit-form\').remove()">Cancel</button>' +
        '</div>';
    card.appendChild(form);
};

window.saveDietNutrition = async function(entryId) {
    const data = {
        user_id: USER_ID,
        calories: parseFloat(document.getElementById('edit-cal-' + entryId).value) || 0,
        protein_g: parseFloat(document.getElementById('edit-pro-' + entryId).value) || 0,
        carbs_g: parseFloat(document.getElementById('edit-carb-' + entryId).value) || 0,
        fat_g: parseFloat(document.getElementById('edit-fat-' + entryId).value) || 0,
        saturated_fat_g: parseFloat(document.getElementById('edit-satfat-' + entryId).value) || 0,
        unsaturated_fat_g: parseFloat(document.getElementById('edit-unsatfat-' + entryId).value) || 0,
        fiber_g: parseFloat(document.getElementById('edit-fib-' + entryId).value) || 0,
        sugar_g: parseFloat(document.getElementById('edit-sug-' + entryId).value) || 0,
        sodium_mg: parseFloat(document.getElementById('edit-sod-' + entryId).value) || 0,
        caffeine_mg: parseFloat(document.getElementById('edit-caf-' + entryId).value) || 0
    };
    try {
        await apiCall('PUT', '/v0/diet/entries/' + entryId + '/nutrition', data);
        showToast('Nutrition updated!');
        loadDietData();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};

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
            const item = items.length > 0 ? items[0] : {};
            const cal = items.length > 0 ? Math.round(item.calories || 0) : '?';
            const pro = items.length > 0 ? Math.round(item.protein_g || 0) : '?';
            const cn = item.custom_nutrients || {};
            const itemJson = items.length > 0 ? JSON.stringify({
                calories: item.calories || 0, protein_g: item.protein_g || 0,
                carbs_g: item.carbs_g || 0, fat_g: item.fat_g || 0,
                saturated_fat_g: cn.saturated_fat_g || 0, unsaturated_fat_g: cn.unsaturated_fat_g || 0,
                fiber_g: item.fiber_g || 0,
                sugar_g: item.sugar_g || 0, sodium_mg: item.sodium_mg || 0, caffeine_mg: item.caffeine_mg || 0
            }).replace(/"/g, '&quot;') : '{}';
            return '<div class="diet-entry-card" data-entry-id="' + e.entry_id + '">' +
                '<div class="diet-entry-info">' +
                    '<span class="diet-entry-type-badge">' + e.entry_type + '</span>' +
                    '<span class="diet-entry-desc">' + e.description + '</span>' +
                    (e.quantity ? '<span class="diet-entry-qty">' + e.quantity + ' ' + (e.unit || '') + '</span>' : '') +
                '</div>' +
                '<div class="diet-entry-nutrition">' +
                    '<span class="diet-entry-cal">' + cal + ' kcal</span>' +
                    '<span class="diet-entry-pro">' + pro + 'g pro</span>' +
                    '<button class="diet-entry-edit" onclick="editDietNutrition(\'' + e.entry_id + '\', ' + itemJson + ')" title="Edit nutrition">&#9998;</button>' +
                    '<span class="diet-entry-meal">' + (e.meal_type || '') + '</span>' +
                    '<button class="diet-entry-delete" onclick="deleteDietEntry(\'' + e.entry_id + '\')" title="Delete">&times;</button>' +
                '</div>' +
            '</div>';
        }).join('');
    } catch (e) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Failed to load entries</div>';
    }
}