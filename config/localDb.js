const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../dashboard.sqlite');
const localDb = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening local SQLite database', err.message);
    } else {
        console.log('Connected to the local SQLite database.');
        initDb();
    }
});

function initDb() {
    localDb.serialize(() => {
        // Users table
        localDb.run(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT
            )
        `);

        // Chat History
        localDb.run(`
            CREATE TABLE IF NOT EXISTS dashboard_chat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sql_used TEXT,
                created_at DATETIME DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        `);

        // Workflow Entity Replica
        localDb.run(`
            CREATE TABLE IF NOT EXISTS workflow_entity (
                id TEXT PRIMARY KEY,
                name TEXT,
                active BOOLEAN
            )
        `);

        // Workflow Settings (ROI)
        localDb.run(`
            CREATE TABLE IF NOT EXISTS workflow_settings (
                workflow_id TEXT PRIMARY KEY,
                saved_time_seconds INTEGER DEFAULT 0,
                hourly_rate REAL DEFAULT 0,
                FOREIGN KEY (workflow_id) REFERENCES workflow_entity (id) ON DELETE CASCADE
            )
        `);

        // Migration: add hourly_rate if it doesn't exist
        localDb.run(`ALTER TABLE workflow_settings ADD COLUMN hourly_rate REAL DEFAULT 0`, (err) => {
            // Silence the duplicate column error on startup
        });

        // Execution Entity Replica
        localDb.run(`
            CREATE TABLE IF NOT EXISTS execution_entity (
                id INTEGER PRIMARY KEY,
                "workflowId" TEXT,
                status TEXT,
                "startedAt" DATETIME,
                "stoppedAt" DATETIME
            )
        `);
    });
}

// Convert callback based queries to promises for easier async/await usage
localDb.query = function (sql, params = []) {
    return new Promise((resolve, reject) => {
        this.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                // To keep compatibility with pg structure expecting `rows`
                resolve({ rows });
            }
        });
    });
};

localDb.execute = function (sql, params = []) {
    return new Promise((resolve, reject) => {
        this.run(sql, params, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(this);
            }
        });
    });
};

module.exports = localDb;
