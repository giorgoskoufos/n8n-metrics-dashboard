// ==========================================
// n8n Analytics Dashboard - Backend Server
// ==========================================

// --- SECTION 1: SETUP & IMPORTS ---
require('dotenv').config();
const { parse } = require('flatted');
const express = require('express');
const { Pool } = require('pg');
const { OpenAI } = require('openai'); // Προσθήκη OpenAI
const path = require('path');

const app = express();
const port = process.env.DASHBOARD_PORT || 3000;
const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET;

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Middleware
app.use(express.static('public'));
app.use(express.json()); // Απαραίτητο για να διαβάζει τα JSON (όπως το AI prompt)

// --- SECTION 2: DATABASE CONNECTIONS ---

// 2A. Main Database Pool (Με πλήρη δικαιώματα για το dashboard)
let poolConfig = {};
if (process.env.DASHBOARD_DATABASE_URL) {
    console.log("Connecting to DB using DASHBOARD_DATABASE_URL...");
    poolConfig = { connectionString: process.env.DASHBOARD_DATABASE_URL };
} else {
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

// 2B. AI Read-Only Database Pool (Απόλυτη Ασφάλεια!)
const aiPool = new Pool({
    connectionString: process.env.AI_DB_URL // π.χ. postgresql://n8n_readonly_ai:...
});

// 2C. OpenAI Initialization
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- SECTION 2.5: AUTHENTICATION ---

// To Endpoint για το Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Ψάχνουμε τον χρήστη στη βάση του n8n
        const query = 'SELECT id, email, password, "firstName", "lastName" FROM "user" WHERE email = $1';
        const dbRes = await pool.query(query, [email]);

        if (dbRes.rows.length === 0) {
            return res.status(401).json({ error: 'Wrong Credentials' });
        }

        const user = dbRes.rows[0];
        
        // Συγκρίνουμε τον κωδικό
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ error: 'Wrong Credentials' });
        }

        // Φτιάχνουμε το Token (το "πάσο")
        const token = jwt.sign(
            { id: user.id, email: user.email, firstName: user.firstName }, 
            JWT_SECRET, 
            { expiresIn: '8h' }
        );

        res.json({ 
            message: 'Sucessful Login!', 
            token: token,
            user: { firstName: user.firstName, lastName: user.lastName, email: user.email }
        });

    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Internal server error during login' });
    }
});

// Middlewares
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // reads "Bearer TOKEN"

    if (!token) return res.status(401).json({ error: 'Απαιτείται σύνδεση (Missing Token)' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Μη έγκυρο ή ληγμένο token' });
        req.user = user;
        next();
    });
};

// --- SECTION 3: CORE METRICS & EXECUTIONS ---

app.get('/api/metrics', authenticateToken, async (req, res) => {
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
});

app.get('/api/executions', authenticateToken, async (req, res) => {
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


// --- SECTION 4: ANALYTICS (SLOWEST & ERRORS) ---

app.get('/api/analytics/slowest', authenticateToken, async (req, res) => {
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

app.get('/api/analytics/errors', authenticateToken, async (req, res) => {
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


// --- SECTION 5: ERROR DETAILS (MODAL) ---

app.get('/api/execution-error/:id', authenticateToken, async (req, res) => {
    try {
        // ΠΡΟΣΟΧΗ: Κρατάμε το AS workflow_id για να μην χάσουμε το Link στο UI!
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
});


// --- SECTION 6: AI CHATBOT (TEXT-TO-SQL) ---

app.post('/api/ai-chat', authenticateToken, async (req, res) => {
    const userMessage = req.body.message;

    if (!userMessage) return res.status(400).json({ error: "Message is required" });

    // Το Σχέδιο (Schema) μόνο με τα απαραίτητα για το AI
    const dbSchema = `
        Tables:
        1. workflow_entity
           - id (string)
           - name (string)
           - active (boolean)
           
        2. execution_entity
           - id (integer)
           - "workflowId" (string) -> Foreign key to workflow_entity.id
           - status (string: 'success', 'error', 'canceled')
           - "startedAt" (timestamp)
           - "stoppedAt" (timestamp)
           - waitTill (timestamp)
           
        Rules:
        - Always wrap case-sensitive column names in double quotes (e.g., e."workflowId").
        - NEVER select from execution_data.
        - To find executions by workflow name, JOIN workflow_entity w ON e."workflowId" = w.id.
        - Return valid PostgreSQL syntax.
    `;

    try {
        // ΦΑΣΗ 1: Generate SQL
        const sqlPrompt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: `You are a strict PostgreSQL DBA. Translate natural language to SQL using this schema:\n${dbSchema}\nRespond ONLY with the raw SQL query. No formatting, no markdown.` },
                { role: "user", content: userMessage }
            ],
            temperature: 0,
        });

        let generatedSql = sqlPrompt.choices[0].message.content.trim();
        generatedSql = generatedSql.replace(/^```sql\n?/, '').replace(/```$/, '').trim();

        // ΦΑΣΗ 2: Execute SQL (Με το aiPool!)
        let dbResult;
        try {
            dbResult = await aiPool.query(generatedSql);
        } catch (dbError) {
            console.error("❌ ΤΟ SQL ΠΟΥ ΕΣΚΑΣΕ:", generatedSql);
            console.error("❌ Ο ΛΟΓΟΣ (DB ERROR):", dbError);
            return res.status(400).json({ error: "Το AI έγραψε μη έγκυρο SQL.", details: dbError.message, sqlUsed: generatedSql });
        }

        // ΦΑΣΗ 3: Translate Results to Human Language
        const answerPrompt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are an analytics assistant. Answer the user based ONLY on the JSON database results provided. Be brief, clear, and do not mention the database or SQL in your answer." },
                { role: "user", content: `Question: ${userMessage}\nResults: ${JSON.stringify(dbResult.rows)}` }
            ],
            temperature: 0.7,
        });

        res.json({ 
            answer: answerPrompt.choices[0].message.content,
            sqlUsed: generatedSql 
        });

    } catch (error) {
        console.error("AI Pipeline Error:", error);
        res.status(500).json({ error: "Αποτυχία επικοινωνίας με το AI API." });
    }
});


// --- SECTION 7: SERVER INITIALIZATION ---

app.listen(port, () => {
  console.log(`🚀 n8n Analytics Dashboard listening at http://localhost:${port}`);
});