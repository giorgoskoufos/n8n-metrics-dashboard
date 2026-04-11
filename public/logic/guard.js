// ==========================================
// Authentication Guard - n8n Analytics
// ==========================================

const isInPagesFolder = window.location.pathname.includes('/pages/');

(function enforceLogin() {
    const token = localStorage.getItem('n8n_auth_token');
    
    // Αν ΔΕΝ υπάρχει token, κάνουμε redirect
    if (!token) {
        // Αν είμαστε στο chat.html (/pages/) πάμε στο 'login.html'
        // Αν είμαστε στο index.html (root) πάμε στο 'pages/login.html'
        window.location.replace(isInPagesFolder ? 'login.html' : 'pages/login.html');
    }
})();

// Global Logout Function
window.logout = function() {
    console.log("Logging out...");
    localStorage.removeItem('n8n_auth_token');
    window.location.replace(isInPagesFolder ? 'login.html' : 'pages/login.html');
};