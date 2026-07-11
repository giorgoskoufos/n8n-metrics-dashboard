// --- SECTION 7: TAB NAVIGATION & DYNAMIC TABLES ---
window.switchTab = async function(tabName) {
    if (currentTab === tabName) return;
    currentTab = tabName;

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    const activeBtn = document.querySelector(`[onclick="switchTab('${tabName}')"]`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    const thead = document.getElementById('tableHeader') || document.getElementById('table-head');
    const tbody = document.getElementById('executionsTableBody') || document.getElementById('table-body');
    const scrollTrigger = document.getElementById('scrollTrigger') || document.getElementById('scroll-trigger');

    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-500">Loading...</td></tr>';

    if (tabName === 'executions') {
        initExecutionsHeader(); // rebuild filter row + wire events
        const scrollTrigger = document.getElementById('scrollTrigger') || document.getElementById('scroll-trigger');
        if (scrollTrigger) {
            scrollTrigger.style.display = 'block';
            scrollTrigger.innerHTML = '';
        }
        loadMoreExecutions(true);

    } else if (tabName === 'slowest') {
        if (thead) thead.innerHTML = `
            <tr class="text-gray-400 text-sm">
                <th class="p-4 font-medium">Workflow</th>
                <th class="p-4 font-medium">Avg Run Time (7d)</th>
                <th class="p-4 font-medium">Total Runs (7d)</th>
            </tr>
        `;
        if (scrollTrigger) scrollTrigger.style.display = 'none';

        const res = await fetchWithAuth('/api/analytics/slowest');
        const data = await res.json();
        if (tbody) {
            tbody.innerHTML = '';
            data.forEach(row => {
                const avgTime = parseFloat(row.avg_duration).toFixed(3) + 's';
                tbody.innerHTML += `
                    <tr class="hover:bg-gray-800/30 transition-colors text-sm border-b border-gray-800/50">
                        <td class="p-4 text-white">${row.name}</td>
                        <td class="p-4 text-orange-400 font-mono">${avgTime}</td>
                        <td class="p-4 text-n8n-text">${parseInt(row.total_runs).toLocaleString()}</td>
                    </tr>
                `;
            });
        }

    } else if (tabName === 'errors') {
        if (thead) thead.innerHTML = `
            <tr class="text-gray-400 text-sm">
                <th class="p-4 font-medium">Workflow</th>
                <th class="p-4 font-medium">Errors (7d)</th>
                <th class="p-4 font-medium">Total Runs (7d)</th>
                <th class="p-4 font-medium">Error Rate</th>
            </tr>
        `;
        if (scrollTrigger) scrollTrigger.style.display = 'none';

        const res = await fetchWithAuth('/api/analytics/errors');
        const data = await res.json();
        if (tbody) {
            tbody.innerHTML = '';
            data.forEach(row => {
                const errCount = parseInt(row.error_count);
                const totalRuns = parseInt(row.total_runs);
                const rate = ((errCount / totalRuns) * 100).toFixed(1) + '%';
                tbody.innerHTML += `
                    <tr class="hover:bg-gray-800/30 transition-colors text-sm border-b border-gray-800/50">
                        <td class="p-4 text-white">${row.name}</td>
                        <td class="p-4 text-n8n-danger font-bold">${errCount.toLocaleString()}</td>
                        <td class="p-4 text-n8n-text">${totalRuns.toLocaleString()}</td>
                        <td class="p-4 text-n8n-text">${rate}</td>
                    </tr>
                `;
            });
        }
    }
}