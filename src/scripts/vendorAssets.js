/**
 * Copies the frontend's third-party assets out of node_modules into public/vendor.
 *
 *   node src/scripts/vendorAssets.js
 *
 * Run it after changing any of those dependencies, and commit the result. The
 * copies are tracked in git on purpose: the Dockerfile installs dependencies
 * before the source is copied in, so a postinstall hook could not do this, and
 * the container would boot with no frontend assets at all.
 *
 * Why these live locally instead of on a CDN:
 *   - chart.js and marked were loaded from jsDelivr with NO version in the URL.
 *     Any major release would have broken the dashboard with no warning and no
 *     way to roll back.
 *   - Font Awesome was pinned, but to two different versions on different pages.
 *   - Every external origin is one more party that can serve script into a page
 *     holding an auth token, and one more thing that has to be reachable for the
 *     dashboard to render.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const vendor = path.join(root, 'public', 'vendor');
const nm = (...p) => path.join(root, 'node_modules', ...p);

function copyFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return fs.statSync(to).size;
}

function copyDir(from, to, filter = () => true) {
    fs.mkdirSync(to, { recursive: true });
    let n = 0;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        if (!filter(entry.name)) continue;
        fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
        n++;
    }
    return n;
}

const kb = (b) => `${(b / 1024).toFixed(0)} KB`;

function version(pkg) {
    return require(nm(pkg, 'package.json')).version;
}

const steps = [];

// --- Chart.js ---
steps.push(() => {
    const size = copyFile(nm('chart.js', 'dist', 'chart.umd.min.js'), path.join(vendor, 'chart.umd.min.js'));
    return `chart.js ${version('chart.js')} -> vendor/chart.umd.min.js (${kb(size)})`;
});

// --- marked ---
// v18 ships no pre-minified browser build; the UMD bundle is the browser entry.
steps.push(() => {
    const size = copyFile(nm('marked', 'lib', 'marked.umd.js'), path.join(vendor, 'marked.umd.js'));
    return `marked ${version('marked')} -> vendor/marked.umd.js (${kb(size)})`;
});

// --- Font Awesome ---
// The stylesheet resolves its fonts as ../webfonts/, so the two must keep this
// relative layout. Only woff2 is copied: every browser this dashboard supports
// reads it, and shipping ttf as well doubles the size for nothing.
steps.push(() => {
    const css = copyFile(
        nm('@fortawesome', 'fontawesome-free', 'css', 'all.min.css'),
        path.join(vendor, 'fontawesome', 'css', 'all.min.css')
    );
    const fonts = copyDir(
        nm('@fortawesome', 'fontawesome-free', 'webfonts'),
        path.join(vendor, 'fontawesome', 'webfonts'),
        (name) => name.endsWith('.woff2')
    );
    return `font-awesome ${version('@fortawesome/fontawesome-free')} -> vendor/fontawesome/ (css ${kb(css)}, ${fonts} woff2)`;
});

// --- Open Sans ---
// @fontsource ships one stylesheet per weight, each pointing at ./files/. They
// are concatenated into a single file in the same directory, so those relative
// URLs keep resolving and the page needs one request instead of four.
steps.push(() => {
    const weights = ['400', '500', '600', '700'];
    let css = weights
        .map((w) => fs.readFileSync(nm('@fontsource', 'open-sans', `${w}.css`), 'utf8'))
        .join('\n');

    // @fontsource lists a .woff fallback after each .woff2. Only woff2 is copied
    // — every browser this dashboard supports reads it — so the fallback is
    // dropped rather than left pointing at a file that is not there. A generated
    // file has no excuse for containing a dead URL.
    css = css.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '');

    const outDir = path.join(vendor, 'open-sans');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'open-sans.css'), css);

    // Every subset those four weights declare, not just Latin and Greek. The
    // dashboard renders free text that came from someone's workflows — names,
    // error messages, API responses — so any script can turn up. Each @font-face
    // is gated by unicode-range and only fetched when it is actually needed, so
    // completeness costs nothing at page load; an omitted subset, by contrast,
    // is a 404 and a fallback font the moment a Cyrillic name appears.
    const wanted = /-(400|500|600|700)-normal\.woff2$/;
    const files = copyDir(
        nm('@fontsource', 'open-sans', 'files'),
        path.join(outDir, 'files'),
        (name) => wanted.test(name)
    );
    return `open-sans ${version('@fontsource/open-sans')} -> vendor/open-sans/ (${files} woff2, greek included)`;
});

console.log(`Vendoring into ${vendor}\n`);
for (const step of steps) {
    try {
        console.log('  ' + step());
    } catch (e) {
        console.error('  FAILED:', e.message);
        process.exitCode = 1;
    }
}
console.log('\nCommit public/vendor/ — the container is built without node_modules present at copy time.');
