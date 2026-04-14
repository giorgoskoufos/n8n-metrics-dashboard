// ==========================================
// Global Utility Functions - n8n Analytics
// ==========================================

/**
 * Global Manual Sync Trigger
 * Controls the Sync button state and triggers backend ETL.
 */
window.forceDbSync = async function() {
    const btn = document.getElementById('syncBtn');
    const icon = document.getElementById('syncIcon');
    
    // UI Feedback: Start
    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('fa-spin-pulse');

    try {
        const res = await window.fetchWithAuth('/api/sync/force', { method: 'POST' });
        
        if (res.ok) {
            // Success: Reload to show fresh data
            window.location.reload();
        } else {
            const errData = await res.json().catch(() => ({}));
            alert('Sync failed: ' + (errData.error || 'Check server logs.'));
        }
    } catch (e) {
        console.error("[SYNC] Manual trigger failed:", e);
    } finally {
        // UI Feedback: End (only if reload didn't happen)
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('fa-spin-pulse');
    }
};
