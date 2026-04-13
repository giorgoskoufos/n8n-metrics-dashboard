document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('settingsContainer');
    const saveBtn = document.getElementById('saveBtn');
    
    // New UX Elements
    const searchInput = document.getElementById('workflowSearch');
    const sortSelect = document.getElementById('workflowSort');
    const jumpBtn = document.getElementById('jumpBtn');
    const jumpIcon = document.getElementById('jumpIcon');

    let allWorkflows = [];
    let globalSettings = {};

    // Fetch Global Settings
    try {
        const res = await fetchWithAuth('/api/settings');
        if (res.ok) {
            globalSettings = await res.json();
            if (globalSettings.timezone) {
                document.getElementById('timezoneSelect').value = globalSettings.timezone;
            }
        }
    } catch (err) { console.error("Failed to load global settings", err); }

    // Fetch Settings
    try {
        const response = await fetchWithAuth('/api/settings/roi');
        if (!response.ok) throw new Error("Failed to fetch settings");
        
        allWorkflows = await response.json();
        
        if (allWorkflows.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">No workflows found. Run a sync first.</div>';
            return;
        }

        renderWorkflows();

    } catch (err) {
        console.error(err);
        container.innerHTML = '<div class="text-center py-8 text-red-500 text-sm">Failed to load workflows.</div>';
    }

    function renderWorkflows() {
        if (!container) return;
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
        const sortMode = sortSelect ? sortSelect.value : 'name_asc';
        
        // Filter
        let filtered = allWorkflows.filter(wf => 
            wf.name.toLowerCase().includes(searchTerm) || 
            wf.id.toLowerCase().includes(searchTerm)
        );

        // Sort
        filtered.sort((a, b) => {
            if (sortMode === 'name_asc') {
                return a.name.localeCompare(b.name);
            } else if (sortMode === 'name_desc') {
                return b.name.localeCompare(a.name);
            } else if (sortMode === 'execs_desc') {
                const countA = parseInt(a.execution_count) || 0;
                const countB = parseInt(b.execution_count) || 0;
                return countB - countA;
            } else if (sortMode === 'time_desc') {
                const timeA = parseInt(a.saved_time_seconds) || 0;
                const timeB = parseInt(b.saved_time_seconds) || 0;
                return timeB - timeA;
            }
            return 0;
        });

        // Calculate DOM
        if (filtered.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-gray-600 text-sm border border-dashed border-gray-700 rounded-lg">No workflows match your search.</div>';
            updateJumpButtonVisibility();
            return;
        }

        container.innerHTML = filtered.map(wf => `
            <div class="flex flex-col p-3 border border-gray-800 rounded-lg hover:bg-gray-800/50 transition-colors settings-row bg-n8n-card/30" data-id="${wf.id}">
                <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div class="truncate pr-4 flex-1 w-full">
                        <h3 class="text-sm font-semibold text-gray-200 truncate" title="${escapeHtml(wf.name)}">${escapeHtml(wf.name)}</h3>
                        <div class="flex gap-4 mt-1">
                            <p class="text-xs text-gray-500 font-mono">ID: ${escapeHtml(wf.id)}</p>
                            ${wf.execution_count ? `<p class="text-xs text-indigo-400/80"><i class="fa-solid fa-bolt mr-1"></i>${parseInt(wf.execution_count).toLocaleString()} execs</p>` : ''}
                        </div>
                    </div>
                    
                    <div class="flex flex-wrap sm:flex-nowrap items-center gap-3 sm:gap-4 flex-shrink-0 w-full sm:w-auto mt-2 sm:mt-0 justify-between sm:justify-end">
                        <button class="text-xs text-gray-400 hover:text-indigo-400 underline wizard-toggle bg-transparent border-none cursor-pointer text-left focus:outline-none">
                            Wizard Calculator
                        </button>
                        
                        <div class="flex items-center gap-1 bg-black/20 p-1.5 rounded border border-gray-800">
                            <span class="text-xs text-gray-500 ml-1">Wage/hr: $</span>
                            <input type="number" min="0" value="${wf.hourly_rate || 0}" class="w-16 bg-[#171717] border border-gray-700 rounded p-1 text-sm text-white focus:border-indigo-500 focus:outline-none text-right hourly-rate-input shadow-inner transition-colors">
                        </div>

                        <div class="flex items-center gap-1 bg-black/20 p-1.5 rounded border border-gray-800">
                            <span class="text-xs text-gray-500 ml-1">Time Saved/Exec:</span>
                            <input type="number" min="0" value="${wf.saved_time_seconds}" class="w-20 bg-[#171717] border border-gray-700 rounded p-1 text-sm text-white focus:border-indigo-500 focus:outline-none text-right saved-time-input shadow-inner transition-colors">
                            <span class="text-xs text-gray-500 mr-1">s</span>
                        </div>
                    </div>
                </div>

                <!-- Expandable Wizard -->
                <div class="wizard-container hidden mt-4 pt-3 border-t border-gray-800/60 bg-black/20 rounded-md p-4 shadow-inner">
                    <p class="text-xs text-gray-400 mb-3"><i class="fa-solid fa-wand-magic-sparkles mr-1 text-indigo-400"></i> Calculate exact machine seconds based on your human labor baseline.</p>
                    <div class="flex flex-wrap items-end gap-3 text-sm">
                        <!-- Frequency -->
                        <div>
                            <label class="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Manual Freq</label>
                            <input type="number" min="1" value="5" class="w-20 bg-[#171717] border border-gray-700 rounded p-2 text-white focus:outline-none focus:border-indigo-500 wiz-freq">
                        </div>
                        <div>
                            <label class="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Per</label>
                            <select class="bg-[#171717] border border-gray-700 rounded p-2 text-white focus:outline-none cursor-pointer wiz-per">
                                <option value="day">Day</option>
                                <option value="week" selected>Week</option>
                                <option value="month">Month</option>
                            </select>
                        </div>
                        
                        <!-- Duration -->
                        <div class="ml-0 sm:ml-2">
                            <label class="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Manual Duration</label>
                            <input type="number" min="1" value="3" class="w-20 bg-[#171717] border border-gray-700 rounded p-2 text-white focus:outline-none focus:border-indigo-500 wiz-dur">
                        </div>
                        <div>
                            <label class="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Unit</label>
                            <select class="bg-[#171717] border border-gray-700 rounded p-2 text-white focus:outline-none cursor-pointer wiz-unit">
                                <option value="minutes">Minutes</option>
                                <option value="hours" selected>Hours</option>
                            </select>
                        </div>
                        
                        <!-- Referene -->
                        <div class="ml-0 sm:ml-4 flex flex-col justify-center bg-indigo-900/20 px-4 py-1.5 rounded border border-indigo-500/20 h-[38px]">
                            <span class="text-[10px] text-indigo-400 uppercase tracking-widest leading-none">n8n Executions (30d)</span>
                            <span class="text-white font-bold leading-tight wiz-execs">${wf.executions_30d || 1}</span>
                        </div>
                        
                        <button class="ml-auto w-full sm:w-auto bg-gray-700 hover:bg-indigo-600 text-white font-semibold py-2 px-4 rounded transition-colors text-xs wiz-apply mt-2 sm:mt-0 shadow-md">
                            Apply Calculated Value
                        </button>
                    </div>
                </div>
            </div>
        `).join('');

        // Re-attach core listeners
        document.querySelectorAll('.saved-time-input').forEach(input => {
            input.addEventListener('input', (e) => {
                const id = e.target.closest('.settings-row').getAttribute('data-id');
                const wf = allWorkflows.find(w => w.id === id);
                if (wf) wf.saved_time_seconds = parseInt(e.target.value) || 0;
            });
        });

        document.querySelectorAll('.hourly-rate-input').forEach(input => {
            input.addEventListener('input', (e) => {
                const id = e.target.closest('.settings-row').getAttribute('data-id');
                const wf = allWorkflows.find(w => w.id === id);
                if (wf) wf.hourly_rate = parseFloat(e.target.value) || 0;
            });
        });

        // Wizard UI Logic
        document.querySelectorAll('.wizard-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const container = e.target.closest('.settings-row').querySelector('.wizard-container');
                container.classList.toggle('hidden');
            });
        });

        document.querySelectorAll('.wiz-apply').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const row = e.target.closest('.settings-row');
                const freq = parseInt(row.querySelector('.wiz-freq').value) || 0;
                const per = row.querySelector('.wiz-per').value;
                const dur = parseInt(row.querySelector('.wiz-dur').value) || 0;
                const unit = row.querySelector('.wiz-unit').value;
                const execs = parseInt(row.querySelector('.wiz-execs').innerText.replace(/,/g, '')) || 1;
                
                // Convert Frequency to Monthly
                let multiplier = 1;
                if (per === 'day') multiplier = 30;
                if (per === 'week') multiplier = 30 / 7;
                
                const monthlyFreq = freq * multiplier;
                
                // Convert Duration to Seconds
                const unitSeconds = unit === 'hours' ? 3600 : 60;
                const totalHumanSeconds30d = monthlyFreq * dur * unitSeconds;
                
                // Calculate
                const calculatedSeconds = Math.round(totalHumanSeconds30d / Math.max(1, execs));
                
                // Update UI and Cache
                const timeInput = row.querySelector('.saved-time-input');
                timeInput.value = calculatedSeconds;
                
                const id = row.getAttribute('data-id');
                const wf = allWorkflows.find(w => w.id === id);
                if (wf) wf.saved_time_seconds = calculatedSeconds;
                
                // Flash green to show it worked
                timeInput.classList.add('bg-green-900/40', 'border-green-500');
                setTimeout(() => {
                    timeInput.classList.remove('bg-green-900/40', 'border-green-500');
                }, 800);
            });
        });

        // Need slight delay for rendering to finish before checking scroll height
        setTimeout(updateJumpButtonVisibility, 50);
    }

    searchInput?.addEventListener('input', renderWorkflows);
    sortSelect?.addEventListener('change', renderWorkflows);

    // Save ROI Settings
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

            // We use 'allWorkflows' as the source of truth because inputs map to it.
            const settings = allWorkflows.map(wf => ({
                workflow_id: wf.id,
                saved_time_seconds: parseInt(wf.saved_time_seconds) || 0,
                hourly_rate: parseFloat(wf.hourly_rate) || 0
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
    }

    // Save Preference Logic
    const savePrefsBtn = document.getElementById('savePrefsBtn');
    if (savePrefsBtn) {
        savePrefsBtn.addEventListener('click', async () => {
            const tz = document.getElementById('timezoneSelect').value;
            savePrefsBtn.disabled = true;
            savePrefsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            
            try {
                const res = await fetchWithAuth('/api/settings', {
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

    // Jump to Top/Bottom Logic
    function updateJumpButtonVisibility() {
        if (!jumpBtn) return;
        // Only show if page is significantly scrollable
        if (document.body.scrollHeight > window.innerHeight * 1.2) {
            jumpBtn.classList.remove('hidden');
            setTimeout(() => jumpBtn.classList.remove('opacity-0'), 10);
            updateJumpDirection();
        } else {
            jumpBtn.classList.add('opacity-0');
            setTimeout(() => jumpBtn.classList.add('hidden'), 300);
        }
    }

    function updateJumpDirection() {
        if (!jumpBtn || !jumpIcon) return;
        const scrollPosition = window.scrollY;
        const maxScroll = document.body.scrollHeight - window.innerHeight;
        
        // If we are more than halfway down, point UP. Otherwise, point DOWN.
        // Also account for cases where maxScroll is small or 0
        if (maxScroll > 0 && scrollPosition > (maxScroll / 2)) {
            jumpIcon.classList.remove('fa-arrow-down');
            jumpIcon.classList.add('fa-arrow-up');
        } else {
            jumpIcon.classList.remove('fa-arrow-up');
            jumpIcon.classList.add('fa-arrow-down');
        }
    }

    window.addEventListener('scroll', updateJumpDirection);
    window.addEventListener('resize', updateJumpButtonVisibility);

    jumpBtn?.addEventListener('click', () => {
        const isPointingUp = jumpIcon.classList.contains('fa-arrow-up');
        if (isPointingUp) {
            // Jump to top
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            // Jump to bottom
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
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
