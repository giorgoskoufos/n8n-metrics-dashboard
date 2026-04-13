const { pool } = require('../config/db');
const localDb = require('../config/localDb');
const { parse } = require('flatted');

exports.getMetrics = async (req, res) => {
    try {
        const targetWorkflow = req.query.workflow; 
        const timeRange = req.query.timeRange || '24h'; 

        let intervalOffset = '-23 hours';
        let lookback = '-24 hours';
        let prevLookbackEnd = '-24 hours';
        let prevLookbackStart = '-48 hours';
        let step = '+1 hour';
        let truncUnitFormat = '%Y-%m-%d %H:00:00';

        if (timeRange === '48h') {
            intervalOffset = '-47 hours';
            lookback = '-48 hours';
            prevLookbackEnd = '-48 hours';
            prevLookbackStart = '-96 hours';
        } else if (timeRange === '7d') {
            intervalOffset = '-6 days';
            lookback = '-7 days';
            prevLookbackEnd = '-7 days';
            prevLookbackStart = '-14 days';
            truncUnitFormat = '%Y-%m-%d 00:00:00'; 
            step = '+1 day';
        }

        const statsQuery = `
            SELECT COUNT(*) as total, 
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
                   AVG((julianday("stoppedAt") - julianday("startedAt")) * 86400) as avg_duration
            FROM execution_entity e
            ${targetWorkflow ? 'JOIN workflow_entity w ON e."workflowId" = w.id' : ''}
            WHERE datetime(e."startedAt") > datetime('now', '${lookback}')
            ${targetWorkflow ? 'AND w.name = ?' : ''};
        `;

        const prevStatsQuery = `
            SELECT COUNT(*) as total, 
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
            FROM execution_entity e
            ${targetWorkflow ? 'JOIN workflow_entity w ON e."workflowId" = w.id' : ''}
            WHERE datetime(e."startedAt") > datetime('now', '${prevLookbackStart}')
              AND datetime(e."startedAt") <= datetime('now', '${prevLookbackEnd}')
            ${targetWorkflow ? 'AND w.name = ?' : ''};
        `;

        let queryParams = [];
        if (targetWorkflow) queryParams.push(targetWorkflow);

        // Generate hourly buckets for the last 24h/48h/7d in JS
        const now = new Date();
        const buckets = [];
        let bucketCount = 24;
        let stepMs = 3600000; // 1 hour
        if (timeRange === '48h') bucketCount = 48;
        if (timeRange === '7d') { bucketCount = 7; stepMs = 86400000; }

        for (let i = 0; i < bucketCount; i++) {
            const t = new Date(now.getTime() - (i * stepMs));
            if (timeRange === '7d') t.setHours(0, 0, 0, 0);
            else t.setMinutes(0, 0, 0);
            buckets.push(t.toISOString());
        }
        buckets.reverse();

        const topWorkflowsQuery = `
            SELECT w.name AS workflow_name, COUNT(e.id) AS execution_count,
                   ROUND((COUNT(e.id) * 100.0 / (SELECT COUNT(*) FROM execution_entity WHERE datetime("startedAt") > datetime('now', '${lookback}'))), 2) AS percentage
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE datetime(e."startedAt") > datetime('now', '${lookback}')
            GROUP BY w.id, w.name
            ORDER BY execution_count DESC;
        `;

        const [stats, prevStats, execs, topWorkflows] = await Promise.all([
            localDb.query(statsQuery, queryParams),
            localDb.query(prevStatsQuery, queryParams),
            localDb.query(`
                SELECT status, "startedAt" 
                FROM execution_entity 
                WHERE datetime("startedAt") > datetime('now', ?)
                ${targetWorkflow ? 'AND "workflowId" = (SELECT id FROM workflow_entity WHERE name = ?)' : ''}
            `, [lookback, ...(targetWorkflow ? [targetWorkflow] : [])]), 
            localDb.query(topWorkflowsQuery)
        ]);

        // Map executions into buckets
        const hourly = buckets.map(bTime => {
            const bStart = new Date(bTime);
            const bEnd = new Date(bStart.getTime() + stepMs);
            
            const matches = execs.rows.filter(e => {
                const sAt = new Date(e.startedAt + (e.startedAt.endsWith('Z') ? '' : 'Z'));
                return sAt >= bStart && sAt < bEnd;
            });

            return {
                time_val: bTime,
                success_count: matches.filter(m => m.status === 'success').length,
                error_count: matches.filter(m => m.status !== 'success').length
            };
        });

        const currentTotal = stats.rows[0].total || 0;
        const currentError = stats.rows[0].error || 0;
        const prevTotal = prevStats.rows[0].total || 0;
        const prevError = prevStats.rows[0].error || 0;

        let trend_total_pct = 0;
        let trend_error_pct = 0;

        if (prevTotal > 0) trend_total_pct = ((currentTotal - prevTotal) / prevTotal) * 100;
        if (prevTotal === 0 && currentTotal > 0) trend_total_pct = 100;
        
        if (prevError > 0) trend_error_pct = ((currentError - prevError) / prevError) * 100;
        if (prevError === 0 && currentError > 0) trend_error_pct = 100;

        // Active-Bucket Extrapolation -> Normalize the final interval drop-off on line charts
        if (hourly.length > 2) {
            const lastRow = hourly[hourly.length - 1];
            const p1 = hourly[hourly.length - 2].success_count || 0;
            const p2 = hourly[hourly.length - 3].success_count || 0;
            const avgPrevious = (p1 + p2) / 2.0;

            const now = new Date();
            
            if (timeRange === '7d') {
                const hoursPassed = now.getHours() + (now.getMinutes() / 60.0);
                if (hoursPassed > 0 && hoursPassed < 23) {
                    const factor = hoursPassed > 4 ? (24.0 / hoursPassed) : null;
                    if (!factor) lastRow.success_count = Math.round(avgPrevious);
                    else {
                        const projected = lastRow.success_count * factor;
                        lastRow.success_count = Math.round((projected + avgPrevious) / 2);
                    }
                }
            } else {
                const minsPassed = now.getMinutes();
                if (minsPassed > 0 && minsPassed < 58) {
                    const factor = minsPassed > 5 ? (60.0 / minsPassed) : null;
                    if (!factor) lastRow.success_count = Math.round(avgPrevious);
                    else {
                        const projected = lastRow.success_count * factor;
                        lastRow.success_count = Math.round((projected + avgPrevious) / 2);
                    }
                }
            }
        }

        res.json({
            summary: { ...stats.rows[0], trend_total_pct, trend_error_pct },
            hourlyData: hourly,
            topWorkflows: topWorkflows.rows 
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getExecutions = async (req, res) => {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    
    try {
        const query = `
            SELECT w.name, e.status, e."startedAt", e.id as exec_id,
                   (julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400 as duration
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE e."startedAt" IS NOT NULL AND e."stoppedAt" IS NOT NULL
            ORDER BY datetime(e."startedAt") DESC
            LIMIT ? OFFSET ?;
        `;
        const result = await localDb.query(query, [limit, offset]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getSlowest = async (req, res) => {
    try {
        const query = `
            SELECT w.name, 
                   AVG((julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400) as avg_duration,
                   COUNT(e.id) as total_runs
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE datetime(e."startedAt") > datetime('now', '-7 days')
              AND e."stoppedAt" IS NOT NULL
            GROUP BY w.id, w.name
            ORDER BY avg_duration DESC
            LIMIT 10;
        `;
        const result = await localDb.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getErrors = async (req, res) => {
    try {
        const query = `
            SELECT w.name, 
                   SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END) as error_count,
                   COUNT(e.id) as total_runs
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE datetime(e."startedAt") > datetime('now', '-7 days')
            GROUP BY w.id, w.name
            HAVING SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END) > 0
            ORDER BY error_count DESC
            LIMIT 10;
        `;
        const result = await localDb.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getExecutionError = async (req, res) => {
    // Left on Postgres directly since execution payloads can be megabytes/gigabytes. No ETL sync.
    try {
        const query = `
            SELECT d.data, e."workflowId" AS workflow_id 
            FROM execution_data d
            JOIN execution_entity e ON d."executionId" = e.id
            WHERE d."executionId" = $1
        `;
        const result = await pool.query(query, [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No data found' });
        }

        const fullData = parse(result.rows[0].data);
        const workflowId = result.rows[0].workflow_id; 
        
        let errorMessage = "Unknown error detail";
        let nodeName = "Unknown Node";

        if (fullData && fullData.resultData) {
            errorMessage = fullData.resultData.error?.description || fullData.resultData.error?.message;
            nodeName = fullData.resultData.lastNodeExecuted || fullData.resultData.error?.node?.name;
        } else if (fullData && fullData[0]) {
            const root = fullData[0];
            errorMessage = 
                (root.resultData?.error?.description) || 
                (root.resultData?.error?.message) || 
                (root.error?.description) ||
                (root.error?.message) ||
                (root.message);
            nodeName = root.resultData?.lastNodeExecuted || root.resultData?.error?.node?.name || root.error?.node?.name;
        }

        const finalUrl = process.env.N8N_EDITOR_BASE_URL || 'MISSING_ENV';
        const finalWfId = workflowId || 'MISSING_ID';

        const payload = { 
            executionId: req.params.id,
            nodeName: nodeName || "Unknown Node",
            message: errorMessage || "Unknown error detail",
            workflowId: finalWfId, 
            n8nBaseUrl: finalUrl
        };

        if (req.query.full === 'true') {
            payload.fullError = JSON.stringify(fullData, null, 2);
        }

        res.json(payload);
    } catch (err) {
        console.error('Parsing Error:', err);
        res.status(500).json({ error: 'Failed to parse error data' });
    }
};

exports.forceSync = async (req, res) => {
    const { syncData } = require('../config/syncJob');
    try {
        await syncData(true);
        res.json({ message: 'Sync Complete' });
    } catch(err) {
        res.status(500).json({ error: 'Force Sync Failed' });
    }
};

// --- INSIGHTS & ROI METHODS ---

exports.getN8nHealth = async (req, res) => {
    try {
        const baseUrl = process.env.N8N_EDITOR_BASE_URL;
        if (!baseUrl) return res.status(500).json({ status: 'error', message: 'N8N_EDITOR_BASE_URL not configured' });
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);
        
        const response = await fetch(`${baseUrl}/healthz`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const data = await response.json();
            if (data.status === 'ok') {
                return res.json({ status: 'ok' });
            }
        }
        res.status(500).json({ status: 'error' });
    } catch (err) {
        res.status(500).json({ status: 'error' });
    }
};

exports.getSettings = async (req, res) => {
    try {
        const query = `
            SELECT 
                w.id, 
                w.name, 
                COALESCE(s.saved_time_seconds, 0) as saved_time_seconds,
                COALESCE(s.hourly_rate, 0) as hourly_rate,
                COUNT(e.id) as execution_count,
                SUM(CASE WHEN e.status = 'success' AND datetime(e."startedAt") >= datetime('now', '-30 days', 'localtime') THEN 1 ELSE 0 END) as executions_30d
            FROM workflow_entity w
            LEFT JOIN workflow_settings s ON w.id = s.workflow_id
            LEFT JOIN execution_entity e ON w.id = e."workflowId" AND e.status = 'success'
            GROUP BY w.id, w.name, s.saved_time_seconds, s.hourly_rate
            ORDER BY w.name ASC
        `;
        const result = await localDb.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching settings' });
    }
};

exports.updateSettings = async (req, res) => {
    const { settings } = req.body; 
    if (!settings || !Array.isArray(settings)) return res.status(400).json({ error: 'Invalid settings payload' });
    
    try {
        await localDb.execute('BEGIN TRANSACTION');
        for (const s of settings) {
            await localDb.execute(
                `INSERT INTO workflow_settings (workflow_id, saved_time_seconds, hourly_rate) 
                 VALUES (?, ?, ?) 
                 ON CONFLICT(workflow_id) DO UPDATE SET saved_time_seconds=excluded.saved_time_seconds, hourly_rate=excluded.hourly_rate`, 
                 [s.workflow_id, s.saved_time_seconds, s.hourly_rate || 0]
            );
        }
        await localDb.execute('COMMIT');
        res.json({ message: 'Settings saved' });
    } catch (err) {
        try { await localDb.execute('ROLLBACK'); } catch(e){}
        console.error(err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
};

exports.getRoiMetrics = async (req, res) => {
    try {
        const { timeRange } = req.query;
        let timeFilter = "";
        
        if (timeRange && timeRange !== 'all') {
            const now = new Date();
            let lookbackHours = 24;
            if (timeRange === '48h') lookbackHours = 48;
            if (timeRange === '7d') lookbackHours = 168;
            if (timeRange === '30d') lookbackHours = 720;
            
            const pastDateStr = new Date(now.getTime() - (lookbackHours * 60 * 60 * 1000)).toISOString();
            // Using e."startedAt", since datetime(e."startedAt") is used in getMetrics
            timeFilter = ` AND datetime(e."startedAt") >= datetime('${pastDateStr}')`;
        }

        const totalQuery = `
            SELECT 
                COUNT(e.id) as total_executions,
                SUM(COALESCE(s.saved_time_seconds, 0)) as total_time_saved_seconds,
                SUM((COALESCE(s.saved_time_seconds, 0) / 3600.0) * COALESCE(s.hourly_rate, 0)) as total_money_saved
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            LEFT JOIN workflow_settings s ON w.id = s.workflow_id
            WHERE e.status = 'success'${timeFilter}
        `;
        
        const workflowsQuery = `
            SELECT 
                w.name,
                COUNT(e.id) as executions,
                (COUNT(e.id) * COALESCE(s.saved_time_seconds, 0)) as time_saved_seconds,
                (COUNT(e.id) * (COALESCE(s.saved_time_seconds, 0) / 3600.0) * COALESCE(s.hourly_rate, 0)) as money_saved
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            LEFT JOIN workflow_settings s ON w.id = s.workflow_id
            WHERE e.status = 'success'${timeFilter}
            GROUP BY w.id, w.name, s.saved_time_seconds, s.hourly_rate
            HAVING time_saved_seconds > 0
            ORDER BY time_saved_seconds DESC
        `;
        
        const [totalStats, wfStats] = await Promise.all([
            localDb.query(totalQuery),
            localDb.query(workflowsQuery)
        ]);

        res.json({
            summary: totalStats.rows[0],
            topWorkflows: wfStats.rows
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching ROI metrics' });
    }
};

exports.getConcurrencyData = async (req, res) => {
    try {
        const { start, end } = req.query;

        // Default behavior: Rolling 24 hours from cache
        if (!start || !end) {
            const query = `
                SELECT timestamp, active_count 
                FROM concurrency_stats 
                ORDER BY timestamp ASC 
                LIMIT 1000
            `;
            const result = await localDb.query(query);
            return res.json(result.rows);
        }

        // Specific Date behavior: Calculate 288 buckets locally
        const startTimeMs = new Date(start).getTime();
        const endTimeMs = new Date(end).getTime();

        if (isNaN(startTimeMs) || isNaN(endTimeMs)) {
            return res.status(400).json({ error: 'Invalid start or end date' });
        }

        // Fetch executions started within this entire day window
        const query = `
            SELECT "startedAt" 
            FROM execution_entity 
            WHERE datetime("startedAt") >= datetime(?) 
              AND datetime("startedAt") <= datetime(?)
        `;
        const execs = await localDb.query(query, [new Date(start).toISOString(), new Date(end).toISOString()]);

        const execData = execs.rows.map(e => ({
            sAt: new Date(e.startedAt + (e.startedAt.endsWith('Z') ? '' : 'Z')).getTime()
        }));

        const buckets = [];
        // Generate 288 5-minute buckets starting from 00:00 local of that day
        for (let i = 0; i < 288; i++) {
            const bTimeMs = startTimeMs + (i * 5 * 60 * 1000);
            buckets.push(new Date(bTimeMs).toISOString());
        }

        const stats = buckets.map(bTime => {
            const bDateMs = new Date(bTime).getTime();
            const nextBDateMs = bDateMs + (5 * 60 * 1000);
            
            const count = execData.filter(e => {
                return e.sAt >= bDateMs && e.sAt < nextBDateMs;
            }).length;
            
            return { timestamp: bTime, active_count: count };
        });

        res.json(stats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch concurrency' });
    }
};

exports.getFirstExecutionDate = async (req, res) => {
    try {
        const query = 'SELECT MIN("startedAt") as first_date FROM execution_entity';
        const result = await localDb.query(query);
        res.json({ firstDate: result.rows[0]?.first_date || null });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch first execution date' });
    }
};

exports.getGlobalSettings = async (req, res) => {
    try {
        const result = await localDb.query('SELECT key, value FROM dashboard_settings');
        // Convert array of pairs to a cleaner object for the frontend
        const settings = result.rows.reduce((acc, curr) => {
            acc[curr.key] = curr.value;
            return acc;
        }, {});
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
};

exports.updateGlobalSettings = async (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key is required' });

    try {
        await localDb.execute(
            'INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            [key, value]
        );
        res.json({ message: 'Setting updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update setting' });
    }
};

exports.getConcurrencyDetails = async (req, res) => {
    const { time, window: windowMins } = req.query; // time is UTC ISO
    if (!time) return res.status(400).json({ error: 'time parameter is required' });

    const span = parseInt(windowMins) || 5;
    
    try {
        // Calculate the end of the window in SQL
        const query = `
            SELECT w.name as workflow_name, w.id as workflow_id, e.id as exec_id, e.status, e."startedAt", e."stoppedAt",
                   (julianday(IFNULL(e."stoppedAt", datetime('now'))) - julianday(e."startedAt")) * 86400 as current_duration
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE datetime(e."startedAt") <= datetime(?, '+' || ? || ' minutes')
              AND (
                  datetime(e."stoppedAt") >= datetime(?) OR
                  (e.status = 'running' AND datetime(e."startedAt") > datetime('now', '-6 hours'))
              )
            ORDER BY datetime(e."startedAt") DESC
            LIMIT 50
        `;
        const result = await localDb.query(query, [time, span, time]);
        
        const finalUrl = process.env.N8N_EDITOR_BASE_URL || '';
        const mappedRows = result.rows.map(row => ({
            ...row,
            n8nBaseUrl: finalUrl
        }));

        res.json(mappedRows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch concurrency details' });
    }
};

exports.getErrorIntelligence = async (req, res) => {
    try {
        // 1. Stats Summary
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_errors,
                COUNT(DISTINCT workflow_id) as affected_workflows,
                COUNT(DISTINCT node_name) as unique_failing_nodes
            FROM execution_error_analytics
            WHERE datetime(timestamp) > datetime('now', '-7 days')
        `;

        // 2. Workflow Hotspots (Calculated Error Rate)
        const workflowQuery = `
            SELECT 
                w.id,
                w.name, 
                COUNT(a.id) as error_count,
                (SELECT COUNT(*) FROM execution_entity WHERE "workflowId" = w.id AND datetime("startedAt") > datetime('now', '-7 days')) as total_runs
            FROM execution_error_analytics a
            JOIN workflow_entity w ON a.workflow_id = w.id
            WHERE datetime(a.timestamp) > datetime('now', '-7 days')
            GROUP BY w.id, w.name
            ORDER BY error_count DESC
            LIMIT 10
        `;

        // 3. Node Hotspots (Which specific nodes are 'burners')
        const nodeQuery = `
            SELECT node_name, node_type, COUNT(*) as fail_count
            FROM execution_error_analytics
            WHERE datetime(timestamp) > datetime('now', '-7 days')
            GROUP BY node_name, node_type
            ORDER BY fail_count DESC
            LIMIT 10
        `;

        // 4. Source Branch Analysis (Brittle paths)
        const sourceQuery = `
            SELECT source_node, source_output_index, COUNT(*) as crash_count
            FROM execution_error_analytics
            WHERE datetime(timestamp) > datetime('now', '-7 days') AND source_node != ''
            GROUP BY source_node, source_output_index
            ORDER BY crash_count DESC
            LIMIT 10
        `;

        // 5. Recent Detailed Feed
        const feedQuery = `
            SELECT a.*, w.name as workflow_name
            FROM execution_error_analytics a
            JOIN workflow_entity w ON a.workflow_id = w.id
            ORDER BY datetime(a.timestamp) DESC
            LIMIT 30
        `;

        const [summary, workflows, nodes, sources, feed] = await Promise.all([
            localDb.query(summaryQuery),
            localDb.query(workflowQuery),
            localDb.query(nodeQuery),
            localDb.query(sourceQuery),
            localDb.query(feedQuery)
        ]);

        const n8nBaseUrl = process.env.N8N_EDITOR_BASE_URL || '';

        res.json({
            summary: summary.rows[0],
            workflows: workflows.rows,
            nodes: nodes.rows,
            sources: sources.rows,
            feed: feed.rows,
            n8nBaseUrl
        });

    } catch (err) {
        console.error('[BACKEND] Error Analytics Intelligence Failed:', err);
        res.status(500).json({ error: 'Failed to aggregate error intelligence' });
    }
};

exports.getWorkflowErrorDrilldown = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: 'Workflow ID is required' });

        // 1. Node Breakdown (Pie Chart)
        const distributionQuery = `
            SELECT node_name, COUNT(*) as count
            FROM execution_error_analytics
            WHERE workflow_id = ? AND datetime(timestamp) > datetime('now', '-7 days')
            GROUP BY node_name
            ORDER BY count DESC
        `;

        // 2. Source Breakdown (Most common path-to-error)
        const sourceQuery = `
            SELECT source_node, source_output_index, COUNT(*) as count
            FROM execution_error_analytics
            WHERE workflow_id = ? AND source_node != '' AND datetime(timestamp) > datetime('now', '-7 days')
            GROUP BY source_node, source_output_index
            ORDER BY count DESC
            LIMIT 5
        `;

        // 3. Raw Data (Export purposes)
        const rawQuery = `
            SELECT id as exec_id, node_name, node_type, error_message, error_stack, source_node, source_output_index as branch, timestamp as started_at
            FROM execution_error_analytics
            WHERE workflow_id = ?
            ORDER BY datetime(timestamp) DESC
            LIMIT 200
        `;

        // 4. Workflow Name Info
        const infoQuery = `SELECT name FROM workflow_entity WHERE id = ?`;

        const [dist, sources, raw, info] = await Promise.all([
            localDb.query(distributionQuery, [id]),
            localDb.query(sourceQuery, [id]),
            localDb.query(rawQuery, [id]),
            localDb.query(infoQuery, [id])
        ]);

        if (info.rows.length === 0) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        res.json({
            workflowName: info.rows[0].name,
            nodeDistribution: dist.rows,
            sourceDistribution: sources.rows,
            rawErrors: raw.rows
        });

    } catch (err) {
        console.error('[BACKEND] Workflow Drilldown Failed:', err);
        res.status(500).json({ error: 'Failed to fetch workflow drilldown data' });
    }
};
