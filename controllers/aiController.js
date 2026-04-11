const openai = require('../config/openai');
const { pool, aiPool } = require('../config/db');

// Schema for AI context
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
    - For date-specific counts (yesterday, 2 days ago, etc.), use: "startedAt"::date = CURRENT_DATE - INTERVAL 'n days'.
    - When multiple time periods are requested as columns, use conditional aggregation (e.g., COUNT(*) FILTER (WHERE ...)).
    - IMPORTANT: If you use a quoted alias (e.g., AS "totalExecutions"), you MUST use the exact same quoted name in the ORDER BY clause.
    - Return valid PostgreSQL syntax.
`;

exports.chat = async (req, res) => {
    const userMessage = req.body.message;
    const userId = req.user.id;

    if (!userMessage) return res.status(400).json({ error: "Message is required" });

    try {
        // --- STEP 0: Fetch History ---
        const historyRes = await pool.query(
            'SELECT role, content FROM dashboard_chat_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
            [userId]
        );
        const history = historyRes.rows.reverse();

        // Format history for OpenAI
        const chatContext = history.map(msg => ({
            role: msg.role === 'ai' ? 'assistant' : 'user',
            content: msg.content
        }));

        // --- STEP 1: Generate SQL ---
        const sqlMessages = [
            { role: "system", content: `You are a strict PostgreSQL DBA. Translate natural language to SQL using this schema:\n${dbSchema}\nRespond ONLY with the raw SQL query. No formatting, no markdown.` },
            ...chatContext,
            { role: "user", content: userMessage }
        ];

        const sqlPrompt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: sqlMessages,
            temperature: 0,
        });

        let generatedSql = sqlPrompt.choices[0].message.content.trim();
        generatedSql = generatedSql.replace(/^```sql\n?/, '').replace(/```$/, '').trim();

        // --- STEP 2: Execute SQL ---
        let dbResult;
        try {
            await aiPool.query('SET statement_timeout = 5000');
            dbResult = await aiPool.query(generatedSql);
        } catch (dbError) {
            console.error("❌ SQL ERROR:", generatedSql, dbError);
            return res.status(400).json({ error: "The AI generated an invalid SQL query.", details: dbError.message, sqlUsed: generatedSql });
        }

        // --- STEP 3: Translate Results to Human Language ---
        const rowCount = dbResult.rows.length;
        const truncatedRows = dbResult.rows.slice(0, 50);

        const answerPrompt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are an analytics assistant. Answer the user based ONLY on the JSON database results provided. If the data has 2 or more columns, ALWAYS use a Markdown table for clarity. Be brief, clear, and do not mention the database or SQL in your answer." },
                ...chatContext,
                { role: "user", content: `Question: ${userMessage}\nTotal Results in DB: ${rowCount}\nSample Results (Top 50): ${JSON.stringify(truncatedRows)}` }
            ],
            temperature: 0.7,
        });

        const answer = answerPrompt.choices[0].message.content;

        // --- STEP 4: Persist History ---
        await pool.query(
            'INSERT INTO dashboard_chat_history (user_id, role, content) VALUES ($1, $2, $3)',
            [userId, 'user', userMessage]
        );
        await pool.query(
            'INSERT INTO dashboard_chat_history (user_id, role, content, sql_used) VALUES ($1, $2, $3, $4)',
            [userId, 'ai', answer, generatedSql]
        );

        res.json({
            answer,
            sqlUsed: generatedSql
        });

    } catch (error) {
        console.error("AI Pipeline Error:", error);
        res.status(500).json({ error: "AI communication failed." });
    }
};

// New method to fetch history for the UI
exports.getHistory = async (req, res) => {
    try {
        const historyRes = await pool.query(
            'SELECT role, content, sql_used, created_at FROM dashboard_chat_history WHERE user_id = $1 ORDER BY created_at ASC LIMIT 50',
            [req.user.id]
        );
        res.json(historyRes.rows);
    } catch (error) {
        console.error("History Fetch Error:", error);
        res.status(500).json({ error: "Failed to fetch chat history." });
    }
};
