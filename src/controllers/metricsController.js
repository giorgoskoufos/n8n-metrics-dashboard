const { pool } = require('../config/db');
const localDb = require('../config/localDb');
const { parse } = require('flatted');

/**
 * Relative time bounds are computed here rather than with SQLite's
 * datetime('now', '-N days'), so they can be passed as bound parameters and the
 * indexed column stays untouched on the left of the comparison.
 * Always UTC, matching how every timestamp is written by the sync.
 */
const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const isoHoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

exports.getMetrics = async (req, res) => {
    try {
        const targetWorkflow = req.query.workflow; 
        const startDate = req.query.startDate;
        const endDate = req.query.endDate;

        let startIso, endIso, prevStartIso, prevEndIso;
        let isCustom = true; 
        let bucketUnit = 'hour'; 
        let durationMs;

        if (startDate && endDate) {
            startIso = new Date(startDate).toISOString();
            endIso = new Date(endDate).toISOString();
            durationMs = new Date(endDate).getTime() - new Date(startDate).getTime();

            // Range Cap: 60 days
            const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
            if (durationMs > SIXTY_DAYS_MS) {
                durationMs = SIXTY_DAYS_MS;
                startIso = new Date(new Date(endDate).getTime() - SIXTY_DAYS_MS).toISOString();
            }
            
            prevEndIso = startIso;
            prevStartIso = new Date(new Date(startIso).getTime() - durationMs).toISOString();

            if (durationMs > 4 * 24 * 60 * 60 * 1000) {
                bucketUnit = 'day';
            }
        } else {
            // Robust Fallback: Default to 7 days
            const now = new Date();
            durationMs = 7 * 24 * 3600000;
            startIso = new Date(now.getTime() - durationMs).toISOString();
            endIso = now.toISOString();
            prevEndIso = startIso;
            prevStartIso = new Date(new Date(startIso).getTime() - durationMs).toISOString();
            bucketUnit = 'day';
        }

        // Standardize filters for all queries.
        // Date bounds are bound parameters and the column is compared directly
        // rather than through datetime(), so these can use idx_exec_started.
        const wfFilterClause = targetWorkflow ? 'AND w.name = ?' : '';
        const wfJoinClause = targetWorkflow ? 'JOIN workflow_entity w ON e."workflowId" = w.id' : '';
        const wfParam = targetWorkflow ? [targetWorkflow] : [];

        // Order matters: the date bounds appear in the WHERE clause before the
        // optional workflow filter that wfFilterClause appends after them.
        const currentParams = [startIso, endIso, ...wfParam];
        const prevParams = [prevStartIso, prevEndIso, ...wfParam];

        const statsQuery = `
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
                   AVG((julianday("stoppedAt") - julianday("startedAt")) * 86400) as avg_duration
            FROM execution_entity e
            ${wfJoinClause}
            WHERE e."startedAt" >= ? AND e."startedAt" <= ?
            ${wfFilterClause};
        `;

        const prevStatsQuery = `
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
            FROM execution_entity e
            ${wfJoinClause}
            WHERE e."startedAt" >= ? AND e."startedAt" < ?
            ${wfFilterClause};
        `;

        const topWorkflowsQuery = `
            SELECT w.name AS workflow_name, COUNT(e.id) AS execution_count,
                   ROUND((COUNT(e.id) * 100.0 / NULLIF(SUM(COUNT(e.id)) OVER (), 0)), 2) AS percentage
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE e."startedAt" >= ? AND e."startedAt" <= ?
            ${wfFilterClause}
            GROUP BY w.id, w.name
            ORDER BY execution_count DESC;
        `;

        // Bucket boundaries. Computed here because the SQL below derives its bucket
        // index from the same origin, which keeps the grouping identical to the
        // previous JavaScript implementation (including local-midnight day starts).
        const stepMs = bucketUnit === 'day' ? 86400000 : 3600000;
        const startPoint = new Date(new Date(startIso).getTime());
        const endPointFull = new Date(new Date(endIso).getTime());
        if (bucketUnit === 'day') startPoint.setHours(0, 0, 0, 0);
        else startPoint.setMinutes(0, 0, 0);

        const buckets = [];
        for (let t = startPoint.getTime(); t <= endPointFull.getTime(); t += stepMs) {
            buckets.push(new Date(t).toISOString());
        }

        // Counting happens in SQL. This used to pull every execution in the range
        // into memory — over 140k rows for a 60 day window — and bucket them with a
        // nested filter per bucket. Now it returns one row per bucket.
        const bucketQuery = `
            SELECT CAST((julianday(e."startedAt") - julianday(?)) * 86400.0 / ? AS INTEGER) AS bucket_idx,
                   SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END) AS success_count,
                   SUM(CASE WHEN e.status <> 'success' THEN 1 ELSE 0 END) AS error_count
            FROM execution_entity e
            ${wfJoinClause}
            WHERE e."startedAt" >= ? AND e."startedAt" <= ?
            ${wfFilterClause}
            GROUP BY bucket_idx
        `;

        const [stats, prevStats, bucketRows, topWorkflows] = await Promise.all([
            localDb.query(statsQuery, currentParams),
            localDb.query(prevStatsQuery, prevParams),
            localDb.query(bucketQuery, [
                startPoint.toISOString(), stepMs / 1000, startIso, endIso, ...wfParam
            ]),
            localDb.query(topWorkflowsQuery, currentParams)
        ]);

        // Expand the sparse SQL result back into a dense series so empty buckets
        // still render as zero rather than being dropped from the chart.
        const countsByIndex = new Map(
            bucketRows.rows.map(r => [r.bucket_idx, r])
        );
        const hourly = buckets.map((bTime, idx) => {
            const row = countsByIndex.get(idx);
            return {
                time_val: bTime,
                success_count: row ? row.success_count : 0,
                error_count: row ? row.error_count : 0
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

        // Smart Extrapolation: prevent 'cliff' on incomplete final intervals
        if (hourly.length > 2) {
            const lastRow = hourly[hourly.length - 1];
            const p1 = hourly[hourly.length - 2].success_count || 0;
            const p2 = hourly[hourly.length - 3].success_count || 0;
            const avgPrevious = (p1 + p2) / 2.0;
            const now = new Date();

            // Check if the range ends within the current interval
            const rangeEndMs = isCustom ? new Date(endDate).getTime() : now.getTime();
            const lastBucketStartMs = new Date(lastRow.time_val).getTime();
            const isLatestBucket = (rangeEndMs > lastBucketStartMs && rangeEndMs <= lastBucketStartMs + stepMs);

            if (isLatestBucket) {
                if (bucketUnit === 'day') {
                    const hoursPassed = (rangeEndMs - lastBucketStartMs) / 3600000;
                    if (hoursPassed > 1 && hoursPassed < 23) {
                        const factor = 24.0 / hoursPassed;
                        lastRow.success_count = Math.round(((lastRow.success_count * factor) + avgPrevious) / 2);
                    }
                } else {
                    const minsPassed = ((rangeEndMs - lastBucketStartMs) / 60000) % 60;
                    if (minsPassed > 5 && minsPassed < 58) {
                        const factor = 60.0 / minsPassed;
                        lastRow.success_count = Math.round(((lastRow.success_count * factor) + avgPrevious) / 2);
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
        res.status(500).json({ error: 'Database errorfetching metrics' });
    }
};


exports.getExecutions = async (req, res) => {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    // --- Filter params ---
    const { workflow, status, from, toStop, minDuration, execId } = req.query;

    const VALID_STATUSES = ['success', 'error', 'canceled', 'crashed', 'running'];
    if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status filter.' });
    }

    const conditions = [
        'e."startedAt" IS NOT NULL',
        'e."stoppedAt" IS NOT NULL'
    ];
    const params = [];

    if (execId && !isNaN(parseInt(execId))) {
        conditions.push('e.id = ?');
        params.push(parseInt(execId));
    }
    if (workflow) {
        conditions.push('w.name = ?');
        params.push(workflow);
    }
    if (status) {
        conditions.push('e.status = ?');
        params.push(status);
    }
    if (from) {
        conditions.push('e."startedAt" >= ?');
        params.push(new Date(from).toISOString());
    }
    if (toStop) {
        conditions.push('e."startedAt" <= ?');
        params.push(new Date(toStop).toISOString());
    }
    if (minDuration && parseFloat(minDuration) > 0) {
        conditions.push('(julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400 >= ?');
        params.push(parseFloat(minDuration));
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const query = `
            SELECT w.name, e.status, e."startedAt", e."stoppedAt", e.id as exec_id,
                   (julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400 as duration
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            ${whereClause}
            ORDER BY e."startedAt" DESC
            LIMIT ? OFFSET ?;
        `;
        const result = await localDb.query(query, [...params, limit, offset]);
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
            WHERE e."startedAt" > ?
              AND e."stoppedAt" IS NOT NULL
            GROUP BY w.id, w.name
            ORDER BY avg_duration DESC
            LIMIT 10;
        `;
        const result = await localDb.query(query, [isoDaysAgo(7)]);
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
            WHERE e."startedAt" > ?
            GROUP BY w.id, w.name
            HAVING SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END) > 0
            ORDER BY error_count DESC
            LIMIT 10;
        `;
        const result = await localDb.query(query, [isoDaysAgo(7)]);
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
    console.log('[DEBUG] Manual sync triggered from UI burger menu');
    const { syncData } = require('../config/syncJob');
    try {
        await syncData(true);
        res.json({ message: 'Sync Complete' });
    } catch(err) {
        console.error('[ERORR] Manual Sync failed:', err);
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
                SUM(CASE WHEN e.status = 'success' AND e."startedAt" >= ? THEN 1 ELSE 0 END) as executions_30d
            FROM workflow_entity w
            LEFT JOIN workflow_settings s ON w.id = s.workflow_id
            LEFT JOIN execution_entity e ON w.id = e."workflowId" AND e.status = 'success'
            GROUP BY w.id, w.name, s.saved_time_seconds, s.hourly_rate
            ORDER BY w.name ASC
        `;
        // The previous bound mixed 'localtime' into a comparison against UTC
        // timestamps, so the 30-day window was off by the server's UTC offset.
        const result = await localDb.query(query, [isoDaysAgo(30)]);
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
        const timeParams = [];

        if (timeRange && timeRange !== 'all') {
            const LOOKBACK_HOURS = { '24h': 24, '48h': 48, '7d': 168, '30d': 720 };
            const lookbackHours = LOOKBACK_HOURS[timeRange] || 24;
            timeFilter = ` AND e."startedAt" >= ?`;
            timeParams.push(isoHoursAgo(lookbackHours));
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
            localDb.query(totalQuery, timeParams),
            localDb.query(workflowsQuery, timeParams)
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
            WHERE "startedAt" >= ? 
              AND "startedAt" <= ?
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

    const windowStartMs = new Date(time).getTime();
    if (Number.isNaN(windowStartMs)) {
        return res.status(400).json({ error: 'time must be a valid ISO date' });
    }
    // The window end used to be computed inside SQL with a datetime() modifier,
    // which forced a scan. Computing it here keeps the indexed column bare.
    const windowEndIso = new Date(windowStartMs + span * 60000).toISOString();

    try {
        const query = `
            SELECT w.name as workflow_name, w.id as workflow_id, e.id as exec_id, e.status, e."startedAt", e."stoppedAt",
                   (julianday(IFNULL(e."stoppedAt", ?)) - julianday(e."startedAt")) * 86400 as current_duration
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE e."startedAt" <= ?
              AND (
                  e."stoppedAt" >= ? OR
                  (e.status = 'running' AND e."startedAt" > ?)
              )
            ORDER BY e."startedAt" DESC
            LIMIT 50
        `;
        const result = await localDb.query(query, [
            new Date().toISOString(), windowEndIso, time, isoHoursAgo(6)
        ]);
        
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
        const startDate = req.query.startDate;
        const endDate = req.query.endDate;

        let startIso, endIso, prevStartIso, prevEndIso;

        if (startDate && endDate) {
            startIso = new Date(startDate).toISOString();
            endIso = new Date(endDate).toISOString();
        } else {
            const now = new Date();
            startIso = new Date(now.getTime() - 7 * 24 * 3600000).toISOString();
            endIso = now.toISOString();
        }

        const durationMs = new Date(endIso).getTime() - new Date(startIso).getTime();
        prevEndIso = startIso;
        prevStartIso = new Date(new Date(startIso).getTime() - durationMs).toISOString();

        // 1. Summary Stats
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_errors,
                COUNT(DISTINCT workflow_id) as affected_workflows,
                COUNT(DISTINCT node_name) as unique_failing_nodes,
                SUM(CASE WHEN error_category IN ('rate_limit','network','upstream') THEN 1 ELSE 0 END) as transient_count,
                SUM(CASE WHEN error_category IN ('auth','config','data','logic') THEN 1 ELSE 0 END) as structural_count
            FROM execution_error_analytics
            WHERE timestamp >= ? AND timestamp <= ?
        `;

        const prevSummaryQuery = `
            SELECT COUNT(*) as total_errors
            FROM execution_error_analytics
            WHERE timestamp >= ? AND timestamp < ?
        `;

        // Total executions for error rate calculation
        const execCountQuery = `
            SELECT COUNT(*) as total
            FROM execution_entity
            WHERE "startedAt" >= ? AND "startedAt" <= ?
        `;

        // 2. Category Breakdown
        const categoryQuery = `
            SELECT error_category, COUNT(*) as count
            FROM execution_error_analytics
            WHERE timestamp >= ? AND timestamp <= ?
            GROUP BY error_category
            ORDER BY count DESC
        `;

        // 3. Trend Timeline (daily buckets)
        const trendQuery = `
            SELECT date(timestamp) as day, error_category, COUNT(*) as count
            FROM execution_error_analytics
            WHERE timestamp >= ? AND timestamp <= ?
            GROUP BY date(timestamp), error_category
            ORDER BY day ASC
        `;

        // 4. Workflow Health Scores
        const healthQuery = `
            SELECT 
                w.id, w.name,
                COUNT(CASE WHEN e.status = 'error' THEN 1 END) as error_count,
                COUNT(e.id) as total_runs,
                ROUND((1.0 - (CAST(COUNT(CASE WHEN e.status = 'error' THEN 1 END) AS REAL) / NULLIF(COUNT(e.id), 0))) * 100, 1) as health_score
            FROM workflow_entity w
            JOIN execution_entity e ON w.id = e."workflowId"
            WHERE e."startedAt" >= ? AND e."startedAt" <= ?
            GROUP BY w.id, w.name
            HAVING COUNT(CASE WHEN e.status = 'error' THEN 1 END) > 0
            ORDER BY health_score ASC
            LIMIT 15
        `;

        // 5. Deduplicated Error Groups
        const groupsQuery = `
            SELECT 
                a.error_category,
                a.node_name,
                a.node_type,
                SUBSTR(a.error_message, 1, 200) as error_summary,
                COUNT(*) as count,
                COUNT(DISTINCT a.workflow_id) as affected_workflows,
                MIN(a.timestamp) as first_seen,
                MAX(a.timestamp) as last_seen,
                GROUP_CONCAT(DISTINCT w.name) as workflow_names
            FROM execution_error_analytics a
            JOIN workflow_entity w ON a.workflow_id = w.id
            WHERE a.timestamp >= ? AND a.timestamp <= ?
            GROUP BY a.error_category, a.node_name, SUBSTR(a.error_message, 1, 200)
            ORDER BY count DESC
            LIMIT 50
        `;

        const [summary, prevSummary, execCount, categories, trend, health, groups] = await Promise.all([
            localDb.query(summaryQuery, [startIso, endIso]),
            localDb.query(prevSummaryQuery, [prevStartIso, prevEndIso]),
            localDb.query(execCountQuery, [startIso, endIso]),
            localDb.query(categoryQuery, [startIso, endIso]),
            localDb.query(trendQuery, [startIso, endIso]),
            localDb.query(healthQuery, [startIso, endIso]),
            localDb.query(groupsQuery, [startIso, endIso])
        ]);

        const totalErrors = summary.rows[0].total_errors || 0;
        const prevTotalErrors = prevSummary.rows[0].total_errors || 0;
        const totalExecs = execCount.rows[0].total || 0;
        let trendPct = 0;
        if (prevTotalErrors > 0) trendPct = ((totalErrors - prevTotalErrors) / prevTotalErrors) * 100;
        else if (totalErrors > 0) trendPct = 100;

        // Pivot trend data into {day, auth, rate_limit, network, ...} format
        const trendMap = {};
        for (const row of trend.rows) {
            if (!trendMap[row.day]) trendMap[row.day] = { day: row.day };
            trendMap[row.day][row.error_category] = row.count;
        }
        const trendData = Object.values(trendMap);

        // Mark error groups as active/recurring/resolved
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 3600000).toISOString();
        const enrichedGroups = groups.rows.map(g => ({
            ...g,
            workflow_names: g.workflow_names ? g.workflow_names.split(',').slice(0, 3) : [],
            status: g.last_seen >= oneDayAgo ? 'active' : 'recurring'
        }));

        const n8nBaseUrl = process.env.N8N_EDITOR_BASE_URL || '';

        res.json({
            summary: {
                ...summary.rows[0],
                total_executions: totalExecs,
                error_rate: totalExecs > 0 ? ((totalErrors / totalExecs) * 100).toFixed(1) : 0,
                trend_pct: Math.round(trendPct * 10) / 10
            },
            categories: categories.rows,
            trend: trendData,
            workflows: health.rows,
            errorGroups: enrichedGroups,
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
            WHERE workflow_id = ? AND timestamp > ?
            GROUP BY node_name
            ORDER BY count DESC
        `;

        // 2. Source Breakdown (Most common path-to-error)
        const sourceQuery = `
            SELECT source_node, source_output_index, COUNT(*) as count
            FROM execution_error_analytics
            WHERE workflow_id = ? AND source_node != '' AND timestamp > ?
            GROUP BY source_node, source_output_index
            ORDER BY count DESC
            LIMIT 5
        `;

        // 3. Raw Data (Export purposes)
        const rawQuery = `
            SELECT id as exec_id, node_name, node_type, error_message, error_stack, source_node, source_output_index as branch, timestamp as started_at
            FROM execution_error_analytics
            WHERE workflow_id = ?
            ORDER BY timestamp DESC
            LIMIT 200
        `;

        // 4. Workflow Name Info
        const infoQuery = `SELECT name FROM workflow_entity WHERE id = ?`;

        const [dist, sources, raw, info] = await Promise.all([
            localDb.query(distributionQuery, [id, isoDaysAgo(7)]),
            localDb.query(sourceQuery, [id, isoDaysAgo(7)]),
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

exports.getErrorGroupExecutions = async (req, res) => {
    try {
        const { category, nodeName, summary, startDate, endDate } = req.body;
        
        if (!category || !nodeName || !summary || !startDate || !endDate) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        const query = `
            SELECT a.id as exec_id, a.timestamp, w.name as workflow_name
            FROM execution_error_analytics a
            JOIN workflow_entity w ON a.workflow_id = w.id
            WHERE a.timestamp >= ? AND a.timestamp <= ?
              AND a.error_category = ?
              AND a.node_name = ?
              AND SUBSTR(a.error_message, 1, 200) = ?
            ORDER BY a.timestamp DESC
            LIMIT 30
        `;
        
        const result = await localDb.query(query, [startDate, endDate, category, nodeName, summary]);
        res.json({ executions: result.rows });
    } catch (err) {
        console.error('[BACKEND] Error fetching group executions:', err);
        res.status(500).json({ error: 'Failed to fetch group executions' });
    }
};
