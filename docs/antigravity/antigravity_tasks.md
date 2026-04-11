# Antigravity Technical Log - n8n Analytics Dashboard

A log of the architectural and security enhancements performed on the n8n Analytics codebase.

## 1. Backend Modularization (MVC Refactor)
Transformed the monolithic `server.js` into a scalable MVC architecture to separate concerns and improve maintainability.

- **Config (`/config`)**:
    - `db.js`: Created a dual-pool system. `pool` for general dashboard queries and `aiPool` (from `AI_DB_URL`) for text-to-SQL logic.
    - `openai.js`: Centralized OpenAI client initialization.
- **Middlewares (`/middlewares`)**:
    - `auth.js`: Extracted JWT verification logic into a standard Express middleware (`authenticateToken`).
    - `rateLimiter.js`: Implemented `express-rate-limit` for `/api/login` (10 requests/15m) and `/api/ai-chat` (5 requests/1m).
- **Controllers (`/controllers`)**:
    - `authController.js`: Handles user authentication against the `user` table.
    - `metricsController.js`: Primary engine for analytics queries.
    - `aiController.js`: Orchestrates the Text-to-SQL pipeline.
- **Routes (`/routes`)**: Defined standard RESTful endpoints mapping to their respective controllers.

## 2. Security Hardening
- **Helmet Security Headers**:
    - Configured strict `ContentSecurityPolicy`.
    - `script-src`: Whitelisted `self`, `cdn.tailwindcss.com`, and `cdn.jsdelivr.net`.
    - `script-src-attr`: Set to `'unsafe-inline'` to allow the `logout()` and `switchTab()` event handlers (temporary transition from inline attributes).
- **SQL Execution Safety**:
    - Implemented `SET statement_timeout = 5000` on the `aiPool` connections within `aiController.js` to mitigate resource exhaustion from complex AI-generated queries.
    - Added data-level isolation by using a dedicated read-only connection string for all AI tasks.

## 3. Analytics Synchronization (Data Accuracy)
Refactored the `getMetrics` controller to ensure global data consistency when filters are applied. Key technical details:

- **Lookback Logic**: Dynamically calculates PostgreSQL `INTERVAL` strings (e.g., `24 hours`, `48 hours`, `7 days`) based on the frontend `timeRange` parameter.
- **Synchronized SQL Queries**:
    - `statsQuery`: Now utilizes `targetWorkflow` and `lookback` via a conditional `JOIN` on `workflow_entity`.
    - `hourlyQuery`: Generates an hourly/daily time series and joins against filtered executions to ensure "zero-counts" are preserved in the chart.
    - `topWorkflowsQuery`: Updated to respect the selected `lookback` period for chart accuracy.
- **Parameter Binding**: Switched from raw string interpolation to positional parameters (`$1`) for the workflow name to prevent SQL injection.

## 4. Frontend & CI/CD
- **Authentication Guard**: Optimized `guard.js` with a synchronous IIFE and a path-aware redirection logic (`window.location.replace`).
- **Logout System**: Created a globally accessible `window.logout()` function to clear `localStorage` and trigger session teardown.
- **GitHub Actions**: Created `.github/workflows/deploy.yml` which triggers a `GET` request to the Easypanel deploy webhook on every push to `main`.
- **NPM Scripts**: Standardized `npm start` and `npm run dev` (using `--watch`) in `package.json`.

## 5. AI Assistant Evolution
Transformed the AI chat from a simple query tool into a persistent, premium assistant with mobile-first optimizations.

- **Conversational Memory**:
    - **Persistence**: Created the `dashboard_chat_history` table (PostgreSQL) using UUID keys to align with the n8n schema.
    - **Context Awareness**: Updated `aiController.js` to retrieve the last 10 messages, enabling the assistant to handle follow-up questions.
- **Rich Data Presentation**:
    - **Markdown Subsystem**: Integrated `marked.js` to support bold text and complex tabular data.
    - **Scrollable Tables**: Implemented a responsive `.prose-chat` bridge to allow horizontal swiping for wide data tables on mobile devices.
- **Fluid & Orientation-Aware UI**:
    - **Dynamic Resizing**: Added a top-left resize handle with touch/mouse support (using absolute screen delta calculations). 
    - **Landscape Support**: Raised the desktop breakpoint to **1024px** to ensure landscape iPhones remain in a full-screen optimized state.
    - **Viewport Sync**: Optimized the `VisualViewport` API listeners to guarantee that the input field remains visible and synchronized during mobile keyboard interactions.
- **Advanced SQL Training**:
    - Refined the AI system prompt to enforce strict quoted-alias persistence (fixing the `ORDER BY` case-sensitivity bug).
    - Taught the assistant PostgreSQL date arithmetic (INTERVALs) for accurate "Yesterday" vs. "Day Before" reporting.
