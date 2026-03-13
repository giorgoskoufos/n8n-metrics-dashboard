require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Dynamic db conneciton depending on the enviroment the app is hosted
let poolConfig = {};

if (process.env.DATABASE_URL) {
    // Option Α: Server / Easypanel (Internal URL)
    console.log("Connecting to DB using DATABASE_URL...");
    poolConfig = {
        connectionString: process.env.DATABASE_URL,
    };
} else {
    // Option Β: Local / External connection
    console.log("Connecting to DB using individual credentials...");
    poolConfig = {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASS,
        port: process.env.DB_PORT,
    };
}

const pool = new Pool(poolConfig);

app.use(express.static('public'));


// 1. Endpoint για τα Metrics (Γραφήματα & KPIs) - ΠΛΕΟΝ ΔΕΧΕΤΑΙ ΦΙΛΤΡΟ!
app.get('/api/metrics', async (req, res) => {
  try {
    const targetWorkflow = req.query.workflow; // Διαβάζουμε το φίλτρο από το URL

    const statsQuery = `
      SELECT count(*) as total, count(*) FILTER (WHERE status = 'error') as error,
             avg(extract(epoch from ("stoppedAt" - "startedAt"))) as avg_duration
      FROM execution_entity WHERE "startedAt" > NOW() - INTERVAL '7 days';
    `;

    let hourlyQuery;
    let hourlyParams = [];

    if (targetWorkflow) {
        // Αν επιλέχθηκε workflow, φιλτράρουμε το Line Chart!
        hourlyQuery = `
          WITH hours AS (SELECT generate_series(date_trunc('hour', NOW() - INTERVAL '23 hours'), date_trunc('hour', NOW()), '1 hour'::interval) AS hour),
          recent_executions AS (
              SELECT e.id, e.status, date_trunc('hour', e."startedAt") as exec_hour
              FROM execution_entity e
              JOIN workflow_entity w ON e."workflowId" = w.id
              WHERE e."startedAt" > NOW() - INTERVAL '24 hours'
              AND w.name = $1
          )
          SELECT h.hour, COUNT(e.id) FILTER (WHERE e.status = 'success') AS success_count, COUNT(e.id) FILTER (WHERE e.status = 'error') AS error_count
          FROM hours h LEFT JOIN recent_executions e ON h.hour = e.exec_hour GROUP BY h.hour ORDER BY h.hour ASC;
        `;
        hourlyParams.push(targetWorkflow);
    } else {
        // Διαφορετικά τα φέρνουμε όλα
        hourlyQuery = `
          WITH hours AS (SELECT generate_series(date_trunc('hour', NOW() - INTERVAL '23 hours'), date_trunc('hour', NOW()), '1 hour'::interval) AS hour),
          recent_executions AS (SELECT id, status, date_trunc('hour', "startedAt") as exec_hour FROM execution_entity WHERE "startedAt" > NOW() - INTERVAL '24 hours')
          SELECT h.hour, COUNT(e.id) FILTER (WHERE e.status = 'success') AS success_count, COUNT(e.id) FILTER (WHERE e.status = 'error') AS error_count
          FROM hours h LEFT JOIN recent_executions e ON h.hour = e.exec_hour GROUP BY h.hour ORDER BY h.hour ASC;
        `;
    }

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
        pool.query(hourlyQuery, hourlyParams), // Περνάμε το φίλτρο
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

app.listen(port, () => {
  console.log(`n8n-mobile app listening at http://localhost:${port}`);
});