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

        const filters = {};
        const from = document.getElementById('filter-from').value;
        const to = document.getElementById('filter-to').value;
        const cat = document.getElementById('filter-category').value;
        const merchant = document.getElementById('filter-merchant').value.trim();

        if (from) filters.date_from = from;
        if (to) filters.date_to = to;
        if (cat) filters.category = cat;
        if (merchant) filters.merchant = merchant;

        try {
            const data = await apiCall('POST', '/v0/query', {
                user_id: USER_ID,
                filters,
                limit: PAGE_SIZE,
                offset: currentOffset
            });

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

        body.innerHTML = expenses.map(e => `
            <tr>
                <td>${formatDate(e.transaction_date)}</td>
                <td>${e.merchant || '-'}</td>
                <td>${e.description || ''}</td>
                <td>${formatCategory(e.category)}</td>
                <td style="text-align:right;font-weight:600">${formatCurrency(e.amount)}</td>
                <td style="text-align:center;white-space:nowrap"><button class="btn-edit" onclick="editExpense('${e.expense_id}')" title="Edit payment">&#x270E;</button><button class="btn-delete" onclick="deleteExpense('${e.expense_id}')" title="Remove payment">&#x2715;</button></td>
            </tr>
        `).join('');
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

    // Initial load
    loadExpenses();
})();
