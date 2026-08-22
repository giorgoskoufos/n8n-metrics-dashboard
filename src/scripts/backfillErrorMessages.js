/**
 * Repairs error rows whose message was mis-extracted before the H-32 fix.
 *
 * n8n Code-node failures stored the error class ("TypeError") or a truncated
 * leading segment ("call_center") as the message, and no error_type at all, so
 * 3.643 rows classified as 'unknown' purely because they were never read
 * correctly. The full text was captured all along — it is the first line of the
 * stack, which is already in the replica.
 *
 * That matters for scope: this needs no Postgres at all. Re-fetching the raw
 * traces would only reach the executions n8n has not pruned yet; reading the
 * stored stack reaches every row.
 *
 *   node src/scripts/backfillErrorMessages.js            # report only, no writes
 *   node src/scripts/backfillErrorMessages.js --apply    # perform the backfill
 *   node src/scripts/backfillErrorMessages.js --limit 20 # widen the sample shown
 *
 * Safe to run repeatedly: it is idempotent, and a second pass reports 0 changes.
 * The app may keep running — this touches only execution_error_analytics rows
 * that the sync would otherwise rewrite with the same values.
 */
const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');
const { resolveError } = require('../config/errorParser');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const SAMPLE = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) || 8 : 8;

const dbPath = process.env.DASHBOARD_DB_PATH
    ? path.resolve(process.env.DASHBOARD_DB_PATH)
    : path.resolve(__dirname, '../../dashboard.sqlite');

if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`);
    process.exit(1);
}

const db = new sqlite3.Database(dbPath, APPLY ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((res, rej) => { db.all(sql, p, (e, r) => (e ? rej(e) : res(r))); });
const run = (sql, p = []) => new Promise((res, rej) => { db.run(sql, p, function (e) { if (e) rej(e); else res(this); }); });

const truncate = (s, n = 90) => {
    if (s === null || s === undefined) return String(s);
    const flat = String(s).replace(/\s+/g, ' ');
    return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

(async () => {
    console.log(`Database : ${dbPath}`);
    console.log(`Mode     : ${APPLY ? 'APPLY (writes)' : 'REPORT ONLY'}`);

    // http_code is read but almost always NULL on historical rows — it was never
    // extracted before. Re-classification of the existing table therefore leans on
    // the message, the error type and the node type. Rows synced from now on carry
    // the real status and classify from evidence instead.
    const rows = await all(`
        SELECT id, error_message, error_type, error_stack, node_type, error_category, http_code
        FROM execution_error_analytics
    `);
    console.log(`Rows     : ${rows.length}\n`);

    // A single "rows to repair" count hides very different things — a message
    // recovered from the stack and a message that only lost trailing whitespace
    // both show up as "changed". Bucket them, so the number cannot flatter itself.
    const classify = (old, next, oldType) => {
        if (next.errorMessage === old) {
            // Comparing against the OLD type, not merely checking that the new one
            // is non-empty — otherwise every re-categorised row is mislabelled as
            // a recovered type, which is exactly what the first version did.
            return next.errorType !== (oldType || '') ? 'error_type recovered' : 'reclassified only';
        }
        if (old !== null && old.trim() === next.errorMessage) return 'whitespace trimmed only';
        if (old === null || old.trim() === '') return 'empty message filled from stack';
        if (next.errorMessage === null) return 'message could not be read -> null';
        if (next.errorMessage.startsWith(old.trim())) return 'truncated message completed from stack';
        if (old.trim() === next.errorType) return 'error class name replaced by real message';
        return 'message replaced (unexpected — review before applying)';
    };

    const changes = [];
    const catShift = new Map();
    const kinds = new Map();

    for (const r of rows) {
        const next = resolveError(r.error_message, r.error_type, r.error_stack, r.node_type, r.http_code);
        const old = r.error_message === null ? null : String(r.error_message);

        const same =
            next.errorMessage === old &&
            next.errorType === (r.error_type || '') &&
            next.errorCategory === r.error_category;
        if (same) continue;

        const kind = classify(old, next, r.error_type);
        changes.push({ row: r, next, kind });
        kinds.set(kind, (kinds.get(kind) || 0) + 1);

        if (next.errorCategory !== r.error_category) {
            const key = `${r.error_category} -> ${next.errorCategory}`;
            catShift.set(key, (catShift.get(key) || 0) + 1);
        }
    }

    if (changes.length === 0) {
        console.log('Nothing to repair — every row already resolves to its stored values.');
        db.close();
        return;
    }

    console.log(`Rows to repair: ${changes.length}\n`);

    console.log('What changes:');
    for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(v).padStart(6)}  ${k}`);
    }

    console.log('\nCategory movement:');
    if (catShift.size === 0) console.log('       -  none');
    for (const [k, v] of [...catShift.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(v).padStart(6)}  ${k}`);
    }

    // One example per kind beats N examples of whichever kind happens to sort
    // first — the rare buckets are exactly the ones worth eyeballing.
    console.log('\nOne example per kind:');
    const shown = new Set();
    for (const c of changes) {
        if (shown.has(c.kind)) continue;
        shown.add(c.kind);
        console.log(`\n  [${c.kind}]  id ${c.row.id}`);
        console.log(`    was : [${c.row.error_type || ''}] ${truncate(c.row.error_message)}  (${c.row.error_category})`);
        console.log(`    now : [${c.next.errorType}] ${truncate(c.next.errorMessage)}  (${c.next.errorCategory})`);
    }

    // A category shift moves rows between dashboard buckets, so each distinct
    // move gets its own examples. This is the part worth arguing with before
    // committing to it.
    console.log('\nExamples per category move:');
    for (const [move] of [...catShift.entries()].sort((a, b) => b[1] - a[1])) {
        const ex = changes.filter(
            (c) => `${c.row.error_category} -> ${c.next.errorCategory}` === move
        ).slice(0, Math.max(1, Math.min(3, SAMPLE)));
        console.log(`\n  ${move}  (${catShift.get(move)} rows)`);
        for (const c of ex) {
            console.log(`    id ${c.row.id}  [${c.next.errorType}] ${truncate(c.next.errorMessage, 110)}`);
        }
    }

    if (!APPLY) {
        console.log('\nReport only. Re-run with --apply to write these changes.');
        db.close();
        return;
    }

    // One transaction: a half-applied backfill would leave the table in a state
    // neither the old nor the new parser explains.
    await run('BEGIN TRANSACTION');
    try {
        for (const c of changes) {
            await run(
                `UPDATE execution_error_analytics
                 SET error_message = ?, error_type = ?, error_category = ?
                 WHERE id = ?`,
                [c.next.errorMessage, c.next.errorType, c.next.errorCategory, c.row.id]
            );
        }
        await run('COMMIT');
        console.log(`\nApplied. ${changes.length} rows repaired.`);
    } catch (e) {
        await run('ROLLBACK').catch(() => { });
        console.error('\nFailed, rolled back:', e.message);
        process.exitCode = 1;
    }

    const after = await all(`
        SELECT error_category, COUNT(*) n FROM execution_error_analytics
        GROUP BY error_category ORDER BY n DESC
    `);
    console.log('\nCategory distribution now:');
    for (const r of after) console.log(`  ${String(r.n).padStart(6)}  ${r.error_category}`);

    db.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
