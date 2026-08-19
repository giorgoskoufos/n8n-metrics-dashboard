const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Configurable so the replica can live on a mounted volume instead of inside the
// container. It holds history that has already been pruned from the n8n Postgres
// and cannot be rebuilt, so it must survive container replacement.
const dbPath = process.env.DASHBOARD_DB_PATH
    ? path.resolve(process.env.DASHBOARD_DB_PATH)
    : path.resolve(__dirname, '../../dashboard.sqlite');

// A freshly created volume is an empty directory — the parent must exist before opening.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const localDb = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening local SQLite database', err.message);
    } else {
        console.log(`Connected to the local SQLite database at ${dbPath}`);
        applyPragmas();
        initDb();
    }
});

/**
 * Connection tuning. Must run before any other statement.
 *
 * The default rollback journal takes an exclusive lock for the whole write
 * transaction, so every ETL cycle froze all readers — the API appeared to hang
 * on a five minute rhythm. WAL lets readers continue against the last committed
 * snapshot while the sync writes.
 */
function applyPragmas() {
    localDb.serialize(() => {
        // Persisted in the database header — survives restarts and file copies.
        localDb.run('PRAGMA journal_mode = WAL', (e) => {
            if (e) console.error('[DB] Could not enable WAL:', e.message);
        });
        // Per-connection, so these are reapplied on every boot.
        localDb.run('PRAGMA synchronous = NORMAL');   // safe under WAL, far fewer fsyncs
        localDb.run('PRAGMA busy_timeout = 5000');    // wait instead of throwing SQLITE_BUSY
        localDb.run('PRAGMA foreign_keys = ON');      // the schema declares them; enforce them
        localDb.run('PRAGMA cache_size = -32000');    // ~32 MB page cache
    });
}

/**
 * Indexes for the access patterns the dashboard actually uses.
 *
 * Every one of these is IF NOT EXISTS and cheap to re-run. On a replica that has
 * already been indexed offline this is a no-op; on a fresh one it costs a few
 * seconds at boot and saves a full scan of the whole table on every request.
 */
function createIndexes() {
    const indexes = [
        // Time-range filters on the dashboard and the executions table.
        'CREATE INDEX IF NOT EXISTS idx_exec_started ON execution_entity("startedAt")',
        // Per-workflow drilldowns and the workflow filter.
        'CREATE INDEX IF NOT EXISTS idx_exec_wf_started ON execution_entity("workflowId", "startedAt")',
        // Error-rate aggregation and status filtering.
        'CREATE INDEX IF NOT EXISTS idx_exec_status_started ON execution_entity(status, "startedAt")',
        // Error intelligence: range scans, per-workflow drilldown, group dedup.
        'CREATE INDEX IF NOT EXISTS idx_err_ts ON execution_error_analytics(timestamp)',
        'CREATE INDEX IF NOT EXISTS idx_err_wf_ts ON execution_error_analytics(workflow_id, timestamp)',
        'CREATE INDEX IF NOT EXISTS idx_err_cat_node ON execution_error_analytics(error_category, node_name)',
        // Chat history is read per user, newest first.
        'CREATE INDEX IF NOT EXISTS idx_chat_user_created ON dashboard_chat_history(user_id, created_at)'
    ];

    localDb.serialize(() => {
        for (const sql of indexes) {
            localDb.run(sql, (e) => {
                if (e) console.error('[DB] Index creation failed:', sql, e.message);
            });
        }
        // Lets the query planner choose between the indexes above instead of guessing.
        localDb.run('ANALYZE', (e) => {
            if (e) console.error('[DB] ANALYZE failed:', e.message);
            else console.log('[DB] Indexes verified.');
        });
    });
}

function initDb() {
    localDb.serialize(() => {
        // Users table
        localDb.run(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT
            )
        `);

        // Chat History
        localDb.run(`
            CREATE TABLE IF NOT EXISTS dashboard_chat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sql_used TEXT,
                -- UTC, matching every other timestamp in this database. The old
                -- 'localtime' default made chat ordering depend on the server's offset.
                created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        `);

        // Workflow Entity Replica
        localDb.run(`
            CREATE TABLE IF NOT EXISTS workflow_entity (
                id TEXT PRIMARY KEY,
                name TEXT,
                active BOOLEAN
            )
        `);

        // Workflow Settings (ROI)
        localDb.run(`
            CREATE TABLE IF NOT EXISTS workflow_settings (
                workflow_id TEXT PRIMARY KEY,
                saved_time_seconds INTEGER DEFAULT 0,
                hourly_rate REAL DEFAULT 0,
                FOREIGN KEY (workflow_id) REFERENCES workflow_entity (id) ON DELETE CASCADE
            )
        `);

        // Migration: add hourly_rate if it doesn't exist
        localDb.run(`ALTER TABLE workflow_settings ADD COLUMN hourly_rate REAL DEFAULT 0`, (err) => {
            // Silence the duplicate column error on startup
        });

        // Execution Entity Replica
        localDb.run(`
            CREATE TABLE IF NOT EXISTS execution_entity (
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
            )
        `);

        // Migration: add missing_since to replicas created before it existed.
        localDb.run(`ALTER TABLE execution_entity ADD COLUMN missing_since DATETIME`, (err) => {
            // Silence the duplicate column error on startup
        });

        // Work queue for deep error analytics.
        //
        // Extraction used to happen only for the ids discovered in the current
        // cycle: one failure and that execution's detail was lost for good, with
        // nothing recording that it had been lost. 64 error executions had no
        // analytics row and nothing would ever have noticed. These columns make
        // the work outlive the cycle that discovered it.
        localDb.run(`ALTER TABLE execution_entity ADD COLUMN analytics_status TEXT`, (err) => { });
        localDb.run(`ALTER TABLE execution_entity ADD COLUMN analytics_attempts INTEGER DEFAULT 0`, (err) => { });
        localDb.run(`ALTER TABLE execution_entity ADD COLUMN analytics_next_attempt DATETIME`, (err) => { });

        // Partial index: the queue is a handful of rows in a table of half a
        // million, and only the pending ones are ever queried.
        localDb.run(`
            CREATE INDEX IF NOT EXISTS idx_exec_analytics_pending
            ON execution_entity(analytics_next_attempt, id)
            WHERE analytics_status = 'pending'
        `);

        // One-time seed. Every historical error is marked 'done' if its analytics
        // row exists and 'pending' if it does not, which is what recovers the 64
        // that were silently dropped. Touches only rows that have never been
        // marked, so it is a no-op from the second boot onwards.
        localDb.run(`
            UPDATE execution_entity
               SET analytics_status = CASE
                     WHEN EXISTS (SELECT 1 FROM execution_error_analytics a WHERE a.id = execution_entity.id)
                     THEN 'done' ELSE 'pending' END
             WHERE status IN ('error', 'crashed')
               AND analytics_status IS NULL
        `, function (err) {
            if (err) console.error('[DB] Could not seed analytics queue:', err.message);
            else if (this.changes > 0) console.log(`[DB] Analytics queue seeded for ${this.changes} historical errors.`);
        });

        // Concurrency Stats Table
        localDb.run(`
            CREATE TABLE IF NOT EXISTS concurrency_stats (
                timestamp DATETIME PRIMARY KEY,
                active_count INTEGER
            )
        `);

        // Global Dashboard Settings (Timezone, etc)
        localDb.run(`
            CREATE TABLE IF NOT EXISTS dashboard_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

        // NOTE: `instance_lock` is deliberately NOT created here. It is created by
        // instanceLock.js, which awaits its own schema before the first attempt —
        // initDb() runs from the open callback and is still in flight when the
        // first heartbeat fires, so a table defined here would not exist yet.
        // Keeping one definition, in the file that understands the table, also
        // means the two cannot drift apart.

        // Execution Error Analytics
        localDb.run(`
            CREATE TABLE IF NOT EXISTS execution_error_analytics (
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
            )
        `);

        // Migration: add http_code to replicas created before it existed.
        localDb.run(`ALTER TABLE execution_error_analytics ADD COLUMN http_code INTEGER`, (err) => {
            // Silence the duplicate column error on startup
        });

        // Migration: add error_category if it doesn't exist
        localDb.run(`ALTER TABLE execution_error_analytics ADD COLUMN error_category TEXT DEFAULT 'unknown'`, (err) => {
            // Silence the duplicate column error on startup
        });

        // Indexes last, so every table they reference already exists.
        createIndexes();
    });
}

// Convert callback based queries to promises for easier async/await usage
localDb.query = function (sql, params = []) {
    return new Promise((resolve, reject) => {
        this.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                // To keep compatibility with pg structure expecting `rows`
                resolve({ rows });
            }
        });
    });
};

localDb.execute = function (sql, params = []) {
    return new Promise((resolve, reject) => {
        this.run(sql, params, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(this);
            }
        });
    });
};

/**
 * Runs one statement over many parameter sets against a single prepared statement.
 *
 * The sync previously awaited a separate execute() per row, so a batch of a few
 * thousand executions meant a few thousand parse/plan cycles and promise
 * round-trips while holding the write lock. Preparing once and reusing keeps that
 * lock held for a fraction of the time.
 *
 * The caller owns the surrounding transaction.
 */
localDb.executeMany = function (sql, rows) {
    return new Promise((resolve, reject) => {
        if (!rows || rows.length === 0) return resolve(0);

        const stmt = this.prepare(sql, (prepErr) => {
            if (prepErr) return reject(prepErr);

            let pending = rows.length;
            let failed = null;

            for (const params of rows) {
                stmt.run(params, (err) => {
                    if (err && !failed) failed = err;
                    if (--pending === 0) {
                        stmt.finalize((finErr) => {
                            const e = failed || finErr;
                            if (e) reject(e);
                            else resolve(rows.length);
                        });
                    }
                });
            }
        });
    });
};

/**
 * Closes the replica cleanly, checkpointing the WAL first.
 *
 * The checkpoint is the part that matters. Under WAL, recent commits live in the
 * -wal sidecar until something folds them back into the main file. A container
 * that dies without checkpointing leaves the newest data in a file that is easy
 * to leave behind when someone copies "the database" — which is exactly how this
 * replica lost 86% of its rows during the volume migration. TRUNCATE folds the
 * WAL back and empties it, so after a clean stop dashboard.sqlite is complete on
 * its own.
 *
 * Never rejects: shutdown must continue even if the checkpoint fails.
 */
localDb.closeAsync = function () {
    return new Promise((resolve) => {
        this.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
            if (err) console.error('[DB] WAL checkpoint failed:', err.message);
            this.close((closeErr) => {
                if (closeErr) console.error('[DB] Error closing replica:', closeErr.message);
                else console.log('[DB] Replica closed cleanly.');
                resolve();
            });
        });
    });
};

module.exports = localDb;
