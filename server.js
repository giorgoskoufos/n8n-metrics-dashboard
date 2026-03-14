require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.DASHBOARD_PORT || 3000;

// Dynamic db connection depending on the environment
let poolConfig = {};

if (process.env.DASHBOARD_DATABASE_URL) {
    // Option Α: Server / Easypanel (Internal URL)
    console.log("Connecting to DB using DASHBOARD_DATABASE_URL...");
    poolConfig = {
        connectionString: process.env.DASHBOARD_DATABASE_URL,
    };
} else {
    // Option Β: Local / External connection
    console.log("Connecting to DB using individual credentials...");
    poolConfig = {
        user: process.env.DASHBOARD_DB_USER,
        host: process.env.DASHBOARD_DB_HOST,
        database: process.env.DASHBOARD_DB_NAME,
        password: process.env.DASHBOARD_DB_PASS,
        port: process.env.DASHBOARD_DB_PORT,
    };
}

const pool = new Pool(poolConfig);
app.use(express.static('public'));

// 1. Endpoint για τα Metrics (Γραφήματα & KPIs)
app.get('/api/metrics', async (req, res) => {
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

    // Το ::text στο t.time_point λύνει το πρόβλημα του NaN στη JavaScript!
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
});

// 2. Executions Data Endpoint
app.get('/api/executions', async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    
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
});

// 3. Analytics: Top 10 Slowest Workflows (Last 7 Days)
app.get('/api/analytics/slowest', async (req, res) => {
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
});

// 4. Analytics: Top 10 Error Hotspots (Last 7 Days)
app.get('/api/analytics/errors', async (req, res) => {
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
});

app.listen(port, () => {
  console.log(`n8n-mobile app listening at http://localhost:${port}`);
});