const { pool } = require('./db');
const localDb = require('./localDb');

let isSyncing = false;

async function syncData(force = false) {
    if (isSyncing) {
        console.log('[SYNC] Sync already running. Skipping concurrent request.');
        return;
    }
    isSyncing = true;
    console.log('[SYNC] Starting ETL Sync...');
    try {
        // 1. Sync Workflows (Full Sync for active/names is lightweight enough)
        const workflows = await pool.query('SELECT id, name, active FROM workflow_entity');
        for (let w of workflows.rows) {
            await localDb.execute(
                `INSERT INTO workflow_entity (id, name, active) VALUES (?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, active=excluded.active`,
                [w.id, w.name, w.active]
            );
        }
        console.log(`[SYNC] Synced ${workflows.rows.length} workflows.`);

        // 2. Sync Executions (Incremental)
        let lastIdObj = await localDb.query('SELECT MAX(id) as max_id FROM execution_entity');
        let lastId = lastIdObj.rows[0].max_id;
        
        let execQuery = '';
        let params = [];
        
        if (!lastId) {
            // First time boot sync (last 14 days)
            console.log('[SYNC] Initial Boot: Fetching last 14 days of executions.');
            execQuery = `
                SELECT id, "workflowId", status, "startedAt", "stoppedAt" 
                FROM execution_entity 
                WHERE "startedAt" > NOW() - INTERVAL '14 days'
                ORDER BY id ASC
            `;
        } else {
            // Incremental
            console.log(`[SYNC] Incremental Sync since execution_entity id: ${lastId}`);
            execQuery = `
                SELECT id, "workflowId", status, "startedAt", "stoppedAt" 
                FROM execution_entity 
                WHERE id > $1
                ORDER BY id ASC
            `;
            params = [lastId];
        }

        const newExecs = await pool.query(execQuery, params);
        
        // Execute inserts in a transaction for speed
        if (newExecs.rows.length > 0) {
            await localDb.execute('BEGIN TRANSACTION');
            for (let e of newExecs.rows) {
                // SQLite dates should be standard ISO strings for internal functions to work
                const startedStr = e.startedAt ? e.startedAt.toISOString() : null;
                const stoppedStr = e.stoppedAt ? e.stoppedAt.toISOString() : null;

                await localDb.execute(
                    `INSERT INTO execution_entity (id, "workflowId", status, "startedAt", "stoppedAt") 
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET status=excluded.status, "stoppedAt"=excluded."stoppedAt"`,
                    [e.id, e.workflowId, e.status, startedStr, stoppedStr]
                );
            }
            await localDb.execute('COMMIT');
        }
        console.log(`[SYNC] Synced ${newExecs.rows.length} new executions.`);

    } catch (err) {
        console.error('[SYNC] Sync Error:', err);
        try { await localDb.execute('ROLLBACK'); } catch(e){}
    } finally {
        isSyncing = false;
    }
}

module.exports = { syncData };
