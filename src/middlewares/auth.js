const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET;

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
