// settings_save.js
;(() => {
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

            const settings = window.allWorkflows.map(wf => ({
                workflow_id: wf.id,
                saved_time_seconds: parseInt(wf.saved_time_seconds) || 0,
                hourly_rate: parseFloat(wf.hourly_rate) || 0
            }));

            try {
                const res = await window.fetchWithAuth('/api/settings/roi', {
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
    }

    const savePrefsBtn = document.getElementById('savePrefsBtn');
    if (savePrefsBtn) {
        savePrefsBtn.addEventListener('click', async () => {
            const tz = document.getElementById('timezoneSelect').value;
            savePrefsBtn.disabled = true;
            savePrefsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            
            try {
                const res = await window.fetchWithAuth('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'timezone', value: tz })
                });
                
                if (!res.ok) throw new Error("Failed to save preference");
                
                savePrefsBtn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
                savePrefsBtn.classList.replace('bg-indigo-600', 'bg-green-600');
                
                setTimeout(() => {
                    savePrefsBtn.innerHTML = '<i class="fa-solid fa-check"></i> Save Preferences';
                    savePrefsBtn.classList.replace('bg-green-600', 'bg-indigo-600');
                    savePrefsBtn.disabled = false;
                }, 2000);
            } catch (err) {
                console.error(err);
                alert("Error saving preferences.");
                savePrefsBtn.disabled = false;
                savePrefsBtn.innerHTML = '<i class="fa-solid fa-check"></i> Save Preferences';
            }
        });
    }
})();
