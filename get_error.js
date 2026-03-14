require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Ρύθμιση της σύνδεσης με τη βάση (ίδια λογική με το server.js σου)
let poolConfig = {};
if (process.env.DASHBOARD_DATABASE_URL) {
    poolConfig = { connectionString: process.env.DASHBOARD_DATABASE_URL };
} else {
    poolConfig = {
        user: process.env.DASHBOARD_DB_USER,
        host: process.env.DASHBOARD_DB_HOST,
        database: process.env.DASHBOARD_DB_NAME,
        password: process.env.DASHBOARD_DB_PASS,
        port: process.env.DASHBOARD_DB_PORT,
    };
}

const pool = new Pool(poolConfig);

async function fetchError() {
    const targetExecutionId = 325584; // Το ID που θέλουμε να αναλύσουμε
    
    try {
        console.log(`🔍 Συνδεση στη βάση και ανάκτηση δεδομένων για το ID: ${targetExecutionId}...`);
        
        // Προσοχή στα διπλά εισαγωγικά στο "executionId" λόγω Postgres camelCase
        const query = 'SELECT data FROM execution_data WHERE "executionId" = $1';
        const res = await pool.query(query, [targetExecutionId]);
        
        if (res.rows.length === 0) {
            console.error("❌ Το Execution ID δεν βρέθηκε στη βάση!");
            process.exit(1);
        }

        const rawData = res.rows[0].data;

        // Δημιουργία του φακέλου public αν δεν υπάρχει (για σιγουριά)
        const publicDir = path.join(__dirname, 'public');
        if (!fs.existsSync(publicDir)){
            fs.mkdirSync(publicDir);
        }

        // Αποθήκευση στο public/error_payload.txt
        const filePath = path.join(publicDir, 'error_325584.txt');
        fs.writeFileSync(filePath, rawData);
        
        console.log('--------------------------------------------------');
        console.log('✅ ΤΟ ΑΡΧΕΙΟ ΔΗΜΙΟΥΡΓΗΘΗΚΕ ΕΠΙΤΥΧΩΣ!');
        console.log(`📍 Τοποθεσία: ${filePath}`);
        console.log(`🌐 Κατέβασέ το από: http://<IP-ΤΟΥ-SERVER>:3000/error_325584.txt`);
        console.log('--------------------------------------------------');

    } catch (err) {
        console.error("❌ Σφάλμα κατά την εκτέλεση:", err.message);
    } finally {
        await pool.end();
        process.exit();
    }
}

fetchError();