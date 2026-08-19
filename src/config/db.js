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
// A query with no timeout can hold a connection open indefinitely against the
// production n8n database — a lock, a stalled network, one pathological plan.
// The ETL is a background job: it can always try again in five minutes, so
// failing fast is strictly better than hanging. Generous by default, because the
// first-boot sync legitimately reads fourteen days in one statement.
poolConfig.statement_timeout = Number(process.env.DASHBOARD_DB_STATEMENT_TIMEOUT_MS) || 60_000;

// Bounded so a stalled handshake surfaces as an error instead of a hung sync.
poolConfig.connectionTimeoutMillis =
    Number(process.env.DASHBOARD_DB_CONNECT_TIMEOUT_MS) || 15_000;

const pool = new Pool(poolConfig);

module.exports = { pool };
