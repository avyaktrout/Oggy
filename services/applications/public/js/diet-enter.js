// Diet Agent - Enter Food
let _dietGoals = {};
let _autocompleteIdx = -1;
let _autocompleteTimer = null;

(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('diet', 'enter');
    document.getElementById('diet-date').value = todayStr();

    // Load goals, then data + recent + saved meals
    await loadGoalsForEnter();
    loadDietData();
    loadRecentFoods();
    loadSavedMeals();

    // ── Autocomplete on description input ──
    const descInput = document.getElementById('diet-description');
    descInput.addEventListener('input', () => {
        clearTimeout(_autocompleteTimer);
        _autocompleteTimer = setTimeout(() => searchFoods(descInput.value.trim()), 300);
    });
    descInput.addEventListener('focus', () => {
        if (descInput.value.trim().length >= 2) searchFoods(descInput.value.trim());
    });
    descInput.addEventListener('blur', () => {
        setTimeout(() => { document.getElementById('food-autocomplete').style.display = 'none'; }, 200);
    });

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
            const entryType = f.is_liquid === true ? 'liquid' : 'food';
            const qty = f.quantity || 1;
            const unit = f.unit || 'serving';
            const confidence = f.confidence || 'high';
            const confColor = confidence === 'high' ? '#22c55e' : confidence === 'medium' ? '#f59e0b' : '#ef4444';
            const confDot = '<span title="Confidence: ' + confidence + '" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + confColor + ';margin-left:4px;vertical-align:middle"></span>';
            const unitOpts = ['serving','piece','cup','oz','g','ml','slice','bottle','can'];
            const unitSelect = unitOpts.map(u => '<option value="' + u + '"' + (u === unit ? ' selected' : '') + '>' + u + '</option>').join('');
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">' +
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
                '<input type="number" data-receipt-qty="' + i + '" value="' + qty + '" min="0.1" step="0.1" style="width:55px;padding:3px 6px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px">' +
                '<select data-receipt-unit="' + i + '" style="padding:3px 6px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px">' + unitSelect + '</select>' +
                '<input type="text" data-receipt-desc="' + i + '" value="' + (f.name || '').replace(/"/g, '&quot;') + '" style="flex:1;min-width:120px;padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px">' +
                '<span style="font-size:11px;color:var(--text-muted);white-space:nowrap">~' + (f.estimated_calories || '?') + ' cal' + confDot + '</span>' +
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
            const qtyEl = document.querySelector('[data-receipt-qty="' + i + '"]');
            const unitEl = document.querySelector('[data-receipt-unit="' + i + '"]');
            const description = desc ? desc.value.trim() : receiptFoodItems[i].name;
            if (!description) continue;
            const quantity = qtyEl ? (parseFloat(qtyEl.value) || null) : null;
            const unit = unitEl ? (unitEl.value || null) : null;

            try {
                await apiCall('POST', '/v0/diet/entries', {
                    user_id: USER_ID,
                    entry_type: type ? type.value : 'food',
                    description: description,
                    meal_type: meal ? meal.value : 'snack',
                    entry_date: date,
                    quantity,
                    unit
                });
                added++;
            } catch (err) {
                showToast('Failed to add: ' + description, 'error');
            }
        }

        if (added > 0) {
            showToast(added + ' item(s) added to diet log!');
            loadDietData();
            loadRecentFoods();
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

// ─── Goals (for progress bars) ──────────────────────
async function loadGoalsForEnter() {
    try {
        const data = await apiCall('GET', '/v0/diet/goals?user_id=' + USER_ID);
        _dietGoals = {};
        for (const g of (data.goals || [])) {
            _dietGoals[g.target_nutrient] = g.target_value;
        }
    } catch (_) {}
}

function renderProgressBar(current, goal) {
    if (!goal || goal <= 0) return '';
    const pct = Math.min((current / goal) * 100, 100);
    const color = pct < 80 ? '#22c55e' : pct <= 100 ? '#f59e0b' : '#ef4444';
    return '<div class="nutrition-progress"><div class="nutrition-progress-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
           '<div class="nutrition-goal-text">' + Math.round(current) + ' / ' + Math.round(goal) + '</div>';
}

// ─── Autocomplete ───────────────────────────────────
async function searchFoods(q) {
    const dropdown = document.getElementById('food-autocomplete');
    if (q.length < 2) { dropdown.style.display = 'none'; return; }

    try {
        const data = await apiCall('GET', '/v0/diet/search?q=' + encodeURIComponent(q) + '&user_id=' + USER_ID);
        const results = data.results || [];
        if (results.length === 0) { dropdown.style.display = 'none'; return; }

        // Group by source
        const groups = {};
        for (const r of results) {
            if (!groups[r.source]) groups[r.source] = [];
            groups[r.source].push(r);
        }

        const sourceLabels = { recent: 'Recent', branded: 'Branded', usda: 'USDA Database' };
        let html = '';
        let idx = 0;
        for (const src of ['recent', 'branded', 'usda']) {
            if (!groups[src]) continue;
            html += '<div class="autocomplete-section">' + sourceLabels[src] + '</div>';
            for (const r of groups[src]) {
                const calText = r.calories ? r.calories + ' kcal' : '';
                const desc = r.brand ? r.brand + ' · ' + r.description.replace(r.brand + ' ', '') : r.description;
                html += '<div class="autocomplete-item" data-idx="' + idx + '" onclick="selectAutocomplete(' + idx + ')">' +
                    '<span>' + escHtml(desc) + '</span>' +
                    '<span class="autocomplete-item-cal">' + calText + '</span>' +
                '</div>';
                idx++;
            }
        }

        dropdown.innerHTML = html;
        dropdown.style.display = 'block';
        dropdown._results = results;
        _autocompleteIdx = -1;
    } catch (_) {
        dropdown.style.display = 'none';
    }
}

window.selectAutocomplete = function(idx) {
    const dropdown = document.getElementById('food-autocomplete');
    const results = dropdown._results || [];
    const r = results[idx];
    if (!r) return;

    document.getElementById('diet-description').value = r.description;
    if (r.source === 'recent') {
        if (r.quantity) document.getElementById('diet-quantity').value = r.quantity;
        if (r.unit) document.getElementById('diet-unit').value = r.unit;
        if (r.entry_type) document.getElementById('diet-entry-type').value = r.entry_type;
        if (r.meal_type) document.getElementById('diet-meal-type').value = r.meal_type;
    }
    dropdown.style.display = 'none';
};

window.handleDescKeydown = function(event) {
    const dropdown = document.getElementById('food-autocomplete');
    const items = dropdown.querySelectorAll('.autocomplete-item');
    if (dropdown.style.display === 'none' || items.length === 0) {
        if (event.key === 'Enter') addDietEntry();
        return;
    }

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        _autocompleteIdx = Math.min(_autocompleteIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('active', i === _autocompleteIdx));
        items[_autocompleteIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        _autocompleteIdx = Math.max(_autocompleteIdx - 1, 0);
        items.forEach((el, i) => el.classList.toggle('active', i === _autocompleteIdx));
        items[_autocompleteIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (_autocompleteIdx >= 0) {
            selectAutocomplete(_autocompleteIdx);
        } else {
            dropdown.style.display = 'none';
            addDietEntry();
        }
    } else if (event.key === 'Escape') {
        dropdown.style.display = 'none';
    }
};

function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Quick Add Recent Foods ─────────────────────────
async function loadRecentFoods() {
    try {
        const data = await apiCall('GET', '/v0/diet/recent?user_id=' + USER_ID + '&limit=10');
        const foods = data.foods || [];
        const container = document.getElementById('recent-foods');
        const list = document.getElementById('recent-foods-list');

        if (foods.length === 0) { container.style.display = 'none'; return; }
        container.style.display = 'block';

        list.innerHTML = foods.map((f, i) => {
            const cal = f.calories ? Math.round(f.calories) + ' kcal' : '';
            const desc = f.description.length > 25 ? f.description.substring(0, 25) + '...' : f.description;
            return '<div class="recent-food-chip">' +
                '<span class="recent-food-chip-desc" title="' + escHtml(f.description) + '">' + escHtml(desc) + '</span>' +
                '<span class="recent-food-chip-cal">' + cal + '</span>' +
                '<button class="recent-food-chip-add" onclick="quickAddRecent(' + i + ')" title="Add">+</button>' +
            '</div>';
        }).join('');
        list._foods = foods;
    } catch (_) {}
}

window.quickAddRecent = async function(idx) {
    const list = document.getElementById('recent-foods-list');
    const foods = list._foods || [];
    const f = foods[idx];
    if (!f) return;

    try {
        await apiCall('POST', '/v0/diet/entries', {
            user_id: USER_ID,
            entry_type: f.entry_type || 'food',
            description: f.description,
            quantity: f.quantity || null,
            unit: f.unit || null,
            meal_type: f.meal_type || guessMealTypeNow(),
            entry_date: document.getElementById('diet-date').value
        });
        showToast('Added: ' + f.description);
        loadDietData();
        loadRecentFoods();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};

function guessMealTypeNow() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) return 'breakfast';
    if (hour >= 11 && hour < 14) return 'lunch';
    if (hour >= 17 && hour < 21) return 'dinner';
    return 'snack';
}

// ─── Barcode Scanner ────────────────────────────────
let _html5QrCode = null;

window.openBarcodeScanner = function() {
    const modal = document.getElementById('barcode-modal');
    modal.style.display = 'block';
    modal.className = 'barcode-modal-overlay';
    modal.innerHTML =
        '<div class="barcode-modal">' +
            '<h3>Scan Barcode</h3>' +
            '<div id="barcode-reader"></div>' +
            '<div id="barcode-result"></div>' +
            '<div style="margin-top:12px">' +
                '<button class="btn btn-outline btn-sm" onclick="closeBarcodeScanner()">Close</button>' +
            '</div>' +
        '</div>';

    if (typeof Html5Qrcode === 'undefined') {
        document.getElementById('barcode-result').innerHTML = '<div style="color:var(--danger);font-size:13px;margin-top:8px">Barcode scanner library not loaded. Check your internet connection.</div>';
        return;
    }

    _html5QrCode = new Html5Qrcode('barcode-reader');
    _html5QrCode.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        onBarcodeSuccess,
        () => {} // ignore scan failures
    ).catch(err => {
        document.getElementById('barcode-result').innerHTML = '<div style="color:var(--danger);font-size:13px;margin-top:8px">Camera access denied or unavailable: ' + err + '</div>';
    });
};

async function onBarcodeSuccess(decodedText) {
    if (_html5QrCode) {
        try { await _html5QrCode.stop(); } catch (_) {}
    }

    const resultDiv = document.getElementById('barcode-result');
    resultDiv.innerHTML = '<div style="color:var(--primary);font-size:13px">Looking up barcode: ' + decodedText + '...</div>';

    try {
        const product = await apiCall('GET', '/v0/diet/barcode/' + encodeURIComponent(decodedText) + '?user_id=' + USER_ID);

        if (product.error) {
            resultDiv.innerHTML = '<div style="color:var(--danger);font-size:13px">' + product.error + ' (' + decodedText + ')</div>';
            return;
        }

        resultDiv.innerHTML =
            '<div class="barcode-result">' +
                '<div class="barcode-result-name">' + escHtml(product.name) + '</div>' +
                '<div class="barcode-result-brand">' + escHtml(product.brand || '') + (product.serving_size ? ' · ' + product.serving_size : '') + '</div>' +
                '<div class="barcode-result-nutrition">' +
                    '<div><strong>' + (product.calories || 0) + '</strong>kcal</div>' +
                    '<div><strong>' + (product.protein_g || 0) + 'g</strong>protein</div>' +
                    '<div><strong>' + (product.carbs_g || 0) + 'g</strong>carbs</div>' +
                    '<div><strong>' + (product.fat_g || 0) + 'g</strong>fat</div>' +
                '</div>' +
                '<div style="margin-top:10px;display:flex;gap:8px">' +
                    '<button class="btn btn-primary btn-sm" onclick="addBarcodeProduct()">Add to Log</button>' +
                    '<button class="btn btn-outline btn-sm" onclick="openBarcodeScanner()">Scan Another</button>' +
                '</div>' +
            '</div>';
        resultDiv._product = product;
    } catch (err) {
        resultDiv.innerHTML = '<div style="color:var(--danger);font-size:13px">Lookup failed: ' + err.message + '</div>';
    }
}

window.addBarcodeProduct = async function() {
    const product = document.getElementById('barcode-result')._product;
    if (!product) return;

    try {
        await apiCall('POST', '/v0/diet/entries', {
            user_id: USER_ID,
            entry_type: 'food',
            description: (product.brand ? product.brand + ' ' : '') + product.name,
            quantity: 1,
            unit: 'serving',
            meal_type: guessMealTypeNow(),
            entry_date: document.getElementById('diet-date').value
        });
        showToast('Added: ' + product.name);
        closeBarcodeScanner();
        loadDietData();
        loadRecentFoods();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};

window.closeBarcodeScanner = function() {
    if (_html5QrCode) {
        try { _html5QrCode.stop(); } catch (_) {}
        _html5QrCode = null;
    }
    document.getElementById('barcode-modal').style.display = 'none';
};

// ─── Saved Meals ────────────────────────────────────
async function loadSavedMeals() {
    try {
        const data = await apiCall('GET', '/v0/diet/meals?user_id=' + USER_ID);
        const meals = data.meals || [];
        const panel = document.getElementById('saved-meals-panel');
        const list = document.getElementById('saved-meals-list');

        if (meals.length === 0) {
            // Show panel only if there are entries to potentially save
            panel.style.display = 'block';
            list.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No saved meals yet. Log some food, then click "Save Current Meal".</div>';
            return;
        }
        panel.style.display = 'block';

        list.innerHTML = meals.map(m => {
            const items = m.items || [];
            return '<div class="saved-meal-card">' +
                '<div class="saved-meal-info">' +
                    '<div class="saved-meal-name">' + escHtml(m.name) + '</div>' +
                    '<div class="saved-meal-meta">' + items.length + ' item(s) · ' + (m.total_calories || 0) + ' kcal · used ' + (m.usage_count || 0) + 'x</div>' +
                '</div>' +
                '<div class="saved-meal-actions">' +
                    '<button class="btn btn-primary btn-sm" style="font-size:11px;padding:4px 10px" onclick="logSavedMeal(\'' + m.meal_id + '\')">Log</button>' +
                    '<button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 8px;color:var(--danger);border-color:var(--danger)" onclick="deleteSavedMeal(\'' + m.meal_id + '\')">&times;</button>' +
                '</div>' +
            '</div>';
        }).join('');
    } catch (_) {}
}

window.showSaveMealDialog = function() {
    document.getElementById('save-meal-dialog').style.display = 'block';
    document.getElementById('save-meal-name').focus();
};

window.saveCurrentMeal = async function() {
    const name = document.getElementById('save-meal-name').value.trim();
    const mealType = document.getElementById('save-meal-type').value;
    if (!name) { showToast('Enter a meal name', 'error'); return; }

    try {
        await apiCall('POST', '/v0/diet/meals/save-current', {
            user_id: USER_ID,
            name,
            meal_type: mealType,
            date: document.getElementById('diet-date').value
        });
        showToast('Meal saved: ' + name);
        document.getElementById('save-meal-dialog').style.display = 'none';
        document.getElementById('save-meal-name').value = '';
        loadSavedMeals();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};

window.logSavedMeal = async function(mealId) {
    try {
        const result = await apiCall('POST', '/v0/diet/meals/' + mealId + '/log', {
            user_id: USER_ID,
            date: document.getElementById('diet-date').value
        });
        showToast('Logged ' + result.logged + ' item(s) from ' + result.meal_name);
        loadDietData();
        loadRecentFoods();
        loadSavedMeals();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};

window.deleteSavedMeal = async function(mealId) {
    if (!confirm('Delete this saved meal?')) return;
    try {
        await apiCall('DELETE', '/v0/diet/meals/' + mealId + '?user_id=' + USER_ID);
        showToast('Meal deleted');
        loadSavedMeals();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};

// ─── Core Entry Functions ───────────────────────────
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
        loadRecentFoods();
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
        const cal = Math.round(data.total_calories || 0);
        const pro = Math.round(data.total_protein || 0);
        const carb = Math.round(data.total_carbs || 0);
        const fat = Math.round(data.total_fat || 0);

        document.getElementById('nc-calories').innerHTML = cal + renderProgressBar(cal, _dietGoals.calories);
        document.getElementById('nc-protein').innerHTML = pro + 'g' + renderProgressBar(pro, _dietGoals.protein_g);
        document.getElementById('nc-carbs').innerHTML = carb + 'g' + renderProgressBar(carb, _dietGoals.carbs_g);
        document.getElementById('nc-fat').innerHTML = fat + 'g' + renderProgressBar(fat, _dietGoals.fat_g);

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
        loadRecentFoods();
    } catch (err) {
        showToast('Failed to delete: ' + err.message, 'error');
    }
};

window.editDietNutrition = function(entryId, currentData) {
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
