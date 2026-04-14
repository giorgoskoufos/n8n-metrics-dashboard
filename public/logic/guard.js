// ==========================================
// Authentication Guard - n8n Analytics
// ==========================================

window.isInPagesFolder = window.location.pathname.includes('/pages/');

let isRedirecting = false;

(function enforceLogin() {
    const token = localStorage.getItem('n8n_auth_token');
    if (!token) {
        window.location.replace(isInPagesFolder ? 'login.html' : 'pages/login.html');
    }
})();

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

window.logout = function() {
    console.log("Logging out...");
    localStorage.removeItem('n8n_auth_token');
    window.location.replace(isInPagesFolder ? 'login.html' : 'pages/login.html');
};