const { pool } = require('./config/db');
require('dotenv').config();

async function debug() {
    const lookback = '24 hours';
    const targetWorkflow = 'Chat Queue Alerts';
    
    // Test 1: Baseline (All 24h)
    const q1 = `SELECT count(*) as total FROM execution_entity WHERE "startedAt" > NOW() - INTERVAL '${lookback}'`;
    const r1 = await pool.query(q1);
    console.log(`24h Total (All): ${r1.rows[0].total}`);

    // Test 2: Filtered (Workflow name)
    const q2 = `
        SELECT count(*) as total 
        FROM execution_entity e
        JOIN workflow_entity w ON e."workflowId" = w.id
        WHERE e."startedAt" > NOW() - INTERVAL '${lookback}'
        AND w.name = $1
    `;
    const r2 = await pool.query(q2, [targetWorkflow]);
    console.log(`24h Total (${targetWorkflow}): ${r2.rows[0].total}`);

    // Test 3: Total unfiltered
    const q3 = `SELECT count(*) as total FROM execution_entity`;
    const r3 = await pool.query(q3);
    console.log(`Absolute Total in DB: ${r3.rows[0].total}`);

    process.exit();
}

debug();
