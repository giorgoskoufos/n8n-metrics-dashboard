// ==========================================
// n8n Metrics Monitor - Frontend Logic
// ==========================================

// --- SECTION 1: GLOBALS ---
let lineChart = null;
let doughnutChart = null;
Chart.defaults.font.family = "'Open Sans', sans-serif";
Chart.defaults.color = '#eeeeee';
let currentTab = 'executions'; // Default active tab        

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

    // Υποστηρίζει και το νέο και το παλιό HTML!
    const elTotal = document.getElementById('kpi-total') || document.getElementById('totalExecutions');
    const elFailed = document.getElementById('kpi-failed') || document.getElementById('errorCount');
    const elRate = document.getElementById('kpi-error-rate'); // Μόνο στο νέο
    const elTime = document.getElementById('kpi-time') || document.getElementById('avgDuration');

    if (elTotal) elTotal.innerText = total.toLocaleString();
    if (elFailed) elFailed.innerText = errors.toLocaleString();
    if (elRate) elRate.innerText = errorRate + '%';
    if (elTime) elTime.innerText = avgTime + 's';
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

// --- SECTION 4.5: ERROR MODAL LOGIC ---
async function showError(execId) {
    console.log("Έγινε κλικ στο execution:", execId); // Debugging
    const modal = document.getElementById('errorModal');
    const msgBox = document.getElementById('modalErrorMessage');
    const idBox = document.getElementById('modalExecId');
    const n8nLink = document.getElementById('n8nLink');

    if (!modal) {
        alert("Λείπει το HTML του Modal από το αρχείο index.html!");
        return;
    }

    idBox.innerText = execId;
    msgBox.innerText = 'Φόρτωση λεπτομερειών σφάλματος...';
    
    // Αφαίρεση της κλάσης hidden του Tailwind
    modal.classList.remove('hidden');
    modal.style.display = 'flex'; 

    // Link για το n8n 
    if (n8nLink) {
        n8nLink.href = `https://automations-n8n.xadp6y.easypanel.host/execution/${execId}`;
    }

    try {
        const response = await fetch(`/api/execution-error/${execId}`);
        const data = await response.json();
        msgBox.innerText = data.message;
    } catch (err) {
        msgBox.innerText = 'Σφάλμα κατά την ανάκτηση των δεδομένων από τον server.';
    }
}

// Προσθήκη συνάρτησης για το κλείσιμο
function closeErrorModal() {
    const modal = document.getElementById('errorModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

// Συνδέουμε το κλικ έξω από το modal για να κλείνει
window.addEventListener('click', (event) => {
    const modal = document.getElementById('errorModal');
    if (modal && event.target === modal) {
        closeErrorModal();
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
    
    if (executions.length > 0) {
        // Προσθήκη του fallback ΚΑΙ εδώ, καθώς και ασφάλεια αν δεν βρει κανένα
        const tbody = document.getElementById('table-body') || document.getElementById('executionsTableBody');
        
        if (!tbody) {
            console.error("Δεν βρέθηκε το table body στο HTML!");
            return;
        }
        
        executions.forEach(exec => {
            const dateObj = new Date(exec.startedAt);
            const timeString = `${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${dateObj.toLocaleTimeString('en-US', { hour12: false })}`;
            const duration = exec.duration < 1 ? Math.round(exec.duration * 1000) + 'ms' : parseFloat(exec.duration).toFixed(3) + 's';
            
            // Ελέγχουμε αν απέτυχε με οποιονδήποτε τρόπο (όχι μόνο 'error' αλλά και 'crashed')
            const isError = exec.status !== 'success';

            const statusHtml = !isError 
                ? `<span class="flex items-center gap-2 text-[#278250]"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg> Success</span>`
                : `<span class="flex items-center gap-2 text-[#f16a75]"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path></svg> Error</span>`;

            // ΠΡΟΣΘΗΚΗ: Κάνουμε τη γραμμή clickable αν ΔΕΝ είναι success
            const actionAttr = isError ? `onclick="showError('${exec.exec_id}')" style="cursor: pointer;" title="Δες το σφάλμα"` : '';

            tbody.innerHTML += `
                <tr class="hover:bg-gray-800/30 transition-colors text-sm" ${actionAttr}>
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
        const trigger = document.getElementById('scroll-trigger');
        if (trigger) trigger.innerHTML = "No more executions.";
    }
    
    isFetchingExecutions = false;
}

function setupInfiniteScroll() {
    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            loadMoreExecutions();
        }
    }, { root: document.getElementById('table-scroll-container'), threshold: 1.0 });

    const trigger = document.getElementById('scroll-trigger');
    if (trigger) observer.observe(trigger);
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
    loadMoreExecutions(true); // Φορτώνει τα executions με την πρώτη εκκίνηση

    // Listeners για να ανανεώνονται τα γραφήματα όταν αλλάζεις φίλτρο
    const timeFilter = document.getElementById('timeRangeFilter');
    if (timeFilter) timeFilter.addEventListener('change', refreshData);
    
    const wfFilter = document.getElementById('workflowFilter');
    if (wfFilter) wfFilter.addEventListener('change', refreshData);

    // Λογική για το κλείσιμο του Error Modal
    const modal = document.getElementById('errorModal');
    const closeBtn = document.querySelector('.close-modal');
    
    if (closeBtn && modal) {
        closeBtn.onclick = () => modal.style.display = 'none';
    }

    window.onclick = (event) => {
        if (modal && event.target == modal) {
            modal.style.display = 'none';
        }
    };
});

// --- SECTION 7: TAB NAVIGATION & DYNAMIC TABLES ---
async function switchTab(tabName) {
    if (currentTab === tabName) return;
    currentTab = tabName;

    // 1. Update Tab Styles (Αφαιρεί το active από όλα και το βάζει σε αυτό που πατήθηκε)
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const activeBtn = document.querySelector(`[onclick="switchTab('${tabName}')"]`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    // 2. Setup Table Layout & Fetch Data (Με δικλείδες ασφαλείας για παλιά/νέα IDs)
    const thead = document.getElementById('table-head') || document.querySelector('thead');
    const tbody = document.getElementById('table-body') || document.getElementById('executionsTableBody');
    const scrollTrigger = document.getElementById('scroll-trigger') || document.getElementById('scrollTrigger');

    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-500">Loading...</td></tr>';

    if (tabName === 'executions') {
        // --- ALL EXECUTIONS TAB ---
        if (thead) thead.innerHTML = `
            <tr class="text-n8n-text text-sm">
                <th class="p-4 font-medium">Workflow</th>
                <th class="p-4 font-medium">Status</th>
                <th class="p-4 font-medium">Started</th>
                <th class="p-4 font-medium">Run Time</th>
                <th class="p-4 font-medium">Exec. ID</th>
            </tr>
        `;
        if (scrollTrigger) scrollTrigger.style.display = 'flex';
        loadMoreExecutions(true);

    } else if (tabName === 'slowest') {
        // --- SLOWEST WORKFLOWS TAB ---
        if (thead) thead.innerHTML = `
            <tr class="text-n8n-text text-sm">
                <th class="p-4 font-medium">Workflow</th>
                <th class="p-4 font-medium">Avg Run Time (7d)</th>
                <th class="p-4 font-medium">Total Runs (7d)</th>
            </tr>
        `;
        if (scrollTrigger) scrollTrigger.style.display = 'none';
        
        const res = await fetch('/api/analytics/slowest');
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
        // --- ERROR HOTSPOTS TAB ---
        if (thead) thead.innerHTML = `
            <tr class="text-n8n-text text-sm">
                <th class="p-4 font-medium">Workflow</th>
                <th class="p-4 font-medium">Errors (7d)</th>
                <th class="p-4 font-medium">Total Runs (7d)</th>
                <th class="p-4 font-medium">Error Rate</th>
            </tr>
        `;
        if (scrollTrigger) scrollTrigger.style.display = 'none'; 
        
        const res = await fetch('/api/analytics/errors');
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