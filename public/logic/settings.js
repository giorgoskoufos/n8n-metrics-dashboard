document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('settingsContainer');
    const saveBtn = document.getElementById('saveBtn');
    
    // Fetch Settings
    try {
        const response = await fetchWithAuth('/api/settings/roi');
        if (!response.ok) throw new Error("Failed to fetch settings");
        
        const workflows = await response.json();
        
        if (workflows.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">No workflows found. Run a sync first.</div>';
            return;
        }

        container.innerHTML = workflows.map(wf => `
            <div class="flex items-center justify-between p-3 border border-gray-800 rounded-lg hover:bg-gray-800/50 transition-colors settings-row" data-id="${wf.id}">
                <div>
                    <h3 class="text-sm font-semibold text-gray-200">${escapeHtml(wf.name)}</h3>
                    <p class="text-xs text-gray-500 mt-1">ID: ${escapeHtml(wf.id)}</p>
                </div>
                <div class="flex items-center gap-2">
                    <input type="number" min="0" value="${wf.saved_time_seconds}" class="w-24 bg-n8n-dark border border-gray-700 rounded p-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none text-right saved-time-input">
                    <span class="text-xs text-gray-500">seconds</span>
                </div>
            </div>
        `).join('');

    } catch (err) {
        console.error(err);
        container.innerHTML = '<div class="text-center py-8 text-red-500 text-sm">Failed to load workflows.</div>';
    }

    // Save Settings
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        const rows = document.querySelectorAll('.settings-row');
        const settings = Array.from(rows).map(row => ({
            workflow_id: row.getAttribute('data-id'),
            saved_time_seconds: parseInt(row.querySelector('.saved-time-input').value) || 0
        }));

        try {
            const res = await fetchWithAuth('/api/settings/roi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings })
            });

            if (!res.ok) throw new Error("Failed to save");

            saveBtn.classList.replace('bg-indigo-600', 'bg-green-600');
            saveBtn.classList.replace('hover:bg-indigo-500', 'hover:bg-green-500');
            saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Saved!';
            
            setTimeout(() => {
                saveBtn.classList.replace('bg-green-600', 'bg-indigo-600');
                saveBtn.classList.replace('hover:bg-green-500', 'hover:bg-indigo-500');
                saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Settings';
                saveBtn.disabled = false;
            }, 2000);

        } catch (err) {
            console.error(err);
            alert("Error saving settings.");
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Settings';
        }
    });

    function escapeHtml(unsafe) {
        if (!unsafe) return '';
        return String(unsafe)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
});
