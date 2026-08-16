// ==========================================
// Global Utility Functions - n8n Analytics
// ==========================================

/**
 * Escapes a value for safe interpolation into an HTML template string.
 *
 * Every value that reaches the DOM through innerHTML must pass through this.
 * Workflow names, node names and error messages all originate from n8n and are
 * controlled by anyone with editor access there — an unescaped one becomes script
 * execution in this page, which can read the auth token out of localStorage.
 */
window.escapeHtml = function (unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

/**
 * Declarative click dispatcher.
 *
 * Replaces every inline `onclick="fn(arg)"` with `data-action="fn" data-arg="arg"`.
 * Inline handlers are what forced `script-src 'unsafe-inline'` into the CSP, and
 * that directive is exactly what makes an escaping mistake escalate into script
 * execution. With them gone the CSP can refuse inline script outright.
 *
 * Only names listed here can be dispatched, so a stray data-action in injected
 * markup cannot reach an arbitrary global.
 */
const DISPATCHABLE_ACTIONS = [
    'toggleChat', 'switchTab', 'applyPreset', 'setConcPreset', 'closeDetailsModal',
    'logout', 'forceDbSync', 'setErrorRange', 'closeWindow', 'loadRoiMetrics',
    'copyErrorMessage', 'closeErrorModal', 'clearExecFilters', 'applyExecFilters'
];

window.closeWindow = function () { window.close(); };

document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) return;

    const action = el.getAttribute('data-action');
    if (!DISPATCHABLE_ACTIONS.includes(action)) {
        console.warn(`[ACTION] Refusing to dispatch unknown action: ${action}`);
        return;
    }

    const handler = window[action];
    if (typeof handler !== 'function') {
        console.warn(`[ACTION] Handler not loaded on this page: ${action}`);
        return;
    }

    const raw = el.getAttribute('data-arg');
    if (raw === null) {
        handler();
    } else {
        // Numeric arguments (hour ranges, presets) must stay numbers — the original
        // inline handlers passed them as literals, not strings.
        const numeric = Number(raw);
        handler(raw !== '' && !Number.isNaN(numeric) ? numeric : raw);
    }
});

/**
 * Renders markdown to sanitized HTML.
 *
 * marked passes HTML in its input straight through to the output, so its result
 * must never reach innerHTML unsanitized. Falls back to plain escaped text if
 * either library failed to load, so a CDN or file error degrades to unformatted
 * text rather than to an injection point.
 */
window.renderMarkdownSafely = function (text) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
        console.warn('[SECURITY] marked or DOMPurify unavailable — rendering as plain text.');
        return window.escapeHtml(text);
    }
    return DOMPurify.sanitize(marked.parse(text), {
        ALLOWED_TAGS: [
            'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
            'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'span'
        ],
        ALLOWED_ATTR: [], // no href, no src, no style — nothing to hang a payload on
        FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'a', 'img']
    });
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
