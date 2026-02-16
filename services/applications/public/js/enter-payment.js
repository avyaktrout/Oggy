// Enter Payment page logic
(async function() {
    const authed = await initAuth();
    if (!authed) return;
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
    let receiptFoodItems = null; // from receipt scan

    const form = document.getElementById('expense-form');
    const submitBtn = document.getElementById('submit-btn');
    const sugBox = document.getElementById('suggestion-box');
    const dietSugBox = document.getElementById('diet-suggestion-box');

    // ── Diet transfer toggle persistence ──
    const dietToggle = document.getElementById('diet-transfer-enabled');
    dietToggle.checked = localStorage.getItem('oggy_diet_transfer') !== 'false';
    dietToggle.addEventListener('change', () => {
        localStorage.setItem('oggy_diet_transfer', dietToggle.checked);
    });

    // ── Receipt scanning ──
    document.getElementById('receipt-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const status = document.getElementById('receipt-status');
        status.textContent = 'Scanning receipt...';
        status.style.color = 'var(--primary)';

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

            // Auto-fill form
            if (result.total_amount) document.getElementById('amount').value = result.total_amount;
            if (result.merchant) document.getElementById('merchant').value = result.merchant;
            if (result.transaction_date) document.getElementById('transaction_date').value = result.transaction_date;
            if (result.items && result.items.length > 0) {
                document.getElementById('description').value = result.items.map(i => i.name).join(', ');
            }
            if (result.category_suggestion) {
                const catOpt = [...catSelect.options].find(o => o.value === result.category_suggestion);
                if (catOpt) catSelect.value = result.category_suggestion;
            }

            // Store food items for diet transfer
            if (result.is_food_receipt && result.food_items && result.food_items.length > 0) {
                receiptFoodItems = result.food_items;
            } else {
                receiptFoodItems = null;
            }

            const itemCount = result.items ? result.items.length : 0;
            status.textContent = `Found: ${result.merchant || 'Unknown'} — ${itemCount} item(s), $${(result.total_amount || 0).toFixed(2)}`;
            status.style.color = 'var(--success)';
        } catch (err) {
            status.textContent = 'Scan failed: ' + err.message;
            status.style.color = 'var(--danger)';
        }

        // Reset file input for re-use
        e.target.value = '';
    });

    // ── Form submit ──
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
        sugBox.classList.remove('show');
        dietSugBox.classList.remove('show');

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
                    if (typeof checkInquiries === 'function') setTimeout(checkInquiries, 2000);

                    // Check diet transfer after categorization is shown
                    checkDietTransfer(suggestion.suggestion, description, merchant, transaction_date);
                } catch (sugErr) {
                    showToast('Payment saved! (Oggy suggestion unavailable)', 'info');
                    if (typeof checkInquiries === 'function') setTimeout(checkInquiries, 2000);
                    checkDietTransfer(null, description, merchant, transaction_date);
                    resetForm();
                }
            } else {
                showToast(`Payment saved with category: ${category.replace(/_/g, ' ')}`);
                checkDietTransfer(category, description, merchant, transaction_date);
                resetForm();
            }
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add Payment';
        }
    });

    // ── Diet transfer check ──
    function checkDietTransfer(category, description, merchant, transactionDate) {
        if (!dietToggle.checked) return;

        const foodCategories = ['dining', 'groceries', 'coffee', 'business_meal'];
        const isFoodCategory = category && foodCategories.includes(category);
        const hasReceiptFood = receiptFoodItems && receiptFoodItems.length > 0;

        if (!isFoodCategory && !hasReceiptFood) return;

        // Build food description
        let foodDesc = '';
        const itemsHtml = [];

        if (hasReceiptFood) {
            foodDesc = receiptFoodItems.map(f => f.name).join(', ');
            receiptFoodItems.forEach(f => {
                itemsHtml.push(`${f.name} (~${f.estimated_calories || '?'} cal)`);
            });
        } else {
            foodDesc = merchant ? `${description} at ${merchant}` : description;
        }

        document.getElementById('diet-sug-description').value = foodDesc;
        document.getElementById('diet-sug-items').innerHTML = itemsHtml.length
            ? itemsHtml.map(i => `<div>• ${i}</div>`).join('')
            : '';

        // Auto-detect meal type from time
        const hour = new Date().getHours();
        let mealGuess = 'snack';
        if (hour >= 5 && hour < 11) mealGuess = 'breakfast';
        else if (hour >= 11 && hour < 14) mealGuess = 'lunch';
        else if (hour >= 17 && hour < 21) mealGuess = 'dinner';

        // Use receipt guess if available
        if (hasReceiptFood && receiptFoodItems[0].meal_type_guess) {
            mealGuess = receiptFoodItems[0].meal_type_guess;
        }

        document.getElementById('diet-sug-meal').value = mealGuess;

        // Guess entry type
        const lowerDesc = foodDesc.toLowerCase();
        const isLiquid = /\b(drink|coffee|tea|juice|soda|water|smoothie|latte|cappuccino|beer|wine|cocktail|energy)\b/.test(lowerDesc);
        document.getElementById('diet-sug-type').value = isLiquid ? 'liquid' : 'food';

        dietSugBox.classList.add('show');
    }

    // ── Diet suggestion accept ──
    document.getElementById('diet-sug-accept').addEventListener('click', async () => {
        const description = document.getElementById('diet-sug-description').value.trim();
        const mealType = document.getElementById('diet-sug-meal').value;
        const entryType = document.getElementById('diet-sug-type').value;
        const transactionDate = document.getElementById('transaction_date').value;

        if (!description) {
            showToast('Enter a food description', 'error');
            return;
        }

        try {
            await apiCall('POST', '/v0/diet/entries', {
                user_id: USER_ID,
                entry_type: entryType,
                description: description,
                meal_type: mealType,
                entry_date: transactionDate
            });
            showToast('Added to diet log!');
            dietSugBox.classList.remove('show');
            receiptFoodItems = null;
        } catch (err) {
            showToast('Diet entry failed: ' + err.message, 'error');
        }
    });

    // Diet suggestion dismiss
    document.getElementById('diet-sug-dismiss').addEventListener('click', () => {
        dietSugBox.classList.remove('show');
        receiptFoodItems = null;
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
        // Restore diet toggle from localStorage
        dietToggle.checked = localStorage.getItem('oggy_diet_transfer') !== 'false';
    }

    // ── Helper: read file as base64 ──
    function readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                const commaIdx = dataUrl.indexOf(',');
                const meta = dataUrl.substring(0, commaIdx); // "data:image/jpeg;base64"
                const base64 = dataUrl.substring(commaIdx + 1);
                const mimeMatch = meta.match(/data:([^;]+)/);
                resolve({ base64, mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg' });
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }
})();
