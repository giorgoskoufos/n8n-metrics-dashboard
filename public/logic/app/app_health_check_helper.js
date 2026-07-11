// --- SECTION 1.5: HEALTH CHECK HELPER ---
window.checkN8nHealth = async function() {
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
    } catch (e) {
        healthContainer.innerHTML = `<span class="flex h-2 w-2 relative mr-2">
  <span class="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
</span> <span class="text-[10px] text-red-500 font-bold tracking-widest uppercase">n8n Offline</span>`;
    }
}

window.checkN8nHealth();

