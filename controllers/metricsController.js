const { pool } = require('../config/db');
const localDb = require('../config/localDb');
const { parse } = require('flatted');

exports.getMetrics = async (req, res) => {
    try {
        const targetWorkflow = req.query.workflow; 
        const timeRange = req.query.timeRange || '24h'; 

        let intervalOffset = '-23 hours';
        let lookback = '-24 hours';
        let step = '+1 hour';
        let truncUnitFormat = '%Y-%m-%d %H:00:00';

        if (timeRange === '48h') {
            intervalOffset = '-47 hours';
            lookback = '-48 hours';
        } else if (timeRange === '7d') {
            intervalOffset = '-6 days';
            lookback = '-7 days';
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

        let queryParams = [];
        if (targetWorkflow) queryParams.push(targetWorkflow);

        const hourlyQuery = `
            WITH RECURSIVE time_series(time_point) AS (
                SELECT strftime('${truncUnitFormat}', datetime('now', '${intervalOffset}'))
                UNION ALL
                SELECT datetime(time_point, '${step}')
                FROM time_series
                WHERE time_point < strftime('${truncUnitFormat}', 'now')
            ),
            recent_executions AS (
                SELECT e.id, e.status, strftime('${truncUnitFormat}', e."startedAt") as exec_time
                FROM execution_entity e
                ${targetWorkflow ? 'JOIN workflow_entity w ON e."workflowId" = w.id' : ''}
                WHERE datetime(e."startedAt") > datetime('now', '${lookback}')
                ${targetWorkflow ? 'AND w.name = ?' : ''}
            )
            SELECT t.time_point as time_val, 
                   SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END) AS success_count, 
                   SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END) AS error_count
            FROM time_series t 
            LEFT JOIN recent_executions e ON t.time_point = e.exec_time 
            GROUP BY t.time_point 
            ORDER BY t.time_point ASC;
        `;

        const topWorkflowsQuery = `
            SELECT w.name AS workflow_name, COUNT(e.id) AS execution_count,
                   ROUND((COUNT(e.id) * 100.0 / (SELECT COUNT(*) FROM execution_entity WHERE datetime("startedAt") > datetime('now', '${lookback}'))), 2) AS percentage
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE datetime(e."startedAt") > datetime('now', '${lookback}')
            GROUP BY w.id, w.name
            ORDER BY execution_count DESC;
        `;

        const [stats, hourly, topWorkflows] = await Promise.all([
            localDb.query(statsQuery, queryParams),
            localDb.query(hourlyQuery, targetWorkflow ? [targetWorkflow, targetWorkflow] : []), 
            localDb.query(topWorkflowsQuery)
        ]);

        res.json({
            summary: stats.rows[0],
            hourlyData: hourly.rows,
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

        if (fullData && fullData.resultData && fullData.resultData.error) {
            errorMessage = fullData.resultData.error.description || fullData.resultData.error.message;
        } else if (fullData && fullData[0]) {
            const root = fullData[0];
            errorMessage = 
                (root.resultData?.error?.description) || 
                (root.resultData?.error?.message) || 
                (root.error?.description) ||
                (root.error?.message) ||
                (root.message);
        }

        const finalUrl = process.env.N8N_EDITOR_BASE_URL || 'MISSING_ENV';
        const finalWfId = workflowId || 'MISSING_ID';

        res.json({ 
            executionId: req.params.id,
            message: errorMessage || "Unknown error detail",
            workflowId: finalWfId, 
            n8nBaseUrl: finalUrl
        });
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
