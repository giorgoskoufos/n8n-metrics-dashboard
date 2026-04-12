const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { JWT_SECRET } = require('../middlewares/auth');

exports.login = async (req, res) => {
    const { email, password } = req.body;

    try {
        const query = 'SELECT id, email, password, "firstName", "lastName" FROM "user" WHERE email = $1';
        const dbRes = await pool.query(query, [email]);

        if (dbRes.rows.length === 0) {
            return res.status(401).json({ error: 'Wrong Credentials' });
        }

        const user = dbRes.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ error: 'Wrong Credentials' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, firstName: user.firstName }, 
            JWT_SECRET, 
            { expiresIn: '8h' }
        );

        // Replicate user to SQLite for local dashboard reference
        const localDb = require('../config/localDb');
        await localDb.execute(
            'INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET email=excluded.email',
            [user.id, user.email]
        );

        res.json({ 
            message: 'Sucessful Login!', 
            token: token,
            user: { firstName: user.firstName, lastName: user.lastName, email: user.email }
        });

    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Internal server error during login' });
    }
};
