const { pool } = require('../config/db');
const { parse } = require('flatted');

exports.getMetrics = async (req, res) => {
    try {
        const targetWorkflow = req.query.workflow; 
        const timeRange = req.query.timeRange || '24h'; 

        let intervalOffset = '23 hours';
        let lookback = '24 hours';
        let step = '1 hour';
        let truncUnit = 'hour';

        if (timeRange === '48h') {
            intervalOffset = '47 hours';
            lookback = '48 hours';
        } else if (timeRange === '7d') {
            intervalOffset = '6 days';
            lookback = '7 days';
            truncUnit = 'day'; 
            step = '1 day';
        }

        const statsQuery = `
            SELECT count(*) as total, count(*) FILTER (WHERE status = 'error') as error,
                   avg(extract(epoch from ("stoppedAt" - "startedAt"))) as avg_duration
            FROM execution_entity WHERE "startedAt" > NOW() - INTERVAL '7 days';
        `;

        let hourlyParams = [];
        if (targetWorkflow) hourlyParams.push(targetWorkflow);

        const hourlyQuery = `
            WITH time_series AS (
                SELECT generate_series(date_trunc('${truncUnit}', NOW() - INTERVAL '${intervalOffset}'), date_trunc('${truncUnit}', NOW()), '${step}'::interval) AS time_point
            ),
            recent_executions AS (
                SELECT e.id, e.status, date_trunc('${truncUnit}', e."startedAt") as exec_time
                FROM execution_entity e
                ${targetWorkflow ? 'JOIN workflow_entity w ON e."workflowId" = w.id' : ''}
                WHERE e."startedAt" > NOW() - INTERVAL '${lookback}'
                ${targetWorkflow ? 'AND w.name = $1' : ''}
            )
            SELECT t.time_point::text as time_val, 
                   COUNT(e.id) FILTER (WHERE e.status = 'success') AS success_count, 
                   COUNT(e.id) FILTER (WHERE e.status = 'error') AS error_count
            FROM time_series t 
            LEFT JOIN recent_executions e ON t.time_point = e.exec_time 
            GROUP BY t.time_point 
            ORDER BY t.time_point ASC;
        `;

        const topWorkflowsQuery = `
            SELECT w.name AS workflow_name, COUNT(e.id) AS execution_count,
                   ROUND((COUNT(e.id) * 100.0 / SUM(COUNT(e.id)) OVER()), 2) AS percentage
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE e."startedAt" > NOW() - INTERVAL '7 days'
            GROUP BY w.id, w.name
            ORDER BY execution_count DESC;
        `;

        const [stats, hourly, topWorkflows] = await Promise.all([
            pool.query(statsQuery),
            pool.query(hourlyQuery, hourlyParams), 
            pool.query(topWorkflowsQuery)
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
    // Sanitization: Ensure limit is between 1-100 and offset is >= 0
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    
    try {
        const query = `
            SELECT w.name, e.status, e."startedAt", e.id as exec_id,
                   extract(epoch from (e."stoppedAt" - e."startedAt")) as duration
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE e."startedAt" IS NOT NULL AND e."stoppedAt" IS NOT NULL
            ORDER BY e."startedAt" DESC
            LIMIT $1 OFFSET $2;
        `;
        const result = await pool.query(query, [limit, offset]);
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
                   AVG(EXTRACT(EPOCH FROM (e."stoppedAt" - e."startedAt"))) as avg_duration,
                   COUNT(e.id) as total_runs
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE e."startedAt" > NOW() - INTERVAL '7 days' 
              AND e."stoppedAt" IS NOT NULL
            GROUP BY w.id, w.name
            ORDER BY avg_duration DESC
            LIMIT 10;
        `;
        const result = await pool.query(query);
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
                   COUNT(e.id) FILTER (WHERE e.status = 'error') as error_count,
                   COUNT(e.id) as total_runs
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE e."startedAt" > NOW() - INTERVAL '7 days'
            GROUP BY w.id, w.name
            HAVING COUNT(e.id) FILTER (WHERE e.status = 'error') > 0
            ORDER BY error_count DESC
            LIMIT 10;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getExecutionError = async (req, res) => {
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
