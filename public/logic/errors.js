/**
 * Error Intelligence Dashboard Logic
 */

document.addEventListener('DOMContentLoaded', loadErrorIntelligence);

let currentExecId = null;
let currentDrilldownData = null; // For exports
let drilldownPieChart = null;

async function loadErrorIntelligence() {
    initDrilldownChart();

    const cardTotal = document.getElementById('cardTotalErrors');
    const cardUnique = document.getElementById('cardUniqueNodes');
    const cardWorkflows = document.getElementById('cardWorkflows');

    const nodeBody = document.getElementById('nodeHotspotsBody');
    const feedBody = document.getElementById('errorFeedBody');

    const drilldownSelector = document.getElementById('workflowDrilldownSelector');

    try {
        const res = await fetchWithAuth('/api/analytics/error-intelligence');
        if (!res.ok) throw new Error("Failed to fetch intelligence data");
        const data = await res.json();

        // Update Headline Stats
        cardTotal.innerText = (data.summary.total_errors || 0).toLocaleString();
        cardUnique.innerText = (data.summary.unique_failing_nodes || 0).toLocaleString();
        cardWorkflows.innerText = (data.summary.affected_workflows || 0).toLocaleString();

        // Populate Workflow Drilldown Selector
        if (data.workflows) {
            drilldownSelector.innerHTML = '<option value="">Select a workflow to analyze...</option>';
            data.workflows.forEach(wf => {
                const opt = document.createElement('option');
                opt.value = wf.id;
                opt.innerText = `${wf.name} (${wf.error_count} errors)`;
                drilldownSelector.appendChild(opt);
            });
        }

        // Render Global Node Hotspots
        if (data.nodes && data.nodes.length > 0) {
            nodeBody.innerHTML = data.nodes.map(n => `
                <tr class="hover:bg-gray-800/30 transition-colors text-xs border-b border-gray-800/20">
                    <td class="p-4 font-semibold text-white truncate max-w-[120px]">${escapeHtml(n.node_name)}</td>
                    <td class="p-4 text-right text-n8n-danger font-bold">${n.fail_count}</td>
                </tr>
            `).join('');
        } else {
            nodeBody.innerHTML = '<tr><td colspan="2" class="p-8 text-center text-gray-500 italic text-sm">Empty.</td></tr>';
        }

        // Render Error Feed
        if (data.feed && data.feed.length > 0) {
            feedBody.innerHTML = data.feed.map(err => {
                const timeStr = formatTimeNice(err.timestamp);
                return `
                    <tr class="hover:bg-gray-800/30 transition-colors text-xs border-b border-gray-800/30">
                        <td class="p-4">
                            <div class="font-bold text-white mb-0.5 truncate max-w-[180px]">${escapeHtml(err.workflow_name)}</div>
                            <div class="text-[10px] text-gray-500 uppercase font-semibold">${timeStr}</div>
                        </td>
                        <td class="p-4">
                            <span class="inline-block bg-gray-800 text-gray-300 px-3 py-1.5 rounded text-[10px] font-mono border border-gray-700 whitespace-nowrap">${escapeHtml(err.node_name)}</span>
                        </td>
                        <td class="p-4 text-red-400/80 leading-relaxed max-w-md">${escapeHtml(err.error_message)}</td>
                        <td class="p-4 text-right">
                            <button onclick="showErrorDetail('${err.id}')" class="text-indigo-400 hover:text-indigo-300 transition-colors p-2 text-lg">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
        } else {
            feedBody.innerHTML = '<tr><td colspan="4" class="p-12 text-center text-gray-500 italic text-sm">Feed is currently empty.</td></tr>';
        }

    } catch (e) {
        console.error(e);
        nodeBody.innerHTML = '<tr><td colspan="2" class="p-8 text-center text-red-500 text-sm">Failed to load hotspots.</td></tr>';
    }
}


function initDrilldownChart() {
    const chartCanvas = document.getElementById('workflowPieChart');
    if (!chartCanvas) return;
    const ctx = chartCanvas.getContext('2d');
    drilldownPieChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: ['#ff6f5c', '#00c07f', '#ff9f43', '#00b8d9', '#6554c0', '#f16a75'],
                borderWidth: 0,
                hoverOffset: 15
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '58%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { 
                        color: '#9ca3af', 
                        boxWidth: 10, 
                        padding: 25, 
                        font: { size: 10, family: "'Open Sans', sans-serif" } 
                    }
                }
            },
            layout: {
                padding: {
                    top: 10,
                    bottom: 20
                }
            }
        }
    });
}

async function fetchWorkflowDrilldown(workflowId) {
    if (!workflowId) return;

    const chartCanvas = document.getElementById('workflowPieChart');
    const emptyState = document.getElementById('chartEmptyState');
    const sourceContent = document.getElementById('drilldownSourceContent');

    try {
        const res = await fetchWithAuth(`/api/analytics/workflow-drilldown/${workflowId}`);
        const data = await res.json();
        currentDrilldownData = data;

        emptyState.classList.add('hidden');
        chartCanvas.classList.remove('hidden');

        // Update Pie
        const labels = data.nodeDistribution.map(n => n.node_name);
        const counts = data.nodeDistribution.map(n => n.count);

        if (drilldownPieChart) {
            drilldownPieChart.data.labels = labels;
            drilldownPieChart.data.datasets[0].data = counts;
            drilldownPieChart.update();
        }

        // Update Sources sidebar
        if (data.sourceDistribution && data.sourceDistribution.length > 0) {
            sourceContent.innerHTML = data.sourceDistribution.map(s => `
                <div class="p-3 bg-black/40 rounded-lg border border-gray-800/50">
                    <p class="text-[11px] font-bold text-white mb-1 truncate">${escapeHtml(s.source_node)}</p>
                    <div class="flex justify-between items-center text-[10px]">
                        <span class="text-indigo-400 font-mono">Output ${s.source_output_index}</span>
                        <span class="text-gray-500 font-bold">${s.count} flows</span>
                    </div>
                </div>
            `).join('');
        } else {
            sourceContent.innerHTML = '<p class="text-[10px] text-gray-600 italic">No source paths detected for this workflow.</p>';
        }

    } catch (err) {
        console.error("Drilldown failed:", err);
    }
}

function downloadDrilldown(type) {
    if (!currentDrilldownData || !currentDrilldownData.rawErrors) {
        alert("Please select a workflow first.");
        return;
    }

    const name = currentDrilldownData.workflowName.replace(/[^a-z0-9]/gi, '_');
    const filename = `n8n_errors_${name}_${new Date().toISOString().split('T')[0]}`;

    if (type === 'json') {
        const blob = new Blob([JSON.stringify(currentDrilldownData.rawErrors, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.json`;
        a.click();
    } else {
        const headers = ["Execution ID", "Node", "Type", "Error Message", "Branch", "Time"];
        const rows = currentDrilldownData.rawErrors.map(e => [
            e.exec_id,
            `"${e.node_name}"`,
            e.node_type,
            `"${e.error_message.replace(/"/g, '\"')}"`,
            e.branch,
            e.started_at
        ]);
        const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.csv`;
        a.click();
    }
}

async function showErrorDetail(execId) {
    currentExecId = execId;
    const modal = document.getElementById('errorModal');
    const nodeBox = document.getElementById('modalNodeName');
    const idBox = document.getElementById('modalExecId');
    const msgBox = document.getElementById('modalErrorMessage');
    const timeBox = document.getElementById('modalTimestamp');

    // Clear and Show
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    msgBox.innerText = 'Analyzing trace...';

    try {
        const response = await fetchWithAuth(`/api/execution-error/${execId}`);
        const data = await response.json();

        nodeBox.innerText = data.nodeName || 'Unknown Node';
        idBox.innerText = execId;
        msgBox.innerText = data.message || 'Snapshot unavailable. Try fetching the raw trace.';
        timeBox.innerText = `ID: ${execId}`;

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
        modal.classList.remove('flex');
    }
}

// Helper: Auth fetch
async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('n8n_auth_token');
    if (!token) {
        window.location.href = 'login.html';
        return;
    }
    const headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
    return fetch(url, { ...options, headers });
}

function formatTimeNice(isoStr) {
    const date = new Date(isoStr);
    return date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
