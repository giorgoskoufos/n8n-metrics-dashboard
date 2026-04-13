# Project File Index

This file provides an alphabetical index of the core project files (excluding dependency and version control directories) along with a single-sentence explanation of their purpose.

## Root Directory (`/`)
- `.env`: Contains the private environment variables (database credentials, JWT secret, OpenAI keys).
- `.env.example`: A sanitized template of the environment variables required to run the project.
- `dashboard.sqlite`: The isolated local database used to store synchronized analytics and AI chat history without hitting the production Postgres.
- `debug_kpis.js`: A diagnostic script used to manually test and evaluate KPI synchronization metrics from the terminal.
- `Dockerfile`: Defines the containerization instructions for deploying the dashboard via Docker.
- `get_error.js`: A standalone script utilized for troubleshooting and extracting raw error execution payloads from Postgres.
- `n8n_schema_backup.sql`: A backup dump of the n8n database schema used for reference and structural mapping.
- `package.json`: Defines the project's metadata, npm dependencies, and execution scripts.
- `package-lock.json`: Locks the precise versions of npm dependencies to ensure consistent environments across installations.
- `README.md`: The primary public-facing documentation explaining the project's purpose, architecture, and installation.
- `server.js`: The main Node.js entry point that initializes the Express server, mounts routes, and starts the cron synchronization job.

## Configuration (`/config`)
- `db.js`: Establishes and exports the connection pool to the primary n8n PostgreSQL production database.
- `localDb.js`: Initializes and manages the connection to the isolated local `dashboard.sqlite` file.
- `openai.js`: Instantiates the OpenAI client using the provided environment API key for the AI Assistant.
- `syncJob.js`: An automated ETL (Extract, Transform, Load) worker that safely moves execution data from Postgres to the local SQLite database.

## Controllers (`/controllers`)
- `aiController.js`: Handles the Text-to-SQL logic, safely interpreting user queries and executing them against the local SQLite database.
- `authController.js`: Manages user authentication, securely hashing passwords and issuing JWT tokens.
- `metricsController.js`: Processes database queries to calculate period-over-period KPIs, ROI tracking, and execution trend data.

## Documentation (`/docs/antigravity`)
- `antigravity_tasks.md`: A sequential change log of the major architectural and UI tasks completed during dashboard development.
- `FILE_INDEX.md`: This file, providing a human-readable directory of the project's codebase.
- `PROJECT_ARCHITECTURE.md`: High-level technical documentation explaining the Hybrid ETL methodology, Database strategies, and Security boundaries.

## Middlewares (`/middlewares`)
- `auth.js`: Express middleware that intercepts API requests to verify authorization via JWT validation.
- `rateLimiter.js`: Protects authentication and AI endpoints from brute-force attacks and quota abuse by limiting request frequencies.

## Routes (`/routes`)
- `aiRoutes.js`: Exposes API endpoints for the natural language AI Assistant.
- `authRoutes.js`: Maps HTTP endpoints for JWT login processing.
- `metricsRoutes.js`: Contains routing for all dashboard data retrieval, ROI settings management, and manual sync triggers.

## Frontend UI (`/public/pages` & `/public/index.html`)
- `index.html`: The core landing page acting as the primary dashboard displaying real-time aggregated metrics and charts.
- `login.html`: The authentication interface where users submit their n8n credentials.
- `roi.html`: A dedicated analytics page designed to calculate and visualize the total manual time and authentic monetary value saved by successful automations.
- `settings.html`: The configuration interface housing the Wizard Calculator, allowing users to manually assign financial and temporal replacement values to specific workflows.

## Frontend Assets (`/public/assets`)
- `android-chrome-192x192.png`: PWA manifest icon for Android devices.
- `android-chrome-512x512.png`: High-resolution PWA manifest icon for Android devices.
- `apple-touch-icon.png`: Safari and iOS bookmark/home-screen icon.
- `favicon.ico`: Legacy browser icon for the website tab.
- `favicon-16x16.png`: Standard definition 16px favicon.
- `favicon-32x32.png`: High-definition 32px favicon.
- `site.webmanifest`: Configuration file dictating how the application behaves when installed as a Progressive Web App (PWA).

## Frontend Logic (`/public/logic`)
- `app.js`: Connects index.html to the `/api/metrics` endpoint, rendering Chart.js visualizations and dynamic Trend badges.
- `chat-widget.js`: Contains the client-side logic and DOM manipulations for rendering the floating AI Assistant chat window natively.
- `guard.js`: A synchronous script executing before page load that aggressively redirects unauthorized users back to the login screen.
- `login.js`: Handles frontend form submission, orchestrating the POST transmission of credentials and saving the returned JWT to localStorage.
- `roi.js`: Governs `roi.html`, fetching ROI statistics based on dynamic time-range filters and mathematically formatting the display output.
- `settings.js`: Drives `settings.html`, allowing the user to search, filter, and modify workflow time-saving configurations via the API.
