// ==========================================
// Global Utility Functions - n8n Analytics
// ==========================================

let isRedirecting = false;

/**
 * Global Authenticated Fetch Helper
 * Handles automatic token injection and 401/403 redirects.
 */
window.fetchWithAuth = async (url, options = {}) => {
    const token = localStorage.getItem('n8n_auth_token');
    const isPages = window.isInPagesFolder;

    if (!token) {
        window.location.replace(isPages ? 'login.html' : 'pages/login.html');
        throw new Error("No token found");
    }

    const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
        'Authorization': `Bearer ${token}`
    };

    const response = await fetch(url, { ...options, headers });

    if (response.status === 401 || response.status === 403) {
        if (!isRedirecting) {
            isRedirecting = true;
            console.warn("[AUTH] Session expired or invalid token.");
            localStorage.removeItem('n8n_auth_token');
            window.location.replace((isPages ? '' : 'pages/') + 'login.html?reason=expired');
        }
        throw new Error("Session expired");
    }

    return response;
};

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
