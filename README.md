# n8n Analytics Dashboard

> [!NOTE]
> This is a **test project**, free to use and open to the community. We welcome suggestions and contributions to make it better for everyone!

A high-performance, real-time analytics dashboard designed for **self-hosted n8n** instances.

### **🎯 Who is this for?**
This tool is for the **Self-Hosted Community**. If you manage your own n8n instance and want professional analytics without the need for an enterprise license or a full cloud migration, this dashboard is designed for you.

### **💡 The Solution: Bridging the Analytics Gap**
While n8n is a powerful automation engine, deep historical analytics and performance insights are primarily available in the n8n Cloud tiers. For self-hosted users, accessing these "Insights" is often not an option unless they migrate their entire infrastructure to n8n Cloud—a move that many choose to avoid due to privacy, data residency, or cost constraints.

This dashboard provides a robust alternative for the independent user:
- **On-Premise Analytics**: Gain deep insights (beyond the basic 7-day summary) while keeping your data and workers on your own hardware.
- **Operational Clarity**: High-granularity performance tracking across all executions without the need for an enterprise subscription.
- **AI-Powered Discovery**: Interrogate your data using a natural language AI Assistant to identify bottlenecks, a functionality typically associated with managed services.
- **Privacy & Sovereignty**: Analytics are served from an isolated local `dashboard.sqlite` replica — your production PostgreSQL instance is never hit by analytical queries or AI logic.

---

> [!IMPORTANT]
> **Hard Requirements:**
> 1. **Self-Hosted n8n only**: This requires direct access to the n8n database for the initial ETL sync.
> 2. **PostgreSQL Only**: Your n8n instance must be configured to use **PostgreSQL**. It will NOT work with the default SQLite database. The dashboard syncs from Postgres into its own local `dashboard.sqlite` — after that, all queries run locally.

---

> [!WARNING]
> **Version Compatibility & Schema Dependency**
> The ETL sync reads a minimal slice of n8n's internal schema (`workflow_entity` and `execution_entity` — metadata columns only, no payloads). It has been built and tested against **n8n Version 1.x / 2.x**. Major future updates to n8n's core schema structure may require a sync job update, but day-to-day analytics run entirely off the local SQLite replica.

---

## 🚀 Key Features
- **Real-time Metrics**: Monitor total executions, error counts, and average runtimes.
- **ROI Analytics**: Track workflow automation value by assigning manual time-saved metrics and hourly rates, complete with period-over-period financial trend comparisons.
- **Execution Timeline**: Visual breakdown of successes vs. errors over 24h, 48h, or 7 days with active-bucket line forecasting to prevent artificial drop-offs.
- **Error Intelligence**: Surgical node-level failure analysis. Identify not just *what* failed, but the specific upstream "brittle path" origins that triggered the crash.
- **Deep-Linking**: One-click navigation from the dashboard directly into the failing n8n workflow editor.
- **AI Analytics Assistant**: A natural language interface to query your data (e.g., "Which workflow was the slowest yesterday?").
- **Secure by Design**: Built-in authentication, rate limiting, and strict Content Security Policies.

### 📊 Enabling Deep Historical Analytics
By default, n8n prunes execution data frequently to save disk space. To fully utilize this dashboard and visualize long-term trends, you must configure your n8n instance to retain data for longer periods. 

Add the following environment variables to your **n8n instance** (example for keeping data for 720 days / ~2 years):
```env
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=720
```
> [!NOTE]
> Increasing n8n's data retention will grow your **PostgreSQL** database size. The dashboard's own `dashboard.sqlite` replica stores only lightweight metadata (no payloads), so its disk footprint remains minimal regardless of retention settings.

---

## 🏗️ Backend (Node.js & Express)

The backend follows a modular **MVC (Model-View-Controller)** architecture for scalability and security.

### Architecture
- **Config (`/config`)**: Manages external connections. 
  - `db.js`: Manages the PostgreSQL connection pool used exclusively for the ETL sync and login verification. All analytics queries run against the local SQLite replica.
  - `openai.js`: Centralized OpenAI API initialization.
- **Controllers (`/controllers`)**: Contains the business logic for analytics, authentication, and AI interaction.
- **Middlewares (`/middlewares`)**:
  - `auth.js`: JWT-based identity verification.
  - `rateLimiter.js`: Protects endpoints from abuse (e.g., brute-force on login, OpenAI quota draining).
- **Routes (`/routes`)**: Maps public endpoints to the internal controller logic.

### Security Layers
- **Text-to-SQL Isolation**: AI-generated queries are securely sandboxed. They are executed against an isolated, local SQLite database containing only essential analytical fields, making it impossible to read internal `n8n` production secrets.
- **Helmet**: Secures the app with HSTS, CSP, and XSS protection.

---

## 🎨 Frontend (Vanilla JS & Tailwind)

The frontend is designed to be lightweight and portable, requiring no build step (it uses CDNs and the standard DOM API).

### How it Works
- **Authentication Guard (`logic/guard.js`)**: A synchronous script that runs before the page renders. it checks for a valid JWT in `localStorage` and redirects unauthorized users to the login page.
- **State Management**: Uses `app.js` to manage dashboard data fetching, infinite-scroll execution tables, and Chart.js state.
- **Dynamic UI**: Responsive layouts built with TailwindCSS, featuring a persistent header with AI Assistant access and a global Logout function.

---

## 🤖 AI Chat Assistant

The AI Chat uses a custom "Text-to-SQL" pipeline:
1. **Intention Parsing**: Converts your natural language question into valid SQLite syntax based on a restricted schema.
2. **Safe Execution**: The SQL is executed locally against the isolated `dashboard.sqlite` engine.
3. **Natural Response**: The raw data results are passed back to the LLM to generate a human-readable summary.

---

## 🧱 Security & Data Privacy

The dashboard is built with a **Security-First** mindset, explicitly protecting your production data and n8n secrets.

### 1. Minimal Data Extraction (The AI Sandbox)
The local SQLite engine does **not** mirror your full n8n database. We use a "need-to-know" approach:
- **Synced Workflow Data**: Only `id`, `name`, and `active` status. We explicitly **exclude the `nodes` column**, meaning the AI Assistant has zero visibility into your credentials, API keys, or logic.
- **Synced Execution Data**: Only `id`, `workflowId`, `status`, `startedAt`, and `stoppedAt`. We **exclude the `data` payload**, so your actual processing data never touches the analytics engine.
- **Result**: The AI can answer questions about *how many* workflows failed or *when* they ran, but it physically **cannot see your sensitive data**.

### 2. Guarded Architecture
- **No SQL Mutation**: The dashboard has zero logic to `UPDATE` or `DELETE` your n8n workflows. It is a strictly read-only analytical tool.
- **Airgapped AI**: The text-to-SQL logic runs against the local SQLite replica, not your Postgres server. Even if the AI generates a malicious query, it has no network path to your production instance.

---

## 🔐 Authentication (Zero-Config Passport)

The dashboard integrates directly with your existing n8n user base. There is no separate signup or "dashboard-only" user management.

- **Unified Logins**: You log in using the exact same **Email** and **Password** you use for your n8n instance. 
- **Bcrypt Matching**: The dashboard uses `bcrypt` to compare your input against the hashed password stored in n8n's `user` table. Your raw password is never stored or logged anywhere.
- **Pass-through Identity**: If you change your password in n8n, it immediately takes effect here. It's like having Active Directory or Single Sign-On, but natively hooked into your Postgres data.

---

---

## 🔍 Advanced Diagnostics: The Error Drilldown
The dashboard provides a dedicated **Error Intelligence** suite:
- **Workflow Analyzer**: Selection of a specific workflow renders a node failure distribution chart (Doughnut).
- **Brittle Sources**: Identifies the specific upstream "Origin Nodes" and output branches that lead to errors, allowing you to fix structural logic before it crashes.
- **Audit Extracts**: Full CSV/JSON data exports containing execution IDs, error stacks, and metadata for external compliance logs.

---

## 🚧 Retention & Performance Tuning
By default, n8n prunes execution data frequently. To visualize long-term trends:
- **Increase Max Age**: Set `EXECUTIONS_DATA_MAX_AGE` to `180`+ days in your **n8n instance**.
- **Local SQLite is unaffected**: The dashboard's `dashboard.sqlite` replica only grows when new executions are synced in — pruning in n8n does not retroactively remove already-synced rows from the local store. Historical data you've already captured stays intact.
- **Save Debug Errors**: The dashboard supports a `SAVE_DEBUG_ERRORS=true` environment variable to capture deep JSON traces for diagnostic purposes.

---

## 🏗️ Dashboard Database Engine
> [!TIP]
> **Zero Configuration Required**
> The dashboard uses a sophisticated ETL (Extract, Transform, Load) pipeline to automatically sync the necessary analytics data from Postgres into a local SQLite `/dashboard.sqlite` database. This ensures your production n8n database is entirely protected from heavy analytical queries and AI text-to-SQL logic.

---

## 🛠️ Hosting Requirements

To host this dashboard, you need access to your self-hosted n8n database.

### Prerequisites
- **Node.js**: v18 or higher.
- **PostgreSQL**: Access to the n8n database (Standard or Read-only credentials).
- **OpenAI API Key**: Required for the AI Analytics feature.

### Environment Setup (`.env`)
Create a `.env` file in the root directory:

```env
# Server Config
DASHBOARD_PORT=3000
DASHBOARD_JWT_SECRET='your_secure_random_secret'

# Main Database (Direct Connection)
DASHBOARD_DB_USER=postgres
DASHBOARD_DB_HOST=your_db_host
DASHBOARD_DB_NAME=n8n_data
DASHBOARD_DB_PASS=your_password
DASHBOARD_DB_PORT=5432

# n8n Editor Integration (for deep-linking errors)
N8N_EDITOR_BASE_URL=https://your-n8n-instance.com

# AI Chat Subsystem
OPENAI_API_KEY=sk-proj-your-key-here

# Background Sync Frequency (in minutes, Optional, Defaults to 5)
SYNC_INTERVAL_MINUTES=5
```

### Installation
1. Clone the repository.
2. Install dependencies: `npm install`
3. Start the server: `npm start`
4. Access the dashboard at `http://localhost:3000`.
