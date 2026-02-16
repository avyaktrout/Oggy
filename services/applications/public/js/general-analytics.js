// General Assistant - Analytics
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('general', 'analytics');
    loadGeneralAnalytics();
})();

async function loadGeneralAnalytics() {
    try {
        const data = await apiCall('GET', '/v0/general/analytics?user_id=' + USER_ID);

        // Stats cards
        document.getElementById('stat-conversations').textContent = data.total_conversations || 0;
        document.getElementById('stat-learning').textContent = data.learning_events || 0;

        // Projects count
        try {
            const projData = await apiCall('GET', '/v0/general/projects?user_id=' + USER_ID);
            document.getElementById('stat-projects').textContent = (projData.projects || []).length;
        } catch (e) {
            document.getElementById('stat-projects').textContent = '0';
        }

        // Activity chart
        const ctx = document.getElementById('activity-chart');
        if (ctx) {
            const today = new Date();
            const labels = [];
            const chartData = [];
            const activityMap = {};

            // Build map from server data
            for (const row of (data.daily_activity || [])) {
                activityMap[row.day.split('T')[0]] = parseInt(row.count);
            }

            for (let i = 13; i >= 0; i--) {
                const d = new Date(today);
                d.setDate(d.getDate() - i);
                const key = d.toISOString().split('T')[0];
                labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
                chartData.push(activityMap[key] || 0);
            }

            new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Messages',
                        data: chartData,
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

        // Training status
        const el = document.getElementById('training-summary');
        if (el && data.training) {
            const t = data.training;
            el.innerHTML = '<div style="margin-bottom:8px">Last Training</div>' +
                '<div>Level: ' + (t.level || '-') + '</div>' +
                '<div>Accuracy: ' + (t.accuracy || '-') + '</div>';
        }

        // Also check if training is currently running
        try {
            const status = await apiCall('GET', '/v0/continuous-learning/status?domain=general');
            if (el && status.is_running) {
                el.innerHTML = '<div style="color:var(--success);font-weight:600;margin-bottom:8px">Training Active</div>' +
                    '<div>Level: ' + (status.scale_level_display || '-') + '</div>' +
                    '<div>Accuracy: ' + (status.overall_accuracy || '-') + '</div>' +
                    '<div>Time Left: ' + (status.training_time_remaining_readable || '-') + '</div>';
            }
        } catch (e) { /* ignore */ }

    } catch (err) {
        console.error('Failed to load analytics', err);
        document.getElementById('stat-conversations').textContent = '-';
        document.getElementById('stat-learning').textContent = '-';
        document.getElementById('stat-projects').textContent = '-';
    }
}
