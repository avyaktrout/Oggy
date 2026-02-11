// General Assistant - Analytics
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('general', 'analytics');
    loadGeneralAnalytics();
})();

async function loadGeneralAnalytics() {
    // Load projects count
    try {
        const data = await apiCall('GET', '/v0/general/projects?user_id=' + USER_ID);
        document.getElementById('stat-projects').textContent = (data.projects || []).length;
    } catch (e) {
        document.getElementById('stat-projects').textContent = '0';
    }

    // Load chat activity from localStorage (conversation history)
    const chatState = localStorage.getItem('oggy_general_chat');
    let conversationCount = 0;
    if (chatState) {
        try {
            const parsed = JSON.parse(chatState);
            const userMsgs = (parsed.messages || []).filter(m => m.role === 'user');
            conversationCount = userMsgs.length;
        } catch (e) { /* ignore */ }
    }
    document.getElementById('stat-conversations').textContent = conversationCount || '-';

    // Learning events placeholder
    document.getElementById('stat-learning').textContent = '-';

    // Activity chart - placeholder with empty data
    const ctx = document.getElementById('activity-chart');
    if (ctx) {
        const today = new Date();
        const labels = [];
        const data = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
            data.push(0);
        }

        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Messages',
                    data: data,
                    backgroundColor: 'rgba(79, 70, 229, 0.7)',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
            }
        });
    }

    // Check training status
    try {
        const status = await apiCall('GET', '/v0/continuous-learning/status');
        const el = document.getElementById('training-summary');
        if (el && status.is_running) {
            el.innerHTML = '<div style="color:var(--success);font-weight:600;margin-bottom:8px">Training Active</div>' +
                '<div>Level: ' + (status.scale_level_display || '-') + '</div>' +
                '<div>Accuracy: ' + (status.overall_accuracy || '-') + '</div>' +
                '<div>Time Left: ' + (status.training_time_remaining_readable || '-') + '</div>';
        } else if (el && status.overall_accuracy) {
            el.innerHTML = '<div style="margin-bottom:8px">Last Training</div>' +
                '<div>Level: ' + (status.scale_level_display || '-') + '</div>' +
                '<div>Accuracy: ' + (status.overall_accuracy || '-') + '</div>';
        }
    } catch (e) { /* training may not be available */ }
}
