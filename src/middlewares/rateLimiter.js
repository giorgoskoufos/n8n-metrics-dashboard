const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const crypto = require('crypto');
const { SqliteStore } = require('./sqliteRateStore');

/**
 * Where the counters live, and why they are not all in the same place.
 *
 * The targeted limiters below (login, AI, forced sync) are persisted in the
 * replica. Each one guards something a restart must not reset: a login form
 * being guessed at, an OpenAI bill, a full ETL pass against the production n8n
 * Postgres. In memory, a rolling deploy or a crash loop hands the caller a fresh
 * allowance, and the second instance H-34 made possible never sees the first
 * one's count at all.
 *
 * The global limiter is deliberately NOT persisted. It exists to blunt a flood,
 * and it counts every single API call — persisting it would add a database write
 * per request, so the harder the flood the more work the defence would create.
 * Its failure mode is also mild: one process forgetting its counters after a
 * restart, while the targeted limits above still hold.
 */

// Emails are normalised before hashing so Bob@x and bob@x count as one account.
const normalizeEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * Password guessing against ONE account, from one source.
 *
 * Keyed on IP + email rather than email alone, and that is a real trade-off. On
 * email alone, anyone who knows an address can lock its owner out of their own
 * dashboard by failing ten logins — the limiter becomes the attack. Including
 * the IP costs coverage of a distributed attack on a single account, which the
 * per-IP limiter below only partly covers; for a self-hosted tool with a handful
 * of accounts, denying the lockout is the better trade.
 *
 * Only failures count. A person legitimately logging in and out repeatedly is
 * not what this is for.
 */
const loginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    store: new SqliteStore('login-account'),
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
        const email = normalizeEmail(req.body && req.body.email);
        // Hashed here as well as in the store: the key also reaches log lines and
        // the rate-limit headers, and neither should carry an address.
        const who = crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
        return `${ipKeyGenerator(req.ip)}|${who}`;
    },
    message: {
        error: 'Too many failed login attempts for this account. Please try again in 15 minutes.'
    }
});

/**
 * Credential stuffing: one source, many accounts.
 *
 * Looser than the per-account limit and doing a different job — the per-account
 * limiter would happily allow ten attempts against each of a thousand addresses
 * from the same host, because each key is different.
 */
const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    store: new SqliteStore('login-ip'),
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts from this address, please try again later.' }
});

// Applied in order on the login route: the broad source limit first, then the
// per-account one.
const loginLimiter = [loginIpLimiter, loginAccountLimiter];

// Every call is a paid request to OpenAI. Keyed per user once authenticated, so
// one person cannot spend the allowance of everyone behind the same office IP.
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    store: new SqliteStore('ai'),
    keyGenerator: (req) =>
        req.user && req.user.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip),
    message: { error: 'Too many AI requests, please slow down.' }
});

// A forced sync is a full ETL pass against the production n8n Postgres. The
// isSyncing flag only prevents two from overlapping — it does nothing about one
// user firing them back to back forever. Key on the authenticated user rather
// than the IP, so a shared office IP does not lock everyone out and a single
// abusive account cannot hide behind a proxy. Must be mounted AFTER
// authenticateToken, otherwise req.user is undefined and this degrades to per-IP.
const syncLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    store: new SqliteStore('sync'),
    keyGenerator: (req) =>
        req.user && req.user.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip),
    message: { error: 'Sync can be triggered at most twice per minute. Please wait.' }
});

/**
 * A ceiling on /api/* as a whole.
 *
 * Nothing but the login form was bounded before, so an authenticated caller
 * could ask for the 60-day metrics view — several aggregate scans — as fast as
 * the socket allowed. The limit is set well above what the dashboard itself
 * does: a full page load is a handful of calls, and the heaviest page polls.
 *
 * Keyed per user where there is one, so one person hammering the API does not
 * lock out their colleagues on the same address.
 */
const globalApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT_PER_MINUTE) || 300,
    keyGenerator: (req) =>
        req.user && req.user.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip),
    message: { error: 'Too many requests. Please slow down.' }
});

// The public probes are unauthenticated by necessity — an orchestrator cannot
// hold a token. This bound keeps them from being used as a free amplification
// endpoint; it is deliberately loose enough for aggressive probe intervals.
const healthLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Too many health probes.' }
});

module.exports = {
    loginLimiter,
    loginIpLimiter,
    loginAccountLimiter,
    aiLimiter,
    syncLimiter,
    globalApiLimiter,
    healthLimiter
};
