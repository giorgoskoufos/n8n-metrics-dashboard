// ==========================================
// n8n AI Chat Logic
// ==========================================

const chatBox = document.getElementById('chatBox');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');

// --- SECTION 1: EVENT LISTENERS ---

// Αποστολή με το κουμπί
sendBtn.addEventListener('click', sendMessage);

// Αποστολή με το Enter (χωρίς Shift για αλλαγή γραμμής)
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // Αποτρέπει την αλλαγή γραμμής
        sendMessage();
    }
});

// Αυτόματη αλλαγή ύψους του textarea καθώς γράφει ο χρήστης
userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    if(this.value === '') this.style.height = 'auto'; // Επαναφορά όταν αδειάσει
});

// --- SECTION 2: CORE LOGIC ---

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    // 1. Προσθήκη μηνύματος χρήστη στο UI
    appendMessage('user', text);
    
    // 2. Καθαρισμός και κλείδωμα του input
    userInput.value = '';
    userInput.style.height = 'auto';
    userInput.disabled = true;
    sendBtn.disabled = true;

    // 3. Εμφάνιση του "Σκέφτεται..." indicator
    const loadingId = showTypingIndicator();

    try {
        // 4. Κλήση στο Backend API
        const response = await fetch('/api/ai-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });
        
        const data = await response.json();
        
        // 5. Αφαίρεση του loading indicator
        removeMessage(loadingId);

        // 6. Εμφάνιση απάντησης AI
        if (response.ok) {
            appendMessage('ai', data.answer, data.sqlUsed);
        } else {
            appendMessage('error', data.error || 'Προέκυψε κάποιο σφάλμα στο AI.', data.details);
        }

    } catch (err) {
        removeMessage(loadingId);
        appendMessage('error', 'Αποτυχία σύνδεσης με τον server. Δοκίμασε ξανά σε λίγο.');
        console.error("AI Chat Error:", err);
    } finally {
        // 7. Ξεκλείδωμα του input
        userInput.disabled = false;
        sendBtn.disabled = false;
        userInput.focus();
    }
}

// --- SECTION 3: UI UPDATERS ---

function appendMessage(role, text, sql = null) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('flex', 'w-full');

    if (role === 'user') {
        // Συννεφάκι Χρήστη (Δεξιά, Μπλε)
        msgDiv.classList.add('justify-end');
        msgDiv.innerHTML = `
            <div class="bg-indigo-600 text-white p-4 rounded-2xl rounded-tr-none max-w-[85%] shadow-sm">
                <p class="text-sm leading-relaxed whitespace-pre-wrap">${escapeHtml(text)}</p>
            </div>
        `;
    } else {
        // Συννεφάκι AI (Αριστερά, Σκούρο) ή Error (Κόκκινο)
        const isError = role === 'error';
        const borderColor = isError ? 'border-red-900/50' : 'border-gray-800';
        const iconColor = isError ? 'text-red-400' : 'text-indigo-400';
        const icon = isError ? 'fa-triangle-exclamation' : 'fa-robot';
        
        let sqlHtml = '';
        if (sql) {
            sqlHtml = `
                <div class="mt-3 pt-3 border-t border-gray-700/50">
                    <p class="text-xs text-gray-500 mb-1 font-semibold">Εκτελέστηκε το Query:</p>
                    <pre class="bg-black/40 p-2 rounded text-xs font-mono text-gray-400 overflow-x-auto whitespace-pre-wrap">${escapeHtml(sql)}</pre>
                </div>
            `;
        }

        msgDiv.classList.add('justify-start', 'gap-4', 'items-start');
        msgDiv.innerHTML = `
            <div class="bg-indigo-600/20 border border-indigo-500/30 w-10 h-10 shrink-0 flex items-center justify-center rounded-full mt-1">
                <i class="fa-solid ${icon} fa-fw ${iconColor} text-lg"></i>
            </div>
            <div class="bg-n8n-card border ${borderColor} p-4 rounded-2xl rounded-tl-none max-w-[85%] shadow-sm w-full">
                <p class="text-sm leading-relaxed whitespace-pre-wrap">${escapeHtml(text)}</p>
                ${sqlHtml}
            </div>
        `;
    }

    chatBox.appendChild(msgDiv);
    scrollToBottom();
}

function showTypingIndicator() {
    const id = 'typing-' + Date.now();
    const msgDiv = document.createElement('div');
    msgDiv.id = id;
    msgDiv.classList.add('flex', 'gap-4', 'items-start', 'w-full');
    
    msgDiv.innerHTML = `
        <div class="bg-indigo-600/20 border border-indigo-500/30 w-10 h-10 shrink-0 flex items-center justify-center rounded-full mt-1">
            <i class="fa-solid fa-robot fa-fw text-indigo-400 text-lg animate-pulse"></i>
        </div>
        <div class="bg-n8n-card border border-gray-800 p-4 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-1">
            <div class="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style="animation-delay: 0ms"></div>
            <div class="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style="animation-delay: 150ms"></div>
            <div class="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style="animation-delay: 300ms"></div>
        </div>
    `;
    
    chatBox.appendChild(msgDiv);
    scrollToBottom();
    return id;
}

function removeMessage(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function scrollToBottom() {
    chatBox.scrollTop = chatBox.scrollHeight;
}

// Helper: Προστασία από XSS (αν ο χρήστης βάλει HTML tags)
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}