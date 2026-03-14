// ==========================================
// n8n Metrics Monitor - Frontend Logic
// ==========================================

// --- SECTION 1: GLOBALS ---
let lineChart = null;
let doughnutChart = null;
Chart.defaults.font.family = "'Open Sans', sans-serif";
Chart.defaults.color = '#eeeeee';

let currentOffset = 0;
const LIMIT = 20;
let isFetchingExecutions = false;

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
            plugins: { legend: { display: false } }, 
            scales: { 
                y: { grid: { color: '#333' }, min: 0 }, 
                x: { grid: { color: '#333', display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } } 
            } 
        }
    });

    const ctxDoughnut = document.getElementById('doughnutChart').getContext('2d');
    doughnutChart = new Chart(ctxDoughnut, {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], borderWidth: 0, cutout: '75%' }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
}

// --- SECTION 3: DATA FETCHING (Εδώ ενώνονται αρμονικά τα 2 φίλτρα) ---
async function fetchMetricsData() {
    const wfFilter = document.getElementById('workflowFilter')?.value || '';
    const timeFilter = document.getElementById('timeRangeFilter')?.value || '24h';
    
    // Το URLSearchParams διασφαλίζει ότι και τα 2 φίλτρα στέλνονται μαζί χωρίς conflicts
    const params = new URLSearchParams();
    if (wfFilter) params.append('workflow', wfFilter);
    if (timeFilter) params.append('timeRange', timeFilter);
    
    const response = await fetch(`/api/metrics?${params.toString()}`);
    return response.ok ? await response.json() : null;
}

async function fetchExecutions(offset, limit) {
    const response = await fetch(`/api/executions?offset=${offset}&limit=${limit}`);
    return response.ok ? await response.json() : [];
}

// --- SECTION 4: UI UPDATERS ---
function updateKpiCards(summary) {
    if (!summary) return;
    const total = parseInt(summary.total) || 0;
    const errors = parseInt(summary.error) || 0;
    const errorRate = total > 0 ? ((errors / total) * 100).toFixed(1) : 0;
    const avgTime = parseFloat(summary.avg_duration || 0).toFixed(2);

    document.getElementById('kpi-total').innerText = total.toLocaleString();
    document.getElementById('kpi-failed').innerText = errors.toLocaleString();
    document.getElementById('kpi-error-rate').innerText = errorRate + '%';
    document.getElementById('kpi-time').innerText = avgTime + 's';
}

function updateLineChart(chartData) {
    if (!chartData || chartData.length === 0) return;

    const timeFilter = document.getElementById('timeRangeFilter')?.value || '24h';
    const labels = [];
    const successData = [];
    const errorData = [];

    chartData.forEach(row => {
        // Διαβάζουμε σωστά το κείμενο της ημερομηνίας που έστειλε η βάση (όχι πια NaN!)
        const dateObj = new Date(row.time_val); 
        let label = '';

        if (!isNaN(dateObj.getTime())) {
            if (timeFilter === '7d') {
                label = dateObj.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
            } else if (timeFilter === '48h') {
                const hours = dateObj.getHours().toString().padStart(2, '0');
                const day = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
                label = `${day} ${hours}:00`;
            } else {
                const hours = dateObj.getHours().toString().padStart(2, '0');
                label = `${hours}:00`;
            }
        } else {
            label = 'Error'; // Ασφαλής fallback αν κάτι πάει στραβά
        }

        labels.push(label);
        successData.push(parseInt(row.success_count) || 0);
        errorData.push(parseInt(row.error_count) || 0);
    });
    
    lineChart.data.labels = labels;
    lineChart.data.datasets[0].data = successData; 
    lineChart.data.datasets[1].data = errorData;   
    lineChart.update();
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
}

function populateDropdown(workflows) {
    const select = document.getElementById('workflowFilter');
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

// --- SECTION 5: INFINITE SCROLL TABLE ---
async function loadMoreExecutions(reset = false) {
    if (isFetchingExecutions) return;
    isFetchingExecutions = true;

    if (reset) {
        currentOffset = 0;
        document.getElementById('table-body').innerHTML = '';
    }

    const executions = await fetchExecutions(currentOffset, LIMIT);
    
    if (executions.length > 0) {
        const tbody = document.getElementById('table-body');
        
        executions.forEach(exec => {
            const dateObj = new Date(exec.startedAt);
            const timeString = `${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${dateObj.toLocaleTimeString('en-US', { hour12: false })}`;
            const duration = exec.duration < 1 ? Math.round(exec.duration * 1000) + 'ms' : parseFloat(exec.duration).toFixed(3) + 's';
            
            const statusHtml = exec.status === 'success' 
                ? `<span class="flex items-center gap-2 text-[#278250]"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg> Success</span>`
                : `<span class="flex items-center gap-2 text-[#f16a75]"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path></svg> Error</span>`;

            tbody.innerHTML += `
                <tr class="hover:bg-gray-800/30 transition-colors text-sm">
                    <td class="p-4 text-white">${exec.name}</td>
                    <td class="p-4">${statusHtml}</td>
                    <td class="p-4 text-n8n-text">${timeString}</td>
                    <td class="p-4 text-n8n-text">${duration}</td>
                    <td class="p-4 text-n8n-text">${exec.exec_id}</td>
                </tr>
            `;
        });
        currentOffset += LIMIT; 
    } else {
        document.getElementById('scroll-trigger').innerHTML = "No more executions.";
    }
    
    isFetchingExecutions = false;
}

function setupInfiniteScroll() {
    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            loadMoreExecutions();
        }
    }, { root: document.getElementById('table-scroll-container'), threshold: 1.0 });

    observer.observe(document.getElementById('scroll-trigger'));
}

// --- SECTION 6: INITIALIZATION ---
async function refreshData() {
    const data = await fetchMetricsData();
    if (data) {
        updateKpiCards(data.summary);
        updateLineChart(data.hourlyData);
        if (data.topWorkflows) {
            updateDoughnutChart(data.topWorkflows);
            populateDropdown(data.topWorkflows); 
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    initCharts();
    setupInfiniteScroll();
    refreshData(); 
});