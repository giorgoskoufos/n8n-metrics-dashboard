const { pool } = require('./db');
const localDb = require('./localDb');
const fs = require('fs');
const { parse } = require('flatted');

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
        const errorIds = new Set(); // Track new errors

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
                    if (e.status === 'error' || e.status === 'crashed') {
                        errorIds.add(e.id);
                    }
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
                if (e.status === 'error' || e.status === 'crashed') {
                    errorIds.add(e.id);
                }
            }
            await localDb.execute('COMMIT');
        }
        console.log(`[SYNC] Synced ${newExecs.rows.length} new executions.`);

        // 3. Update Concurrency Stats (UTC Standardized)
        await updateConcurrencyStats();

        // 4. Sync Deep Error Analytics
        if (errorIds.size > 0) {
            await syncErrorAnalytics(Array.from(errorIds));
        }

    } catch (err) {
        console.error('[SYNC] Sync Error:', err);
        try { await localDb.execute('ROLLBACK'); } catch (e) { }
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

const SAVE_DEBUG_ERRORS = process.env.SAVE_DEBUG_ERRORS === 'true'; // Controlled by .env flag

async function syncErrorAnalytics(errorIdsArray) {
    if (!errorIdsArray || errorIdsArray.length === 0) return;
    console.log(`[SYNC] Fetching raw traces for ${errorIdsArray.length} errors...`);

    try {
        const query = `
            SELECT d.data, e."workflowId" AS workflow_id, e."startedAt", e.id as exec_id
            FROM execution_data d
            JOIN execution_entity e ON d."executionId" = e.id
            WHERE d."executionId" = ANY($1)
        `;
        const result = await pool.query(query, [errorIdsArray]);

        const analyticsData = [];

        await localDb.execute('BEGIN TRANSACTION');

        for (let row of result.rows) {
            const dataStr = row.data;
            if (!dataStr) continue;

            let fullData;
            try {
                // n8n compresses or stores execution data weirdly depending on version, parsing safely
                fullData = typeof dataStr === 'string' ? parse(dataStr) : dataStr;
                if (fullData && typeof fullData === 'object' && fullData.data) {
                    if (typeof fullData.data === 'string') {
                        // Some versions base64 encode or double json stringify
                        try { fullData = parse(fullData.data); } catch (e) { }
                    }
                }
            } catch (e) {
                console.error(`[SYNC] Failed to parse data for execution ${row.exec_id}`);
                continue;
            }

            let errorMessage = "Unknown error detail";
            let nodeName = "Unknown Node";
            let nodeType = "Unknown Type";
            let nodeId = "";
            let errorType = "";
            let errorStack = "";
            let sourceNode = "";
            let sourceOutputIndex = null;
            let executionSource = "";
            let inputData = "";
            let metadataJson = "";

            if (fullData && fullData.resultData) {
                const rootErr = fullData.resultData.error;
                errorMessage = rootErr?.description || rootErr?.message || errorMessage;
                nodeName = fullData.resultData.lastNodeExecuted || rootErr?.node?.name || nodeName;
                nodeType = rootErr?.node?.type || nodeType;
                nodeId = rootErr?.node?.id || "";
                errorType = rootErr?.name || "";
                errorStack = rootErr?.stack || "";

                // Try to find executionSource
                executionSource = fullData.executionData?.runtimeData?.source || "";

                // Extract metadata
                if (fullData.executionData?.metadata) {
                    try { metadataJson = JSON.stringify(fullData.executionData.metadata); } catch (e) { }
                }

                // Attempt to find the source node and branch
                if (fullData.executionData?.nodeExecutionStack) {
                    const stack = fullData.executionData.nodeExecutionStack;
                    if (stack && stack.length > 0) {
                        const lastFrame = stack[stack.length - 1];

                        // Grab input data that led to the crash
                        if (lastFrame?.data) {
                            try { inputData = JSON.stringify(lastFrame.data); } catch (e) { }
                        }

                        if (lastFrame?.source?.main && lastFrame.source.main.length > 0) {
                            const sourceObj = lastFrame.source.main[0];
                            if (sourceObj) {
                                sourceNode = sourceObj.previousNode || "";
                                sourceOutputIndex = sourceObj.previousNodeOutput !== undefined ? sourceObj.previousNodeOutput : null;
                            }
                        }
                    }
                }
            } else if (fullData && fullData[0]) {
                const root = fullData[0];
                errorMessage = root.resultData?.error?.description || root.resultData?.error?.message || root.error?.description || root.error?.message || root.message || errorMessage;
                nodeName = root.resultData?.lastNodeExecuted || root.resultData?.error?.node?.name || root.error?.node?.name || nodeName;
                nodeType = root.resultData?.error?.node?.type || root.error?.node?.type || nodeType;
                nodeId = root.resultData?.error?.node?.id || root.error?.node?.id || "";
                errorType = root.resultData?.error?.name || root.error?.name || "";
                errorStack = root.resultData?.error?.stack || root.error?.stack || "";

                executionSource = root.executionData?.runtimeData?.source || "";
                if (root.executionData?.metadata) {
                    try { metadataJson = JSON.stringify(root.executionData.metadata); } catch (e) { }
                }

                if (root.executionData?.nodeExecutionStack) {
                    const lastFrame = root.executionData.nodeExecutionStack[root.executionData.nodeExecutionStack.length - 1];
                    if (lastFrame?.data) {
                        try { inputData = JSON.stringify(lastFrame.data); } catch (e) { }
                    }
                }
            }

            // Fallback for timestamp
            const startedStr = row.startedAt ? row.startedAt.toISOString() : new Date().toISOString();

            const payload = {
                id: row.exec_id,
                workflow_id: row.workflow_id,
                node_id: nodeId,
                node_name: nodeName,
                node_type: nodeType,
                error_type: errorType,
                error_message: errorMessage,
                error_stack: errorStack,
                source_node: sourceNode,
                source_output: sourceOutputIndex,
                input_data: inputData,
                metadata: metadataJson,
                execution_source: executionSource,
                started_at: startedStr
            };

            // For debug purposes, add the raw data to the export list if flag is on
            if (SAVE_DEBUG_ERRORS) {
                analyticsData.push({ ...payload, rawTrace: fullData });
            } else {
                analyticsData.push(payload);
            }

            // Insert into SQLite
            await localDb.execute(
                `INSERT INTO execution_error_analytics 
                 (id, workflow_id, node_id, node_name, node_type, error_type, error_message, error_stack, source_node, source_output_index, input_data, metadata, execution_source, timestamp) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET 
                 node_id=excluded.node_id,
                 node_name=excluded.node_name, 
                 node_type=excluded.node_type, 
                 error_type=excluded.error_type,
                 error_message=excluded.error_message, 
                 error_stack=excluded.error_stack,
                 source_node=excluded.source_node, 
                 source_output_index=excluded.source_output_index, 
                 input_data=excluded.input_data,
                 metadata=excluded.metadata,
                 execution_source=excluded.execution_source`,
                [
                    row.exec_id,
                    row.workflow_id,
                    nodeId,
                    nodeName,
                    nodeType,
                    errorType,
                    errorMessage,
                    errorStack,
                    sourceNode,
                    sourceOutputIndex,
                    inputData,
                    metadataJson,
                    executionSource,
                    startedStr
                ]
            );
        }

        await localDb.execute('COMMIT');
        console.log(`[SYNC] Error Analytics updated for ${analyticsData.length} records.`);

        // Debug Export
        if (SAVE_DEBUG_ERRORS && analyticsData.length > 0) {
            const outPath = require('path').resolve(__dirname, '../scratch/debug_errors.json');
            fs.writeFileSync(outPath, JSON.stringify(analyticsData, null, 2));
            console.log(`[SYNC] Raw debug export saved to scratch/debug_errors.json`);
        }

    } catch (e) {
        console.error('[SYNC] Failed to map error analytics:', e);
        try { await localDb.execute('ROLLBACK'); } catch (err) { }
    }
}

module.exports = { syncData, updateConcurrencyStats, syncErrorAnalytics };
