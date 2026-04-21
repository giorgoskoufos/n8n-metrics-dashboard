# 🏗️ n8n Analytics Dashboard Architecture

This document serves as the core logic blueprint for the n8n Analytics Dashboard. It provides rapid context into the Hybrid ETL engine for AI agents and developers.

## 1. System Overview
A lightweight, high-performance MVC application that sits alongside a self-hosted n8n instance. 
Instead of crushing the production n8n database with analytical queries, it utilizes an asynchronous **ETL (Extract, Transform, Load)** pipeline to map core metrics into an isolated local SQLite file.

- **Stack**: Node.js (Express), Vanilla JS (Tailwind/Chart.js), PostgreSQL, SQLite3.
- **Goal**: Real-time workflow analytics with a natural language AI Assistant.

## 2. The Hybrid Database Strategy
We strictly enforce database boundaries to guarantee the n8n core application never suffers performance hits.

### Postgres (`/config/db.js`)
Only utilized for highly specific, non-blocking queries:
1. Verifying user credentials on login.
2. The `syncJob.js` ETL process incrementally fetching un-synced `execution_entity` rows.
3. `getExecutionError`: A 1-to-1 fetch of raw JSON payloads only triggered when a user manually interacts with an error log in the UI.

### SQLite (`/config/localDb.js` -> `dashboard.sqlite`)
The isolated analytical brain.
- **Schema Mapping**: Generates clean replicas of `workflow_entity` and `execution_entity`. We explicitly **drop** sensitive configuration payloads (`nodes`), rendering secret-leakage physically impossible.
- **Configuration & State**: Stores `users` mappings, conversational `dashboard_chat_history`, and custom user `workflow_settings` (mapping the manual configuration of time-saved per workflow and relative hourly rates for monetary calculation).
- All Chart.js metric polling, ROI mathematical aggregations, and AI Text-to-SQL queries strictly route to this file. Native telemetry logic normalizes real-time time-series bucketing using active-bucket extrapolation to prevent chart line-drops.

## 3. The ETL Sync Engine (`/config/syncJob.js`)
Runs as a background cron worker (driven by `node-cron` in `server.js`).
- Initializes by grabbing up to 14 days of history on its first run.
- Runs incrementally afterward (`WHERE id > $last_id`), firing concurrent-safe UPSERTS via a mutex lock.
- Manual triggers are supported via `/api/sync/force`.

## 4. The AI "Text-to-SQL" Pipeline (`aiController.js`)
- **Intention**: LLM parses the highly-restricted SQLite schema representation.
- **Execution**: Generated SQL runs safely inside `dashboard.sqlite`. 
- **Airgapped**: It is impossible for the LLM to write to Postgres or access webhook keys.
- **Memory**: The last 10 messages are injected as context.

## 5. Frontend & UI
- **Authentication Guard (`logic/guard.js`)**: A synchronous IIFE that blocks rendering globally minus a valid JWT.
- **Dynamic Navigation**: A fully stateful, context-aware mobile Burger Menu engineered with backdrop blurs governing the multi-page Analytics environment.
- **Chat Widget**: Fluid resizing and robust visual viewport listeners for iOS keyboards.
- **Manual Sync Engine**: A spinning "Sync Data" button wired directly to the `metricsRoute` to bypass local cron schedules.
- **Precision Filter Architecture**: Employs a dual-mode filtering system:
  - **Macro Presets**: System-wide ISO rolling windows calculated on-the-fly for KPIs.
  - **Component-Scoped**: Independent local filters (e.g., Execution Volume calendar) that target specific visualizations without polluting global state.

## 6. Data Integrity & Persistence
- Introduced `sqlite3` to manage internal state via `dashboard.sqlite`. 
- Moved `dashboard_chat_history` entirely off the n8n Database, resolving the critical "TypeORM Bricking" vulnerability caused by foreign key tampering of the vendor `user` schema.

## 7. Error Intelligence Hub
A specialized diagnostic subsystem for high-precision troubleshooting.
- **Workflow Analyzer**: A drilldown engine that retrieves node failure distributions for specific workflows. 
- **Brittle Source Diagnostics**: An upstream traversal engine that identifies "origin nodes" responsible for downstream crashes. It analyzes branch-level failure rates (e.g., Output 0 vs. Output 1) to identify structural weaknesses.
- **Data Mobility**: Features an on-demand export engine that generates CSV/JSON payloads, bridges analytical findings to external triage tools (Jira/Sentry).
