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
- **State**: Stores `users` mappings and `dashboard_chat_history`.
- All Chart.js metric polling and AI Text-to-SQL logic routes strictly to this file. 

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
- **Chat Widget**: Fluid resizing and robust visual viewport listeners for iOS keyboards.
- **Manual Sync Engine**: A spinning "Sync Data" button wired directly to the `metricsRoute` to bypass local cron schedules.
