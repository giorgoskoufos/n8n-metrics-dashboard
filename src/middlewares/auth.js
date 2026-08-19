const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET;

// Fail at boot rather than at the first login. A missing secret makes jwt.sign()
// throw on every request; a short one is brute-forceable offline from a single
// captured token, which lets an attacker mint tokens for any user.
const MIN_SECRET_LENGTH = 32;
if (!JWT_SECRET) {
    throw new Error(
        'DASHBOARD_JWT_SECRET is not set. Generate one with: openssl rand -base64 48'
    );
}
if (JWT_SECRET.length < MIN_SECRET_LENGTH) {
    throw new Error(
        `DASHBOARD_JWT_SECRET is too short (${JWT_SECRET.length} chars, minimum ${MIN_SECRET_LENGTH}). ` +
        'Generate one with: openssl rand -base64 48'
    );
}

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // reads "Bearer TOKEN"

    if (!token) return res.status(401).json({ error: 'Authentication required (Missing Token)' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
};

// n8n 2.x role slugs. Anything else ('global:member', project-scoped roles) is
// treated as unprivileged.
const ELEVATED_ROLES = new Set(['global:owner', 'global:admin']);

/**
 * Gate for actions that cost the production n8n instance real work, such as
 * forcing a full ETL pass.
 *
 * Fails OPEN when the role is unknown. n8n 1.x has no roleSlug column, so login
 * stores null and there is genuinely no way to tell an owner from a member —
 * denying there would take a working feature away from every user on that
 * version. The per-user rate limit is what bounds the abuse; this is defence in
 * depth on top of it, not the only control.
 */
const requireElevatedRole = (req, res, next) => {
    const role = req.user && req.user.role;
    if (!role) return next();
    if (ELEVATED_ROLES.has(role)) return next();

    console.warn(`[AUTH] Elevated action refused for role "${role}" (user ${req.user.id})`);
    return res.status(403).json({
        error: 'Only n8n owners and admins can trigger this action.'
    });
};

module.exports = { authenticateToken, requireElevatedRole, JWT_SECRET };
