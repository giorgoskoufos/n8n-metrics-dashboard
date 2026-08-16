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

module.exports = { authenticateToken, JWT_SECRET };
