// ==========================================
// Authentication Guard - n8n Analytics
// ==========================================

(function enforceLogin() {
    const token = localStorage.getItem('n8n_auth_token');
    
    // Αν ΔΕΝ υπάρχει token, κάνουμε redirect
    if (!token) {
        // Ελέγχουμε αν βρισκόμαστε ήδη μέσα στον φάκελο /pages/
        const isInPagesFolder = window.location.pathname.includes('/pages/');
        
        // Αν είμαστε στο chat.html (/pages/) πάμε στο 'login.html'
        // Αν είμαστε στο index.html (root) πάμε στο 'pages/login.html'
        window.location.replace(isInPagesFolder ? 'login.html' : 'pages/login.html');
    }
})();