/**
 * Shared Surgical Error Snapshot Modal Component
 * Injects modal HTML and provides global logic.
 */

(function () {
    // 1. Inject CSS for scale transition if not present
    if (!document.getElementById('error-modal-styles')) {
        const style = document.createElement('style');
        style.id = 'error-modal-styles';
        style.textContent = `
            #errorModal.flex { display: flex !important; }
            #errorModal .scale-95 { transform: scale(0.95); }
            #errorModal .scale-100 { transform: scale(1.00); }
        `;
        document.head.appendChild(style);
    }

    // 2. Inject HTML
    const modalHTML = `
    <div id="errorModal" class="fixed inset-0 bg-black/90 backdrop-blur-md z-[9999] hidden items-center justify-center p-4">
        <div class="bg-n8n-card border border-gray-700 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl scale-95 transition-transform duration-300" id="modalContainer">
            <div class="p-6 border-b border-gray-800 flex justify-between items-center bg-black/20">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 bg-red-900/40 rounded-lg flex items-center justify-center border border-red-500/30">
                        <i class="fa-solid fa-triangle-exclamation text-red-400"></i>
                    </div>
                    <div>
                        <h3 class="text-lg font-bold text-white">Surgical Error Snapshot</h3>
                        <p class="text-[10px] text-gray-500 uppercase tracking-widest" id="modalTimestamp">Post-Mortem Analysis</p>
                    </div>
                </div>
                <button onclick="closeErrorModal()" class="text-gray-500 hover:text-white transition-colors p-2">
                    <i class="fa-solid fa-xmark text-xl"></i>
                </button>
            </div>
            <div class="p-8">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                    <div>
                        <label class="block text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Failing Node</label>
                        <div id="modalNodeName" class="text-white font-semibold text-sm bg-black/30 p-3 rounded border border-gray-800">--</div>
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Execution ID</label>
                        <div id="modalExecId" class="text-gray-400 font-mono text-sm bg-black/30 p-3 rounded border border-gray-800">--</div>
                    </div>
                </div>

                <label class="block text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Error Description</label>
                <div class="relative group">
                    <div id="modalErrorMessage" class="bg-red-900/10 p-4 pr-12 rounded-lg border border-red-500/20 text-red-400 font-mono text-xs leading-relaxed mb-8 max-h-64 overflow-y-auto whitespace-pre-wrap">
                        Loading...
                    </div>
                    <!-- Refined Square Copy Button -->
                    <button onclick="copyErrorMessage()" 
                        class="absolute top-3 right-3 w-8 h-8 flex items-center justify-center text-white/40 hover:text-white transition-all bg-black/60 hover:bg-indigo-600 rounded-md border border-white/10 z-20 shadow-lg"
                        title="Copy Error Content">
                        <i id="copyIcon" class="fa-regular fa-copy text-xs"></i>
                    </button>
                </div>

                <div class="flex flex-col sm:flex-row justify-between items-center gap-4">
                    <p class="text-[11px] text-gray-500 italic"><i class="fa-solid fa-lightbulb text-indigo-400 mr-1"></i> Snapshot captured via n8n Error Workflow</p>
                    <div class="flex gap-3">
                        <button id="deepDiveBtn" class="bg-gray-800 hover:bg-gray-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition-all flex items-center gap-2">
                            <i class="fa-solid fa-magnifying-glass-plus text-xs"></i> Fetch Raw Trace
                        </button>
                        <a id="n8nLink" href="#" target="_blank" class="bg-[#ff6f5c] hover:bg-opacity-90 text-white px-5 py-2.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2">
                            Open n8n <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
                        </a>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // 3. Logic
    let currentExecId = null;

    window.showErrorSnapshot = async function (execId) {
        currentExecId = execId;
        const modal = document.getElementById('errorModal');
        const container = document.getElementById('modalContainer');
        const msgBox = document.getElementById('modalErrorMessage');
        const idBox = document.getElementById('modalExecId');
        const nodeBox = document.getElementById('modalNodeName');
        const timestampBox = document.getElementById('modalTimestamp');
        const n8nLink = document.getElementById('n8nLink');
        const deepDiveBtn = document.getElementById('deepDiveBtn');

        if (!modal) return;

        // Dashboard specific cleanup if functions exist globally
        if (typeof window.closeDetailsModal === 'function') {
            window.closeDetailsModal();
        }

        // Reset UI
        idBox.innerText = execId;
        nodeBox.innerText = '--';
        msgBox.innerText = 'Loading snapshot...';
        timestampBox.innerText = 'Analyzing trace...';
        if (n8nLink) n8nLink.style.display = 'none';

        deepDiveBtn.onclick = () => window.fetchDetailedError(execId);

        // Show Modal
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden'; 
        
        setTimeout(() => {
            container.classList.remove('scale-95');
            container.classList.add('scale-100');
        }, 10);

        try {
            const response = await fetchWithAuth(`/api/execution-error/${execId}`);
            const data = await response.json();

            nodeBox.innerText = data.nodeName || 'Unknown Node';
            msgBox.innerText = data.message || 'Snapshot unavailable. Try fetching the raw trace.';
            
            if (data.timestamp) {
                const date = new Date(data.timestamp);
                timestampBox.innerText = date.toLocaleString();
            } else {
                timestampBox.innerText = 'Post-Mortem Analysis';
            }

            if (n8nLink && data.workflowId && data.n8nBaseUrl) {
                n8nLink.href = `${data.n8nBaseUrl}/workflow/${data.workflowId}/executions/${execId}`;
                n8nLink.style.display = 'flex';
            }
        } catch (err) {
            msgBox.innerText = 'No instant snapshot found. Use "Fetch Raw Trace" for a deep inspection.';
            timestampBox.innerText = 'Trace Empty';
        }
    };

    // Alias for backward compatibility
    window.showError = window.showErrorSnapshot;

    window.fetchDetailedError = async function (execId) {
        const msgBox = document.getElementById('modalErrorMessage');
        msgBox.innerText = 'Fetching raw JSON dump from Postgres... (This may take a moment)';

        try {
            const response = await fetchWithAuth(`/api/execution-error/${execId}?full=true`);
            const data = await response.json();
            msgBox.innerText = data.fullError || data.message || 'Full trace unavailable.';
        } catch (e) {
            msgBox.innerText = 'Error fetching raw trace from production database.';
        }
    };

    window.closeErrorModal = function () {
        const modal = document.getElementById('errorModal');
        const container = document.getElementById('modalContainer');
        if (modal) {
            container.classList.add('scale-95');
            container.classList.remove('scale-100');
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
                document.body.style.overflow = 'auto';
            }, 300);
            
            // Reset copy icon
            const icon = document.getElementById('copyIcon');
            if (icon) icon.className = 'fa-regular fa-copy';
        }
    };

    window.copyErrorMessage = async function () {
        const msg = document.getElementById('modalErrorMessage')?.innerText;
        const icon = document.getElementById('copyIcon');
        if (!msg || msg === 'Loading...' || msg === 'Analyzing trace...') return;

        try {
            await navigator.clipboard.writeText(msg);
            if (icon) {
                icon.className = 'fa-solid fa-check text-green-400';
                setTimeout(() => {
                    icon.className = 'fa-regular fa-copy';
                }, 2000);
            }
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    };

    // Global click listener for backdrop
    window.addEventListener('click', (event) => {
        const modal = document.getElementById('errorModal');
        if (modal && event.target === modal) {
            window.closeErrorModal();
        }
    });

})();
