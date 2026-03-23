// ==========================================
// Login Logic - n8n Analytics
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    // 1. Αν ο χρήστης έχει ΗΔΗ token, τον στέλνουμε κατευθείαν στο dashboard!
    const token = localStorage.getItem('n8n_auth_token');
    if (token) {
        window.location.href = '../index.html';
        return;
    }

    // 2. Διαχείριση της φόρμας Login
    const loginForm = document.getElementById('loginForm');
    
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault(); // Αποτρέπουμε το reload της σελίδας
            
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const errorDiv = document.getElementById('loginError');
            const btn = document.getElementById('loginBtn');

            // UI State: Loading
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Φόρτωση...';
            btn.disabled = true;
            errorDiv.classList.add('hidden');

            try {
                // Κάνουμε POST στο backend (επειδή είμαστε στο /pages/, το API είναι στο root /api/)
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();

                if (response.ok) {
                    // Αποθήκευση του Token στον Browser
                    localStorage.setItem('n8n_auth_token', data.token);
                    
                    // Ανακατεύθυνση στο κεντρικό Dashboard!
                    window.location.href = '../index.html';
                } else {
                    // Εμφάνιση Σφάλματος
                    errorDiv.innerText = data.error || 'Αποτυχία σύνδεσης';
                    errorDiv.classList.remove('hidden');
                }
            } catch (err) {
                errorDiv.innerText = 'Σφάλμα επικοινωνίας με τον server.';
                errorDiv.classList.remove('hidden');
                console.error(err);
            } finally {
                // Επαναφορά UI κουμπιού
                btn.innerHTML = '<span>Σύνδεση</span> <i class="fa-solid fa-arrow-right text-sm"></i>';
                btn.disabled = false;
            }
        });
    }
});