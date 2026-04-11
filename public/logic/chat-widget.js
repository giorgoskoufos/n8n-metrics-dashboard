// ==========================================
// n8n AI Chat Widget Logic
// ==========================================

console.log("🤖 AI Chat Widget Initializing...");

// Global state
let isChatOpen = false;

// --- SECTION 1: TOGGLE LOGIC ---

function toggleChat() {
    console.log("🤖 Toggling AI Chat. Current state:", isChatOpen);
    const widget = document.getElementById('chatWidget');
    const toggleBtn = document.getElementById('chatToggle');
    const input = document.getElementById('userInput');

    if (!widget || !toggleBtn || !input) {
        console.error("🤖 Chat widget elements not found!");
        return;
    }

    isChatOpen = !isChatOpen;

    if (isChatOpen) {
        // Show Widget
        widget.classList.remove('translate-y-10', 'translate-y-full', 'opacity-0', 'pointer-events-none');
        widget.classList.add('translate-y-0', 'opacity-100', 'pointer-events-auto');

        // Update FAB icons
        const robotIcon = toggleBtn.querySelector('.fa-robot');
        const xIcon = toggleBtn.querySelector('.fa-xmark');
        if (robotIcon) robotIcon.classList.add('hidden');
        if (xIcon) xIcon.classList.remove('hidden');

        input.focus();

        // Robust iOS body scroll lock
        if (window.innerWidth < 1024) {
            // Reset any custom resized dimensions for mobile
            widget.style.width = '100%';
            widget.style.height = '';

            const scrollY = window.scrollY;
            document.body.style.position = 'fixed';
            document.body.style.top = `-${scrollY}px`;
            document.body.style.width = '100%';
            document.body.style.overflow = 'hidden';
            document.body.dataset.scrollY = scrollY;

            // Sync initial viewport for iOS
            if (window.visualViewport) {
                widget.style.height = `${window.visualViewport.height}px`;
                widget.style.top = `${window.visualViewport.offsetTop}px`;
            }
        }
    } else {
        // Hide Widget
        if (window.innerWidth < 1024) {
            widget.classList.add('translate-y-full', 'opacity-0', 'pointer-events-none');
            resetViewportStyles(); // Clear iOS-specific overrides

            // Restore scroll and release lock
            const scrollY = document.body.dataset.scrollY;
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.width = '';
            document.body.style.overflow = '';
            window.scrollTo(0, parseInt(scrollY || '0'));
        } else {
            widget.classList.add('translate-y-10', 'opacity-0', 'pointer-events-none');
        }
        widget.classList.remove('translate-y-0', 'opacity-100', 'pointer-events-auto');

        const robotIcon = toggleBtn.querySelector('.fa-robot');
        const xIcon = toggleBtn.querySelector('.fa-xmark');
        if (robotIcon) robotIcon.classList.remove('hidden');
        if (xIcon) xIcon.classList.add('hidden');
    }
}

// Ensure toggle function is global
window.toggleChat = toggleChat;

// --- SECTION 2: EVENT LISTENERS ---

function initChatWidget() {
    const sendBtn = document.getElementById('sendBtn');
    const userInput = document.getElementById('userInput');
    const widget = document.getElementById('chatWidget');
    const chatBox = document.getElementById('chatBox');

    if (sendBtn) {
        sendBtn.addEventListener('click', sendMessage);
    }

    if (userInput) {
        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Auto-expand textarea
        userInput.addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });
    }

    // iOS Gesture Isolation: Prevent background panning
    if (widget && chatBox) {
        widget.addEventListener('touchmove', (e) => {
            // If the touch is NOT in the scrollable chatBox, block it
            if (!chatBox.contains(e.target)) {
                if (isChatOpen) e.preventDefault();
            }
        }, { passive: false });
    }

    // Load history on start
    loadChatHistory();

    // Initialize resizer for both desktop and mobile
    initResizer();
}

function initResizer() {
    const handle = document.getElementById('chatResizeHandle');
    const widget = document.getElementById('chatWidget');
    if (!handle || !widget) return;

    let startX, startY, startWidth, startHeight;

    function startResize(e) {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;
        startWidth = widget.offsetWidth;
        startHeight = widget.offsetHeight;

        function onMove(moveEvent) {
            const currentX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
            const currentY = moveEvent.touches ? moveEvent.touches[0].clientY : moveEvent.clientY;

            const deltaX = startX - currentX;
            const deltaY = startY - currentY;

            const newWidth = Math.max(300, Math.min(window.innerWidth - 10, startWidth + deltaX));
            const newHeight = Math.max(400, Math.min(window.innerHeight - 10, startHeight + deltaY));

            widget.style.width = `${newWidth}px`;
            widget.style.height = `${newHeight}px`;
            scrollToBottom();
        }

        function onEnd() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    }

    handle.addEventListener('mousedown', startResize);
    handle.addEventListener('touchstart', startResize, { passive: false });
}

async function loadChatHistory() {
    const chatBox = document.getElementById('chatBox');
    if (!chatBox) return;

    try {
        const response = await fetchWithAuth('/api/chat-history');
        if (response.ok) {
            const history = await response.json();
            if (history.length > 0) {
                // Clear the default welcome message if there's history
                chatBox.innerHTML = '';
                history.forEach(msg => {
                    appendMessage(msg.role, msg.content, msg.sql_used);
                });
                scrollToBottom();
            }
        }
    } catch (err) {
        console.error("🤖 Failed to load chat history:", err);
    }
}

// Run init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatWidget);
} else {
    initChatWidget();
}

// --- SECTION 3: CORE CHAT LOGIC ---

async function sendMessage() {
    const input = document.getElementById('userInput');
    const sendBtn = document.getElementById('sendBtn');
    const text = input.value.trim();
    if (!text) return;

    appendMessage('user', text);

    input.value = '';
    input.style.height = 'auto';
    input.disabled = true;
    sendBtn.disabled = true;

    const loadingId = showTypingIndicator();

    try {
        const response = await fetchWithAuth('/api/ai-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });

        const data = await response.json();
        removeMessage(loadingId);

        if (response.ok) {
            appendMessage('ai', data.answer, data.sqlUsed);
        } else {
            appendMessage('error', data.error || 'AI encountered an issue.', data.details);
        }
    } catch (err) {
        removeMessage(loadingId);
        appendMessage('error', 'Connection failed. Please try again.');
        console.error("AI Chat Widget Error:", err);
    } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
    }
}

// --- SECTION 4: UI UPDATERS ---

function appendMessage(role, text, sql = null) {
    const chatBox = document.getElementById('chatBox');
    if (!chatBox) return;

    const msgDiv = document.createElement('div');
    msgDiv.classList.add('flex', 'w-full');

    if (role === 'user') {
        msgDiv.classList.add('justify-end');
        msgDiv.innerHTML = `
            <div class="bg-indigo-600 text-white p-3 rounded-2xl rounded-tr-none max-w-[85%] shadow-sm">
                <p class="text-xs leading-relaxed whitespace-pre-wrap">${escapeHtml(text)}</p>
            </div>
        `;
    } else {
        const isError = role === 'error';
        const borderColor = isError ? 'border-red-900/50' : 'border-gray-800';
        const iconColor = isError ? 'text-red-400' : 'text-indigo-400';
        const icon = isError ? 'fa-triangle-exclamation' : 'fa-robot';

        let sqlHtml = '';
        if (sql) {
            sqlHtml = `
                <div class="mt-2 pt-2 border-t border-gray-700/50">
                    <p class="text-[10px] text-gray-500 mb-1 font-semibold uppercase">Executed Query:</p>
                    <pre class="bg-black/40 p-2 rounded text-[10px] font-mono text-gray-400 overflow-x-auto whitespace-pre-wrap">${escapeHtml(sql)}</pre>
                </div>
            `;
        }

        // Parse markdown for AI responses, escape for errors
        const formattedContent = isError ? escapeHtml(text) : marked.parse(text);

        msgDiv.classList.add('justify-start', 'gap-3', 'items-start');
        msgDiv.innerHTML = `
            <div class="bg-indigo-600/20 border border-indigo-500/30 w-8 h-8 shrink-0 flex items-center justify-center rounded-full mt-1">
                <i class="fa-solid ${icon} fa-fw ${iconColor} text-sm"></i>
            </div>
            <div class="bg-n8n-card border ${borderColor} p-3 rounded-2xl rounded-tl-none max-w-[85%] shadow-sm w-full prose-chat text-white">
                <div class="text-xs leading-relaxed">${formattedContent}</div>
                ${sqlHtml}
            </div>
        `;
    }

    chatBox.appendChild(msgDiv);
    scrollToBottom();
}

function showTypingIndicator() {
    const chatBox = document.getElementById('chatBox');
    const id = 'typing-' + Date.now();
    const msgDiv = document.createElement('div');
    msgDiv.id = id;
    msgDiv.classList.add('flex', 'gap-3', 'items-start', 'w-full');

    msgDiv.innerHTML = `
        <div class="bg-indigo-600/20 border border-indigo-500/30 w-8 h-8 shrink-0 flex items-center justify-center rounded-full mt-1">
            <i class="fa-solid fa-robot fa-fw text-indigo-400 text-sm animate-pulse"></i>
        </div>
        <div class="bg-n8n-card border border-gray-800 p-3 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-1">
            <div class="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style="animation-delay: 0ms"></div>
            <div class="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style="animation-delay: 150ms"></div>
            <div class="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style="animation-delay: 300ms"></div>
        </div>
    `;

    if (chatBox) chatBox.appendChild(msgDiv);
    scrollToBottom();
    return id;
}

function removeMessage(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function scrollToBottom() {
    const chatBox = document.getElementById('chatBox');
    if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// --- SECTION 5: VIEWPORT HANDLING (iOS Fix) ---

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        const widget = document.getElementById('chatWidget');
        if (widget && isChatOpen && window.innerWidth < 1024) {
            widget.style.height = `${window.visualViewport.height}px`;
            setTimeout(scrollToBottom, 50);
        }
    });

    window.visualViewport.addEventListener('scroll', () => {
        const widget = document.getElementById('chatWidget');
        if (widget && isChatOpen && window.innerWidth < 1024) {
            widget.style.top = `${window.visualViewport.offsetTop}px`;
        }
    });
}

function resetViewportStyles() {
    const widget = document.getElementById('chatWidget');
    if (widget) {
        widget.style.height = '';
        widget.style.top = '';
    }
}
