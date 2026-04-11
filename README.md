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
- **Privacy & Sovereignty**: Your analytics data remains strictly within your PostgreSQL instance.

---

> [!IMPORTANT]
> **Hard Requirements:**
> 1. **Self-Hosted n8n only**: This requires direct access to the n8n database.
> 2. **PostgreSQL Only**: Your n8n instance must be configured to use **PostgreSQL**. It will NOT work with the default SQLite database.

---

> [!WARNING]
> **Version Compatibility & Schema Dependency**
> This dashboard directly queries n8n's internal database schema (specifically the `workflow_entity` and `execution_entity` tables). It has been built and tested against **n8n Version 1.x / 2.x**. Major future updates to n8n may alter this internal schema and require subsequent dashboard updates.

---

## 🚀 Key Features
- **Real-time Metrics**: Monitor total executions, error counts, and average runtimes.
- **Execution Timeline**: Visual breakdown of successes vs. errors over 24h, 48h, or 7 days.
- **Error Hotspots**: Identify which workflows are failing the most.
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
> Increasing data retention will significantly increase your PostgreSQL database size. Ensure your host has adequate disk space.

---

## 🏗️ Backend (Node.js & Express)

The backend follows a modular **MVC (Model-View-Controller)** architecture for scalability and security.

### Architecture
- **Config (`/config`)**: Manages external connections. 
  - `db.js`: Handles dual-pool connection pooling (standard pool for dashboard data, read-only pool for AI).
  - `openai.js`: Centralized OpenAI API initialization.
- **Controllers (`/controllers`)**: Contains the business logic for analytics, authentication, and AI interaction.
- **Middlewares (`/middlewares`)**:
  - `auth.js`: JWT-based identity verification.
  - `rateLimiter.js`: Protects endpoints from abuse (e.g., brute-force on login, OpenAI quota draining).
- **Routes (`/routes`)**: Maps public endpoints to the internal controller logic.

### Security Layers
- **Text-to-SQL Isolation**: AI-generated queries are executed using a **Read-Only Database User** with a strict 5000ms timeout to prevent accidental or malicious runaway queries.
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
1. **Intention Parsing**: Converts your natural language question into valid PostgreSQL syntax based on a provided schema of `workflow_entity` and `execution_entity`.
2. **Safe Execution**: The SQL is run against the `aiPool` (Read-only).
3. **Natural Response**: The raw data results are passed back to the LLM to generate a human-readable summary.

---

## 🏗️ Database Setup (Required for AI Chat)

> [!CAUTION]
> **Database Schema Modification**
> The SQL below creates a table (`dashboard_chat_history`) with a Foreign Key linked to the internal n8n `user` table. While this ensures data integrity, **it is an unsupported modification** of the n8n schema. In rare cases, it could interfere with future n8n database migrations. Proceed at your own risk and always backup your database before updating n8n.

Run the following SQL commands directly in your PostgreSQL database:

```sql
-- 1. Create a Read-Only User for the AI Assistant (Crucial for Security)
CREATE USER n8n_ai_readonly WITH PASSWORD 'your_secure_password';
GRANT CONNECT ON DATABASE n8n_data TO n8n_ai_readonly;
GRANT USAGE ON SCHEMA public TO n8n_ai_readonly;
GRANT SELECT ON public.workflow_entity TO n8n_ai_readonly;
GRANT SELECT ON public.execution_entity TO n8n_ai_readonly;

-- 2. Create the persistent chat history table
CREATE TABLE IF NOT EXISTS public.dashboard_chat_history (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES public."user"(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    sql_used TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Add an index for fast history retrieval
CREATE INDEX IF NOT EXISTS idx_chat_history_user ON public.dashboard_chat_history (user_id, created_at);
```

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

# AI Chat Subsystem (Requires Read-Only access for safety)
AI_DB_URL=postgresql://read_only_user:password@host:port/database
OPENAI_API_KEY=sk-proj-your-key-here
```

### Installation
1. Clone the repository.
2. Install dependencies: `npm install`
3. Start the server: `npm start`
4. Access the dashboard at `http://localhost:3000`.
