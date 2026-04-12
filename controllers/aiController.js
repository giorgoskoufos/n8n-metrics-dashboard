const openai = require('../config/openai');
const localDb = require('../config/localDb');

// Schema for AI context (SQLite dialect)
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
       - "startedAt" (timestamp, ISO string format)
       - "stoppedAt" (timestamp, ISO string format)
       
    Rules:
    - This is a SQLite database. Do NOT use PostgreSQL specific syntax like EXTRACT(EPOCH FROM ...) or NOW() - INTERVAL.
    - Always wrap case-sensitive column names in double quotes (e.g., e."workflowId").
    - To find executions by workflow name, JOIN workflow_entity w ON e."workflowId" = w.id.
    - For date-specific queries, use SQLite date functions. Example: datetime("startedAt") > datetime('now', '-2 days').
    - When multiple time periods are requested as columns, use conditional aggregation: SUM(CASE WHEN ... THEN 1 ELSE 0 END).
    - Return valid SQLite syntax.
`;

exports.chat = async (req, res) => {
    const userMessage = req.body.message;
    const userId = req.user.id;

    if (!userMessage) return res.status(400).json({ error: "Message is required" });

    try {
        // --- STEP 0: Fetch History ---
        const historyRes = await localDb.query(
            'SELECT role, content FROM dashboard_chat_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
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
            { role: "system", content: `You are a strict SQLite DBA. Translate natural language to SQL using this schema:\n${dbSchema}\nRespond ONLY with the raw SQL query. No formatting, no markdown.` },
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
            // Read-only PRAGMA simulation or rely on SELECT parse
            if (!generatedSql.toUpperCase().startsWith('SELECT') && !generatedSql.toUpperCase().startsWith('WITH')) {
                throw new Error('Only SELECT queries are allowed.');
            }
            dbResult = await localDb.query(generatedSql);
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
        await localDb.execute(
            'INSERT INTO dashboard_chat_history (user_id, role, content) VALUES (?, ?, ?)',
            [userId, 'user', userMessage]
        );
        await localDb.execute(
            'INSERT INTO dashboard_chat_history (user_id, role, content, sql_used) VALUES (?, ?, ?, ?)',
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
        const historyRes = await localDb.query(
            'SELECT role, content, sql_used, created_at FROM dashboard_chat_history WHERE user_id = ? ORDER BY created_at ASC LIMIT 50',
            [req.user.id]
        );
        res.json(historyRes.rows);
    } catch (error) {
        console.error("History Fetch Error:", error);
        res.status(500).json({ error: "Failed to fetch chat history." });
    }
};
