// ==========================================
// n8n Metrics Monitor - Frontend Logic
// ==========================================

// --- SECTION 1: GLOBALS ---
let doughnutChart = null;
let concurrencyChart = null;
if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = "'Open Sans', sans-serif";
    Chart.defaults.color = '#eeeeee';
}
let currentTab = 'executions'; // Default active tab        

let currentOffset = 0;
const LIMIT = 20;
let isFetchingExecutions = false;
let lastRawConcurrency = []; // Cache for raw 5-minute points
let lastTopWorkflows = [];   // Cache for exec filter dropdown

window.userSettings = { timezone: 'auto' };

/**
 * Centrally formats any UTC string into the user's preferred timezone.
 */
window.formatTime = (utcStr, options = {}) => {
    if (!utcStr) return 'N/A';
    
    // Ensure string is treated as UTC if it doesn't have an offset
    const dateStr = (utcStr.endsWith('Z') || utcStr.includes('+')) ? utcStr : (utcStr + 'Z');
    const date = new Date(dateStr);
    
    // Default to 24-hour time to avoid 12/24 confusion
    const baseOptions = {
        timeZone: window.userSettings.timezone === 'auto' ? undefined : window.userSettings.timezone,
        hour12: false,
        hourCycle: 'h23',
        ...options
    };
    
    return date.toLocaleString([], baseOptions);
};

// Fetch settings once at boot
async function initSettings() {
    try {
        const res = await fetchWithAuth('/api/settings');
        if (res.ok) {
            window.userSettings = await res.json();
            console.log("[SETTINGS] Timezone initialized:", window.userSettings.timezone || 'auto');
        }
    } catch(e) {}
}

// --- SECTION 1.5: HEALTH CHECK HELPER ---
async function checkN8nHealth() {
    const healthContainer = document.getElementById('n8nHealthIndicator');
    if (!healthContainer) return;
    
    try {
        const res = await fetchWithAuth('/api/n8n-health');
        if (res.ok) {
            const data = await res.json();
            if (data.status === 'ok') {
                healthContainer.innerHTML = `<span class="flex h-2 w-2 relative mr-2">
  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
  <span class="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
</span> <span class="text-[10px] text-green-400 font-bold tracking-widest uppercase">n8n Online</span>`;
                return;
            }
        }
        throw new Error();
    } catch(e) {
        healthContainer.innerHTML = `<span class="flex h-2 w-2 relative mr-2">
  <span class="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
</span> <span class="text-[10px] text-red-500 font-bold tracking-widest uppercase">n8n Offline</span>`;
    }
}

document.addEventListener('DOMContentLoaded', checkN8nHealth);

// --- SECTION 2: CHART INITIALIZATION ---
function initCharts() {
    const ctxLine = document.getElementById('lineChart').getContext('2d');
    lineChart = new Chart(ctxLine, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Success', data: [], borderColor: '#278250', backgroundColor: 'rgba(39, 130, 80, 0.1)', tension: 0.4, borderWidth: 2, fill: false, pointRadius: 0, pointHitRadius: 10, pointHoverRadius: 5 },
                { label: 'Errors', data: [], borderColor: '#f16a75', backgroundColor: 'rgba(241, 106, 117, 0.1)', tension: 0.4, borderWidth: 2, fill: false, pointRadius: 0, pointHitRadius: 10, pointHoverRadius: 5 }
            ]
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false,
            plugins: { 
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (tooltipItems) => {
                            if (!tooltipItems.length) return '';
                            return window.formatTime(tooltipItems[0].label, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                        }
                    }
                }
            }, 
            scales: { 
                y: { grid: { color: '#333' }, min: 0 }, 
                x: { 
                    grid: { color: '#333', display: false }, 
                    ticks: { 
                        maxTicksLimit: 8, 
                        maxRotation: 0,
                        callback: function(val, index) {
                            const label = this.getLabelForValue(val);
                            if (!label) return '';
                            return window.formatTime(label, { hour: '2-digit', minute: '2-digit' });
                        }
                    } 
                } 
            } 
        }
    });

    const ctxDoughnut = document.getElementById('doughnutChart').getContext('2d');
    doughnutChart = new Chart(ctxDoughnut, {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], borderWidth: 0, cutout: '75%', hoverOffset: 15 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });

    const ctxConcurrency = document.getElementById('concurrencyChart').getContext('2d');
    concurrencyChart = new Chart(ctxConcurrency, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Active Executions',
                data: [],
                borderColor: '#6366f1',
                backgroundColor: (context) => {
                    const chart = context.chart;
                    const {ctx, chartArea} = chart;
                    if (!chartArea) return null;
                    const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
                    gradient.addColorStop(0, 'rgba(99, 102, 241, 0)');
                    gradient.addColorStop(1, 'rgba(99, 102, 241, 0.3)');
                    return gradient;
                },
                tension: 0.4,
                fill: true,
                pointRadius: 0,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { 
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (tooltipItems) => {
                            if (!tooltipItems.length) return '';
                            const startStr = tooltipItems[0].label;
                            const intervalMins = parseInt(document.getElementById('concurrencyInterval')?.value) || 5;
                            const startDate = new Date(startStr);
                            const endDate = new Date(startDate.getTime() + intervalMins * 60000);
                            
                            const format = (d) => window.formatTime(d.toISOString(), { hour: '2-digit', minute: '2-digit' });
                            return `${format(startDate)} - ${format(endDate)}`;
                        },
                        label: (context) => {
                            return ` ${context.parsed.y} Executions`;
                        }
                    }
                }
            },
            onClick: async (e, activeEls) => {
                if (activeEls.length > 0) {
                    const dataIndex = activeEls[0].index;
                    const timestamp = concurrencyChart.data.labels[dataIndex];
                    const interval = document.getElementById('concurrencyInterval')?.value || 5;
                    await fetchConcurrencyDetails(timestamp, interval);
                }
            },
            scales: {
                y: { grid: { color: '#222' }, min: 0, ticks: { stepSize: 1, color: '#555' } },
                x: { 
                    grid: { display: false }, 
                    ticks: { 
                        color: '#555',
                        maxTicksLimit: 12,
                        callback: function(val, index) {
                            const label = this.getLabelForValue(val);
                            return window.formatTime(label, { hour: '2-digit', minute: '2-digit' });
                        }
                    } 
                }
            }
        }
    });
}

// --- SECTION 3: DATA FETCHING ---
async function fetchMetricsData() {
    const wfFilter = document.getElementById('workflowFilter')?.value || '';
    const timeFilter = document.getElementById('timeRangeFilter')?.value || '24h';
    
    const params = new URLSearchParams();
    if (wfFilter) params.append('workflow', wfFilter);
    if (timeFilter) params.append('timeRange', timeFilter);
    
    try {
        const response = await fetchWithAuth(`/api/metrics?${params.toString()}`);
        return response.ok ? await response.json() : null;
    } catch (err) {
        console.error("Error fetching metrics:", err);
        return null;
    }
}

async function fetchExecutions(offset, limit) {
    try {
        const params = new URLSearchParams();
        params.append('offset', offset);
        params.append('limit', limit);

        const workflow = document.getElementById('execWorkflowFilter')?.value;
        const status   = document.getElementById('execStatusFilter')?.value;
        const execId   = document.getElementById('execIdFilter')?.value?.trim();
        const startDt  = parseExecDate(document.getElementById('execStartFilter')?.value);
        const endDt    = parseExecDate(document.getElementById('execEndFilter')?.value);
        const minDur   = document.getElementById('execMinDurFilter')?.value;

        if (workflow) params.append('workflow', workflow);
        if (status)   params.append('status',   status);
        if (execId && !isNaN(parseInt(execId))) params.append('execId', parseInt(execId));
        if (startDt)  params.append('from',     startDt.toISOString());
        if (endDt)    params.append('toStop',    endDt.toISOString());
        if (minDur && parseFloat(minDur) > 0) params.append('minDuration', parseFloat(minDur));

        const response = await fetchWithAuth(`/api/executions?${params.toString()}`);
        return response.ok ? await response.json() : [];
    } catch (err) {
        console.error("Error fetching executions:", err);
        return [];
    }
}

// --- SECTION 4: UI UPDATERS ---
function updateKpiCards(summary) {
    if (!summary) return;
    const total = parseInt(summary.total) || 0;
    const errors = parseInt(summary.error) || 0;
    const errorRate = total > 0 ? ((errors / total) * 100).toFixed(1) : 0;
    const avgTime = parseFloat(summary.avg_duration || 0).toFixed(2);

    const elTotal = document.getElementById('kpi-total') || document.getElementById('totalExecutions');
    const elFailed = document.getElementById('kpi-failed') || document.getElementById('errorCount');
    const elRate = document.getElementById('kpi-error-rate');
    const elTime = document.getElementById('kpi-time') || document.getElementById('avgDuration');

    if (elTotal) elTotal.innerText = total.toLocaleString();
    if (elFailed) elFailed.innerText = errors.toLocaleString();
    if (elRate) elRate.innerText = errorRate + '%';
    if (elTime) elTime.innerText = avgTime + 's';
    ['kpiSk1','kpiSk2','kpiSk3'].forEach(id => document.getElementById(id)?.classList.add('done'));

    // Update Trend Badges
    const trendTotalEl = document.getElementById('trendTotal');
    const trendErrorEl = document.getElementById('trendError');

    if (trendTotalEl && summary.trend_total_pct !== undefined) {
        const pct = parseFloat(summary.trend_total_pct);
        trendTotalEl.classList.remove('hidden', 'bg-green-900/30', 'text-green-400', 'bg-red-900/30', 'text-red-400', 'bg-gray-800', 'text-gray-400');
        if (pct > 0) {
            trendTotalEl.classList.add('bg-green-900/30', 'text-green-400');
            trendTotalEl.innerText = `+${pct.toFixed(1)}%`;
        } else if (pct < 0) {
            trendTotalEl.classList.add('bg-red-900/30', 'text-red-400');
            trendTotalEl.innerText = `${pct.toFixed(1)}%`;
        } else {
            trendTotalEl.classList.add('bg-gray-800', 'text-gray-400');
            trendTotalEl.innerText = `0%`;
        }
    }

    if (trendErrorEl && summary.trend_error_pct !== undefined) {
        const pct = parseFloat(summary.trend_error_pct);
        trendErrorEl.classList.remove('hidden', 'bg-green-900/30', 'text-green-400', 'bg-red-900/30', 'text-red-400', 'bg-gray-800', 'text-gray-400');
        if (pct < 0) {
            // Negative error trend is GOOD (Green)
            trendErrorEl.classList.add('bg-green-900/30', 'text-green-400');
            trendErrorEl.innerText = `${pct.toFixed(1)}%`;
        } else if (pct > 0) {
            // Positive error trend is BAD (Red)
            trendErrorEl.classList.add('bg-red-900/30', 'text-red-400');
            trendErrorEl.innerText = `+${pct.toFixed(1)}%`;
        } else {
            trendErrorEl.classList.add('bg-gray-800', 'text-gray-400');
            trendErrorEl.innerText = `0%`;
        }
    }
}

function updateLineChart(chartData) {
    if (!chartData || chartData.length === 0) return;

    const labels = [];
    const successData = [];
    const errorData = [];

    chartData.forEach(row => {
        labels.push(row.time_val); // Push raw ISO string, Chart ticks will format it
        successData.push(parseInt(row.success_count) || 0);
        errorData.push(parseInt(row.error_count) || 0);
    });
    
    lineChart.data.labels = labels;
    lineChart.data.datasets[0].data = successData; 
    lineChart.data.datasets[1].data = errorData;   
    lineChart.update();
    document.getElementById('lineChartSk')?.classList.add('done');
}

function updateDoughnutChart(workflows) {
    if (!workflows || workflows.length === 0) return;

    let cumulativePercentage = 0;
    const labels = [];
    const dataValues = [];
    let restCount = 0;

    workflows.forEach(wf => {
        const pct = parseFloat(wf.percentage);
        const count = parseInt(wf.execution_count);

        if (cumulativePercentage < 90) {
            labels.push(wf.workflow_name);
            dataValues.push(count);
            cumulativePercentage += pct;
        } else {
            restCount += count;
        }
    });

    if (restCount > 0) {
        labels.push('Rest Workflows');
        dataValues.push(restCount);
    }

    doughnutChart.data.labels = labels;
    doughnutChart.data.datasets[0].data = dataValues;

    const colors = ['#ff6f5c', '#00c07f', '#ff9f43', '#00b8d9', '#6554c0', '#f16a75'];
    const backgroundColors = labels.map((label, index) => label === 'Rest Workflows' ? '#374151' : colors[index % colors.length]);
    
    doughnutChart.data.datasets[0].backgroundColor = backgroundColors;
    doughnutChart.update();
    document.getElementById('doughnutSk')?.classList.add('done');
}

function updateConcurrencyChart(data) {
    if (!data || !concurrencyChart) return;
    
    // 1. Cache the raw data for re-filtering
    lastRawConcurrency = data;

    // 2. Get current interval preference
    const intervalMins = parseInt(document.getElementById('concurrencyInterval')?.value) || 5;
    
    const now = new Date();
    const intervalMs = intervalMins * 60000;

    let processedLabels = [];
    let processedData = [];

    if (intervalMins === 5) {
        data.forEach(d => {
            const bucketStart = new Date(d.timestamp);
            if (bucketStart.getTime() + intervalMs <= now.getTime()) {
                processedLabels.push(d.timestamp);
                processedData.push(d.active_count);
            }
        });
    } else {
        // Aggregate 5m points into 10m or 30m blocks using SUM (Volume)
        const pointsPerBlock = intervalMins / 5;
        for (let i = 0; i < data.length; i += pointsPerBlock) {
            const block = data.slice(i, i + pointsPerBlock);
            if (block.length === 0) continue;
            
            const bucketStart = new Date(block[0].timestamp);
            // Hide if the entire block hasn't passed yet
            if (bucketStart.getTime() + intervalMs <= now.getTime()) {
                const sum = block.reduce((acc, b) => acc + (parseInt(b.active_count) || 0), 0);
                processedLabels.push(block[0].timestamp); 
                processedData.push(sum);
            }
        }
    }

    concurrencyChart.data.labels = processedLabels;
    concurrencyChart.data.datasets[0].data = processedData;
    concurrencyChart.update();
    document.getElementById('concurrencySk')?.classList.add('done');
}

async function fetchConcurrencyDetails(timestamp, windowSize = 5) {
    const modal = document.getElementById('detailsModal');
    const tbody = document.getElementById('detailsTableBody');
    const subtitle = document.getElementById('detailsModalSubtitle');
    
    if (!modal) return;
    
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-gray-500 italic">Fetching executions starting at ${timestamp}...</td></tr>`;
    
    // Display range in subtitle
    const startDate = new Date(timestamp);
    const endDate = new Date(startDate.getTime() + windowSize * 60000);
    const startStr = window.formatTime(startDate.toISOString(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const endStr = window.formatTime(endDate.toISOString(), { hour: '2-digit', minute: '2-digit', hour12: false });
    
    subtitle.innerText = `${startStr} - ${endStr} (${windowSize}min)`;
    
    document.body.style.overflow = 'hidden'; // Lock background
    modal.classList.remove('hidden');
    modal.style.display = 'flex'; 
    setTimeout(() => document.getElementById('detailsModalContainer').classList.remove('scale-95'), 10);

    try {
        const response = await fetchWithAuth(`/api/analytics/concurrency/details?time=${encodeURIComponent(timestamp)}&window=${windowSize}`);
        const data = await response.json();
        
        if (data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-gray-500 italic">No executions found precisely at this 5m interval.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(exec => {
            const isError = exec.status !== 'success';
            const statusColor = isError ? 'text-red-400' : (exec.status === 'running' ? 'text-blue-400 animate-pulse' : 'text-green-400');
            const statusIcon = isError ? 'fa-xmark' : (exec.status === 'running' ? 'fa-spinner fa-spin' : 'fa-check');
            
            const timeString = window.formatTime(exec.startedAt, { hour: '2-digit', minute: '2-digit' });
            
            const durationSec = parseFloat(exec.current_duration);
            const durationStr = durationSec < 60 ? `${Math.round(durationSec)}s` : `${Math.round(durationSec/60)}m`;

            let actionBtn = '';
            if (isError) {
                actionBtn = `
                    <button onclick="showError('${exec.exec_id}')" class="text-red-500 hover:text-red-400 transition-colors" title="View Error Log">
                        <i class="fa-solid fa-arrow-right"></i>
                    </button>
                `;
            } else if (exec.n8nBaseUrl && exec.workflow_id) {
                const link = `${exec.n8nBaseUrl}/workflow/${exec.workflow_id}/executions/${exec.exec_id}`;
                actionBtn = `
                    <a href="${link}" target="_blank" class="text-indigo-400 hover:text-indigo-300 transition-colors" title="Open Execution in n8n">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                    </a>
                `;
            }

            return `
            <tr class="hover:bg-gray-800/30 transition-colors border-b border-gray-800/50">
                <td class="p-4 text-white font-semibold text-sm truncate max-w-[200px]">${exec.workflow_name}</td>
                <td class="p-4"><span class="${statusColor} text-[10px] font-bold uppercase tracking-tight"><i class="fa-solid ${statusIcon} mr-1"></i> ${exec.status}</span></td>
                <td class="p-4 text-gray-400 text-xs">${timeString}</td>
                <td class="p-4 text-gray-500 text-[10px] font-mono">${durationStr}</td>
                <td class="p-4 text-right">
                    ${actionBtn}
                </td>
            </tr>
            `;
        }).join('');
        
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-red-500 italic">Error fetching concurrency details.</td></tr>`;
    }
}

function closeDetailsModal() {
    const modal = document.getElementById('detailsModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
        document.getElementById('detailsModalContainer').classList.add('scale-95');
        document.body.style.overflow = 'auto'; // Unlock
    }
}

function populateDropdown(workflows) {
    const select = document.getElementById('workflowFilter');
    // Populate only if empty (contains only the "All Workflows" option)
    if (select && select.options.length <= 1 && workflows) {
        const top15 = workflows.slice(0, 15);
        top15.forEach(wf => {
            const option = document.createElement('option');
            option.value = wf.workflow_name;
            option.innerText = wf.workflow_name;
            select.appendChild(option);
        });
    }
}

function populateExecWorkflowDropdown(workflows) {
    const select = document.getElementById('execWorkflowFilter');
    if (!select || !workflows) return;
    // Always rebuild — select is recreated each time the tab renders
    while (select.options.length > 1) select.remove(1);
    workflows.forEach(wf => {
        const option = document.createElement('option');
        option.value = wf.workflow_name;
        option.innerText = wf.workflow_name;
        select.appendChild(option);
    });
}

function clearExecFilters() {
    ['execWorkflowFilter','execStatusFilter','execIdFilter',
     'execStartFilter','execEndFilter','execMinDurFilter'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    loadMoreExecutions(true);
}

// --- Date helpers for free-text timestamp inputs ---

// Parse "DD/MM/YYYY HH:mm" → Date, returns null if invalid or empty
function parseExecDate(str) {
    if (!str || !str.trim()) return null;
    const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const dt = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]), parseInt(m[4]), parseInt(m[5]));
    return isNaN(dt.getTime()) ? null : dt;
}

// Format Date → "DD/MM/YYYY HH:mm"
function formatExecDate(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Apply button handler — the ONLY way to trigger a filtered reload
function applyExecFilters() {
    loadMoreExecutions(true);
}

// Builds the two-row executions thead (headers + filter row) and wires events.
// Called on first page load AND every time the executions tab is activated.
function initExecutionsHeader() {
    const thead = document.getElementById('tableHeader') || document.getElementById('table-head');
    if (!thead) return;
    thead.innerHTML = `
        <tr class="text-gray-400 text-xs uppercase tracking-widest border-b border-gray-800/50">
            <th class="px-4 pt-3 pb-1 font-medium text-gray-600">#</th>
            <th class="px-4 pt-3 pb-1 font-medium">Workflow</th>
            <th class="px-4 pt-3 pb-1 font-medium">Status</th>
            <th class="px-4 pt-3 pb-1 font-medium">Started</th>
            <th class="px-4 pt-3 pb-1 font-medium">Ended</th>
            <th class="px-4 pt-3 pb-1 font-medium">Run Time</th>
            <th class="px-4 pt-3 pb-1 font-medium"></th>
        </tr>
        <tr class="bg-black/20 border-b border-gray-800/50">
            <td class="px-3 py-3">
                <input type="number" id="execIdFilter" min="1" placeholder="ID…"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 w-16 text-center" />
            </td>
            <td class="px-3 py-3">
                <select id="execWorkflowFilter"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 w-full max-w-[180px] cursor-pointer">
                    <option value="">All Workflows</option>
                </select>
            </td>
            <td class="px-3 py-3">
                <select id="execStatusFilter"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 w-full cursor-pointer">
                    <option value="">Any Status</option>
                    <option value="success">Success</option>
                    <option value="error">Error</option>
                    <option value="canceled">Canceled</option>
                    <option value="crashed">Crashed</option>
                </select>
            </td>
            <td class="px-3 py-3">
                <input type="text" id="execStartFilter" placeholder="DD/MM/YYYY HH:mm"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 font-mono w-36" />
            </td>
            <td class="px-3 py-3">
                <input type="text" id="execEndFilter" placeholder="DD/MM/YYYY HH:mm"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 font-mono w-36" />
            </td>
            <td class="px-3 py-3">
                <div class="flex items-center gap-1">
                    <span class="text-gray-600 text-[10px]">&gt;</span>
                    <input type="number" id="execMinDurFilter" min="0" step="0.1" placeholder="—"
                        class="bg-black/40 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 w-12 text-center" />
                    <span class="text-gray-600 text-[10px]">s</span>
                </div>
            </td>
            <td class="px-3 py-3">
                <div class="flex flex-col items-center gap-1">
                    <button onclick="applyExecFilters()" title="Apply filters"
                        class="w-[26px] h-[22px] text-[9px] bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/50 hover:border-indigo-400/60 active:bg-indigo-600/70 transition-colors rounded flex items-center justify-center">
                        <i class="fa-solid fa-check"></i>
                    </button>
                    <button onclick="clearExecFilters()" title="Clear all filters"
                        class="w-[26px] h-[22px] text-[9px] bg-gray-700/20 border border-gray-600/30 text-gray-400 hover:bg-n8n-primary/20 hover:border-n8n-primary/40 hover:text-n8n-primary active:bg-n8n-primary/30 active:border-n8n-primary/60 transition-colors rounded flex items-center justify-center">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </td>
        </tr>
    `;
    // Populate workflow dropdown from cache
    populateExecWorkflowDropdown(lastTopWorkflows);
    // Auto-fill end = start + 10 min when start is typed and end is still empty
    const startEl = document.getElementById('execStartFilter');
    const endEl   = document.getElementById('execEndFilter');
    if (startEl && endEl) {
        startEl.addEventListener('change', () => {
            const d = parseExecDate(startEl.value);
            if (d && !endEl.value.trim()) {
                endEl.value = formatExecDate(new Date(d.getTime() + 10 * 60 * 1000));
            }
        });
    }
    // Enter key on any filter input/select fires Apply
    thead.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('keydown', e => { if (e.key === 'Enter') applyExecFilters(); });
    });
}

// --- SECTION 4.5: ERROR MODAL LOGIC ---
async function showError(execId, hasSnapshot = false) {
    const modal = document.getElementById('errorModal');
    const msgBox = document.getElementById('modalErrorMessage');
    const idBox = document.getElementById('modalExecId');
    const nodeBox = document.getElementById('modalNodeName');
    const n8nLink = document.getElementById('n8nLink');
    const deepDiveBtn = document.getElementById('deepDiveBtn');

    if (!modal) return;

    closeDetailsModal(); // Close Execution Snapshot if it's open

    idBox.innerText = execId;
    nodeBox.innerText = '--';
    msgBox.innerText = 'Loading snapshot...';
    
    deepDiveBtn.onclick = () => fetchDetailedError(execId);
    
    modal.classList.remove('hidden');
    modal.style.display = 'flex'; 
    document.body.style.overflow = 'hidden'; // Lock background
    setTimeout(() => document.getElementById('modalContainer').classList.remove('scale-95'), 10);

    try {
        const response = await fetchWithAuth(`/api/execution-error/${execId}`);
        const data = await response.json();
        
        nodeBox.innerText = data.nodeName || 'Unknown Node';
        msgBox.innerText = data.message || 'Snapshot unavailable. Try fetching the raw trace.';

        if (n8nLink && data.workflowId && data.n8nBaseUrl) {
            n8nLink.href = `${data.n8nBaseUrl}/workflow/${data.workflowId}/executions/${execId}`;
        }
    } catch (err) {
        msgBox.innerText = 'No instant snapshot found. Use "Fetch Raw Trace" for a deep inspection.';
    }
}

async function fetchDetailedError(execId) {
    const msgBox = document.getElementById('modalErrorMessage');
    msgBox.innerText = 'Fetching raw JSON dump from Postgres... (This may take a moment)';
    
    try {
        const response = await fetchWithAuth(`/api/execution-error/${execId}?full=true`);
        const data = await response.json();
        msgBox.innerText = data.fullError || data.message || 'Full trace unavailable.';
    } catch (e) {
        msgBox.innerText = 'Error fetching raw trace from production database.';
    }
}

function closeErrorModal() {
    const modal = document.getElementById('errorModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
        document.body.style.overflow = 'auto'; // Unlock
        // Reset copy icon if modal closes
        const icon = document.getElementById('copyIcon');
        if (icon) icon.className = 'fa-regular fa-copy';
    }
}

async function copyErrorMessage() {
    const msg = document.getElementById('modalErrorMessage')?.innerText;
    const icon = document.getElementById('copyIcon');
    if (!msg || msg === 'Loading...' || msg === 'Analyzing trace...') return;
    
    try {
        await navigator.clipboard.writeText(msg);
        if (icon) {
            icon.className = 'fa-solid fa-check text-green-400';
            setTimeout(() => {
                icon.className = 'fa-regular fa-copy';
            }, 2000);
        }
    } catch (err) {
        console.error('Failed to copy text: ', err);
    }
}

window.addEventListener('click', (event) => {
    const modal = document.getElementById('errorModal');
    const detailsModal = document.getElementById('detailsModal');
    if (modal && event.target === modal) {
        closeErrorModal();
    }
    if (detailsModal && event.target === detailsModal) {
        closeDetailsModal();
    }
});

// --- SECTION 5: INFINITE SCROLL TABLE ---
async function loadMoreExecutions(reset = false) {
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
            const endStr   = window.formatTime(exec.stoppedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
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

function hasActiveFilters() {
    return ['execWorkflowFilter','execStatusFilter','execIdFilter',
            'execStartFilter','execEndFilter','execMinDurFilter']
        .some(id => {
            const el = document.getElementById(id);
            return el && el.value && el.value.trim() !== '';
        });
}

function setupInfiniteScroll() {
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

async function refreshData() {
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

async function fetchConcurrency(dateVal) {
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

async function initDateFilter() {
    const dateInput = document.getElementById('trafficDate');
    const btn24h = document.getElementById('btn24h');
    if (!dateInput) return;

    try {
        const res = await fetchWithAuth('/api/analytics/first-execution-date');
        let firstDateIso = '';
        if (res.ok) {
            const data = await res.json();
            if (data.firstDate) {
                firstDateIso = data.firstDate.substring(0, 10);
                dateInput.min = firstDateIso;
            }
        }
        
        // Max is always today
        const todayLocal = new Date();
        const offset = todayLocal.getTimezoneOffset() * 60000;
        const localISOTime = (new Date(todayLocal.getTime() - offset)).toISOString().split('T')[0];
        dateInput.max = localISOTime;

        // Listeners
        dateInput.addEventListener('change', (e) => {
            const val = e.target.value;
            if (val) {
                // Mobile WebKit strict fallback validation
                if ((firstDateIso && val < firstDateIso) || val > localISOTime) {
                    e.target.value = ''; // Revert invalid choice
                    e.target.blur(); // Force close the native mobile UI wheel
                    setTimeout(() => {
                        alert(`Please select a date between ${firstDateIso} and ${localISOTime}`);
                    }, 400); // Wait for the wheel drop-down to fully exit
                    return;
                }
                btn24h.classList.remove('bg-indigo-600/20', 'text-indigo-400');
                btn24h.classList.add('bg-black/30', 'text-gray-500');
                fetchConcurrency(val);
            }
        });

        if (btn24h) {
            btn24h.addEventListener('click', () => {
                dateInput.value = ''; // Clear picker
                btn24h.classList.add('bg-indigo-600/20', 'text-indigo-400');
                btn24h.classList.remove('bg-black/30', 'text-gray-500');
                fetchConcurrency(null);
            });
        }
    } catch (err) {
        console.error('Failed to init date filter limits', err);
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    await initSettings();
    initCharts();
    setupInfiniteScroll();
    await initDateFilter();
    await refreshData();     // await so lastTopWorkflows is populated before header renders
    initExecutionsHeader();  // build filter row on first load
    loadMoreExecutions(true);

    const timeFilter = document.getElementById('timeRangeFilter');
    if (timeFilter) timeFilter.addEventListener('change', refreshData);
    
    const wfFilter = document.getElementById('workflowFilter');
    if (wfFilter) wfFilter.addEventListener('change', refreshData);

    const concInterval = document.getElementById('concurrencyInterval');
    if (concInterval) {
        concInterval.addEventListener('change', () => {
            if (lastRawConcurrency.length > 0) {
                updateConcurrencyChart(lastRawConcurrency);
            }
        });
    }
});

// --- SECTION 7: TAB NAVIGATION & DYNAMIC TABLES ---
async function switchTab(tabName) {
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