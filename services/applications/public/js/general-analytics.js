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

        // Domain learning stats
        const dl = data.domain_learning || {};
        document.getElementById('stat-subjects').textContent = dl.enabled_tags || 0;
        document.getElementById('stat-packs').textContent = dl.active_packs || 0;
        document.getElementById('stat-cards').textContent = dl.total_cards || 0;
        document.getElementById('stat-plans').textContent = dl.study_plans_saved || 0;

        // Subject tags
        const tagContainer = document.getElementById('domain-tags-list');
        if (dl.tags && dl.tags.length > 0) {
            tagContainer.innerHTML = dl.tags.map(t => `
                <div style="background:var(--bg-secondary,#f8fafc);border-radius:8px;padding:10px 14px;border:1px solid var(--border-color,#e2e8f0)">
                    <div style="font-weight:600;font-size:14px;margin-bottom:4px">${t.display_name || t.tag}</div>
                    <div style="font-size:12px;color:var(--text-muted)">${parseInt(t.pack_count) || 0} packs, ${parseInt(t.card_count) || 0} cards</div>
                </div>
            `).join('');
        } else {
            tagContainer.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No subjects tracked yet</p>';
        }

        // Load benchmarks
        loadGeneralBenchmarks();

    } catch (err) {
        console.error('Failed to load analytics', err);
        document.getElementById('stat-conversations').textContent = '-';
        document.getElementById('stat-learning').textContent = '-';
        document.getElementById('stat-projects').textContent = '-';
    }
}

async function loadGeneralBenchmarks() {
    const section = document.getElementById('general-training-section');
    if (!section) return;
    try {
        const data = await apiCall('GET', '/v0/benchmark-analytics?domain=general&limit=15');
        if (!data.total_benchmarks) {
            section.innerHTML = '<h2 style="font-size:18px;font-weight:600;margin-bottom:12px">Training Performance</h2>' +
                '<div class="analytics-panel"><p style="text-align:center;color:var(--text-muted);padding:20px">No training data yet. Start training from the Chat page.</p></div>';
            return;
        }
        document.getElementById('general-level').textContent = data.current_state.level || '-';
        document.getElementById('general-winrate').textContent = (parseFloat(data.summary.win_rate) * 100).toFixed(0) + '%';
        document.getElementById('general-oggy-acc').textContent = (parseFloat(data.summary.avg_oggy_accuracy) * 100).toFixed(1) + '%';

        const ts = data.time_series;
        const ctx = document.getElementById('general-accuracy-chart');
        if (ctx && ts.length > 0) {
            new Chart(ctx, {
                type: 'line',
                data: {
                    labels: ts.map(r => '#' + r.index),
                    datasets: [
                        { label: 'Oggy', data: ts.map(r => +(r.oggy_accuracy * 100).toFixed(1)), borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)', fill: true, tension: 0.35, pointRadius: 3, borderWidth: 2.5 },
                        { label: 'Base', data: ts.map(r => +(r.base_accuracy * 100).toFixed(1)), borderColor: '#cbd5e1', backgroundColor: 'rgba(203,213,225,0.08)', fill: true, tension: 0.35, pointRadius: 3, borderWidth: 2.5, borderDash: [6, 4] }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { position: 'top' } },
                    scales: {
                        y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, grid: { color: '#f1f5f9' } },
                        x: { grid: { display: false } }
                    }
                }
            });
        }
    } catch (err) {
        console.error('Failed to load general benchmarks', err);
    }

    // Per-intent chart
    try {
        const intentData = await apiCall('GET', '/v0/benchmark-analytics/intent-performance?domain=general');
        const tested = (intentData.intents || []).filter(i => i.status !== 'untested');
        const panel = document.getElementById('intent-panel');
        if (tested.length > 0 && panel) {
            panel.style.display = '';
            tested.sort((a, b) => (a.accuracy || 0) - (b.accuracy || 0));
            const ctx = document.getElementById('chart-intent').getContext('2d');
            new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: tested.map(i => i.display_name),
                    datasets: [{ label: 'Accuracy %', data: tested.map(i => ((i.accuracy || 0) * 100).toFixed(1)), backgroundColor: tested.map(i => i.pass ? '#22c55e' : '#ef4444'), borderRadius: 4 }]
                },
                options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } } }
            });
            const failing = tested.filter(i => !i.pass);
            const trainBtn = document.getElementById('intent-train-weakest');
            if (trainBtn && failing.length > 0) {
                trainBtn.style.display = '';
                trainBtn.dataset.weakest = JSON.stringify(failing.map(i => i.intent_name));
            }
        }
    } catch (e) { /* intent system may not have data */ }
}

window.trainOnWeakestIntents = async function(domain) {
    const btn = document.getElementById('intent-train-weakest');
    const intents = btn && btn.dataset.weakest ? JSON.parse(btn.dataset.weakest) : [];
    if (intents.length === 0) { showToast('No failing intents to train on'); return; }
    const chatPage = domain === 'diet' ? '/diet-chat.html' : domain === 'general' ? '/general-chat.html' : '/chat.html';
    sessionStorage.setItem('oggy_train_intents', JSON.stringify(intents));
    window.location.href = chatPage + '?auto_train=1';
};
