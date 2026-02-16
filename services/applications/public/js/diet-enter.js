// Diet Agent - Enter Food
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('diet', 'enter');
    document.getElementById('diet-date').value = todayStr();
    loadDietData();

    // ── Receipt scanning ──
    let receiptFoodItems = null;

    document.getElementById('receipt-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const status = document.getElementById('receipt-status');
        const review = document.getElementById('receipt-review');
        status.textContent = 'Scanning receipt...';
        status.style.color = 'var(--primary)';
        review.style.display = 'none';

        try {
            const { base64, mimeType } = await readFileAsBase64(file);
            const result = await apiCall('POST', '/v0/receipt/analyze', {
                image_base64: base64,
                mime_type: mimeType
            });

            if (result.error && !result.merchant) {
                status.textContent = result.error;
                status.style.color = 'var(--danger)';
                return;
            }

            if (result.is_food_receipt && result.food_items && result.food_items.length > 0) {
                receiptFoodItems = result.food_items;
                renderReceiptItems(result.food_items);
                review.style.display = 'block';
                status.textContent = `Found ${result.food_items.length} food item(s) from ${result.merchant || 'receipt'}`;
                status.style.color = 'var(--success)';
            } else if (result.items && result.items.length > 0) {
                // Not a food receipt but has items — put first item description in the form
                document.getElementById('diet-description').value = result.items.map(i => i.name).join(', ');
                status.textContent = `Receipt scanned (${result.items.length} items) — not detected as food`;
                status.style.color = 'var(--warning, orange)';
            } else {
                status.textContent = 'No food items found on receipt';
                status.style.color = 'var(--warning, orange)';
            }
        } catch (err) {
            status.textContent = 'Scan failed: ' + err.message;
            status.style.color = 'var(--danger)';
        }

        e.target.value = '';
    });

    function renderReceiptItems(items) {
        const container = document.getElementById('receipt-items-list');
        container.innerHTML = items.map((f, i) => {
            const meal = f.meal_type_guess || guessMealType();
            const isLiquid = /\b(drink|coffee|tea|juice|soda|water|smoothie|latte|cappuccino|beer|wine|cocktail|energy)\b/i.test(f.name);
            const entryType = isLiquid ? 'liquid' : 'food';
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">' +
                '<input type="checkbox" checked data-receipt-idx="' + i + '" style="margin:0">' +
                '<select data-receipt-meal="' + i + '" style="padding:3px 6px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px">' +
                    '<option value="breakfast"' + (meal === 'breakfast' ? ' selected' : '') + '>Breakfast</option>' +
                    '<option value="lunch"' + (meal === 'lunch' ? ' selected' : '') + '>Lunch</option>' +
                    '<option value="dinner"' + (meal === 'dinner' ? ' selected' : '') + '>Dinner</option>' +
                    '<option value="snack"' + (meal === 'snack' ? ' selected' : '') + '>Snack</option>' +
                '</select>' +
                '<select data-receipt-type="' + i + '" style="padding:3px 6px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px">' +
                    '<option value="food"' + (entryType === 'food' ? ' selected' : '') + '>Food</option>' +
                    '<option value="liquid"' + (entryType === 'liquid' ? ' selected' : '') + '>Liquid</option>' +
                '</select>' +
                '<input type="text" data-receipt-desc="' + i + '" value="' + (f.name || '').replace(/"/g, '&quot;') + '" style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px">' +
                '<span style="font-size:11px;color:var(--text-muted);white-space:nowrap">~' + (f.estimated_calories || '?') + ' cal</span>' +
            '</div>';
        }).join('');
    }

    function guessMealType() {
        const hour = new Date().getHours();
        if (hour >= 5 && hour < 11) return 'breakfast';
        if (hour >= 11 && hour < 14) return 'lunch';
        if (hour >= 17 && hour < 21) return 'dinner';
        return 'snack';
    }

    document.getElementById('receipt-add-all').addEventListener('click', async () => {
        if (!receiptFoodItems) return;
        const date = document.getElementById('diet-date').value;
        let added = 0;

        for (let i = 0; i < receiptFoodItems.length; i++) {
            const cb = document.querySelector('[data-receipt-idx="' + i + '"]');
            if (!cb || !cb.checked) continue;

            const desc = document.querySelector('[data-receipt-desc="' + i + '"]');
            const meal = document.querySelector('[data-receipt-meal="' + i + '"]');
            const type = document.querySelector('[data-receipt-type="' + i + '"]');
            const description = desc ? desc.value.trim() : receiptFoodItems[i].name;
            if (!description) continue;

            try {
                await apiCall('POST', '/v0/diet/entries', {
                    user_id: USER_ID,
                    entry_type: type ? type.value : 'food',
                    description: description,
                    meal_type: meal ? meal.value : 'snack',
                    entry_date: date
                });
                added++;
            } catch (err) {
                showToast('Failed to add: ' + description, 'error');
            }
        }

        if (added > 0) {
            showToast(added + ' item(s) added to diet log!');
            loadDietData();
        }
        document.getElementById('receipt-review').style.display = 'none';
        receiptFoodItems = null;
    });

    document.getElementById('receipt-dismiss').addEventListener('click', () => {
        document.getElementById('receipt-review').style.display = 'none';
        receiptFoodItems = null;
    });

    function readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                const commaIdx = dataUrl.indexOf(',');
                const meta = dataUrl.substring(0, commaIdx);
                const base64 = dataUrl.substring(commaIdx + 1);
                const mimeMatch = meta.match(/data:([^;]+)/);
                resolve({ base64, mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg' });
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }
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