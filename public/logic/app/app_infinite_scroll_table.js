// --- SECTION 5: INFINITE SCROLL TABLE ---
window.loadMoreExecutions = async function(reset = false) {
    if (currentTab !== 'executions') return;
    if (isFetchingExecutions) return;
    isFetchingExecutions = true;

    if (reset) {
        currentOffset = 0;
        const tbody = document.getElementById('table-body') || document.getElementById('executionsTableBody');
        if (tbody) tbody.innerHTML = '';
    }

    const executions = await fetchExecutions(currentOffset, LIMIT);
    const tbody = document.getElementById('table-body') || document.getElementById('executionsTableBody');
    const trigger = document.getElementById('scroll-trigger') || document.getElementById('scrollTrigger');

    if (!tbody) {
        isFetchingExecutions = false;
        return;
    }

    if (executions.length > 0) {
        executions.forEach(exec => {
            const startStr = window.formatTime(exec.startedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
            const endStr = window.formatTime(exec.stoppedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
            const duration = exec.duration < 1 ? Math.round(exec.duration * 1000) + 'ms' : parseFloat(exec.duration).toFixed(3) + 's';

            const isError = exec.status !== 'success';

            const statusHtml = !isError
                ? `<span class="flex items-center gap-2 text-[#278250]"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg> Success</span>`
                : `<span class="flex items-center gap-2 text-[#f16a75] font-bold"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path></svg> Error</span>`;

            const actionAttr = isError ? `onclick="showError('${exec.exec_id}')" style="cursor: pointer;" title="View Error"` : '';

            tbody.innerHTML += `
                <tr class="hover:bg-gray-800/30 transition-colors text-sm border-b border-gray-800/50" ${actionAttr}>
                    <td class="p-4 text-gray-500 font-mono">#${exec.exec_id}</td>
                    <td class="p-4 text-white">${exec.name}</td>
                    <td class="p-4">${statusHtml}</td>
                    <td class="p-4 text-n8n-text">${startStr}</td>
                    <td class="p-4 text-n8n-text">${endStr}</td>
                    <td class="p-4 text-n8n-text">${duration}</td>
                </tr>
            `;
        });
        currentOffset += LIMIT;
    } else {
        if (trigger) trigger.innerHTML = "No more executions.";
    }

    isFetchingExecutions = false;
}

window.hasActiveFilters = function() {
    return ['execWorkflowFilter', 'execStatusFilter', 'execIdFilter',
        'execStartFilter', 'execEndFilter', 'execMinDurFilter']
        .some(id => {
            const el = document.getElementById(id);
            return el && el.value && el.value.trim() !== '';
        });
}

window.setupInfiniteScroll = function() {
    const trigger = document.getElementById('scrollTrigger') || document.getElementById('scroll-trigger');
    if (!trigger) return;

    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && currentTab === 'executions' && !isFetchingExecutions) {
            loadMoreExecutions();
        }
    }, {
        root: null,
        threshold: 0.1
    });

    observer.observe(trigger);
}

window.refreshData = async function() {
    const data = await fetchMetricsData();
    if (data) {
        updateKpiCards(data.summary);
        updateLineChart(data.hourlyData);
        if (data.topWorkflows) {
            updateDoughnutChart(data.topWorkflows);
            populateDropdown(data.topWorkflows);
            lastTopWorkflows = data.topWorkflows; // cache for exec filter
        }
    }

    // Fetch Concurrency
    const dateInput = document.getElementById('trafficDate');
    fetchConcurrency(dateInput ? dateInput.value : null);
}

window.fetchConcurrency = async function(dateVal) {
    let url = '/api/analytics/concurrency';

    if (dateVal) {
        // Construct Local 00:00:00 to 23:59:59 times
        const start = new Date(dateVal + 'T00:00:00');
        const end = new Date(dateVal + 'T23:59:59.999');
        url += `?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
    }

    const concRes = await fetchWithAuth(url);
    if (concRes.ok) {
        const concData = await concRes.json();
        updateConcurrencyChart(concData);
    }
}

window.initDateFilter = async function() {
    const rangeStart = document.getElementById('rangeStart');
    const rangeEnd = document.getElementById('rangeEnd');

    try {
        const res = await fetchWithAuth('/api/analytics/first-execution-date');
        let firstDateIso = '';
        if (res.ok) {
            const data = await res.json();
            if (data.firstDate) {
                firstDateIso = data.firstDate.substring(0, 10);
                if (rangeStart) rangeStart.min = firstDateIso;
                if (rangeEnd) rangeEnd.min = firstDateIso;
            }
        }

        // Max is always today
        const todayLocal = new Date();
        const offset = todayLocal.getTimezoneOffset() * 60000;
        const localISOTime = (new Date(todayLocal.getTime() - offset)).toISOString().split('T')[0];
        if (rangeStart) rangeStart.max = localISOTime;
        if (rangeEnd) rangeEnd.max = localISOTime;

        // Custom Range Listeners -> Clear highlights on manual change
        [rangeStart, rangeEnd].forEach(el => {
            el?.addEventListener('change', () => {
                window.lastPresetHours = null;
                refreshData();
            });
        });

        // Concurrency chart listeners
        const trafficDate = document.getElementById('trafficDate');
        const intervalSelect = document.getElementById('concurrencyInterval');
        if (trafficDate) {
            trafficDate.min = firstDateIso;
            trafficDate.max = localISOTime;
            trafficDate.addEventListener('change', (e) => {
                // Clear the sub-preset highlight
                const btn = document.getElementById('btnConc24h');
                if (btn) {
                    btn.classList.replace('bg-indigo-600/20', 'bg-gray-800/40');
                    btn.classList.replace('text-indigo-400', 'text-gray-400');
                }
                fetchConcurrency(e.target.value);
            });
        }
        if (intervalSelect) {
            intervalSelect.addEventListener('change', () => {
                // Interval just re-filters the cached lastRawConcurrency
                updateConcurrencyChart(lastRawConcurrency);
            });
        }

        // Set Default 7d Macro
        applyPreset(168);

    } catch (e) {
        console.error("Date Filter Init failed:", e);
    }
}

;(async () => {
    await initSettings();
    
    // Only run dashboard-specific logic if the core elements exist
    if (!initDashboard()) {
        console.log("[INIT] Non-dashboard page detected. Skipping chart initialization.");
        return;
    }

    initCharts();
    setupInfiniteScroll();
    await initDateFilter();
    initExecutionsHeader(); // Initialize filters on boot

    const wfFilter = document.getElementById('workflowFilter');
    if (wfFilter) wfFilter.addEventListener('change', refreshData);
})();

