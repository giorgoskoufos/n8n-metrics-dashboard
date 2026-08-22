// --- SECTION 1: GLOBALS ---
window.lineChart = null;
window.doughnutChart = null;
window.concurrencyChart = null;
if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = "'Open Sans', sans-serif";
    Chart.defaults.color = '#eeeeee';
}
window.currentTab = 'executions'; // Default active tab        

window.currentOffset = 0;
window.LIMIT = 20;
window.isFetchingExecutions = false;
window.lastRawConcurrency = []; // Cache for raw 5-minute points
window.lastTopWorkflows = [];   // Cache for exec filter dropdown

// userSettings, formatTime and initSettings moved to global_functions.js in M-17.
// They lived here, and app.js is not loaded by errors.html — so the timezone
// setting had no effect on the one page made entirely of timestamps.

