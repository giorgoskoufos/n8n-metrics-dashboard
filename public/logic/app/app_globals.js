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

    return date.toLocaleString('en-US', baseOptions);
};

// Fetch settings once at boot
window.initSettings = async function() {
    try {
        const res = await fetchWithAuth('/api/settings');
        if (res.ok) {
            window.userSettings = await res.json();
            console.log("[SETTINGS] Timezone initialized:", window.userSettings.timezone || 'auto');
        }
    } catch (e) { }
}

