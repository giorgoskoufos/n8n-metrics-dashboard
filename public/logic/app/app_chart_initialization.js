// --- SECTION 2: CHART INITIALIZATION ---
window.initCharts = function() {
    const elLine = document.getElementById('lineChart');
    if (elLine) {
        const ctxLine = elLine.getContext('2d');
        window.lineChart = new Chart(ctxLine, {
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
                            callback: function (val, index) {
                                const label = this.getLabelForValue(val);
                                if (!label) return '';
                                return window.formatTime(label, { hour: '2-digit', minute: '2-digit' });
                            }
                        }
                    }
                }
            }
        });
    }

    const elDoughnut = document.getElementById('doughnutChart');
    if (elDoughnut) {
        const ctxDoughnut = elDoughnut.getContext('2d');
        window.doughnutChart = new Chart(ctxDoughnut, {
            type: 'doughnut',
            data: { labels: [], datasets: [{ data: [], borderWidth: 0, cutout: '75%', hoverOffset: 15 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
        });
    }

    const elConcurrency = document.getElementById('concurrencyChart');
    if (elConcurrency) {
        const ctxConcurrency = elConcurrency.getContext('2d');
        window.concurrencyChart = new Chart(ctxConcurrency, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Active Executions',
                    data: [],
                    borderColor: '#6366f1',
                    backgroundColor: (context) => {
                        const chart = context.chart;
                        const { ctx, chartArea } = chart;
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
                        const timestamp = window.concurrencyChart.data.labels[dataIndex];
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
                            callback: function (val, index) {
                                const label = this.getLabelForValue(val);
                                return window.formatTime(label, { hour: '2-digit', minute: '2-digit' });
                            }
                        }
                    }
                }
            }
        });
    }
}

/**
 * Main dashboard initialization - only runs if we are on the index/dashboard page.
 */
window.initDashboard = function() {
    return !!document.getElementById('lineChart');
}

