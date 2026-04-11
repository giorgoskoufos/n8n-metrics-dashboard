const openai = require('../config/openai');
const { aiPool } = require('../config/db');

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
    - Return valid PostgreSQL syntax.
`;

exports.chat = async (req, res) => {
    const userMessage = req.body.message;

    if (!userMessage) return res.status(400).json({ error: "Message is required" });

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

        // ΦΑΣΗ 2: Execute SQL
        let dbResult;
        try {
            await aiPool.query('SET statement_timeout = 5000'); 
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
};
