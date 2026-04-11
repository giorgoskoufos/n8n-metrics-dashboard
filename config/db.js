const { Pool } = require('pg');
require('dotenv').config();

// 2A. Main Database Pool
let poolConfig = {};
if (process.env.DASHBOARD_DATABASE_URL) {
    poolConfig = { connectionString: process.env.DASHBOARD_DATABASE_URL };
} else {
    poolConfig = {
        user: process.env.DASHBOARD_DB_USER,
        host: process.env.DASHBOARD_DB_HOST,
        database: process.env.DASHBOARD_DB_NAME,
        password: process.env.DASHBOARD_DB_PASS,
        port: process.env.DASHBOARD_DB_PORT,
    };
}
const pool = new Pool(poolConfig);

// 2B. AI Read-Only Database Pool
const aiPool = new Pool({
    connectionString: process.env.AI_DB_URL
});

module.exports = { pool, aiPool };
