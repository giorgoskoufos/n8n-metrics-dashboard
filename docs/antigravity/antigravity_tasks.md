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

---

## 7. ROI Analytics & Internationalization (Premium UI)
Upgraded the open-source dashboard to feature n8n "Insights" capabilities, with a fully responsive architecture.

- **ROI Tracking Framework (`workflow_settings`)**:
    - Defined a new SQLite configuration table linking `workflow_entity` IDs to manual `saved_time_seconds` integers.
    - Built a fully mathematical analytics dashboard mapping total execution occurrences to real-world time saved (Days, Hours, Minutes).
- **Dynamic UX State**:
    - Centralized responsive navigation into a globally consistent fixed-left Mobile Burger Menu utilizing high-fidelity backdrop blurs.
    - Implemented a stateful expandable accordion architecture for rapid scalability of the `settings.html` UI block.
- **Trend Engines**:
    - Reworked `getMetrics` into a multi-phase query, actively firing secondary `look-back` SQL fetches to render `period-over-period` percentage differentials (+10%, -5%).
- **Scale-Ready Data Views**:
    - Brought client-side Text Searching and custom Sorting (Alphabetical, Configured Value, and Execution Count) to Settings tables. Engineered robust DOM-scrolling `jump to top/bottom` contextual floating buttons. 
- **Health Infrastructure**:
    - Wired up a stateless `/healthz` endpoint executing a raw Postgres `SELECT 1` heartbeat for external Docker Swarm/Uptime Kuma monitoring.

## 8. Financial ROI & UX Refinements
- **Monetary Telemetry**:
    - Expanded local DB schema (`workflow_settings`) to natively support currency configuration (`hourly_rate`) per automation.
    - Updated tracking infrastructure to output exact financial equivalents formatted synchronously.
- **"Wizard" Calculator UX**:
    - Embedded an intelligent client UI calculation engine into `settings.html` row expansions. Instead of manually predicting granular metrics, administrators submit bulk real-world intervals ("1 hour per week").
    - Synchronized Javascript pulls actual contextual backend history (30d active executions) and performs reverse-mathematics to safely project "Micro Machine Seconds".
- **Telemetry Dampening & Forecasting**:
    - Hardened the real-time Line Chart architecture against extreme drop-offs natively occurring in partial time groupings.
    - Developed an Active-Bucket Extrapolation logic engine dynamically dividing active time fractional volume vs complete historical moving averages.

---

## 9. Error Intelligence & Workflow Diagnostics (Latest)
Successfully pivoted the Error analytics framework from a bird's-eye view to a high-precision, surgical diagnostic tool.

- **Unified Workflow Analyzer**:
    - Centralized workflow error deep-dives. Selection of any workflow now triggers a real-time retrieval of its specific failure signature.
    - Optimized the UI grid (3-column layout) to fit Global Hotspots alongside the Drilldown.
- **Surgical Brittle-Path Logic**:
    - Relocated "Brittle Origins" from a global, cluttered table to a Tailored Sidebar within the Analyzer.
    - Backend updated (`metricsController.js`) to provide source-node distribution filtered per workflow, showing exactly which upstream node/output branch triggered a downstream error.
- **Visual Intelligence (Chart.js)**:
    - Standardized the Error Doughnut Chart with a **58% cutout** for high-impact visibility. 
    - Implemented **descender-safe legend padding** (25px) to prevent vertical character clipping on long node names.
- **Diagnostic Export Engine**:
    - Built one-click **CSV/JSON extractors** that package both failing node data and upstream branch origins into portable audit logs.
- **Mobile-First Responsive Audit**:
    - Reworked card height dynamics (`h-auto` transitions) and implemented robust horizontal table scrolling (`min-w-[700px]`) to maintain 100% diagnostic usability on mobile devices.
