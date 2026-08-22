const log = require('../utils/logger').logger('DB');

/**
 * The replica's schema, as data.
 *
 * Kept apart from localDb.js for one reason: requiring localDb opens a database
 * connection and starts applying migrations. Anything that only wants to *know*
 * the schema — the offline optimiser, the ETL deciding which columns it may
 * select, a test — had to either duplicate the knowledge or accept the side
 * effect. Both happened. optimizeReplica.js carried its own copy of the index
 * list and had already fallen five indexes behind.
 *
 * Nothing in this file performs I/O. localDb.js owns the runner.
 */

// ==========================================================================
// Columns mirrored from n8n
// ==========================================================================
//
// n8n's execution_entity has nineteen columns; this replica used to take five.
// The ones below are the rest of what is worth keeping, and each is listed once,
// here, for both the migration that creates it and the ETL that fills it. That
// single list is the point: the previous arrangement made it possible to add a
// column to the SELECT and forget the ALTER TABLE, and the failure mode of that
// mistake is an ETL that throws on every cycle.
//
// `since` names the migration that introduced the column. A column added later
// gets a new id and a new migration — never an edit to one that has shipped,
// because its id is already recorded on every existing replica and an edit would
// only reach fresh installs.
//
// `pg` is the source column name; it doubles as the local one. The camelCase is
// n8n's and is kept deliberately, so a query can be read against either database
// without translating. Columns this project invents are snake_case, which is how
// you can tell at a glance which of the two put a value there.

const EXECUTION_MIRROR_COLUMNS = [
    // How the execution was triggered: webhook, trigger, manual, error, retry,
    // integrated, cli. Unlocks F-02 — a webhook failure and a schedule failure
    // are not the same problem and were being counted as one.
    { pg: 'mode', type: 'TEXT', since: '009' },

    // When the row was created, as opposed to when it started running. The
    // difference is queue lag (F-03), which is the first thing to move when a
    // queue-mode instance runs out of workers, and nothing measured it.
    { pg: 'createdAt', type: 'DATETIME', since: '009' },

    // Set by a Wait node. An execution parked here is not stalled, and without
    // this column there is no way to tell the two apart.
    { pg: 'waitTill', type: 'DATETIME', since: '009' },

    // Distinct from status: an execution can stop without finishing. Kept as
    // BOOLEAN to match `active` on workflow_entity — SQLite stores both as
    // integers either way.
    { pg: 'finished', type: 'BOOLEAN', since: '009' },

    // The retry graph (F-05). Both are empty on this instance today, which is
    // exactly why they matter now: the moment retries are switched on, an error
    // rate that cannot see them starts reporting failures that were resolved
    // seconds later.
    { pg: 'retryOf', type: 'TEXT', since: '009' },
    { pg: 'retrySuccessId', type: 'TEXT', since: '009' },

    // Payload sizes, in bytes. n8n's Postgres grows until it hurts and nothing
    // in the product says which workflow is doing it (F-04). bigint in the
    // source, so node-postgres hands these over as strings — the ETL coerces.
    { pg: 'jsonSizeBytes', type: 'INTEGER', since: '009' },
    { pg: 'binaryDataSizeBytes', type: 'INTEGER', since: '009' },

    // Which version of the workflow ran. With workflow_history this is git blame
    // for automations (F-11): "the errors start at the version deployed on the
    // 13th, by X".
    { pg: 'workflowVersionId', type: 'TEXT', since: '009' }

    // NOT mirrored, deliberately:
    //
    //   deletedAt  — every path that could write it filters it to NULL first.
    //                Phase B skips soft-deleted rows on fetch (that filter is the
    //                bug fix F-01 asked for, and it is already in place), so the
    //                column could only ever hold NULL here. A column that is
    //                always NULL is worse than no column: it reads like an answer.
    //   storedAt, deduplicationKey, tracingContext, usedPrivateCredentials
    //              — n8n 2.x internals with no consumer here. Mirroring a column
    //                costs a write on every row forever; each one should have to
    //                earn it.
];

const WORKFLOW_MIRROR_COLUMNS = [
    // 87 of this instance's 163 workflows are archived and 76 are live — more
    // than half the dropdown is dead entries (F-17).
    { pg: 'isArchived', type: 'BOOLEAN', since: '009' },

    // The folder tree n8n already maintains and this dashboard ignores: 15
    // folders with real hierarchy, flattened into one list of 163 (F-16).
    { pg: 'parentFolderId', type: 'TEXT', since: '009' },

    // updatedAt is what separates "died silently" from "somebody turned it off"
    // in F-09. createdAt gives a workflow an age, so a new one with no history
    // is not mistaken for a broken one.
    { pg: 'createdAt', type: 'DATETIME', since: '009' },
    { pg: 'updatedAt', type: 'DATETIME', since: '009' },

    // n8n's own count of triggers on the workflow. A second, cheap opinion on
    // whether something is meant to run on its own.
    { pg: 'triggerCount', type: 'INTEGER', since: '009' },

    { pg: 'description', type: 'TEXT', since: '009' }
];

/** The `columns` entries for one migration: [table, column, definition]. */
function columnsAddedIn(since) {
    return [
        ...EXECUTION_MIRROR_COLUMNS.filter((c) => c.since === since)
            .map((c) => ['execution_entity', c.pg, c.type]),
        ...WORKFLOW_MIRROR_COLUMNS.filter((c) => c.since === since)
            .map((c) => ['workflow_entity', c.pg, c.type])
    ];
}

// ==========================================================================
// Schema migrations
// ==========================================================================
//
// The schema used to be applied as a wall of CREATE TABLE IF NOT EXISTS and
// ALTER TABLE ADD COLUMN with the callback error thrown away:
//
//     localDb.run('ALTER TABLE x ADD COLUMN y', (err) => { /* silenced */ });
//
// The comment said "silence the duplicate column error", but the catch does not
// know which error it caught. A full disk, a corrupt page, a locked database and
// a typo in the column definition were all silenced exactly the same way, and
// the app carried on and started serving queries against a table that did not
// have the column. Ordering was implicit too: the analytics-queue seed ran
// against execution_error_analytics twelve statements before that table was
// created, so on a fresh database it failed every time.
//
// Each migration below runs once, in order, inside its own transaction, and is
// recorded in schema_migrations. Anything that fails stops the process rather
// than being written off.
//
// Two rules for adding one:
//   1. Never edit a migration that has shipped. Its id is already recorded on
//      every existing replica, so an edit only affects new installs — which is
//      how two databases with the same version number end up different.
//   2. Make it idempotent anyway. Every existing replica reaches this code with
//      an empty schema_migrations table, so all of these run once against a
//      database that already has everything in them.

const MIGRATIONS = [
    {
        id: '001-core-tables',
        sql: [
            `CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT
            )`,

            `CREATE TABLE IF NOT EXISTS dashboard_chat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sql_used TEXT,
                -- UTC, matching every other timestamp in this database. The old
                -- 'localtime' default made chat ordering depend on the server's offset.
                created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )`,

            `CREATE TABLE IF NOT EXISTS workflow_entity (
                id TEXT PRIMARY KEY,
                name TEXT,
                active BOOLEAN
            )`,

            `CREATE TABLE IF NOT EXISTS workflow_settings (
                workflow_id TEXT PRIMARY KEY,
                saved_time_seconds INTEGER DEFAULT 0,
                hourly_rate REAL DEFAULT 0,
                FOREIGN KEY (workflow_id) REFERENCES workflow_entity (id) ON DELETE CASCADE
            )`,

            `CREATE TABLE IF NOT EXISTS execution_entity (
                id INTEGER PRIMARY KEY,
                "workflowId" TEXT,
                status TEXT,
                "startedAt" DATETIME,
                "stoppedAt" DATETIME,
                -- First cycle in which Postgres stopped returning this row while
                -- it was still non-terminal. Non-null means "we asked and it was
                -- gone"; the sync promotes it to status 'unknown' once the grace
                -- period passes. Without this, a pruned 'running' row stays
                -- 'running' forever — one sat that way since 16/05/2026.
                missing_since DATETIME
            )`,

            `CREATE TABLE IF NOT EXISTS execution_error_analytics (
                id INTEGER PRIMARY KEY,
                workflow_id TEXT,
                node_id TEXT,
                node_name TEXT,
                node_type TEXT,
                error_type TEXT,
                error_message TEXT,
                error_stack TEXT,
                source_node TEXT,
                source_output_index INTEGER,
                input_data TEXT,
                metadata TEXT,
                execution_source TEXT,
                error_category TEXT DEFAULT 'unknown',
                -- HTTP status from the n8n error object when there is one. Far more
                -- reliable than hunting for "429" inside free text, so the classifier
                -- consults it first. Only populated going forward — it was never
                -- extracted before, so it stays NULL on historical rows.
                http_code INTEGER,
                timestamp DATETIME
            )`,

            `CREATE TABLE IF NOT EXISTS dashboard_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )`

            // NOTE: `instance_lock` is deliberately NOT created here. instanceLock.js
            // owns it and awaits its own schema before the first attempt — the first
            // heartbeat fires while these migrations are still running, so a table
            // defined here would not exist yet. Keeping one definition, in the file
            // that understands the table, also means the two cannot drift apart.
        ]
    },

    {
        // Columns added to tables that shipped without them. Written as
        // add-if-missing rather than ALTER-and-ignore, so a real failure is a
        // real failure.
        id: '002-added-columns',
        columns: [
            ['workflow_settings', 'hourly_rate', 'REAL DEFAULT 0'],
            ['execution_entity', 'missing_since', 'DATETIME'],
            // Work queue for deep error analytics. Extraction used to happen only
            // for the ids discovered in the current cycle: one failure and that
            // execution's detail was lost for good, with nothing recording that it
            // had been lost. 64 error executions had no analytics row and nothing
            // would ever have noticed. These columns make the work outlive the
            // cycle that discovered it.
            ['execution_entity', 'analytics_status', 'TEXT'],
            ['execution_entity', 'analytics_attempts', 'INTEGER DEFAULT 0'],
            ['execution_entity', 'analytics_next_attempt', 'DATETIME'],
            ['execution_error_analytics', 'http_code', 'INTEGER'],
            ['execution_error_analytics', 'error_category', "TEXT DEFAULT 'unknown'"]
        ]
    },

    {
        // One-time seed of the analytics queue. Every historical error is marked
        // 'done' if its analytics row exists and 'pending' if it does not, which
        // is what recovers the 64 that were silently dropped. Guarded on
        // analytics_status IS NULL as well as being recorded, so it stays a no-op
        // however it is re-run.
        id: '003-seed-analytics-queue',
        sql: [
            `UPDATE execution_entity
                SET analytics_status = CASE
                      WHEN EXISTS (SELECT 1 FROM execution_error_analytics a WHERE a.id = execution_entity.id)
                      THEN 'done' ELSE 'pending' END
              WHERE status IN ('error', 'crashed')
                AND analytics_status IS NULL`
        ]
    },

    {
        // Authorization mirror (M-20). n8n's own model: a workflow belongs to a
        // project, a user belongs to a project. Mirrored rather than queried live
        // because every scoped read joins against it, and a round trip to Postgres
        // per request would put the n8n database back on the critical path.
        //
        // Deliberately no foreign keys to workflow_entity. Membership is replaced
        // wholesale on every sync, and a workflow deleted between the two source
        // queries would abort that replace — leaving the previous, now wrong,
        // membership in place. An id with no matching workflow simply joins to
        // nothing, which is the correct outcome anyway.
        id: '004-authorization-mirror',
        sql: [
            `CREATE TABLE IF NOT EXISTS project (
                id TEXT PRIMARY KEY,
                name TEXT,
                type TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS project_relation (
                project_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                role TEXT,
                PRIMARY KEY (project_id, user_id)
            )`,
            `CREATE TABLE IF NOT EXISTS shared_workflow (
                workflow_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                role TEXT,
                PRIMARY KEY (workflow_id, project_id)
            )`
        ]
    },

    {
        // L-30. The table counted executions STARTED per five-minute bucket while
        // being called concurrency_stats.active_count — a different measurement
        // entirely, and the drill-down behind the chart had been written to match
        // the name rather than the data. Real concurrency is F-06.
        //
        // The contents are a rolling 24-hour cache recomputed from execution_entity
        // on every sync, so the copy only keeps the chart populated between this
        // boot and the next cycle. Nothing is at risk if it moves nothing.
        id: '005-rename-concurrency-to-volume',
        sql: [
            `CREATE TABLE IF NOT EXISTS execution_volume_stats (
                timestamp DATETIME PRIMARY KEY,
                started_count INTEGER
            )`
        ],
        run: async (db) => {
            const old = await db.query(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='concurrency_stats'"
            );
            if (old.rows.length === 0) return;
            const moved = await db.execute(
                `INSERT OR IGNORE INTO execution_volume_stats (timestamp, started_count)
                 SELECT timestamp, active_count FROM concurrency_stats`
            );
            await db.execute('DROP TABLE concurrency_stats');
            log.info(`Migrated ${moved.changes} volume buckets from concurrency_stats.`);
        }
    },

    {
        // Rate-limit counters (L-27). In the replica rather than in process
        // memory so a restart, a rolling deploy or a second instance does not
        // hand an attacker a fresh allowance on the login form. Keys are hashed
        // by the store, so no email address is ever written here.
        id: '006-rate-limits',
        sql: [
            `CREATE TABLE IF NOT EXISTS rate_limits (
                key TEXT PRIMARY KEY,
                hits INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            )`
        ]
    },

    {
        // One row per ETL pass (L-26). Without it the only record of the sync was
        // console output, which meant "when did this last work, and how long has
        // it been getting slower" could not be answered at all — and the answer to
        // the second question is what tells you a replica is outgrowing its box.
        // Read back by the UI in F-19.
        id: '007-sync-runs',
        sql: [
            `CREATE TABLE IF NOT EXISTS sync_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TEXT NOT NULL,
                finished_at TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                workflows INTEGER,
                executions INTEGER,
                rows_read INTEGER,
                errors INTEGER,
                analytics_done INTEGER,
                analytics_failed INTEGER,
                analytics_queued INTEGER,
                reclassified INTEGER,
                purged_input INTEGER,
                purged_stack INTEGER,
                replica_bytes INTEGER,
                error_message TEXT
            )`
        ]
    },

    {
        // Indexes last, so every table they reference exists. All IF NOT EXISTS
        // and cheap to re-run; on a replica indexed offline this is a no-op, on a
        // fresh one it costs a few seconds and saves a full table scan per request.
        id: '008-indexes',
        sql: [
            // Time-range filters on the dashboard and the executions table.
            'CREATE INDEX IF NOT EXISTS idx_exec_started ON execution_entity("startedAt")',
            // Per-workflow drilldowns and the workflow filter.
            'CREATE INDEX IF NOT EXISTS idx_exec_wf_started ON execution_entity("workflowId", "startedAt")',
            // Error-rate aggregation and status filtering.
            'CREATE INDEX IF NOT EXISTS idx_exec_status_started ON execution_entity(status, "startedAt")',
            // The analytics queue is a handful of rows in a table of half a
            // million, and only the pending ones are ever queried.
            `CREATE INDEX IF NOT EXISTS idx_exec_analytics_pending
                ON execution_entity(analytics_next_attempt, id)
              WHERE analytics_status = 'pending'`,
            // Error intelligence: range scans, per-workflow drilldown, group dedup.
            'CREATE INDEX IF NOT EXISTS idx_err_ts ON execution_error_analytics(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_err_wf_ts ON execution_error_analytics(workflow_id, timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_err_cat_node ON execution_error_analytics(error_category, node_name)',
            // Chat history is read per user, newest first.
            'CREATE INDEX IF NOT EXISTS idx_chat_user_created ON dashboard_chat_history(user_id, created_at)',
            // Authorization: every scoped query resolves "which workflows may this
            // user see" by joining these two, so both sides of that join are indexed.
            'CREATE INDEX IF NOT EXISTS idx_project_relation_user ON project_relation(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_shared_workflow_project ON shared_workflow(project_id)',
            // Only the expiry sweep scans this table; every other access is by
            // primary key.
            'CREATE INDEX IF NOT EXISTS idx_rate_limits_expiry ON rate_limits(expires_at)',
            // The history is read newest-first, and pruned oldest-first.
            'CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at)'
        ]
    },

    {
        // F-01. The fifteen columns n8n has always had and this replica threw
        // away. Nothing reads them yet — that is the point of a foundation — but
        // every one of them is a question the dashboard currently cannot answer
        // about data it was already fetching and discarding.
        //
        // Add-if-missing rather than a table rebuild: execution_entity holds
        // 500,000 rows of history that Postgres has already pruned, and ALTER
        // TABLE ADD COLUMN in SQLite is a constant-time header change while a
        // rebuild would copy every one of them.
        //
        // The new columns are NULL on existing rows. syncJob's backfill pass
        // fills in whatever Postgres still has (roughly 70k of the 500k; the
        // rest are gone and will stay NULL, which is the honest answer).
        id: '009-mirror-remaining-source-columns',
        columns: columnsAddedIn('009')
    },

    {
        id: '010-mirror-column-indexes',
        sql: [
            // F-02 groups and filters by trigger type over a time range. Without
            // this, "error rate for webhooks this week" scans every execution.
            'CREATE INDEX IF NOT EXISTS idx_exec_mode_started ON execution_entity(mode, "startedAt")',
            // F-05 walks retry chains: given an execution, what retried it.
            // Partial, because the column is NULL on effectively every row — a
            // full index here would be half a million entries to serve none.
            `CREATE INDEX IF NOT EXISTS idx_exec_retry_of ON execution_entity("retryOf")
              WHERE "retryOf" IS NOT NULL`,
            // Scaffolding for the one-time backfill, which walks id order
            // looking for rows it has not reached: 466,000 of them on this
            // replica, in 2,000-row chunks. syncJob DROPs this index the moment
            // the pass completes — partial on `mode IS NULL`, it would otherwise
            // keep an entry for every execution Postgres has already pruned.
            `CREATE INDEX IF NOT EXISTS idx_exec_backfill_pending ON execution_entity(id)
              WHERE mode IS NULL`
        ]
    }
];

// Indexes that exist to serve a one-time migration and are dropped by the code
// that finishes it. They belong in their migration — a fresh replica needs them
// — but not in the permanent set below, or the offline optimiser would helpfully
// rebuild the scaffolding on every run and then report the schema as incomplete
// for the rest of the database's life.
const TRANSIENT_INDEXES = new Set(['idx_exec_backfill_pending']);

/**
 * Every CREATE INDEX the schema expects to find in a healthy replica.
 *
 * Derived rather than listed, so the offline optimiser cannot fall behind the
 * app again. It was missing five of the twelve indexes at the time this was
 * written, which is the quiet kind of drift: the script reported success and the
 * database it produced was slower than the one the app builds at boot.
 */
const INDEX_STATEMENTS = MIGRATIONS
    .flatMap((m) => (m.sql || []).filter((s) => /^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(s)))
    .filter((s) => !TRANSIENT_INDEXES.has(s.match(/idx_\w+/)[0]));

/**
 * The mirrored columns this source actually has, plus the SQL fragments that
 * follow from that set. Built once per cycle and reused by the fetch, the
 * upsert, the non-terminal refresh and the backfill, so those four can never
 * disagree about which columns are in play.
 */
function mirrorPlan(available, spec) {
    const cols = spec.filter((c) => available.has(c.pg));
    const quoted = cols.map((c) => `"${c.pg}"`);
    return {
        cols,
        any: cols.length > 0,
        // Leading comma included, so callers can append to a base list without
        // building a conditional separator at every call site.
        select: quoted.map((q) => `, ${q}`).join(''),
        placeholders: cols.map(() => ', ?').join(''),
        upsert: quoted.map((q) => `, ${q} = excluded.${q}`).join(''),
        assign: quoted.map((q) => `, ${q} = ?`).join(''),
        setList: quoted.map((q) => `${q} = ?`).join(', '),
        values: (row) => cols.map((c) => toSqlite(row[c.pg], c.type))
    };
}

/**
 * One source value, as SQLite should store it.
 *
 * Three conversions, each for a concrete reason. Dates become ISO-8601 UTC
 * strings because every comparison in this replica is lexicographic on that
 * format — it is what makes the indexes usable as ranges. Booleans become 0/1.
 * And the bigint columns arrive from node-postgres as *strings*, because an int8
 * does not fit a JS number safely. Checking the shape here rather than leaving it
 * to SQLite's column affinity is what stops a value that is not a number at all
 * from being stored as text in a numeric column, where SUM() would read it as 0.
 */
function toSqlite(value, type) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (type === 'INTEGER' && typeof value === 'string') {
        if (!/^-?\d+$/.test(value)) return null;
        const n = Number(value);
        // Past 2^53 a JS number can no longer hold the value exactly, while
        // SQLite's integers are 64-bit and its column affinity parses the text
        // losslessly. Above that line the string is the *more* accurate binding,
        // not the lazier one.
        return Number.isSafeInteger(n) ? n : value;
    }
    return value;
}

module.exports = {
    MIGRATIONS,
    INDEX_STATEMENTS,
    TRANSIENT_INDEXES,
    EXECUTION_MIRROR_COLUMNS,
    WORKFLOW_MIRROR_COLUMNS,
    mirrorPlan,
    toSqlite
};
