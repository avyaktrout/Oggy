// View Payments page logic
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderNav('view');
    startInquiryPolling();

    // Populate category filter
    const catFilter = document.getElementById('filter-category');
    CATEGORIES.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c.replace(/_/g, ' ');
        catFilter.appendChild(opt);
    });

    // Diet transfer toggle persistence
    const dietToggle = document.getElementById('diet-transfer-toggle');
    dietToggle.checked = localStorage.getItem('oggy_view_diet_transfer') === 'true';
    dietToggle.addEventListener('change', () => {
        localStorage.setItem('oggy_view_diet_transfer', dietToggle.checked);
        renderExpenses(allExpenses);
    });
    const FOOD_CATEGORIES = ['dining', 'groceries', 'coffee', 'business_meal'];
    const FOOD_KEYWORDS = /\b(food|eat|lunch|dinner|breakfast|brunch|restaurant|burger|pizza|taco|burrito|sushi|ramen|sandwich|salad|chicken|steak|pasta|rice|noodle|soup|coffee|tea|juice|smoothie|drink|beverage|bar|grill|cafe|diner|bakery|chipotle|mcdonald|wendy|subway|panera|chick-fil-a|popeyes|taco bell|dunkin|starbucks|panda express|five guys|shake shack|wingstop|domino|papa john|little caesars|buffalo wild wings|ihop|waffle house|denny|cracker barrel|olive garden|applebee|chili|outback|red lobster|cheesecake factory|grocery|kroger|walmart|target|aldi|trader joe|whole foods|publix|safeway|costco|sam's club)\b/i;

    let currentOffset = 0;
    const PAGE_SIZE = 50;
    let allExpenses = [];

    // Load on page load
    window.loadExpenses = async function() {
        currentOffset = 0;
        allExpenses = [];
        await fetchExpenses();
    };

    window.loadMore = async function() {
        await fetchExpenses(true);
    };

    window.clearFilters = function() {
        document.getElementById('filter-from').value = '';
        document.getElementById('filter-to').value = '';
        document.getElementById('filter-category').value = '';
        document.getElementById('filter-merchant').value = '';
        loadExpenses();
    };

    async function fetchExpenses(append = false) {
        const body = document.getElementById('expenses-body');
        if (!append) {
            body.innerHTML = '<tr><td colspan="6" class="loading"><span class="spinner"></span>Loading...</td></tr>';
        }

        const params = { user_id: USER_ID, limit: PAGE_SIZE, offset: currentOffset };
        const from = document.getElementById('filter-from').value;
        const to = document.getElementById('filter-to').value;
        const cat = document.getElementById('filter-category').value;
        const merchant = document.getElementById('filter-merchant').value.trim();

        if (from) params.start_date = from;
        if (to) params.end_date = to;
        if (cat) params.category = cat;
        if (merchant) params.merchant = merchant;

        try {
            const data = await apiCall('POST', '/v0/query', params);

            const expenses = data.expenses || data.results || [];
            if (append) {
                allExpenses = allExpenses.concat(expenses);
            } else {
                allExpenses = expenses;
            }

            renderExpenses(allExpenses);
            currentOffset += expenses.length;

            // Show/hide load more
            const loadMoreBtn = document.getElementById('load-more-btn');
            loadMoreBtn.style.display = expenses.length >= PAGE_SIZE ? 'inline-flex' : 'none';

            // Update summary
            const totalAmount = allExpenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
            document.getElementById('sum-count').textContent = allExpenses.length;
            document.getElementById('sum-amount').textContent = formatCurrency(totalAmount);

        } catch (err) {
            body.innerHTML = `<tr><td colspan="6" style="color:var(--danger);padding:16px">${err.message}</td></tr>`;
        }
    }

    function renderExpenses(expenses) {
        const body = document.getElementById('expenses-body');
        if (expenses.length === 0) {
            body.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted);padding:16px;text-align:center">No payments found</td></tr>';
            return;
        }

        const showDiet = dietToggle.checked;
        body.innerHTML = expenses.map(e => {
            const catLower = (e.category || '').toLowerCase();
            const combined = `${e.description || ''} ${e.merchant || ''} ${catLower}`;
            const isFood = showDiet && (FOOD_CATEGORIES.includes(catLower) || FOOD_KEYWORDS.test(combined));
            const dietBtn = isFood ? `<button class="btn-diet" onclick="openDietTransfer('${e.expense_id}')" title="Send to Diet" style="background:none;border:none;cursor:pointer;font-size:16px;padding:2px 4px">&#127869;</button>` : '';
            return `<tr>
                <td>${formatDate(e.transaction_date)}</td>
                <td>${e.merchant || '-'}</td>
                <td>${e.description || ''}</td>
                <td>${formatCategory(e.category)}</td>
                <td style="text-align:right;font-weight:600">${formatCurrency(e.amount)}</td>
                <td style="text-align:center;white-space:nowrap">${dietBtn}<button class="btn-edit" onclick="editExpense('${e.expense_id}')" title="Edit payment">&#x270E;</button><button class="btn-delete" onclick="deleteExpense('${e.expense_id}')" title="Remove payment">&#x2715;</button></td>
            </tr>`;
        }).join('');
    }

    // --- Edit ---
    // Populate edit category dropdown
    const editCat = document.getElementById('edit-category');
    CATEGORIES.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c.replace(/_/g, ' ');
        editCat.appendChild(opt);
    });

    window.editExpense = function(expenseId) {
        const expense = allExpenses.find(e => e.expense_id === expenseId);
        if (!expense) return;
        document.getElementById('edit-id').value = expense.expense_id;
        document.getElementById('edit-date').value = expense.transaction_date ? expense.transaction_date.split('T')[0] : '';
        document.getElementById('edit-amount').value = expense.amount || '';
        document.getElementById('edit-merchant').value = expense.merchant || '';
        document.getElementById('edit-description').value = expense.description || '';
        document.getElementById('edit-category').value = expense.category || '';
        document.getElementById('edit-notes').value = expense.notes || '';
        document.getElementById('edit-modal').style.display = 'flex';
    };

    window.closeEditModal = function() {
        document.getElementById('edit-modal').style.display = 'none';
    };

    window.saveExpense = async function() {
        const expenseId = document.getElementById('edit-id').value;
        const saveBtn = document.getElementById('edit-save-btn');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
            const updates = {
                transaction_date: document.getElementById('edit-date').value,
                amount: parseFloat(document.getElementById('edit-amount').value),
                merchant: document.getElementById('edit-merchant').value,
                description: document.getElementById('edit-description').value,
                category: document.getElementById('edit-category').value || null,
                notes: document.getElementById('edit-notes').value || null
            };
            const updated = await apiCall('PUT', '/v0/expenses/' + expenseId, updates);
            // Update local data
            const idx = allExpenses.findIndex(e => e.expense_id === expenseId);
            if (idx !== -1) Object.assign(allExpenses[idx], updated);
            renderExpenses(allExpenses);
            const totalAmount = allExpenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
            document.getElementById('sum-count').textContent = allExpenses.length;
            document.getElementById('sum-amount').textContent = formatCurrency(totalAmount);
            closeEditModal();
            showToast('Payment updated');
        } catch (err) {
            showToast('Failed to save: ' + err.message, 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    };

    // Close modal on overlay click
    document.getElementById('edit-modal').addEventListener('click', function(e) {
        if (e.target === this) closeEditModal();
    });

    // --- Delete ---
    window.deleteExpense = async function(expenseId) {
        if (!confirm('Remove this payment?')) return;
        try {
            await apiCall('DELETE', '/v0/expenses/' + expenseId);
            allExpenses = allExpenses.filter(e => e.expense_id !== expenseId);
            renderExpenses(allExpenses);
            const totalAmount = allExpenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
            document.getElementById('sum-count').textContent = allExpenses.length;
            document.getElementById('sum-amount').textContent = formatCurrency(totalAmount);
            showToast('Payment removed');
        } catch (err) {
            showToast('Failed to remove: ' + err.message, 'error');
        }
    };

    // --- Diet Transfer ---
    window.openDietTransfer = function(expenseId) {
        const expense = allExpenses.find(e => e.expense_id === expenseId);
        if (!expense) return;

        const desc = expense.merchant
            ? `${expense.description || ''} at ${expense.merchant}`.trim()
            : (expense.description || '');
        document.getElementById('diet-modal-desc').value = desc;
        document.getElementById('diet-modal-date').value = expense.transaction_date
            ? expense.transaction_date.split('T')[0]
            : todayStr();

        // Guess meal type from description
        const lower = desc.toLowerCase();
        const isLiquid = /\b(drink|coffee|tea|juice|soda|water|smoothie|latte|cappuccino|beer|wine|cocktail|energy)\b/.test(lower);
        document.getElementById('diet-modal-type').value = isLiquid ? 'liquid' : 'food';

        // Guess meal from time or category
        let meal = 'snack';
        if (expense.category === 'coffee') meal = 'snack';
        else {
            const hour = new Date().getHours();
            if (hour >= 5 && hour < 11) meal = 'breakfast';
            else if (hour >= 11 && hour < 14) meal = 'lunch';
            else if (hour >= 17 && hour < 21) meal = 'dinner';
        }
        document.getElementById('diet-modal-meal').value = meal;

        document.getElementById('diet-modal').style.display = 'flex';
    };

    window.closeDietModal = function() {
        document.getElementById('diet-modal').style.display = 'none';
    };

    window.sendToDiet = async function() {
        const desc = document.getElementById('diet-modal-desc').value.trim();
        if (!desc) { showToast('Enter a food description', 'error'); return; }

        const btn = document.getElementById('diet-modal-send');
        btn.disabled = true;
        btn.textContent = 'Sending...';
        try {
            await apiCall('POST', '/v0/diet/entries', {
                user_id: USER_ID,
                entry_type: document.getElementById('diet-modal-type').value,
                description: desc,
                meal_type: document.getElementById('diet-modal-meal').value,
                entry_date: document.getElementById('diet-modal-date').value
            });
            showToast('Added to diet log!');
            closeDietModal();
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Send to Diet';
        }
    };

    // Close diet modal on overlay click
    document.getElementById('diet-modal').addEventListener('click', function(e) {
        if (e.target === this) closeDietModal();
    });

    // Initial load
    loadExpenses();
})();
