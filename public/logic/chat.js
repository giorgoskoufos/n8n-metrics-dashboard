// ==========================================
// n8n AI Chat Logic
// ==========================================

const chatBox = document.getElementById('chatBox');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');


// --- SECTION 1: EVENT LISTENERS ---

// Submit with button
sendBtn.addEventListener('click', sendMessage);

// Submit with Enter (no Shift)
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // Prevent newline
        sendMessage();
    }
});

// Auto-resize textarea as the user types
userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    if(this.value === '') this.style.height = 'auto'; // Reset when empty
});

// --- SECTION 2: CORE LOGIC ---

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    // 1. Add user message to UI
    appendMessage('user', text);
    
    // 2. Clear and lock input
    userInput.value = '';
    userInput.style.height = 'auto';
    userInput.disabled = true;
    sendBtn.disabled = true;

    // 3. Show thinking indicator
    const loadingId = showTypingIndicator();

    try {
        // 4. Call Backend API
        const response = await fetchWithAuth('/api/ai-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });
        
        const data = await response.json();
        
        // 5. Remove loading indicator
        removeMessage(loadingId);

        // 6. Append AI response
        if (response.ok) {
            appendMessage('ai', data.answer, data.sqlUsed);
        } else {
            appendMessage('error', data.error || 'AI encountered an error.', data.details);
        }

    } catch (err) {
        removeMessage(loadingId);
        appendMessage('error', 'Connection failed. Please try again later.');
        console.error("AI Chat Error:", err);
    } finally {
        // 7. Unlock input
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
        // User Bubble (Right, Blue)
        msgDiv.classList.add('justify-end');
        msgDiv.innerHTML = `
            <div class="bg-indigo-600 text-white p-4 rounded-2xl rounded-tr-none max-w-[85%] shadow-sm">
                <p class="text-sm leading-relaxed whitespace-pre-wrap">${escapeHtml(text)}</p>
            </div>
        `;
    } else {
        // AI Bubble (Left, Dark) or Error (Red)
        const isError = role === 'error';
        const borderColor = isError ? 'border-red-900/50' : 'border-gray-800';
        const iconColor = isError ? 'text-red-400' : 'text-indigo-400';
        const icon = isError ? 'fa-triangle-exclamation' : 'fa-robot';
        
        let sqlHtml = '';
        if (sql) {
            sqlHtml = `
                <div class="mt-3 pt-3 border-t border-gray-700/50">
                    <p class="text-xs text-gray-500 mb-1 font-semibold">Executed Query:</p>
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

// Helper: XSS Protection
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}