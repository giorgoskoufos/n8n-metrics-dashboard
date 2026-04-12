# Antigravity Technical Log - n8n Analytics Dashboard

A log of the architectural and security enhancements performed on the n8n Analytics codebase.

## 1. Backend Modularization (MVC Refactor)
Transformed the monolithic `server.js` into a scalable MVC architecture to separate concerns and improve maintainability.
- Extracted controllers, routes, and middleware logic.

## 2. Security Hardening
- Implemented Helmet Content Security Policies.
- Added strict rate-limiting via `express-rate-limit`.

## 3. Analytics Synchronization (Data Accuracy)
- Integrated dynamic SQL `INTERVAL` generation for chart syncing.
- Switched to positional parameters ($1) to prevent SQL injection.

## 4. Frontend & CI/CD
- Optimized authentication barrier globally using `guard.js` block.
- Implemented Easypanel `.github/workflows/deploy.yml` triggers.

## 5. AI Assistant Evolution
- Integrated persistent `dashboard_chat_history`.
- Built fluid, iOS-optimized markdown UI.

---

## 6. ETL Architecture & SQLite Migration (Latest)
Fundamentally shifted the application away from direct OLAP processing on the n8n production database, migrating to a Hybrid ETL strategy.

- **SQLite State Isolation**: 
    - Introduced `sqlite3` to manage internal state via `dashboard.sqlite`. 
    - Moved `dashboard_chat_history` entirely off the n8n Database, resolving the critical "TypeORM Bricking" vulnerability caused by foreign key tampering of the vendor `user` schema.
- **Sync Engine**: 
    - Built a robust, incremental ETL job (`config/syncJob.js`) that safely mirrors `workflow_entity` and `execution_entity`.
    - Protected `syncData()` with a Node.js asynchronous Mutex lock to prevent transaction collisions between automated cron beats and manual triggers.
- **AI Exfiltration Hardening**:
    - Directed all `aiController` logic to the SQLite replica.
    - Explicitly omitted the `nodes` JSON payload during the ETL sync, rendering LLM secret-leakage theoretically physically impossible.
- **Event-Loop Protection**:
    - Re-wired `getExecutionError` in `metricsController.js` to intelligently target Postgres, ensuring that querying a massive execution blob for error inspection remains a one-off action that doesn't bloat the local SQLite database.
- **Hybrid UI Flow**:
    - Exposed `/api/sync/force` endpoint linked to a frontend `.fa-spin-pulse` manual reload button, allowing the user to bypass the `.env` driven background interval natively.
