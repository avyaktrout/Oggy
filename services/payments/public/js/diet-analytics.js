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
                totalEntries += (data.total_entries || 0);
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
}