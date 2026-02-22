// Diet Agent - Analytics
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar('diet', 'analytics');
    loadDietAnalytics();
})();

async function loadDietAnalytics() {
    const today = new Date();
    const dates = [];
    const calorieData = [];
    let totalProtein = 0, totalCarbs = 0, totalFat = 0;
    let totalEntries = 0, daysWithData = 0;

    for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        dates.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));

        try {
            const data = await apiCall('GET', '/v0/diet/nutrition?user_id=' + USER_ID + '&date=' + dateStr);
            const cal = Math.round(data.total_calories || 0);
            calorieData.push(cal);
            if (cal > 0) {
                daysWithData++;
                totalEntries += parseInt(data.total_entries) || 0;
                totalProtein += (data.total_protein || 0);
                totalCarbs += (data.total_carbs || 0);
                totalFat += (data.total_fat || 0);
            }
        } catch (e) {
            calorieData.push(0);
        }
    }

    // Stats
    const totalCal = calorieData.reduce((a, b) => a + b, 0);
    document.getElementById('stat-entries').textContent = totalEntries;
    document.getElementById('stat-avg-cal').textContent = daysWithData > 0 ? Math.round(totalCal / daysWithData) : '-';
    document.getElementById('stat-days').textContent = daysWithData;

    // Calories chart
    const ctx1 = document.getElementById('calories-chart');
    if (ctx1) {
        new Chart(ctx1, {
            type: 'bar',
            data: {
                labels: dates,
                datasets: [{
                    label: 'Calories',
                    data: calorieData,
                    backgroundColor: 'rgba(79, 70, 229, 0.7)',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true } }
            }
        });
    }

    // Macros chart
    const ctx2 = document.getElementById('macros-chart');
    if (ctx2 && (totalProtein + totalCarbs + totalFat) > 0) {
        new Chart(ctx2, {
            type: 'doughnut',
            data: {
                labels: ['Protein', 'Carbs', 'Fat'],
                datasets: [{
                    data: [Math.round(totalProtein), Math.round(totalCarbs), Math.round(totalFat)],
                    backgroundColor: ['#10b981', '#f59e0b', '#ef4444']
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' }
                }
            }
        });
    } else if (ctx2) {
        ctx2.parentElement.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:14px">Not enough data yet</div>';
    }

    // Load training performance
    loadDietBenchmarks();
}

async function loadDietBenchmarks() {
    const section = document.getElementById('diet-training-section');
    if (!section) return;
    try {
        const data = await apiCall('GET', '/v0/benchmark-analytics?domain=diet&limit=15');
        if (!data.total_benchmarks) {
            section.innerHTML = '<h2 style="font-size:18px;font-weight:600;margin-bottom:12px">Training Performance</h2>' +
                '<div class="analytics-panel"><p style="text-align:center;color:var(--text-muted);padding:20px">No training data yet. Start diet training from the Chat page.</p></div>';
            return;
        }
        document.getElementById('diet-level').textContent = data.current_state.level || '-';
        document.getElementById('diet-winrate').textContent = (parseFloat(data.summary.win_rate) * 100).toFixed(0) + '%';
        document.getElementById('diet-oggy-acc').textContent = (parseFloat(data.summary.avg_oggy_accuracy) * 100).toFixed(1) + '%';

        const ts = data.time_series;
        const ctx = document.getElementById('diet-accuracy-chart');
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
        console.error('Failed to load diet benchmarks', err);
    }
}