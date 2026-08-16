// settings_accordions.js
// Extracted from an inline <script> block in settings.html so the page no longer
// depends on script-src 'unsafe-inline'.

(() => {
    /** Wires a header button to the panel it expands, keeping the chevron in sync. */
    function wireAccordion(toggleId, contentId, arrowId) {
        const toggle = document.getElementById(toggleId);
        const content = document.getElementById(contentId);
        const arrow = document.getElementById(arrowId);
        if (!toggle || !content || !arrow) return null;

        toggle.addEventListener('click', () => {
            const isHidden = content.classList.toggle('hidden');
            arrow.classList.toggle('rotate-180', !isHidden);
        });

        return { content, arrow };
    }

    const prefs = wireAccordion('prefToggle', 'prefContent', 'prefArrow');
    wireAccordion('roiToggle', 'roiContent', 'roiArrow');

    // Open General Preferences on load — it's the section people come here for.
    if (prefs) {
        setTimeout(() => {
            prefs.content.classList.remove('hidden');
            prefs.arrow.classList.add('rotate-180');
        }, 100);
    }
})();
