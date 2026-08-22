/**
 * An express-rate-limit store backed by the replica's SQLite file.
 *
 * The default store is a Map in the process. It forgets everything on restart,
 * and it is per-process — so a rolling deploy, a crash loop, or the second
 * instance that H-34 made possible each hand an attacker a fresh allowance. For
 * a login limiter that is most of the value gone.
 *
 * SQLite rather than Redis on purpose: this is a single-node tool that already
 * ships a database and already opens it. Requiring Redis to rate-limit a login
 * form would be a new service to run, secure and back up, in exchange for
 * counters that fit in a few dozen rows.
 *
 * Not for high-frequency limiters — see the comment on globalLimiter in
 * rateLimiter.js. This costs one write per counted request, which is right for
 * logins and AI calls and wrong for every GET the dashboard makes.
 */
const localDb = require('../config/localDb');
const crypto = require('crypto');
const log = require('../utils/logger').logger('RATELIMIT');

// Expired rows are swept on a timer rather than per request: the sweep is pure
// overhead for the caller waiting on a response, and nothing reads an expired
// row anyway — increment treats it as absent.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let sweeper = null;

function startSweeper() {
    if (sweeper) return;
    sweeper = setInterval(async () => {
        try {
            await localDb.execute('DELETE FROM rate_limits WHERE expires_at <= ?', [Date.now()]);
        } catch (err) {
            log.error('Sweep failed:', err.message);
        }
    }, SWEEP_INTERVAL_MS);
    if (sweeper.unref) sweeper.unref();   // never hold the process open
}

class SqliteStore {
    /**
     * @param {string} prefix distinguishes limiters sharing the table, so the
     *   login counter and the AI counter for the same IP cannot collide.
     */
    constructor(prefix) {
        this.prefix = prefix;
        this.windowMs = 60_000;   // replaced by init()
    }

    init(options) {
        this.windowMs = options.windowMs;
        startSweeper();
    }

    /**
     * Keys are hashed. They contain client-controlled input — an email address in
     * the login limiter's case — and there is no reason to keep a second copy of
     * anyone's address in a table whose only job is counting. A truncated SHA-256
     * is also a fixed 32 bytes, so a long key cannot bloat the row.
     */
    #key(key) {
        return crypto.createHash('sha256').update(`${this.prefix}:${key}`).digest('hex').slice(0, 32);
    }

    /**
     * One statement. The window reset lives inside the UPDATE rather than in a
     * read-then-write pair, so two requests arriving together cannot both decide
     * the window had expired and each start their own count of 1.
     */
    async increment(key) {
        const id = this.#key(key);
        const now = Date.now();
        const expires = now + this.windowMs;

        const rows = await localDb.query(
            `INSERT INTO rate_limits (key, hits, expires_at) VALUES (?, 1, ?)
             ON CONFLICT(key) DO UPDATE SET
                 hits       = CASE WHEN expires_at <= ? THEN 1        ELSE hits + 1     END,
                 expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
             RETURNING hits, expires_at`,
            [id, expires, now, now]
        );

        const row = rows.rows[0] || { hits: 1, expires_at: expires };
        return { totalHits: row.hits, resetTime: new Date(row.expires_at) };
    }

    /** Used by skipSuccessfulRequests / skipFailedRequests. Never goes below zero. */
    async decrement(key) {
        await localDb.execute(
            'UPDATE rate_limits SET hits = MAX(hits - 1, 0) WHERE key = ?',
            [this.#key(key)]
        );
    }

    async resetKey(key) {
        await localDb.execute('DELETE FROM rate_limits WHERE key = ?', [this.#key(key)]);
    }

    async resetAll() {
        await localDb.execute('DELETE FROM rate_limits WHERE key LIKE ?', [`%`]);
    }

    async get(key) {
        const rows = await localDb.query(
            'SELECT hits, expires_at FROM rate_limits WHERE key = ? AND expires_at > ?',
            [this.#key(key), Date.now()]
        );
        if (rows.rows.length === 0) return undefined;
        return { totalHits: rows.rows[0].hits, resetTime: new Date(rows.rows[0].expires_at) };
    }

    shutdown() {
        if (sweeper) { clearInterval(sweeper); sweeper = null; }
    }
}

module.exports = { SqliteStore };
