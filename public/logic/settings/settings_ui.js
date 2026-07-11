// settings_ui.js
;(() => {
    const jumpBtn = document.getElementById('jumpBtn');
    const jumpIcon = document.getElementById('jumpIcon');

    window.updateJumpButtonVisibility = function() {
        if (!jumpBtn) return;
        if (document.body.scrollHeight > window.innerHeight * 1.2) {
            jumpBtn.classList.remove('hidden');
            setTimeout(() => jumpBtn.classList.remove('opacity-0'), 10);
            window.updateJumpDirection();
        } else {
            jumpBtn.classList.add('opacity-0');
            setTimeout(() => jumpBtn.classList.add('hidden'), 300);
        }
    };

    window.updateJumpDirection = function() {
        if (!jumpBtn || !jumpIcon) return;
        const scrollPosition = window.scrollY;
        const maxScroll = document.body.scrollHeight - window.innerHeight;
        
        if (maxScroll > 0 && scrollPosition > (maxScroll / 2)) {
            jumpIcon.classList.remove('fa-arrow-down');
            jumpIcon.classList.add('fa-arrow-up');
        } else {
            jumpIcon.classList.remove('fa-arrow-up');
            jumpIcon.classList.add('fa-arrow-down');
        }
    };

    window.addEventListener('scroll', window.updateJumpDirection);
    window.addEventListener('resize', window.updateJumpButtonVisibility);

    jumpBtn?.addEventListener('click', () => {
        const isPointingUp = jumpIcon.classList.contains('fa-arrow-up');
        if (isPointingUp) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        }
    });
})();
