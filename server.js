// ==========================================
// n8n Analytics Dashboard - Backend Server
// ==========================================

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');

// Route Imports
const authRoutes = require('./routes/authRoutes');
const metricsRoutes = require('./routes/metricsRoutes');
const aiRoutes = require('./routes/aiRoutes');

const app = express();
app.set('trust proxy', 1);
const port = process.env.DASHBOARD_PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "script-src": ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
            "script-src-attr": ["'unsafe-inline'"],
            "style-src": ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
            "font-src": ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            "connect-src": ["'self'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
            "img-src": ["'self'", "data:", "https://*"],
        },
    },
}));
app.use(express.static('public'));
app.use(express.json());

// Main Routes
app.use('/api', authRoutes);
app.use('/api', metricsRoutes);
app.use('/api', aiRoutes);

// Server Initialization
const server = app.listen(port, () => {
    console.log(`🚀 n8n Analytics Dashboard modularized and listening at http://localhost:${port}`);
    console.log(`📡 Press Ctrl+C to stop the server`);
});

// Error Handling for the Server
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Error: Port ${port} is already in use. Please kill the existing process or change DASHBOARD_PORT in your .env file.`);
    } else {
        console.error('❌ Server error:', err);
    }
    process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('👋 Shutting down server...');
    server.close(() => {
        console.log('✅ Server stopped.');
        process.exit(0);
    });
});