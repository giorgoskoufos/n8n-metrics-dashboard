// ==========================================
// n8n Analytics Dashboard - Backend Server
// ==========================================

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');

// Route Imports
const authRoutes = require('./src/routes/authRoutes');
const metricsRoutes = require('./src/routes/metricsRoutes');
const aiRoutes = require('./src/routes/aiRoutes');

const app = express();
app.set('trust proxy', 1);
const port = process.env.DASHBOARD_PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),

            // No 'unsafe-inline'. Every inline onclick has been replaced by the
            // data-action dispatcher in global_functions.js, which is what lets this
            // directive actually hold — with it present, one missed escape anywhere
            // turns straight into script execution and a stolen auth token.
            "script-src": ["'self'", "cdn.jsdelivr.net"],

            // Blocks inline event handler attributes outright, so a reintroduced
            // onclick= fails loudly in the console instead of silently reopening the hole.
            "script-src-attr": ["'none'"],

            // Still needed: Tailwind emits inline style attributes (skeleton loaders
            // size their bars this way). Inline style is a far smaller risk than
            // inline script — it cannot execute.
            "style-src": ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
            "font-src": ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            "connect-src": ["'self'"],
            "img-src": ["'self'", "data:"],

            // Nothing here embeds or is embedded, and no plugin content is expected.
            "object-src": ["'none'"],
            "base-uri": ["'self'"],
            "frame-ancestors": ["'none'"],
        },
    },
}));
app.use(express.static('public'));
app.use(express.json({ limit: '100kb' }));

// Main Routes
app.use('/api', authRoutes);
app.use('/api', metricsRoutes);
app.use('/api', aiRoutes);

// Health Check Endpoint (returns HTTP status only — no body to leak infra state)
app.get('/healthz', async (req, res) => {
    try {
        const { pool } = require('./src/config/db');
        await pool.query('SELECT 1');
        res.status(200).end();
    } catch (error) {
        res.status(503).end();
    }
});

// ETL Sync Engine
const cron = require('node-cron');
const { syncData } = require('./src/config/syncJob');

const syncInterval = process.env.SYNC_INTERVAL_MINUTES || 5;
cron.schedule(`*/${syncInterval} * * * *`, () => {
    syncData();
});

// Run an initial sync on boot
setTimeout(() => {
    syncData();
}, 2000);

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