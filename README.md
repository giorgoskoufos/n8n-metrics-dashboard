# n8n Analytics Dashboard

A high-performance, real-time analytics dashboard designed for self-hosted n8n instances. This application shares the same PostgreSQL database as n8n to provide deep insights into workflow executions, error hotspots, and performance bottlenecks.

---

## 🚀 Key Features
- **Real-time Metrics**: Monitor total executions, error counts, and average runtimes.
- **Execution Timeline**: Visual breakdown of successes vs. errors over 24h, 48h, or 7 days.
- **Error Hotspots**: Identify which workflows are failing the most.
- **AI Analytics Assistant**: A natural language interface to query your data (e.g., "Which workflow was the slowest yesterday?").
- **Secure by Design**: Built-in authentication, rate limiting, and strict Content Security Policies.

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
