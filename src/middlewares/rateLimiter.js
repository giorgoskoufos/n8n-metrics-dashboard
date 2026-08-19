const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts, please try again later.' }
});

const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
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
    keyGenerator: (req) =>
        req.user && req.user.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip),
    message: { error: 'Sync can be triggered at most twice per minute. Please wait.' }
});

// The public probes are unauthenticated by necessity — an orchestrator cannot
// hold a token. This bound keeps them from being used as a free amplification
// endpoint; it is deliberately loose enough for aggressive probe intervals.
const healthLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Too many health probes.' }
});

module.exports = { loginLimiter, aiLimiter, syncLimiter, healthLimiter };
