// Diet Agent - View Nutrition
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('diet', 'nutrition');
    document.getElementById('nutrition-date').value = todayStr();
    loadNutritionPage();
})();

window.loadNutritionPage = async function() {
    const date = document.getElementById('nutrition-date').value;
    document.getElementById('nutrition-date-label').textContent = 'Nutrition: ' + formatDate(date);
    await Promise.all([loadSummary(date), loadEntries(date)]);
};

window.changeDate = function(delta) {
    const input = document.getElementById('nutrition-date');
    const d = new Date(input.value);
    d.setDate(d.getDate() + delta);
    input.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    loadNutritionPage();
};

window.setToday = function() {
    document.getElementById('nutrition-date').value = todayStr();
    loadNutritionPage();
};

async function loadSummary(date) {
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

async function loadEntries(date) {
    const container = document.getElementById('entries-list');
    try {
        const data = await apiCall('GET', '/v0/diet/entries?user_id=' + USER_ID + '&date=' + date);
        if (!data.entries || data.entries.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0">No entries for this date.</div>';
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
                    '<button class="btn-delete" onclick="deleteEntry(\'' + e.entry_id + '\')" title="Delete">x</button>' +
                '</div>' +
            '</div>';
        }).join('');
    } catch (e) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Failed to load entries</div>';
    }
}

window.deleteEntry = async function(entryId) {
    if (!confirm('Delete this entry?')) return;
    try {
        await apiCall('DELETE', '/v0/diet/entries/' + entryId + '?user_id=' + USER_ID);
        showToast('Entry deleted');
        loadNutritionPage();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};

// --- Diet Rules ---
window.toggleRulesPanel = function() {
    const body = document.getElementById('rules-body');
    const arrow = document.getElementById('rules-arrow');
    if (body.style.display === 'none') {
        body.style.display = 'block';
        arrow.innerHTML = '&#9660;';
        loadRules();
    } else {
        body.style.display = 'none';
        arrow.innerHTML = '&#9654;';
    }
};

async function loadRules() {
    const container = document.getElementById('diet-rules-list');
    try {
        const data = await apiCall('GET', '/v0/diet/rules?user_id=' + USER_ID);
        if (!data.rules || data.rules.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No rules set yet.</div>';
            return;
        }
        container.innerHTML = data.rules.map(r =>
            '<div class="diet-rule-card">' +
                '<span class="diet-rule-type-badge">' + r.rule_type + '</span>' +
                '<span class="diet-rule-desc">' + r.description + '</span>' +
                '<button class="btn btn-sm" onclick="deleteDietRule(\'' + r.rule_id + '\')" style="padding:2px 8px;font-size:11px;background:none;color:var(--danger);border:1px solid var(--danger)">x</button>' +
            '</div>'
        ).join('');
    } catch (e) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Failed to load rules</div>';
    }
}

window.addDietRule = async function() {
    const description = document.getElementById('rule-description').value.trim();
    if (!description) return;
    try {
        await apiCall('POST', '/v0/diet/rules', {
            user_id: USER_ID,
            rule_type: document.getElementById('rule-type').value,
            description
        });
        document.getElementById('rule-description').value = '';
        showToast('Rule added');
        loadRules();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};

window.deleteDietRule = async function(ruleId) {
    try {
        await apiCall('DELETE', '/v0/diet/rules/' + ruleId + '?user_id=' + USER_ID);
        showToast('Rule removed');
        loadRules();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
};