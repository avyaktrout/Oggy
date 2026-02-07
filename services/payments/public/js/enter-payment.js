// Enter Payment page logic
(function() {
    renderNav('enter');
    startInquiryPolling();

    // Populate category dropdown
    const catSelect = document.getElementById('category');
    CATEGORIES.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c.replace(/_/g, ' ');
        catSelect.appendChild(opt);
    });

    // Default date to today
    document.getElementById('transaction_date').value = todayStr();

    let pendingExpenseId = null;
    let pendingSuggestion = null;

    const form = document.getElementById('expense-form');
    const submitBtn = document.getElementById('submit-btn');
    const sugBox = document.getElementById('suggestion-box');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
        sugBox.classList.remove('show');

        const amount = parseFloat(document.getElementById('amount').value);
        const description = document.getElementById('description').value.trim();
        const merchant = document.getElementById('merchant').value.trim();
        const transaction_date = document.getElementById('transaction_date').value;
        const category = document.getElementById('category').value || null;
        const tagsRaw = document.getElementById('tags').value.trim();
        const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
        const notes = document.getElementById('notes').value.trim() || null;

        try {
            const expense = await apiCall('POST', '/v0/expenses', {
                user_id: USER_ID,
                amount, description, merchant, transaction_date,
                category, tags, notes
            });

            pendingExpenseId = expense.expense_id;

            if (!category) {
                // Ask Oggy for suggestion
                try {
                    const suggestion = await apiCall('POST', '/v0/categorization/suggest', {
                        user_id: USER_ID,
                        expense_id: pendingExpenseId,
                        amount, description, merchant, transaction_date
                    });

                    pendingSuggestion = suggestion;
                    document.getElementById('sug-category').textContent = suggestion.suggestion.replace(/_/g, ' ');
                    document.getElementById('sug-confidence').textContent =
                        `Confidence: ${Math.round((suggestion.confidence || 0) * 100)}%`;
                    document.getElementById('sug-reasoning').textContent = suggestion.reasoning || '';
                    sugBox.classList.add('show');
                } catch (sugErr) {
                    showToast('Payment saved! (Oggy suggestion unavailable)', 'info');
                    resetForm();
                }
            } else {
                showToast(`Payment saved with category: ${category.replace(/_/g, ' ')}`);
                resetForm();
            }
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add Payment';
        }
    });

    // Accept suggestion
    document.getElementById('sug-accept').addEventListener('click', async () => {
        if (!pendingExpenseId || !pendingSuggestion) return;
        try {
            await apiCall('POST', `/v0/expenses/${pendingExpenseId}/categorize`, {
                category: pendingSuggestion.suggestion,
                source: 'oggy_accepted',
                suggestion_data: {
                    trace_id: pendingSuggestion.trace_id,
                    confidence: pendingSuggestion.confidence
                }
            });
            showToast(`Accepted: ${pendingSuggestion.suggestion.replace(/_/g, ' ')}`);
            sugBox.classList.remove('show');
            resetForm();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    // Reject suggestion - show category picker
    document.getElementById('sug-reject').addEventListener('click', () => {
        const chosen = prompt(
            'Enter the correct category:\n' +
            CATEGORIES.join(', ')
        );
        if (chosen && CATEGORIES.includes(chosen.trim().toLowerCase())) {
            applyCategoryCorrection(chosen.trim().toLowerCase());
        } else if (chosen) {
            showToast('Invalid category', 'error');
        }
    });

    async function applyCategoryCorrection(category) {
        if (!pendingExpenseId) return;
        try {
            await apiCall('POST', `/v0/expenses/${pendingExpenseId}/categorize`, {
                category,
                source: 'oggy_rejected',
                suggestion_data: {
                    trace_id: pendingSuggestion?.trace_id,
                    suggested_category: pendingSuggestion?.suggestion,
                    user_chosen_category: category
                }
            });
            showToast(`Set to: ${category.replace(/_/g, ' ')}`);
            sugBox.classList.remove('show');
            resetForm();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    function resetForm() {
        form.reset();
        document.getElementById('transaction_date').value = todayStr();
        pendingExpenseId = null;
        pendingSuggestion = null;
    }
})();
