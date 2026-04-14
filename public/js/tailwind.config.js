// =============================================================
// Shared Tailwind Configuration — n8n Analytics Dashboard
// Loaded by every page AFTER cdn.tailwindcss.com
//
// Usage (base, all pages except errors.html):
//   <script src="/js/tailwind.config.js"></script>
//
// Usage (errors.html — also needs flat n8n-* keys):
//   <script src="../js/tailwind.config.js"></script>
//   <script>__applyErrorsTheme();</script>
// =============================================================

// ── Full merged token set ────────────────────────────────────
tailwind.config = {
    theme: {
        extend: {
            fontFamily: { sans: ['"Open Sans"', 'sans-serif'] },
            colors: {
                n8n: {
                    dark:    '#171717',
                    card:    '#222222',
                    primary: '#ff6f5c',
                    success: '#278250',
                    danger:  '#f16a75',
                    text:    '#eeeeee',
                    hover:   '#333333',
                }
            }
        }
    }
};

// ── errors.html extension ────────────────────────────────────
// errors.html uses flat CSS class names (bg-n8n-card, text-n8n-danger …)
// that map to slightly different shades than the base palette.
// Call this immediately after loading this script in errors.html.
window.__applyErrorsTheme = function () {
    tailwind.config = {
        theme: {
            extend: {
                fontFamily: { sans: ['"Open Sans"', 'sans-serif'] },
                colors: {
                    // inherit nested n8n.* namespace (used by other shared components)
                    n8n: {
                        dark:    '#171717',
                        card:    '#222222',
                        primary: '#ff6f5c',
                        success: '#278250',
                        danger:  '#f16a75',
                        text:    '#eeeeee',
                        hover:   '#333333',
                    },
                    // flat keys used throughout errors.html markup
                    'n8n-primary': '#ff6f5c',
                    'n8n-dark':    '#121212',
                    'n8n-card':    '#1a1a1a',
                    'n8n-text':    '#eeeeee',
                    'n8n-success': '#4ade80',
                    'n8n-danger':  '#f87171',
                }
            }
        }
    };
};
