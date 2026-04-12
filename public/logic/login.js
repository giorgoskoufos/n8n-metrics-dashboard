// ==========================================
// Login Logic - n8n Analytics
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    // 1. If the user ALREADY has a token, redirect them to the dashboard!
    const token = localStorage.getItem('n8n_auth_token');
    if (token) {
        window.location.href = '../index.html';
        return;
    }

    // 2. Login Form Handling
    const loginForm = document.getElementById('loginForm');
    
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault(); // Prevent page reload
            
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const errorDiv = document.getElementById('loginError');
            const btn = document.getElementById('loginBtn');

            // UI State: Loading
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
            btn.disabled = true;
            errorDiv.classList.add('hidden');

            try {
                // Post to backend (root /api/ from /pages/ context)
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();

                if (response.ok) {
                    // Store token in browser
                    localStorage.setItem('n8n_auth_token', data.token);
                    
                    // Redirect to the main Dashboard!
                    window.location.href = '../index.html';
                } else {
                    // Display Error
                    errorDiv.innerText = data.error || 'Login failed';
                    errorDiv.classList.remove('hidden');
                }
            } catch (err) {
                errorDiv.innerText = 'Server communication error.';
                errorDiv.classList.remove('hidden');
                console.error(err);
            } finally {
                // Restore button state
                btn.innerHTML = '<span>Login</span> <i class="fa-solid fa-arrow-right text-sm"></i>';
                btn.disabled = false;
            }
        });
    }
});