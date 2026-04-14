// ==========================================
// Authentication Guard - n8n Analytics
// ==========================================

window.isInPagesFolder = window.location.pathname.includes('/pages/');

(function enforceLogin() {
    const token = localStorage.getItem('n8n_auth_token');
    
    // If no token, redirect
    if (!token) {
        // If in pages folder (chat.html) go to 'login.html'
        // If at root (index.html) go to 'pages/login.html'
        window.location.replace(isInPagesFolder ? 'login.html' : 'pages/login.html');
    }
})();

window.logout = function() {
    console.log("Logging out...");
    localStorage.removeItem('n8n_auth_token');
    window.location.replace(isInPagesFolder ? 'login.html' : 'pages/login.html');
};