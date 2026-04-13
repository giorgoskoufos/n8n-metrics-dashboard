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

        // 2. Sync Executions
        // PHASE A: Re-sync existing "running" executions to catch their completion
        const runningExecs = await localDb.query("SELECT id FROM execution_entity WHERE status = 'running'");
        if (runningExecs.rows.length > 0) {
            const runningIds = runningExecs.rows.map(r => r.id);
            console.log(`[SYNC] Re-checking status for ${runningIds.length} active executions...`);
            
            // Query Postgres for the current state of these specific executions
            const updatedExecs = await pool.query(
                `SELECT id, status, "stoppedAt" FROM execution_entity WHERE id = ANY($1)`,
                [runningIds]
            );

            if (updatedExecs.rows.length > 0) {
                await localDb.execute('BEGIN TRANSACTION');
                for (let e of updatedExecs.rows) {
                    const stoppedStr = e.stoppedAt ? e.stoppedAt.toISOString() : null;
                    await localDb.execute(
                        'UPDATE execution_entity SET status = ?, "stoppedAt" = ? WHERE id = ?',
                        [e.status, stoppedStr, e.id]
                    );
                }
                await localDb.execute('COMMIT');
            }
        }

        // PHASE B: Incremental Sync for new executions
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

        // 3. Update Concurrency Stats (UTC Standardized)
        await updateConcurrencyStats();

    } catch (err) {
        console.error('[SYNC] Sync Error:', err);
        try { await localDb.execute('ROLLBACK'); } catch(e){}
    } finally {
        isSyncing = false;
    }
}

async function updateConcurrencyStats() {
    try {
        console.log('[SYNC] Re-calculating concurrency stats using Node.js temporal engine...');
        
        // 1. Generate 5-minute buckets for the last 24 hours in JS
        const now = new Date();
        const buckets = [];
        for (let i = 0; i < 288; i++) { // 288 slots of 5 mins = 24h
            const t = new Date(now.getTime() - (i * 5 * 60 * 1000));
            // Round to nearest 5 mins
            t.setSeconds(0, 0);
            t.setMinutes(Math.floor(t.getMinutes() / 5) * 5);
            buckets.push(t.toISOString());
        }
        buckets.reverse(); // Oldest first

        // 2. Fetch all potentially relevant executions (started within last 30h to catch overlaps)
        const lookback = new Date(now.getTime() - (30 * 60 * 60 * 1000)).toISOString();
        const execs = await localDb.query(`
            SELECT datetime("startedAt") as sAt, 
                   IFNULL(datetime("stoppedAt"), '') as stAt, 
                   status 
            FROM execution_entity 
            WHERE datetime("startedAt") >= datetime(?) OR "stoppedAt" IS NULL
        `, [lookback]);

        const execData = execs.rows.map(e => ({
            sAt: new Date(e.sAt + 'Z'),
            stAt: e.stAt ? new Date(e.stAt + 'Z') : null,
            status: e.status
        }));

        // 3. Calculate execution volume in JS (Count starts within bucket)
        const stats = buckets.map((bTime, index) => {
            const bDate = new Date(bTime);
            const nextBDate = new Date(bDate.getTime() + 5 * 60 * 1000);
            
            const count = execData.filter(e => {
                // Count if the execution STARTED within this 5-minute window
                return e.sAt >= bDate && e.sAt < nextBDate;
            }).length;
            
            return { timestamp: bTime, active_count: count }; // We keep the column name 'active_count' for DB compatibility
        });

        // 4. Batch Insert (using transaction)
        await localDb.execute('BEGIN TRANSACTION');
        await localDb.execute('DELETE FROM concurrency_stats WHERE timestamp < ?', [buckets[0]]);
        for (const s of stats) {
            await localDb.execute(
                'INSERT OR REPLACE INTO concurrency_stats (timestamp, active_count) VALUES (?, ?)',
                [s.timestamp, s.active_count]
            );
        }
        await localDb.execute('COMMIT');
        
        console.log(`[SYNC] Concurrency stats updated for ${buckets.length} intervals.`);
    } catch (err) {
        console.error('[SYNC] Concurrency Update Error:', err);
    }
}

module.exports = { syncData };
