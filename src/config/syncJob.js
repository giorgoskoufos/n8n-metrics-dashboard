const { pool } = require('./db');
const localDb = require('./localDb');
const fs = require('fs');
const path = require('path');
const { parse } = require('flatted');
const { resolveError, extractHttpCode, CLASSIFIER_VERSION } = require('./errorParser');
const instanceLock = require('./instanceLock');

let isSyncing = false;

// Statuses that can still change, so they must be re-checked every cycle.
// 'waiting' belongs here — a Wait node can hold an execution for days.
const NON_TERMINAL_STATUSES = ['new', 'running', 'waiting'];

// How long an execution may stay absent from Postgres before its status is
// written off as unknowable. Long enough to ride out replication lag and a
// restart, short enough that the row does not sit misleading forever.
const MISSING_GRACE_MS = Number(process.env.EXECUTION_MISSING_GRACE_MS) || 60 * 60 * 1000;

// How far back Phase B re-reads on every cycle, measured in execution ids.
//
// The hazard is real and visible in the data: Postgres hands out ids at INSERT
// but commits land out of order, so a row with a LOWER id can become visible
// after we have already passed it. A probe of the production table found 894
// rows whose createdAt runs backwards against id order — proof that ids are
// allocated concurrently, which is the precondition for that miss.
//
// The obvious fix, a watermark on createdAt, is worse: n8n has NO index on that
// column, so `WHERE "createdAt" > $1` plans as a Seq Scan of the whole table on
// every cycle, while `id > $1` is an Index Only Scan on the primary key. We
// never write to the n8n database, so adding an index is not an option either.
//
// Re-reading a fixed window of ids keeps the index and closes the same gap:
// the rows come back through ON CONFLICT DO UPDATE, which is already idempotent.
const ID_OVERLAP = Number(process.env.SYNC_ID_OVERLAP) || 500;

// --- Error analytics queue limits (M-14 / M-15) ---

// Ids per payload query. The old code joined execution_data — 1.2 GB — for every
// error id at once and held all of it in memory. Average payload is 42 KB and the
// largest seen is 2.2 MB, so a spike of a few thousand errors in one cycle meant
// hundreds of megabytes in a single result set.
const ERROR_CHUNK_SIZE = Number(process.env.ERROR_CHUNK_SIZE) || 50;

// Ceiling on how much of the queue one cycle drains. The rest stays pending and
// is picked up next time, so a backlog costs many small cycles instead of one
// enormous one.
const ERROR_BATCH_LIMIT = Number(process.env.ERROR_BATCH_LIMIT) || 500;

// Payloads above this are left unread. The check happens in Postgres, so an
// oversized trace is never sent over the wire at all.
const MAX_PAYLOAD_BYTES = Number(process.env.MAX_ERROR_PAYLOAD_BYTES) || 5 * 1024 * 1024;

// After this many failures an execution stops being retried. Without a ceiling a
// permanently unparseable trace is retried forever, every cycle.
const MAX_ANALYTICS_ATTEMPTS = Number(process.env.MAX_ANALYTICS_ATTEMPTS) || 5;

// Exponential backoff, capped. A failure that is really an outage should not be
// hammered at every cycle, and one that is really a bad row should drift out of
// the way of healthy work.
function backoffFor(attempts) {
    const minutes = Math.min(2 ** attempts, 6 * 60);
    return new Date(Date.now() + minutes * 60_000).toISOString();
}

// Always print a size a human can act on. Fixing the unit at MB turns every
// small payload into "0.0 MB, over the 0 MB limit", which tells the reader
// nothing at all.
function formatBytes(n) {
    if (!Number.isFinite(n)) return 'unknown size';
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} bytes`;
}

// n8n's execution_entity has changed shape across major versions — soft deletes
// (deletedAt) arrived in 1.x. Probe once and build the filter from the columns
// that actually exist, the same way authController handles the user table, so
// the sync keeps working on older instances instead of failing on every cycle.
let execColumnsPromise = null;
function getExecutionColumns() {
    if (!execColumnsPromise) {
        execColumnsPromise = pool
            .query(
                `SELECT column_name FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'execution_entity'`
            )
            .then((r) => new Set(r.rows.map((x) => x.column_name)))
            .catch((err) => {
                console.error('[SYNC] Could not read execution_entity columns:', err.message);
                execColumnsPromise = null;   // retry on the next cycle
                return new Set();
            });
    }
    return execColumnsPromise;
}

// Returns a result object rather than nothing, because the caller cannot
// otherwise tell "synced" from "silently skipped" — /api/sync/force used to
// answer "Sync Complete" to a request that did no work at all.
async function syncData() {
    if (isSyncing) {
        console.log('[SYNC] Sync already running. Skipping concurrent request.');
        return { status: 'already_running' };
    }

    // isSyncing only guards against overlap inside THIS process. Two containers
    // sharing the replica each have their own flag and would happily write over
    // one another — which is what destroyed this file three times. The lock is
    // the cross-process half of the same guarantee.
    if (!(await instanceLock.claimForEtl())) {
        return { status: 'not_lock_owner', owner: await instanceLock.describeOwner() };
    }

    isSyncing = true;
    console.log('[SYNC] Starting ETL Sync...');
    try {
        // 1. Sync Workflows (Full Sync for active/names is lightweight enough)
        const workflows = await pool.query('SELECT id, name, active FROM workflow_entity');
        await localDb.execute('BEGIN TRANSACTION');
        await localDb.executeMany(
            `INSERT INTO workflow_entity (id, name, active) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, active=excluded.active`,
            workflows.rows.map(w => [w.id, w.name, w.active])
        );
        await localDb.execute('COMMIT');
        console.log(`[SYNC] Synced ${workflows.rows.length} workflows.`);

        // 2. Sync Executions
        // PHASE A: Re-check every execution that has not reached a terminal state.
        //
        // This used to look at status='running' only, so rows stuck at 'new' or
        // 'waiting' were never revisited — the replica had five 'new' rows with a
        // NULL startedAt that could never be updated by anything.
        const openExecs = await localDb.query(
            `SELECT id, missing_since FROM execution_entity WHERE status IN (${NON_TERMINAL_STATUSES.map(() => '?').join(',')})`,
            NON_TERMINAL_STATUSES
        );
        const errorIds = new Set(); // Track new errors

        if (openExecs.rows.length > 0) {
            const openIds = openExecs.rows.map(r => r.id);
            console.log(`[SYNC] Re-checking status for ${openIds.length} non-terminal executions...`);

            // Query Postgres for the current state of these specific executions
            const updatedExecs = await pool.query(
                `SELECT id, status, "startedAt", "stoppedAt" FROM execution_entity WHERE id = ANY($1)`,
                [openIds]
            );

            const returned = new Map(updatedExecs.rows.map(e => [e.id, e]));
            const now = new Date();
            const nowIso = now.toISOString();

            await localDb.execute('BEGIN TRANSACTION');

            for (const local of openExecs.rows) {
                const e = returned.get(local.id);

                if (e) {
                    // Clearing missing_since matters: a row can disappear from a
                    // query and come back (replication lag, a transaction still
                    // open), and a stale marker would eventually condemn a healthy
                    // execution to 'unknown'.
                    await localDb.execute(
                        `UPDATE execution_entity
                            SET status = ?, "startedAt" = COALESCE("startedAt", ?), "stoppedAt" = ?, missing_since = NULL
                          WHERE id = ?`,
                        [
                            e.status,
                            e.startedAt ? e.startedAt.toISOString() : null,
                            e.stoppedAt ? e.stoppedAt.toISOString() : null,
                            e.id
                        ]
                    );
                    if (e.status === 'error' || e.status === 'crashed') errorIds.add(e.id);
                    continue;
                }

                // Postgres no longer has this row. Almost always it was pruned
                // before it ever finished, so its status is now unknowable — but
                // one absent cycle is not proof, so it is given a grace period
                // rather than being condemned immediately.
                if (!local.missing_since) {
                    await localDb.execute(
                        'UPDATE execution_entity SET missing_since = ? WHERE id = ?',
                        [nowIso, local.id]
                    );
                } else if (now - new Date(local.missing_since) >= MISSING_GRACE_MS) {
                    // 'unknown' is deliberately not 'crashed'. We do not know that
                    // it failed; we know only that we can never find out.
                    await localDb.execute(
                        "UPDATE execution_entity SET status = 'unknown' WHERE id = ?",
                        [local.id]
                    );
                    console.warn(
                        `[SYNC] Execution ${local.id} has been absent from Postgres since ` +
                        `${local.missing_since} — marking 'unknown'.`
                    );
                }
            }

            await localDb.execute('COMMIT');
        }

        // PHASE B: Incremental Sync for new executions
        let lastIdObj = await localDb.query('SELECT MAX(id) as max_id FROM execution_entity');
        let lastId = lastIdObj.rows[0].max_id;

        // Clamp the watermark to what Postgres actually has.
        //
        // MAX(id) over the replica is only trustworthy while every id in it came
        // from Postgres. One row with an impossibly high id — a manual insert, a
        // restore from the wrong source, a test that leaked — parks the watermark
        // above every real execution and the sync then fetches nothing, forever,
        // while cheerfully reporting "0 new executions". That is the failure mode
        // this project keeps being bitten by: silent, and indistinguishable from
        // idle. The clamp costs one index-only scan per cycle.
        if (lastId) {
            const pgMaxRes = await pool.query('SELECT MAX(id) AS max_id FROM execution_entity');
            const pgMax = pgMaxRes.rows[0].max_id;
            if (pgMax !== null && pgMax < lastId) {
                console.warn(
                    `[SYNC] Replica high-water id ${lastId} is beyond the source maximum ${pgMax}. ` +
                    'Clamping — a stray id would otherwise stall the sync indefinitely.'
                );
                lastId = pgMax;
            }
        }

        let execQuery = '';
        let params = [];

        // Skip executions the user deleted in n8n. Only applied on fetch: rows
        // already in the replica are kept, because retaining history that n8n no
        // longer has is the entire point of this database.
        const execColumns = await getExecutionColumns();
        const notDeleted = execColumns.has('deletedAt') ? 'AND "deletedAt" IS NULL' : '';

        if (!lastId) {
            // First time boot sync (last 14 days)
            console.log('[SYNC] Initial Boot: Fetching last 14 days of executions.');
            execQuery = `
                SELECT id, "workflowId", status, "startedAt", "stoppedAt"
                FROM execution_entity
                WHERE "startedAt" > NOW() - INTERVAL '14 days'
                  ${notDeleted}
                ORDER BY id ASC
            `;
        } else {
            // Incremental, with an overlap window so a late-committing row with a
            // lower id is not skipped for good. See ID_OVERLAP.
            const from = Math.max(0, lastId - ID_OVERLAP);
            console.log(`[SYNC] Incremental Sync from execution_entity id: ${from} (high water ${lastId}, overlap ${ID_OVERLAP})`);
            execQuery = `
                SELECT id, "workflowId", status, "startedAt", "stoppedAt"
                FROM execution_entity
                WHERE id > $1
                  ${notDeleted}
                ORDER BY id ASC
            `;
            params = [from];
        }

        const newExecs = await pool.query(execQuery, params);
        let syncedCount = 0;

        // One prepared statement for the whole batch, inside a single transaction,
        // so the write lock is held briefly instead of once per row.
        if (newExecs.rows.length > 0) {
            // The overlap re-reads rows we already have. Queueing their errors
            // again would make syncErrorAnalytics re-fetch payloads out of the
            // 1.2 GB execution_data table every single cycle, forever — so only
            // rows that are genuinely new, or whose status actually moved, are
            // handed on. One indexed lookup buys that.
            const fetchedIds = newExecs.rows.map(e => e.id);
            const knownRes = await localDb.query(
                `SELECT id, status FROM execution_entity WHERE id IN (${fetchedIds.map(() => '?').join(',')})`,
                fetchedIds
            );
            const knownStatus = new Map(knownRes.rows.map(r => [r.id, r.status]));

            let freshCount = 0;
            const batch = newExecs.rows.map(e => {
                const previous = knownStatus.get(e.id);
                const isNew = previous === undefined;
                if (isNew || previous !== e.status) freshCount++;

                if ((e.status === 'error' || e.status === 'crashed') && (isNew || previous !== e.status)) {
                    errorIds.add(e.id);
                }
                return [
                    e.id,
                    e.workflowId,
                    e.status,
                    e.startedAt ? e.startedAt.toISOString() : null,
                    e.stoppedAt ? e.stoppedAt.toISOString() : null
                ];
            });

            await localDb.execute('BEGIN TRANSACTION');
            await localDb.executeMany(
                // The overlap window means existing rows come back through here
                // every cycle, so the conflict branch has to be a correct update
                // and not just a formality.
                //
                // startedAt is COALESCEd rather than overwritten: optimizeReplica
                // backfilled it for 76 rows that Postgres has as NULL, and a plain
                // assignment would wipe that repair on the very next sync.
                `INSERT INTO execution_entity (id, "workflowId", status, "startedAt", "stoppedAt")
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    "startedAt" = COALESCE(excluded."startedAt", execution_entity."startedAt"),
                    "stoppedAt" = excluded."stoppedAt",
                    missing_since = NULL`,
                batch
            );
            await localDb.execute('COMMIT');
            syncedCount = freshCount;
        }
        // Reports what actually changed, not how many rows the overlap happened to
        // re-read — otherwise every idle cycle would claim it synced 500 executions.
        console.log(`[SYNC] ${syncedCount} new or changed executions (${newExecs.rows.length} rows read).`);

        // 3. Update Concurrency Stats (UTC Standardized)
        await updateConcurrencyStats();

        // 4. Deep Error Analytics.
        //
        // Discovery and extraction are now separate. The cycle only records that
        // an execution needs analytics; a queue decides when the work happens.
        // Previously the two were the same step, so a failed extraction was lost
        // with the cycle that found it.
        if (errorIds.size > 0) {
            await enqueueForAnalytics(Array.from(errorIds));
        }
        const analytics = await processAnalyticsQueue();

        // Brings the history in line whenever the rules change. No-op otherwise.
        const reclassified = await reclassifyIfNeeded();

        return {
            status: 'ok',
            workflows: workflows.rows.length,
            executions: syncedCount,
            rowsRead: newExecs.rows.length,
            errors: errorIds.size,
            analytics,
            reclassified: reclassified.ran ? reclassified.changed : 0
        };

    } catch (err) {
        console.error('[SYNC] Sync Error:', err);
        try { await localDb.execute('ROLLBACK'); } catch (e) { }
        return { status: 'failed', error: err.message };
    } finally {
        isSyncing = false;
    }
}

async function updateConcurrencyStats() {
    try {
        console.log('[SYNC] Re-calculating concurrency stats using Node.js temporal engine...');

        // 1. Generate 5-minute buckets for the last 24 hours in JS
        const now = new Date();
        const buckets = [];
        for (let i = 0; i < 288; i++) { // 288 slots of 5 mins = 24h
            const t = new Date(now.getTime() - (i * 5 * 60 * 1000));
            // Round to nearest 5 mins
            t.setSeconds(0, 0);
            t.setMinutes(Math.floor(t.getMinutes() / 5) * 5);
            buckets.push(t.toISOString());
        }
        buckets.reverse(); // Oldest first

        // 2. Fetch all potentially relevant executions (started within last 30h to catch overlaps)
        const lookback = new Date(now.getTime() - (30 * 60 * 60 * 1000)).toISOString();
        // Compare the stored column directly instead of wrapping it in datetime().
        // Every value is written by toISOString(), so the layout is identical and
        // lexicographic ordering matches chronological ordering — which lets this
        // use idx_exec_started instead of scanning the whole table.
        const execs = await localDb.query(`
            SELECT "startedAt" AS sAt, "stoppedAt" AS stAt, status
            FROM execution_entity
            WHERE "startedAt" >= ? OR "stoppedAt" IS NULL
        `, [lookback]);

        const execData = execs.rows
            .filter(e => e.sAt)   // rows still queued have no start time yet
            .map(e => ({
                sAt: new Date(e.sAt),
                stAt: e.stAt ? new Date(e.stAt) : null,
                status: e.status
            }));

        // 3. Calculate execution volume in JS (Count starts within bucket)
        const stats = buckets.map((bTime, index) => {
            const bDate = new Date(bTime);
            const nextBDate = new Date(bDate.getTime() + 5 * 60 * 1000);

            const count = execData.filter(e => {
                // Count if the execution STARTED within this 5-minute window
                return e.sAt >= bDate && e.sAt < nextBDate;
            }).length;

            return { timestamp: bTime, active_count: count }; // We keep the column name 'active_count' for DB compatibility
        });

        // 4. Batch Insert (using transaction)
        await localDb.execute('BEGIN TRANSACTION');
        await localDb.execute('DELETE FROM concurrency_stats WHERE timestamp < ?', [buckets[0]]);
        await localDb.executeMany(
            'INSERT OR REPLACE INTO concurrency_stats (timestamp, active_count) VALUES (?, ?)',
            stats.map(s => [s.timestamp, s.active_count])
        );
        await localDb.execute('COMMIT');

        console.log(`[SYNC] Concurrency stats updated for ${buckets.length} intervals.`);
    } catch (err) {
        console.error('[SYNC] Concurrency Update Error:', err);
    }
}

const SAVE_DEBUG_ERRORS = process.env.SAVE_DEBUG_ERRORS === 'true'; // Controlled by .env flag

/**
 * Re-classifies the stored errors once, when the classifier rules have changed.
 *
 * Runs inside the sync so it is covered by the ETL lock — this is a mass write to
 * the analytics table and two instances doing it at once is exactly the scenario
 * H-34 exists to prevent.
 *
 * Only the derived fields are rewritten. The raw trace fields (stack, input_data,
 * metadata) are never touched, so this is always safe to re-run and never loses
 * anything that cannot be recomputed.
 */
async function reclassifyIfNeeded() {
    const stored = await localDb.query(
        `SELECT value FROM dashboard_settings WHERE key = 'classifier_version'`
    );
    const current = stored.rows[0] ? Number(stored.rows[0].value) : 0;
    if (current === CLASSIFIER_VERSION) return { ran: false };

    console.log(`[SYNC] Classifier rules changed (v${current} -> v${CLASSIFIER_VERSION}). Re-classifying stored errors…`);

    const rows = await localDb.query(
        `SELECT id, error_message, error_type, error_stack, node_type, error_category, http_code
           FROM execution_error_analytics`
    );

    let changed = 0;
    await localDb.execute('BEGIN TRANSACTION');
    try {
        for (const r of rows.rows) {
            const next = resolveError(r.error_message, r.error_type, r.error_stack, r.node_type, r.http_code);
            const old = r.error_message === null ? null : String(r.error_message);
            if (next.errorMessage === old &&
                next.errorType === (r.error_type || '') &&
                next.errorCategory === r.error_category) continue;

            await localDb.execute(
                `UPDATE execution_error_analytics
                    SET error_message = ?, error_type = ?, error_category = ?
                  WHERE id = ?`,
                [next.errorMessage, next.errorType, next.errorCategory, r.id]
            );
            changed++;
        }

        // Stamped in the same transaction as the rows. Separately, a crash between
        // the two would either redo the whole pass or, worse, record it as done
        // when it was not.
        await localDb.execute(
            `INSERT INTO dashboard_settings (key, value) VALUES ('classifier_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [String(CLASSIFIER_VERSION)]
        );
        await localDb.execute('COMMIT');
    } catch (e) {
        try { await localDb.execute('ROLLBACK'); } catch (err) { }
        console.error('[SYNC] Re-classification failed, rolled back:', e.message);
        return { ran: false, error: e.message };
    }

    console.log(`[SYNC] Re-classified ${changed} of ${rows.rows.length} stored errors.`);
    return { ran: true, changed, total: rows.rows.length };
}

/**
 * Records that these executions need their error detail extracted.
 *
 * Marking is cheap and separate from doing the work on purpose: whatever happens
 * to this process afterwards, the intent survives in the database.
 */
async function enqueueForAnalytics(ids) {
    if (!ids || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await localDb.execute(
        `UPDATE execution_entity
            SET analytics_status = 'pending', analytics_attempts = 0, analytics_next_attempt = NULL
          WHERE id IN (${placeholders})`,
        ids
    );
}

/**
 * Drains up to ERROR_BATCH_LIMIT of the queue, in chunks.
 *
 * Everything that used to make this fragile is handled here: work is bounded per
 * cycle, payloads are fetched in small batches rather than one enormous join,
 * failures are retried with backoff instead of vanishing, and an execution that
 * keeps failing is eventually parked rather than retried forever.
 */
async function processAnalyticsQueue() {
    const due = await localDb.query(
        `SELECT id FROM execution_entity
          WHERE analytics_status = 'pending'
            AND (analytics_next_attempt IS NULL OR analytics_next_attempt <= ?)
          ORDER BY id DESC
          LIMIT ?`,
        [new Date().toISOString(), ERROR_BATCH_LIMIT]
    );

    const ids = due.rows.map(r => r.id);
    if (ids.length === 0) return { processed: 0, failed: 0, remaining: 0 };

    let processed = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i += ERROR_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + ERROR_CHUNK_SIZE);
        const result = await syncErrorAnalytics(chunk);
        processed += result.done;
        failed += result.failed;
    }

    const left = await localDb.query(
        `SELECT COUNT(*) AS n FROM execution_entity WHERE analytics_status = 'pending'`
    );
    const remaining = left.rows[0].n;

    console.log(
        `[SYNC] Error analytics: ${processed} extracted, ${failed} failed, ${remaining} still queued.`
    );
    return { processed, failed, remaining };
}

/**
 * Extracts error detail for one chunk of execution ids.
 *
 * Returns counts rather than throwing, because the caller is draining a queue —
 * one bad chunk must not abandon the rest.
 */
async function syncErrorAnalytics(errorIdsArray) {
    if (!errorIdsArray || errorIdsArray.length === 0) return { done: 0, failed: 0 };

    const markFailed = async (ids, reason) => {
        for (const id of ids) {
            const cur = await localDb.query(
                'SELECT analytics_attempts AS a FROM execution_entity WHERE id = ?', [id]
            );
            const attempts = (cur.rows[0] ? cur.rows[0].a : 0) + 1;
            if (attempts >= MAX_ANALYTICS_ATTEMPTS) {
                await localDb.execute(
                    `UPDATE execution_entity SET analytics_status = 'failed', analytics_attempts = ? WHERE id = ?`,
                    [attempts, id]
                );
                console.warn(`[SYNC] Giving up on analytics for execution ${id} after ${attempts} attempts (${reason}).`);
            } else {
                await localDb.execute(
                    `UPDATE execution_entity
                        SET analytics_attempts = ?, analytics_next_attempt = ?
                      WHERE id = ?`,
                    [attempts, backoffFor(attempts), id]
                );
            }
        }
    };

    let result;
    try {
        // octet_length is evaluated by Postgres, so an oversized trace is measured
        // without ever being sent. Selecting it and checking here would mean
        // pulling the very payload we are trying to avoid.
        const query = `
            SELECT
                CASE WHEN octet_length(d.data) > $2 THEN NULL ELSE d.data END AS data,
                octet_length(d.data) AS data_bytes,
                e."workflowId" AS workflow_id, e."startedAt", e.id as exec_id
            FROM execution_data d
            JOIN execution_entity e ON d."executionId" = e.id
            WHERE d."executionId" = ANY($1)
        `;
        result = await pool.query(query, [errorIdsArray, MAX_PAYLOAD_BYTES]);
    } catch (e) {
        // The whole chunk failed — a timeout, a dropped connection. Retry later.
        console.error(`[SYNC] Payload fetch failed for ${errorIdsArray.length} errors:`, e.message);
        await markFailed(errorIdsArray, e.message);
        return { done: 0, failed: errorIdsArray.length };
    }

    // Anything Postgres did not return no longer exists there — pruned before we
    // got to it. Retrying cannot help, so park it rather than churn every cycle.
    const returned = new Set(result.rows.map(r => r.exec_id));
    const vanished = errorIdsArray.filter(id => !returned.has(id));
    if (vanished.length > 0) {
        const placeholders = vanished.map(() => '?').join(',');
        await localDb.execute(
            `UPDATE execution_entity SET analytics_status = 'failed' WHERE id IN (${placeholders})`,
            vanished
        );
        console.warn(`[SYNC] ${vanished.length} error payloads no longer exist in Postgres — pruned before extraction.`);
    }

    const succeeded = [];
    const oversized = [];

    try {
        const analyticsData = [];

        await localDb.execute('BEGIN TRANSACTION');

        for (let row of result.rows) {
            const dataStr = row.data;
            if (!dataStr) {
                if (row.data_bytes > MAX_PAYLOAD_BYTES) {
                    oversized.push({ id: row.exec_id, bytes: row.data_bytes });
                } else {
                    succeeded.push(row.exec_id);   // genuinely empty, nothing to extract
                }
                continue;
            }

            let fullData;
            try {
                // n8n compresses or stores execution data weirdly depending on version, parsing safely
                fullData = typeof dataStr === 'string' ? parse(dataStr) : dataStr;
                if (fullData && typeof fullData === 'object' && fullData.data) {
                    if (typeof fullData.data === 'string') {
                        // Some versions base64 encode or double json stringify
                        try { fullData = parse(fullData.data); } catch (e) { }
                    }
                }
            } catch (e) {
                // Left in the queue deliberately, not silently dropped: it gets a
                // backoff and a bounded number of retries, and if the trace is
                // simply unparseable it ends up 'failed' where it can be counted.
                console.error(`[SYNC] Failed to parse data for execution ${row.exec_id}`);
                continue;
            }

            // Raw candidates, straight from the trace. They are reconciled against
            // the stack below rather than being trusted as-is.
            let rawMessage = "";
            let rawType = "";
            let httpCode = null;
            let nodeName = "Unknown Node";
            let nodeType = "Unknown Type";
            let nodeId = "";
            let errorStack = "";
            let sourceNode = "";
            let sourceOutputIndex = null;
            let executionSource = "";
            let inputData = "";
            let metadataJson = "";

            if (fullData && fullData.resultData) {
                const rootErr = fullData.resultData.error;
                rawMessage = rootErr?.description || rootErr?.message || "";
                nodeName = fullData.resultData.lastNodeExecuted || rootErr?.node?.name || nodeName;
                nodeType = rootErr?.node?.type || nodeType;
                nodeId = rootErr?.node?.id || "";
                rawType = rootErr?.name || "";
                errorStack = rootErr?.stack || "";
                httpCode = extractHttpCode(rootErr);

                // Try to find executionSource
                executionSource = fullData.executionData?.runtimeData?.source || "";

                // Extract metadata
                if (fullData.executionData?.metadata) {
                    try { metadataJson = JSON.stringify(fullData.executionData.metadata); } catch (e) { }
                }

                // Attempt to find the source node and branch
                if (fullData.executionData?.nodeExecutionStack) {
                    const stack = fullData.executionData.nodeExecutionStack;
                    if (stack && stack.length > 0) {
                        const lastFrame = stack[stack.length - 1];

                        // Grab input data that led to the crash
                        if (lastFrame?.data) {
                            try { inputData = JSON.stringify(lastFrame.data); } catch (e) { }
                        }

                        if (lastFrame?.source?.main && lastFrame.source.main.length > 0) {
                            const sourceObj = lastFrame.source.main[0];
                            if (sourceObj) {
                                sourceNode = sourceObj.previousNode || "";
                                sourceOutputIndex = sourceObj.previousNodeOutput !== undefined ? sourceObj.previousNodeOutput : null;
                            }
                        }
                    }
                }
            } else if (fullData && fullData[0]) {
                const root = fullData[0];
                // `root.message` used to sit at the end of this chain. It is not an
                // error message — on this shape it is whatever unrelated property
                // happens to be named `message`, which is how unrelated strings ended
                // up stored as error text. Removed: better an empty message we can
                // detect than a wrong one we cannot.
                rawMessage = root.resultData?.error?.description || root.resultData?.error?.message
                    || root.error?.description || root.error?.message || "";
                nodeName = root.resultData?.lastNodeExecuted || root.resultData?.error?.node?.name || root.error?.node?.name || nodeName;
                nodeType = root.resultData?.error?.node?.type || root.error?.node?.type || nodeType;
                nodeId = root.resultData?.error?.node?.id || root.error?.node?.id || "";
                rawType = root.resultData?.error?.name || root.error?.name || "";
                errorStack = root.resultData?.error?.stack || root.error?.stack || "";
                httpCode = extractHttpCode(root.resultData?.error) ?? extractHttpCode(root.error);

                executionSource = root.executionData?.runtimeData?.source || "";
                if (root.executionData?.metadata) {
                    try { metadataJson = JSON.stringify(root.executionData.metadata); } catch (e) { }
                }

                if (root.executionData?.nodeExecutionStack) {
                    const lastFrame = root.executionData.nodeExecutionStack[root.executionData.nodeExecutionStack.length - 1];
                    if (lastFrame?.data) {
                        try { inputData = JSON.stringify(lastFrame.data); } catch (e) { }
                    }
                }
            }

            // Fallback for timestamp
            const startedStr = row.startedAt ? row.startedAt.toISOString() : new Date().toISOString();

            // Reconcile against the stack before classifying — classifying the raw
            // candidate is exactly what produced the 3.643 'unknown' rows.
            const { errorType, errorMessage, errorCategory } =
                resolveError(rawMessage, rawType, errorStack, nodeType, httpCode);

            const payload = {
                id: row.exec_id,
                workflow_id: row.workflow_id,
                node_id: nodeId,
                node_name: nodeName,
                node_type: nodeType,
                error_type: errorType,
                error_message: errorMessage,
                error_stack: errorStack,
                source_node: sourceNode,
                source_output: sourceOutputIndex,
                input_data: inputData,
                metadata: metadataJson,
                execution_source: executionSource,
                error_category: errorCategory,
                http_code: httpCode,
                started_at: startedStr
            };

            // For debug purposes, add the raw data to the export list if flag is on
            if (SAVE_DEBUG_ERRORS) {
                analyticsData.push({ ...payload, rawTrace: fullData });
            } else {
                analyticsData.push(payload);
            }

            // Insert into SQLite
            await localDb.execute(
                `INSERT INTO execution_error_analytics
                 (id, workflow_id, node_id, node_name, node_type, error_type, error_message, error_stack, source_node, source_output_index, input_data, metadata, execution_source, error_category, http_code, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                 node_id=excluded.node_id,
                 node_name=excluded.node_name,
                 node_type=excluded.node_type,
                 error_type=excluded.error_type,
                 error_message=excluded.error_message,
                 error_stack=excluded.error_stack,
                 source_node=excluded.source_node,
                 source_output_index=excluded.source_output_index,
                 input_data=excluded.input_data,
                 metadata=excluded.metadata,
                 execution_source=excluded.execution_source,
                 error_category=excluded.error_category,
                 http_code=COALESCE(excluded.http_code, execution_error_analytics.http_code)`,
                [
                    row.exec_id,
                    row.workflow_id,
                    nodeId,
                    nodeName,
                    nodeType,
                    errorType,
                    errorMessage,
                    errorStack,
                    sourceNode,
                    sourceOutputIndex,
                    inputData,
                    metadataJson,
                    executionSource,
                    errorCategory,
                    httpCode,
                    startedStr
                ]
            );
            succeeded.push(row.exec_id);
        }

        // Marked inside the same transaction as the rows they describe. Committing
        // the analytics and then marking done separately would leave a window
        // where a crash loses the mark and the work is repeated — or worse, where
        // the mark survives and the analytics do not.
        if (succeeded.length > 0) {
            const ph = succeeded.map(() => '?').join(',');
            await localDb.execute(
                `UPDATE execution_entity
                    SET analytics_status = 'done', analytics_next_attempt = NULL
                  WHERE id IN (${ph})`,
                succeeded
            );
        }

        // Too large to read. Not a failure to retry — it will be exactly as large
        // next time — so it is parked with its size recorded in the log.
        if (oversized.length > 0) {
            const ph = oversized.map(() => '?').join(',');
            await localDb.execute(
                `UPDATE execution_entity SET analytics_status = 'failed' WHERE id IN (${ph})`,
                oversized.map(o => o.id)
            );
            // One line, not one per row: a spike would otherwise bury everything
            // else in the log with the same message repeated hundreds of times.
            const biggest = Math.max(...oversized.map(o => o.bytes));
            console.warn(
                `[SYNC] ${oversized.length} error payload(s) skipped for exceeding ` +
                `${formatBytes(MAX_PAYLOAD_BYTES)} (largest ${formatBytes(biggest)}): ` +
                `${oversized.slice(0, 5).map(o => o.id).join(', ')}` +
                `${oversized.length > 5 ? `, +${oversized.length - 5} more` : ''}. ` +
                'Raise MAX_ERROR_PAYLOAD_BYTES to include them.'
            );
        }

        await localDb.execute('COMMIT');
        console.log(`[SYNC] Error Analytics updated for ${analyticsData.length} records.`);

        // Debug Export.
        //
        // scratch/ is gitignored, so it does not exist in the container: with
        // SAVE_DEBUG_ERRORS on, writeFileSync threw and took the whole analytics
        // pass down with it. The directory is created on demand now, the path is
        // configurable, and a failure here is logged rather than propagated —
        // a troubleshooting aid must never break the thing being troubleshot.
        if (SAVE_DEBUG_ERRORS && analyticsData.length > 0) {
            try {
                const outPath = process.env.DEBUG_ERRORS_PATH
                    ? path.resolve(process.env.DEBUG_ERRORS_PATH)
                    : path.resolve(__dirname, '../../scratch/debug_errors.json');
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, JSON.stringify(analyticsData, null, 2));
                console.log(`[SYNC] Raw debug export saved to ${outPath}`);
            } catch (e) {
                console.error('[SYNC] Could not write the debug export:', e.message);
            }
        }

        return { done: succeeded.length, failed: vanished.length + oversized.length };

    } catch (e) {
        console.error('[SYNC] Failed to map error analytics:', e);
        try { await localDb.execute('ROLLBACK'); } catch (err) { }
        // The rollback undid the 'done' marks too, so everything in this chunk is
        // still pending. Give it a backoff so the next cycle does not walk
        // straight back into the same failure.
        await markFailed(errorIdsArray, e.message);
        return { done: 0, failed: errorIdsArray.length };
    }
}

function isSyncActive() {
    return isSyncing;
}

/**
 * Resolves once no ETL pass is in flight, or after timeoutMs, whichever comes
 * first. Returns true if the sync actually finished.
 *
 * This is what makes shutdown safe. The ETL writes to the replica inside explicit
 * transactions; killing the process mid-pass leaves a hot journal at best, and the
 * replica holds execution history that n8n has already pruned, so there is nothing
 * to restore it from.
 *
 * Polling rather than an event emitter on purpose — syncData has several exit
 * paths (success, caught error, rollback) and a flag checked in one place cannot
 * fall out of sync with them the way a set of emit() calls can.
 */
function waitForIdle(timeoutMs = 8000) {
    if (!isSyncing) return Promise.resolve(true);

    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const timer = setInterval(() => {
            if (!isSyncing) {
                clearInterval(timer);
                resolve(true);
            } else if (Date.now() >= deadline) {
                clearInterval(timer);
                resolve(false);
            }
        }, 100);
        // Never hold the event loop open just to watch for idleness.
        if (timer.unref) timer.unref();
    });
}

module.exports = {
    syncData,
    updateConcurrencyStats,
    syncErrorAnalytics,
    enqueueForAnalytics,
    processAnalyticsQueue,
    reclassifyIfNeeded,
    isSyncActive,
    waitForIdle
};
