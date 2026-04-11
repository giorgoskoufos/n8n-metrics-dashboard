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
const port = process.env.DASHBOARD_PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "script-src": ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com", "cdn.jsdelivr.net"],
            "script-src-attr": ["'unsafe-inline'"],
            "style-src": ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
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
app.listen(port, () => {
    console.log(`🚀 n8n Analytics Dashboard modularized and listening at http://localhost:${port}`);
});