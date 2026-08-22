/**
 * Single-writer lock for the ETL.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Two processes running the ETL against one dashboard.sqlite destroyed this
 * replica three times during a volume migration. PRAGMA integrity_check kept
 * answering "ok" while 86% of the rows were gone, so the damage was invisible
 * until the row counts were compared by hand.
 *
 * ── Why the lock lives inside the replica ──────────────────────────────────
 * Not in a lock file, not in the orchestrator's config. Two processes are
 * dangerous only when they share the database file; if they share the file they
 * can see each other's lock row, and if they cannot see each other's lock row
 * they are not sharing a file and there is nothing to protect. The scope comes
 * out exactly right on every platform — Swarm, Portainer, plain docker run,
 * Kubernetes, a downloaded zip run twice in two terminals — with nothing to
 * configure and no way for an operator to switch it off by accident.
 *
 * ── Why the ETL is blocked and not the boot ────────────────────────────────
 * A process killed with SIGKILL cannot release its lock, so a stale row can
 * outlive its owner. If a stale lock refused startup, that row would take the
 * whole dashboard down until someone cleared it by hand. Refusing only the ETL
 * means the worst case is stale numbers on a site that still works. A safety
 * mechanism must not be more dangerous than what it protects against.
 *
 * ── Why acquisition repeats instead of happening once at boot ──────────────
 * Under a start-first rolling update the new container comes up while the old
 * one is still running, so it correctly declines the lock. If it only ever
 * asked once, it would never sync again after the old container went away. The
 * heartbeat re-attempts, so ownership transfers on its own within one TTL.
 */
const os = require('os');
const crypto = require('crypto');
const localDb = require('./localDb');
const log = require('../utils/logger').logger('LOCK');

// Unique per process. Hostname and PID both repeat across containers (PID is
// almost always 1 in Docker), so neither can identify an owner on its own —
// they are kept only to make the logs readable by a human.
const OWNER_ID = crypto.randomUUID();
const HOSTNAME = os.hostname();

// A lock is considered abandoned after this long without a heartbeat. It must
// be comfortably larger than the heartbeat interval, or a slow write turns into
// a spurious takeover.
const TTL_MS = Number(process.env.ETL_LOCK_TTL_MS) || 60_000;
const HEARTBEAT_MS = Math.max(5_000, Math.floor(TTL_MS / 4));

let holding = false;
let heartbeatTimer = null;
let lastDeclinedOwner = null;
let schemaReady = null;

const nowIso = () => new Date().toISOString();
const staleBefore = () => new Date(Date.now() - TTL_MS).toISOString();

/**
 * This module owns its own table rather than relying on localDb's initDb().
 *
 * initDb() runs from the database open callback, so it is still in flight when
 * the first heartbeat fires — the lock would fail with "no such table" and sit
 * out a full interval before retrying. Awaiting this instead makes acquisition
 * correct no matter what else is going on at boot, and keeps the definition in
 * the one file that understands what the table means.
 *
 * Memoised: the statements are idempotent, but there is no reason to re-queue
 * them on every heartbeat.
 */
function ensureSchema() {
    if (!schemaReady) {
        schemaReady = localDb
            .execute(`
                CREATE TABLE IF NOT EXISTS instance_lock (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    owner_id TEXT,
                    hostname TEXT,
                    pid INTEGER,
                    acquired_at DATETIME,
                    heartbeat_at DATETIME
                )
            `)
            // Pinned to one row. The CHECK makes a second row impossible rather
            // than merely unlikely.
            .then(() => localDb.execute('INSERT OR IGNORE INTO instance_lock (id) VALUES (1)'))
            .catch((err) => {
                schemaReady = null;   // let the next attempt try again
                throw err;
            });
    }
    return schemaReady;
}

/**
 * Claims the lock, or renews it if we already hold it.
 *
 * The whole decision is one UPDATE. That is deliberate: a read followed by a
 * write would let two processes both observe a free lock and both write
 * themselves into it. SQLite serialises writers, so with the condition inside
 * the WHERE clause exactly one UPDATE reports a changed row and exactly one
 * process wins.
 */
async function acquireOrRenew() {
    const now = nowIso();
    try {
        await ensureSchema();
        const res = await localDb.execute(
            `UPDATE instance_lock
                SET owner_id     = ?,
                    hostname     = ?,
                    pid          = ?,
                    heartbeat_at = ?,
                    acquired_at  = CASE WHEN owner_id = ? THEN acquired_at ELSE ? END
              WHERE id = 1
                AND (owner_id IS NULL OR owner_id = ? OR heartbeat_at IS NULL OR heartbeat_at < ?)`,
            [OWNER_ID, HOSTNAME, process.pid, now, OWNER_ID, now, OWNER_ID, staleBefore()]
        );

        const won = res.changes === 1;

        if (won && !holding) {
            log.info(`ETL lock acquired by ${HOSTNAME}#${process.pid}.`);
            lastDeclinedOwner = null;
        } else if (!won && holding) {
            // Only reachable if another process decided we were stale and took
            // over — worth shouting about, because it means this instance was
            // starved long enough to look dead.
            log.warn('Lost the ETL lock to another instance.');
        }

        holding = won;
        // "Declined" and "broken" must stay distinguishable all the way up. They
        // look identical from here — both simply mean "not the writer" — but a
        // caller that conflates them reports a second instance that does not
        // exist, and sends whoever reads the log hunting for it.
        return { won, failed: false };
    } catch (err) {
        // A failure is not proof that someone else owns it, but we must assume
        // the worst: writing without a confirmed lock is the exact scenario this
        // module exists to prevent.
        log.error('Could not acquire or renew the ETL lock:', err.message);
        holding = false;
        return { won: false, failed: true, error: err };
    }
}

async function describeOwner() {
    try {
        const r = await localDb.query('SELECT hostname, pid, heartbeat_at FROM instance_lock WHERE id = 1');
        const row = r.rows[0];
        if (!row || !row.hostname) return 'unknown instance';
        return `${row.hostname}#${row.pid} (last seen ${row.heartbeat_at})`;
    } catch {
        return 'unknown instance';
    }
}

/**
 * True only while this process is the confirmed owner. The ETL calls this before
 * every pass.
 */
function isHolding() {
    return holding;
}

/**
 * Attempts to take the lock, logging the outcome once per change of owner
 * rather than on every attempt — an instance that is not the writer would
 * otherwise fill the log with the same line every few seconds.
 */
async function claimForEtl() {
    const result = await acquireOrRenew();
    if (result.won) return true;

    if (result.failed) {
        // The error itself was already logged with its real cause. Saying
        // "another instance holds the lock" here would invent one.
        log.warn('ETL skipped — the lock could not be checked. Not syncing, to stay safe.');
        return false;
    }

    const owner = await describeOwner();
    if (owner !== lastDeclinedOwner) {
        log.warn(
            `ETL skipped — another instance holds the lock: ${owner}. ` +
            'This instance keeps serving reads. Ownership transfers automatically ' +
            `if that instance stops (within ${Math.round(TTL_MS / 1000)}s).`
        );
        lastDeclinedOwner = owner;
    }
    return false;
}

function startHeartbeat() {
    if (heartbeatTimer) return;
    acquireOrRenew();
    heartbeatTimer = setInterval(acquireOrRenew, HEARTBEAT_MS);
    // Must never be the reason the process stays alive.
    if (heartbeatTimer.unref) heartbeatTimer.unref();
}

/**
 * Hands the lock back on a clean shutdown, so a replacement instance can start
 * syncing immediately instead of waiting out the TTL. Scoped to our own
 * owner_id — a process that already lost the lock must not clear the winner's.
 */
async function release() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (!holding) return;
    holding = false;
    try {
        await localDb.execute(
            `UPDATE instance_lock
                SET owner_id = NULL, hostname = NULL, pid = NULL, heartbeat_at = NULL
              WHERE id = 1 AND owner_id = ?`,
            [OWNER_ID]
        );
        log.info('ETL lock released.');
    } catch (err) {
        // Not fatal. The TTL is the backstop for exactly this case.
        log.error('Could not release the ETL lock:', err.message);
    }
}

module.exports = {
    claimForEtl,
    isHolding,
    startHeartbeat,
    release,
    describeOwner,
    OWNER_ID,
    TTL_MS,
    HEARTBEAT_MS
};
