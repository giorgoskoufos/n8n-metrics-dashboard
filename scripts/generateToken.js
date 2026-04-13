require('dotenv').config();
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET;

if (!JWT_SECRET) {
    console.error('DASHBOARD_JWT_SECRET not found in .env');
    process.exit(1);
}

const payload = { 
    id: 'n8n-service-worker',
    email: 'n8n@automation.local',
    role: 'automation' 
};

// Generate a token that lasts for 1 year
const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '365d' });

console.log('==========================================');
console.log('n8n AUTOMATION JWT TOKEN (Expires in 1 year)');
console.log('==========================================');
console.log('');
console.log(token);
console.log('');
console.log('==========================================');
