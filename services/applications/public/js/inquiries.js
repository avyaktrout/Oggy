// Inquiry notification widget - loaded on all pages
(function() {
    window.updateInquiryWidget = function(inquiries) {
        const container = document.getElementById('inquiry-banner-container');
        if (!container || !inquiries || inquiries.length === 0) {
            if (container) container.innerHTML = '';
            return;
        }

        const inquiry = inquiries[0]; // Show first pending inquiry
        const options = inquiry.context?.options || [];
        const isConfirmation = inquiry.question_type === 'high_confidence_confirmation';
        const isAdvice = inquiry.question_type === 'ai_advice';

        if (isAdvice) {
            // Advice tip rendering — "Oggy suggests:" with Save/Dismiss
            container.innerHTML = `
                <div class="container" style="padding-bottom:0">
                    <div class="inquiry-banner inquiry-banner--advice show">
                        <div class="inquiry-question">Oggy suggests:</div>
                        <div class="inquiry-advice-text">${inquiry.question_text}</div>
                        <div class="inquiry-options" id="inquiry-options">
                            <button class="inquiry-option-btn inquiry-save-tip" onclick="saveAdviceTip('${inquiry.inquiry_id}')">Save this tip</button>
                            <button class="inquiry-option-btn inquiry-confirm-no" onclick="dismissInquiry('${inquiry.inquiry_id}')">Dismiss</button>
                        </div>
                    </div>
                </div>
            `;
            return;
        }

        let optionsHtml;
        if (isConfirmation) {
            const suggestedCat = inquiry.context?.suggested_category || '';
            const catLabel = suggestedCat.replace(/_/g, ' ');
            const allCategories = ['dining','groceries','transportation','utilities','entertainment','business_meal','shopping','health','personal_care','other'];
            optionsHtml = `
                <button class="inquiry-option-btn inquiry-confirm-yes" onclick="answerInquiry('${inquiry.inquiry_id}', '${suggestedCat}')">Yes, it's ${catLabel}</button>
                <button class="inquiry-option-btn inquiry-confirm-no" onclick="showConfirmationCorrection('${inquiry.inquiry_id}')">No, it's something else</button>
                <div id="inquiry-correction-${inquiry.inquiry_id}" class="inquiry-correction-options" style="display:none">
                    ${allCategories
                        .filter(c => c !== suggestedCat)
                        .map(opt => `<button class="inquiry-option-btn" onclick="answerInquiry('${inquiry.inquiry_id}', '${opt}')">${opt.replace(/_/g, ' ')}</button>`)
                        .join('')}
                </div>
            `;
        } else {
            optionsHtml = `
                ${options.map(opt =>
                    `<button class="inquiry-option-btn" onclick="answerInquiry('${inquiry.inquiry_id}', '${opt}')">${opt.replace(/_/g, ' ')}</button>`
                ).join('')}
                <input type="text" id="inquiry-custom-answer" placeholder="Or type your answer..."
                       style="padding:6px 12px;border:1px solid var(--border);border-radius:20px;font-size:13px;width:200px"
                       onkeydown="if(event.key==='Enter')answerInquiryCustom('${inquiry.inquiry_id}')">
            `;
        }

        container.innerHTML = `
            <div class="container" style="padding-bottom:0">
                <div class="inquiry-banner show">
                    <div class="inquiry-question">Oggy wants to ask: ${inquiry.question_text}</div>
                    <div class="inquiry-options" id="inquiry-options">
                        ${optionsHtml}
                    </div>
                    <span class="inquiry-dismiss" onclick="dismissInquiry('${inquiry.inquiry_id}')">Dismiss</span>
                </div>
            </div>
        `;
    };

    window.showConfirmationCorrection = function(inquiryId) {
        const el = document.getElementById('inquiry-correction-' + inquiryId);
        if (el) el.style.display = el.style.display === 'none' ? 'flex' : 'none';
    };

    window.answerInquiry = async function(inquiryId, answer) {
        try {
            await apiCall('POST', `/v0/inquiries/${inquiryId}/answer`, {
                user_id: USER_ID,
                answer: answer
            });
            showToast('Thanks! Oggy learned from your answer.');
            checkInquiries();
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    window.saveAdviceTip = async function(inquiryId) {
        try {
            await apiCall('POST', `/v0/inquiries/${inquiryId}/answer`, {
                user_id: USER_ID,
                answer: 'saved'
            });
            showToast('Tip saved! Oggy will remember this.');
            checkInquiries();
            loadSavedTips();
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    window.answerInquiryCustom = function(inquiryId) {
        const input = document.getElementById('inquiry-custom-answer');
        const answer = input?.value?.trim();
        if (answer) answerInquiry(inquiryId, answer);
    };

    window.dismissInquiry = async function(inquiryId) {
        try {
            await apiCall('POST', `/v0/inquiries/${inquiryId}/dismiss`, {
                user_id: USER_ID
            });
            checkInquiries();
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    // ── Saved Tips ──

    window.toggleSavedTips = function() {
        const body = document.getElementById('saved-tips-body');
        const arrow = document.getElementById('saved-tips-arrow');
        if (!body) return;
        const showing = body.style.display === 'none';
        body.style.display = showing ? 'block' : 'none';
        if (arrow) arrow.innerHTML = showing ? '&#9660;' : '&#9654;';
        if (showing) loadSavedTips();
    };

    window.loadSavedTips = async function() {
        const list = document.getElementById('saved-tips-list');
        const countEl = document.getElementById('saved-tips-count');
        if (!list) return;

        const domain = window.INQUIRY_DOMAIN || '';
        try {
            const data = await apiCall('GET', `/v0/inquiries/saved-tips?user_id=${USER_ID}&domain=${domain}`);
            const tips = data.tips || [];

            if (countEl) {
                countEl.textContent = tips.length > 0 ? `(${tips.length})` : '';
            }

            if (tips.length === 0) {
                list.innerHTML = '<div class="saved-tips-empty">No saved tips yet. Save tips from Oggy\'s suggestions above.</div>';
                return;
            }

            list.innerHTML = tips.map(tip => {
                const date = tip.answered_at ? new Date(tip.answered_at).toLocaleDateString() : '';
                const topic = tip.topic ? tip.topic.replace(/-/g, ' ') : '';
                return `
                    <div class="saved-tip-item">
                        <div class="saved-tip-text">${tip.question_text}</div>
                        <div class="saved-tip-meta">
                            ${topic ? `<span class="saved-tip-topic">${topic}</span>` : ''}
                            <span class="saved-tip-date">${date}</span>
                            <span class="saved-tip-remove" onclick="removeSavedTip('${tip.inquiry_id}')">Remove</span>
                        </div>
                    </div>
                `;
            }).join('');
        } catch (err) {
            list.innerHTML = '<div class="saved-tips-empty">Failed to load saved tips.</div>';
        }
    };

    window.removeSavedTip = async function(inquiryId) {
        try {
            await apiCall('DELETE', `/v0/inquiries/saved-tips/${inquiryId}?user_id=${USER_ID}`);
            showToast('Tip removed.');
            loadSavedTips();
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    // Load saved tips count on page load
    setTimeout(async () => {
        const countEl = document.getElementById('saved-tips-count');
        if (!countEl) return;
        try {
            const domain = window.INQUIRY_DOMAIN || '';
            const data = await apiCall('GET', `/v0/inquiries/saved-tips?user_id=${USER_ID}&domain=${domain}`);
            const count = (data.tips || []).length;
            countEl.textContent = count > 0 ? `(${count})` : '';
        } catch (e) { /* ignore */ }
    }, 2000);
})();
