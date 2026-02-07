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

        container.innerHTML = `
            <div class="container" style="padding-bottom:0">
                <div class="inquiry-banner show">
                    <div class="inquiry-question">Oggy wants to ask: ${inquiry.question_text}</div>
                    <div class="inquiry-options" id="inquiry-options">
                        ${options.map(opt =>
                            `<button class="inquiry-option-btn" onclick="answerInquiry('${inquiry.inquiry_id}', '${opt}')">${opt.replace(/_/g, ' ')}</button>`
                        ).join('')}
                        <input type="text" id="inquiry-custom-answer" placeholder="Or type your answer..."
                               style="padding:6px 12px;border:1px solid var(--border);border-radius:20px;font-size:13px;width:200px"
                               onkeydown="if(event.key==='Enter')answerInquiryCustom('${inquiry.inquiry_id}')">
                    </div>
                    <span class="inquiry-dismiss" onclick="dismissInquiry('${inquiry.inquiry_id}')">Dismiss</span>
                </div>
            </div>
        `;
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
