# Project File Index

This file provides an alphabetical index of the core project files (excluding dependencies and git-ignored files) along with a single-sentence explanation of their purpose.

## Root Directory (`/`)
- `.env.example`: A sanitized template of the environment variables required to run the project.
- `.gitignore`: Specifies files and directories that should be ignored by Git (e.g., node_modules, .env, scratch).
- `debug_kpis.js`: A specialized diagnostic tool for testing ROI and execution metrics via the CLI.
- `get_error.js`: Utility script for fetching raw execution error payloads for diagnostic purposes.
- `Dockerfile`: Instructions for building the containerized version of the analytics dashboard.
- `package.json`: Project metadata, operational scripts, and dependency definitions.
- `README.md`: The primary documentation covering setup, architecture, and feature overviews.
- `server.js`: The main application entry point. Bootstraps the Express server and starts the ETL background sync.

## Configuration (`/config`)
- `config/db.js`: Manages the PostgreSQL connection pool for the external n8n production database.
- `config/localDb.js`: Initializes and manages the local SQLite database for isolated analytics.
- `config/openai.js`: Provides a pre-configured OpenAI client for AI Assistant functionality.
- `config/syncJob.js`: The heart of the ETL engine; periodically pulls metrics from Postgres into the local SQLite analytics store.

## Controllers (`/controllers`)
- `controllers/aiController.js`: Orchestrates natural language processing and safe Text-to-SQL logic for data interrogation.
- `controllers/authController.js`: Handles user verification and JWT generation based on n8n credentials.
- `controllers/metricsController.js`: Powerhouse logic for calculating ROI, trends, hotspots, and error drilldowns.

## Documentation (`/docs/antigravity`)
- `docs/antigravity/antigravity_tasks.md`: Incremental task log detailing architectural and UI modifications.
- `docs/antigravity/FILE_INDEX.md`: This document; a dictionary providing context for all core codebase files.
- `docs/antigravity/PROJECT_ARCHITECTURE.md`: High-level guide explaining the Hybrid ETL strategy and system boundaries.

## Middleware (`/middlewares`)
- `middlewares/auth.js`: Verifies JWT identity tokens for secure access to analytical endpoints.
- `middlewares/rateLimiter.js`: Implements request throttling to protect the Auth and AI subsystems from abuse.

## Routes (`/routes`)
- `routes/aiRoutes.js`: API routes for the natural language AI Assistant.
- `routes/authRoutes.js`: Routes for handling secure login and logout flows.
- `routes/metricsRoutes.js`: Core data endpoints for the dashboard, ROI settings, and diagnostic feeds.

## Frontend UI (`/public`)
- `public/index.html`: The multi-functional main landing page for the dashboard.
- `public/pages/errors.html`: Intelligent error diagnostics and workflow analyzer interface.
- `public/pages/roi.html`: Visual representation of total temporal and monetary efficiency gains.
- `public/pages/settings.html`: Administrative interface for configuring ROI metrics and tracking sync status.
- `public/pages/login.html`: Entry point for dashboard authentication.

## Frontend Logic (`/public/logic`)
- `public/logic/app.js`: Connects the main dashboard UI to the backend metrics stream and renders Chart.js visualizations.
- `public/logic/chat.js`: Drives the interactive AI Assistant widget and manages conversation state.
- `public/logic/errors.js`: Governs the Error Intelligence page, handling workflow drilldown logic and data exports.
- `public/logic/guard.js`: Mission-critical security script that blocks page rendering without a valid session.
- `public/logic/roi.js`: Calculates and formats ROI analytics across dynamic time ranges.
- `public/logic/settings.js`: Manages the CRUD logic for workflow-specific cost/time configurations.
- `public/logic/login.js`: Orchestrates the transmission of user credentials and local storage of session tokens.
