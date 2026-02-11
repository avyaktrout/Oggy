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
})();
