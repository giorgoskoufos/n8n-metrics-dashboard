require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Database connection setup (same logic as server.js)
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

async function fetchError() {
    const targetExecutionId = 325584; // The ID we want to analyze
    
    try {
        console.log(`🔍 Connecting to database and fetching data for ID: ${targetExecutionId}...`);
        
        // Careful with double quotes on "executionId" due to Postgres camelCase
        const query = 'SELECT data FROM execution_data WHERE "executionId" = $1';
        const res = await pool.query(query, [targetExecutionId]);
        
        if (res.rows.length === 0) {
            console.error("❌ Execution ID not found in database!");
            process.exit(1);
        }

        const rawData = res.rows[0].data;

        // Create public folder if it doesn't exist (just in case)
        const publicDir = path.join(__dirname, 'public');
        if (!fs.existsSync(publicDir)){
            fs.mkdirSync(publicDir);
        }

        // Save to public/error_payload.txt
        const filePath = path.join(publicDir, 'error_325584.txt');
        fs.writeFileSync(filePath, rawData);
        
        console.log('--------------------------------------------------');
        console.log('✅ FILE CREATED SUCCESSFULLY!');
        console.log(`📍 Location: ${filePath}`);
        console.log(`🌐 Download from: http://<SERVER-IP>:3000/error_325584.txt`);
        console.log('--------------------------------------------------');

    } catch (err) {
        console.error("❌ Execution error:", err.message);
    } finally {
        await pool.end();
        process.exit();
    }
}

fetchError();